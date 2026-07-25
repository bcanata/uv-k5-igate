// Rust side = two dumb byte pipes (serial port, TCP socket) and nothing else.
// All protocol knowledge (K5 envelope, AX.25, APRS-IS login/gating) lives in
// the JS frontend, ported from the web repo's k5.js — so protocol changes
// never require touching Rust.
//
// Each pipe owns a background reader thread that pushes data to the webview
// as events. A generation counter invalidates the thread on close/reopen so a
// stale thread can never emit into a new session.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    quitting: std::sync::atomic::AtomicBool,
    serial: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    serial_gen: AtomicU64,
    tcp: Mutex<Option<TcpStream>>,
    tcp_gen: AtomicU64,
    rigctl: Mutex<HashMap<u64, TcpStream>>,
    rigctl_gen: AtomicU64,
    rigctl_next: AtomicU64,
}

#[derive(Clone, serde::Serialize)]
struct RigctlCmd {
    id: u64,
    line: String,
}

// ---------------------------------------------------------------------------
// Configuration and persisted state.
//
// Config is a three-layer merge: built-in defaults < config.json < UVK5_IGATE_*
// environment. The environment stays on top so a terminal launch can still
// override anything, but it can no longer be the only mechanism: an .app
// started from Finder, Spotlight or Login Items never sees a shell profile.
// ---------------------------------------------------------------------------
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct Config {
    call: String,
    server: String,
    port: String,
    autostart: bool,
    comment: String,
    beacon_mins: u32,      // 0 = do not beacon our own position to APRS-IS
    lat: i32,              // micro-degrees; 0/0 = take the radio's stored position
    lon: i32,
    launch_at_login: bool,
    start_hidden: bool,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct Stats {
    heard: u64,
    decoded: u64,
    gated: u64,
    duped: u64,
    total_uptime_secs: u64,
    first_start_unix: u64,
    last_heard_unix: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}
fn data_file(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(name))
}

// Write through a temp file and rename, so a crash mid-write cannot leave a
// truncated config behind. rename() replaces the target on Windows too.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn startup_config(app: AppHandle) -> Config {
    let mut c = read_config(&app);
    // environment wins, so an explicitly-launched station can always be steered
    if let Ok(v) = std::env::var("UVK5_IGATE_CALL")   { if !v.is_empty() { c.call = v; } }
    if let Ok(v) = std::env::var("UVK5_IGATE_SERVER") { if !v.is_empty() { c.server = v; } }
    if let Ok(v) = std::env::var("UVK5_IGATE_PORT")   { if !v.is_empty() { c.port = v; } }
    if let Ok(v) = std::env::var("UVK5_IGATE_AUTOSTART") { c.autostart = v == "1"; }
    if std::env::args().any(|a| a == "--autostart") { c.autostart = true; c.start_hidden = true; }
    c
}

#[tauri::command]
fn save_config(app: AppHandle, cfg: Config) -> Result<(), String> {
    let path = config_path(&app).ok_or("no config dir")?;
    atomic_write(&path, serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?.as_slice())
}

