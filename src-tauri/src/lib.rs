// Rust side = two dumb byte pipes (serial port, TCP socket) and nothing else.
// All protocol knowledge (K5 envelope, AX.25, APRS-IS login/gating) lives in
// the JS frontend, ported from the web repo's k5.js — so protocol changes
// never require touching Rust.
//
// Each pipe owns a background reader thread that pushes data to the webview
// as events. A generation counter invalidates the thread on close/reopen so a
// stale thread can never emit into a new session.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    serial: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    serial_gen: AtomicU64,
    tcp: Mutex<Option<TcpStream>>,
    tcp_gen: AtomicU64,
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

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            serial_open,
            serial_close,
            serial_write,
            tcp_connect,
            tcp_send,
            tcp_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