#[tauri::command]
fn load_stats(app: AppHandle) -> Stats {
    data_file(&app, "state.json")
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Stats>(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_stats(app: AppHandle, mut stats: Stats) -> Result<(), String> {
    if stats.first_start_unix == 0 {
        stats.first_start_unix = now_unix();
    }
    let path = data_file(&app, "state.json").ok_or("no data dir")?;
    atomic_write(&path, serde_json::to_vec_pretty(&stats).map_err(|e| e.to_string())?.as_slice())
}

// Batched from the frontend (one IPC per packet would be wasteful). Rotates at
// 1 MiB so an unattended gateway cannot fill the disk over months.
#[tauri::command]
fn log_append(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let path = data_file(&app, "igate.log").ok_or("no data dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if std::fs::metadata(&path).map(|m| m.len() > 1_048_576).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("1.log"));
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    for l in lines {
        writeln!(f, "{}", l).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Repopulate the monitor pane after a restart, so a station that has been up
// for days does not look freshly booted.
#[tauri::command]
fn log_tail(app: AppHandle, n: usize) -> Vec<String> {
    let Some(path) = data_file(&app, "igate.log") else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(n)..].iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|v| v.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

#[tauri::command]
fn serial_open(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let mut guard = state.serial.lock().unwrap();
    if guard.is_some() {
        return Err("serial port already open".into());
    }
    let port = serialport::new(&path, 38_400)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| e.to_string())?;
    let mut rd = port.try_clone().map_err(|e| e.to_string())?;
    // the clone does not necessarily inherit the timeout, and a reader blocked
    // forever never notices serial_close and keeps the port open for everyone
    rd.set_timeout(Duration::from_millis(100)).ok();
    *guard = Some(port);
    drop(guard);

    let gen = state.serial_gen.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
            let st = app.state::<AppState>();
            if st.serial_gen.load(Ordering::SeqCst) != gen {
                break; // closed or reopened behind our back
            }
            match rd.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let _ = app.emit("serial-data", buf[..n].to_vec());
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    // unplugged or driver error: tear the session down once
                    if st.serial_gen.load(Ordering::SeqCst) == gen {
                        st.serial_gen.fetch_add(1, Ordering::SeqCst);
                        *st.serial.lock().unwrap() = None;
                        let _ = app.emit("serial-closed", e.to_string());
                    }
                    break;
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn serial_close(state: State<'_, AppState>) {
    state.serial_gen.fetch_add(1, Ordering::SeqCst);
    *state.serial.lock().unwrap() = None;
}

#[tauri::command]
fn serial_write(state: State<'_, AppState>, data: Vec<u8>) -> Result<(), String> {
    let mut guard = state.serial.lock().unwrap();
    match guard.as_mut() {
        Some(p) => p
            .write_all(&data)
            .and_then(|_| p.flush())
            .map_err(|e| e.to_string()),
        None => Err("serial port not open".into()),
    }
}

#[tauri::command]
fn tcp_connect(app: AppHandle, state: State<'_, AppState>, host: String, port: u16) -> Result<(), String> {
    let mut guard = state.tcp.lock().unwrap();
    if guard.is_some() {
        return Err("already connected".into());
    }
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| format!("cannot resolve {host}"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| e.to_string())?;
    stream.set_nodelay(true).ok();
    let rd = stream.try_clone().map_err(|e| e.to_string())?;
    *guard = Some(stream);
    drop(guard);

    let gen = state.tcp_gen.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        // read_until, not read_line: APRS-IS carries raw packet bytes (Mic-E
        // info fields are high-bit binary), so UTF-8 validation would kill
        // the connection on the first such packet.
        let mut reader = BufReader::new(rd);
        let mut line: Vec<u8> = Vec::with_capacity(512);
        loop {
            let st = app.state::<AppState>();
            if st.tcp_gen.load(Ordering::SeqCst) != gen {
                break;
            }
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => {
                    if st.tcp_gen.load(Ordering::SeqCst) == gen {
                        st.tcp_gen.fetch_add(1, Ordering::SeqCst);
                        *st.tcp.lock().unwrap() = None;
                        let _ = app.emit("tcp-closed", "connection closed by server".to_string());
                    }
                    break;
                }
                Ok(_) => {
                    let text: String = line.iter().map(|&b| b as char).collect(); // latin-1, lossless
                    let _ = app.emit("tcp-line", text.trim_end_matches(['\r', '\n']).to_string());
                }
                Err(e) => {
                    if st.tcp_gen.load(Ordering::SeqCst) == gen {
                        st.tcp_gen.fetch_add(1, Ordering::SeqCst);
                        *st.tcp.lock().unwrap() = None;
                        let _ = app.emit("tcp-closed", e.to_string());
                    }
                    break;
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn tcp_send(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let mut guard = state.tcp.lock().unwrap();
    match guard.as_mut() {
        Some(s) => {
            // latin-1 out: chars 0-255 map to single bytes, same as the read path
            let bytes: Vec<u8> = line.chars().map(|c| c as u32 as u8).collect();
            s.write_all(&bytes)
                .and_then(|_| s.write_all(b"\r\n"))
                .map_err(|e| e.to_string())
        }
        None => Err("not connected".into()),
    }
}

#[tauri::command]
fn tcp_disconnect(state: State<'_, AppState>) {
    state.tcp_gen.fetch_add(1, Ordering::SeqCst);
    if let Some(s) = state.tcp.lock().unwrap().take() {
        let _ = s.shutdown(Shutdown::Both);
    }
}

// rigctld-compatible server: localhost-only listener, one reader thread per
// client. Lines go to the webview as "rigctl-cmd" events; the JS protocol
// handler answers via rigctl_reply. Client count changes emit "rigctl-count".
fn rigctl_emit_count(app: &AppHandle) {
    let n = app.state::<AppState>().rigctl.lock().unwrap().len();
    let _ = app.emit("rigctl-count", n);
}

#[tauri::command]
fn rigctl_start(app: AppHandle, state: State<'_, AppState>, port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let gen = state.rigctl_gen.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        loop {
            let st = app.state::<AppState>();
            if st.rigctl_gen.load(Ordering::SeqCst) != gen {
                break; // stopped or restarted; dropping the listener closes the port
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nodelay(true).ok();
                    stream.set_nonblocking(false).ok();
                    let Ok(rd) = stream.try_clone() else { continue };
                    let id = st.rigctl_next.fetch_add(1, Ordering::SeqCst) + 1;
                    st.rigctl.lock().unwrap().insert(id, stream);
                    rigctl_emit_count(&app);

                    let capp = app.clone();
                    std::thread::spawn(move || {
                        let mut reader = BufReader::new(rd);
                        let mut line: Vec<u8> = Vec::with_capacity(128);
                        loop {
                            let st = capp.state::<AppState>();
                            if st.rigctl_gen.load(Ordering::SeqCst) != gen {
                                break;
                            }
                            line.clear();
                            match reader.read_until(b'\n', &mut line) {
                                Ok(0) | Err(_) => {
                                    st.rigctl.lock().unwrap().remove(&id);
                                    rigctl_emit_count(&capp);
                                    break;
                                }
                                Ok(_) => {
                                    let text: String = line.iter().map(|&b| b as char).collect();
                                    let text = text.trim().to_string();
                                    if !text.is_empty() {
                                        let _ = capp.emit("rigctl-cmd", RigctlCmd { id, line: text });
                                    }
                                }
                            }
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn rigctl_stop(state: State<'_, AppState>) {
    state.rigctl_gen.fetch_add(1, Ordering::SeqCst);
    let mut clients = state.rigctl.lock().unwrap();
    for (_, s) in clients.drain() {
        let _ = s.shutdown(Shutdown::Both);
    }
}

#[tauri::command]
fn rigctl_reply(state: State<'_, AppState>, id: u64, text: String) -> Result<(), String> {
    let mut clients = state.rigctl.lock().unwrap();
    match clients.get_mut(&id) {
        Some(s) => {
            let bytes: Vec<u8> = text.chars().map(|c| c as u32 as u8).collect();
            s.write_all(&bytes).map_err(|e| e.to_string())
        }
        None => Err("client gone".into()),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;

            let show_i = MenuItem::with_id(app, "show", "Open iGate", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit iGate", true, Some("CmdOrCtrl+Q"))?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("UV-K5 iGate")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        app.state::<AppState>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        let _ = app.emit("app-quitting", ());   // let the UI flush state
                        std::thread::sleep(Duration::from_millis(400));
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // A hidden webview throttles its own timers hard (and macOS may nap
            // the process), so anything time-driven — reconnect backoff, the
            // beacon, state flushes — is paced from here instead of setInterval.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                if handle.emit("tick", ()).is_err() {
                    break;
                }
            });

            // Launched by the login item: come up in the tray, no window flash.
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must not kill the gateway; only the tray quits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            startup_config,
            save_config,
            load_stats,
            save_stats,
            log_append,
            log_tail,
            list_ports,
            serial_open,
            serial_close,
            serial_write,
            tcp_connect,
            tcp_send,
            tcp_disconnect,
            rigctl_start,
            rigctl_stop,
            rigctl_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
