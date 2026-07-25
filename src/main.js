// main.js — app logic: serial session, K5 hello, APRS line extraction, UI.
// The Rust side is a dumb byte pipe; everything protocol-shaped happens here.
"use strict";

const inv = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const $ = (id) => document.getElementById(id);

// ---- state ----
let connected = false;
let rxBuf = new Uint8Array(0);   // binary buffer for AB CD frame extraction
let textBuf = "";                // latin-1 text buffer for APRS:/APRSRAW: lines
let logArr = [];
// Mirrors the Rust `Stats` struct; counters are cumulative across restarts so a
// station can be judged on its whole life, not since the last launch.
const stats = { heard: 0, decoded: 0, gated: 0, duped: 0,
                total_uptime_secs: 0, first_start_unix: 0, last_heard_unix: 0 };
let flushMark = Date.now();      // uptime accounted up to here
let logPending = [];             // batched for log_append

// ---- persisted settings ----
const SET_KEY = "igate.settings";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings() {
  const cfg = {
    call: $("igCall").value.trim().toUpperCase(),
    server: $("igServer").value,
    // only remember a port we actually talked to a radio on, or autostart would
    // faithfully reconnect to whatever happened to be first in the list
    port: connected ? ($("port").value || "") : (loadSettings().port || ""),
    comment: $("igComment").value,
    beacon_mins: parseInt($("igBeaconMins").value, 10) || 0,
    lat: beaconPos ? beaconPos.lat : 0,
    lon: beaconPos ? beaconPos.lon : 0
  };
  localStorage.setItem(SET_KEY, JSON.stringify(cfg));
  inv("save_config", { cfg }).catch(() => {});   // survives a WebView profile reset
}

// ---- status line ----
function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

// ---- monitor log ----
function timeStr(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0") + ":" +
         String(d.getSeconds()).padStart(2, "0");
}
function addLog(kind, text) {
  logArr.push({ t: Date.now(), kind, text });
  if (logArr.length > 500) logArr = logArr.slice(-500);
  logPending.push(timeStr(Date.now()) + " " + text);
  renderLog();
}
function renderLog() {
  const el = $("monLog");
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = logArr.map(e =>
    // restored lines (t === 0) already carry their own timestamp in the text
    `<div class="ln ${e.kind}">${e.t ? `<span class="tm">${timeStr(e.t)}</span>` : ""}${escapeHtml(e.text)}</div>`
  ).join("");
  if (stick) el.scrollTop = el.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function renderStats() {
  $("stHeard").textContent = stats.heard;
  $("stDecoded").textContent = stats.decoded;
  $("stGated").textContent = stats.gated;
  $("stDuped").textContent = stats.duped;
  const up = stats.total_uptime_secs + Math.floor((Date.now() - flushMark) / 1000);
  const parts = [];
  if (up >= 86400) parts.push(Math.floor(up / 86400) + "d");
  if (up >= 3600)  parts.push(Math.floor((up % 86400) / 3600) + "h");
  parts.push(Math.floor((up % 3600) / 60) + "m");
  let s = "up " + parts.join(" ");
  if (stats.last_heard_unix) {
    const ago = Math.max(0, Math.floor(Date.now() / 1000) - stats.last_heard_unix);
    s += " · last heard " + (ago < 90 ? ago + "s" : Math.floor(ago / 60) + "m") + " ago";
  }
  $("stLife").textContent = s;
}

// Persist counters and the log on a timer, plus on the way out: a station that
// is force-quit or loses power should lose one interval, not its whole history.
async function flushState() {
  const now = Date.now();
  stats.total_uptime_secs += Math.floor((now - flushMark) / 1000);
  flushMark = now;
  try { await inv("save_stats", { stats }); } catch (e) {}
  if (logPending.length) {
    const lines = logPending; logPending = [];
    try { await inv("log_append", { lines }); } catch (e) {}
  }
}

// ---- serial byte stream -> frames + text lines ----
function feedBytes(bytes) {
  rxBuf = K5P.concat(rxBuf, bytes);
  if (rxBuf.length > 8192) rxBuf = rxBuf.slice(-4096);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  textBuf += s;
  extractTextLines();
  if (frameWaiter) frameWaiter();        // wake a pending command exchange
}

// pull complete "APRS:<summary>" / "APRSRAW:<hex>" lines out of the mixed stream
function extractTextLines() {
  for (;;) {
    const iRaw = textBuf.indexOf("APRSRAW:");
    const iSum = textBuf.indexOf("APRS:");
    // "APRS:" also matches nothing inside "APRSRAW:" (different 5th char),
    // but an APRS: hit *after* a pending APRSRAW: must not jump the queue
    let idx, raw;
    if (iRaw >= 0 && (iSum < 0 || iRaw <= iSum)) { idx = iRaw; raw = true; }
    else if (iSum >= 0) { idx = iSum; raw = false; }
    else { if (textBuf.length > 1024) textBuf = textBuf.slice(-128); return; }

    if (idx > 0) textBuf = textBuf.slice(idx);        // drop binary junk before the prefix
    const eol = textBuf.search(/[\r\n]/);
    if (eol < 0) { if (textBuf.length > 4096) textBuf = ""; return; }  // incomplete line
    const line = textBuf.slice(raw ? 8 : 5, eol).trim();
    textBuf = textBuf.slice(eol + 1);
    if (!line) continue;
    if (raw) onRawLine(line); else onSummaryLine(line);
  }
}

function onRawLine(hex) {
  stats.heard++;
  stats.last_heard_unix = Math.floor(Date.now() / 1000);
  const f = K5P.decodeRaw(hex);
  if (f) {
    stats.decoded++;
    if (gate.up && gate.verified) gatePacket(f);
    else addLog("tnc2", f.tnc2);
  } else {
    addLog("err", "undecodable frame: " + hex.slice(0, 40) + (hex.length > 40 ? "…" : ""));
  }
  renderStats();
}

// ---- iGate: APRS-IS session + gating ----
const IG_VERSION = "0.1";
const gate = { want: false, up: false, verified: false, retries: 0, timer: null, dueAt: 0, lastSent: 0 };
const dedup = new Map();   // "SRC|info" -> last-heard ms

function igCall() { return $("igCall").value.trim().toUpperCase(); }
function callValid(c) { return /^[A-Z0-9]{1,6}(-([0-9]|1[0-5]))?$/.test(c) && !c.startsWith("N0CALL"); }

function isStatus(text, cls) {
  const el = $("isStatus");
  el.textContent = "APRS-IS: " + text;
  el.className = "isline" + (cls ? " " + cls : "");
}
function igUiUpdate() {
  $("igToggle").textContent = gate.want ? "Stop gating" : "Start gating";
  $("igToggle").classList.toggle("on", gate.want);
  if (!gate.want) isStatus("idle");
}

async function startGating() {
  const call = igCall();
  if (!callValid(call)) { setStatus("enter a valid iGate callsign-SSID first", "err"); return; }
  gate.want = true;
  gate.retries = 0;
  igUiUpdate();
  await connectIS();
}
async function stopGating() {
  gate.want = false;
  gate.dueAt = 0;
  await inv("tcp_disconnect");
  gate.up = false;
  gate.verified = false;
  igUiUpdate();
}
async function connectIS() {
  if (!gate.want || gate.up) return;
  const [host, port] = $("igServer").value.split(":");
  isStatus("connecting to " + host + "…");
  try {
    await inv("tcp_connect", { host, port: parseInt(port, 10) });
  } catch (e) {
    isStatus("connect failed: " + e, "err");
    scheduleReconnect();
    return;
  }
  gate.up = true;
  gate.verified = false;
  gate.retries = 0;
  try {
    await inv("tcp_send", { line: "user " + igCall() + " pass " + K5P.passcode(igCall()) + " vers uv-k5-igate " + IG_VERSION });
    gate.lastSent = Date.now();
    isStatus("logging in as " + igCall() + "…");
  } catch (e) {
    isStatus("login failed: " + e, "err");
  }
}
function scheduleReconnect() {
  if (!gate.want) return;
  const secs = Math.min(60, 5 * Math.pow(2, gate.retries++));
  isStatus("reconnecting in " + secs + " s…", "err");
  gate.dueAt = Date.now() + secs * 1000;   // fired from the Rust tick
}

// Our own position, injected straight into APRS-IS with a TCPIP* path. An
// RX-only gate that never does this is invisible: it appears on the map only
// as a "via" on someone else's packet, and never as a station of its own.
// Deliberately bypasses gateCheck() — that judges other people's RF traffic.
let beaconLastAt = 0;
async function maybeBeacon() {
  if (!gate.up || !gate.verified || !beaconPos) return;
  const mins = parseInt($("igBeaconMins").value, 10) || 0;
  if (!mins) return;                                   // 0 = do not beacon
  if (beaconLastAt && Date.now() - beaconLastAt < mins * 60000) return;
  const line = K5P.igateBeacon(igCall(), beaconPos.lat, beaconPos.lon,
                               $("igComment").value.trim());
  try {
    await inv("tcp_send", { line });
    beaconLastAt = Date.now();
    gate.lastSent = Date.now();
    addLog("gate", "▲ " + line);
  } catch (e) { addLog("err", "beacon to APRS-IS failed: " + e); }
}

function gatePacket(f) {
  const reason = K5P.gateCheck(f);
  if (reason) { addLog("drop", "✗ " + reason + "  " + f.tnc2); return; }
  const key = f.src + "|" + f.info;
  const now = Date.now();
  const seen = dedup.get(key);
  if (seen && now - seen < 30000) {
    stats.duped++;
    addLog("drop", "✗ duplicate  " + f.tnc2);
    return;
  }
  dedup.set(key, now);
  if (dedup.size > 300) for (const [k, t] of dedup) if (now - t > 60000) dedup.delete(k);

  const line = K5P.gateLine(f, igCall());
  inv("tcp_send", { line }).then(() => {
    gate.lastSent = Date.now();
    stats.gated++;
    renderStats();
    addLog("gate", "▲ " + line);
  }).catch((e) => addLog("err", "gate failed: " + e));
}

// APRS-IS liveness. Measured against euro.aprs2.net: the server emits a "#"
// comment every 20.0-20.3 s, so 60 s of silence means a half-open socket —
// which a keepalive write alone would never notice, because a dead TCP
// connection accepts writes happily for a long time. Called from the tick.
function checkIsLiveness() {
  if (!gate.up) return;
  if (gate.lastRx && Date.now() - gate.lastRx > 60000) {
    addLog("err", "APRS-IS silent for 60 s — treating the link as dead");
    gate.up = false; gate.verified = false;
    inv("tcp_disconnect").catch(() => {});
    scheduleReconnect();
    return;
  }
  if (Date.now() - gate.lastSent > 15 * 60 * 1000) {
    inv("tcp_send", { line: "#uv-k5-igate keepalive" })
      .then(() => { gate.lastSent = Date.now(); })
      .catch(() => {});
  }
}
function onSummaryLine(line) {
  addLog("sum", "· " + line);   // the radio's own display line, secondary info
}

// ---- framed-reply waiter + serialized command exchange ----
// One command may be in flight at a time: rigctl requests, hello and the
// beacon button all funnel through exchange() so replies can't interleave.
// Event-driven rather than polled: a hidden window clamps setInterval to ~1 s,
// which would starve a 1.5 s command timeout. feedBytes() pokes us instead.
let frameWaiter = null;
function waitFrame(ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; frameWaiter = null; clearTimeout(to); resolve(v); } };
    const tryExtract = () => {
      const f = K5P.extractFrame(rxBuf);
      if (f) { rxBuf = f.rest; finish(f.payload); return true; }
      return false;
    };
    const to = setTimeout(() => finish(null), ms);
    if (tryExtract()) return;            // it may already be buffered
    frameWaiter = tryExtract;
  });
}
let cmdChain = Promise.resolve();
function exchange(frame, ms) {
  const p = cmdChain.then(async () => {
    rxBuf = new Uint8Array(0);
    await inv("serial_write", { data: Array.from(frame) });
    return waitFrame(ms || 2000);
  });
  cmdChain = p.catch(() => {});
  return p;
}
let fwVersion = "";

// A gate whose radio isn't listening looks perfectly healthy and hears nothing,
// which is exactly how an afternoon gets wasted. Check it at connect time, and
// fix it if the firmware supports the switch.
async function readCfg(addr, len) {
  const d = new Uint8Array(8);
  d[0] = addr & 0xFF; d[1] = (addr >> 8) & 0xFF;
  d[2] = len & 0xFF;  d[3] = (len >> 8) & 0xFF;
  d.set(K5P.TS, 4);
  const p = await exchange(K5P.frameCommand(0x051B, d), 2000);
  if (!p || (p[0] | (p[1] << 8)) !== 0x051C || p.length < 8 + len) return null;
  return p.slice(8, 8 + len);
}
async function readAprsOn() {
  const b = await readCfg(0x0E30, 8);   // the persisted APRS settings row
  return b ? b[0] === 1 : null;
}

// The gate's own position, taken from whatever the operator already typed into
// the radio: SETTINGS_SaveAPRS puts latitude at State[10] of the 0x0E30 row and
// longitude at State[16], which is the first word of the 0x0F20 row.
let beaconPos = null;
async function readRadioPosition() {
  const a = await readCfg(0x0E30, 16);
  const b = await readCfg(0x0F20, 8);
  if (!a || !b) return null;
  const lat = new DataView(a.buffer, a.byteOffset, a.length).getInt32(10, true);
  const lon = new DataView(b.buffer, b.byteOffset, b.length).getInt32(0, true);
  if (lat === 0 && lon === 0) return null;      // fresh radio, nothing set
  return { lat, lon };
}
function showPos() {
  $("igPos").textContent = beaconPos
    ? K5P.fmtCoord(beaconPos.lat, true) + " " + K5P.fmtCoord(beaconPos.lon, false)
    : "no position — set Loc on the radio, or the gate will not beacon";
}
async function setAprsOn(on) {
  const p = await exchange(K5P.frameCommand(0x0706, new Uint8Array([on ? 1 : 0])), 1500);
  return !!p && (p[0] | (p[1] << 8)) === 0x0707;
}
async function ensureAprsListening() {
  let on;
  try { on = await readAprsOn(); } catch (e) { return true; }
  if (on === null) { addLog("err", "could not read the radio's APRS setting"); return true; }
  if (on) { addLog("sum", "· radio APRS listening: on"); return true; }
  addLog("err", "radio APRS listening is OFF — it would hear nothing; switching it on");
  let ok = false;
  try { ok = await setAprsOn(true); } catch (e) {}
  addLog(ok ? "sum" : "err", ok
    ? "· APRS listening switched on"
    : "could not switch it on — older firmware? turn menu APRS on at the radio");
  return ok;
}

async function hello() {
  const p = await exchange(K5P.helloFrame(), 1500);
  if (!p || (p[0] | (p[1] << 8)) !== 0x0515) return null;
  let s = "";
  for (let i = 4; i < p.length && p[i]; i++) s += String.fromCharCode(p[i]);
  return s;
}

// ---- ports ----
async function refreshPorts() {
  const ports = await inv("list_ports");
  // radio adapters first: wch (macOS CH34x driver), usbserial, COM ports last
  ports.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  function score(p) {
    if (/wchusbserial/i.test(p)) return 3;
    if (/usbserial|usbmodem|ttyUSB/i.test(p)) return 2;
    if (/^\/dev\/cu\./.test(p)) return 1;
    return 0;
  }
  const sel = $("port");
  const prev = sel.value;
  sel.innerHTML = ports.map(p => `<option value="${p}">${p}</option>`).join("");
  if (ports.includes(prev)) sel.value = prev;
  if (!ports.length) sel.innerHTML = `<option value="">no ports found</option>`;
}

// ---- connect / disconnect ----
async function connect(isRetry) {
  const path = $("port").value;
  if (!path) { setStatus("select a serial port", "err"); return; }
  if (!isRetry) { radioWant = true; radioTries = 0; }
  setStatus("connecting…");
  try {
    await inv("serial_open", { path });
  } catch (e) {
    try { await inv("serial_close"); } catch (_e) {}   // never leave it half-open
    setStatus("open failed: " + e, "err");
    return;
  }
  // Retry: while the radio is transmitting (an auto-beacon takes a second or
  // two) its main loop cannot answer UART, so a single attempt can miss a
  // perfectly healthy radio.
  let ver = null;
  for (let attempt = 0; attempt < 3 && !ver; attempt++) {
    if (attempt) { setStatus("no answer, retrying…"); await new Promise(r => setTimeout(r, 1200)); }
    ver = await hello();
  }
  if (!ver) {
    try { await inv("serial_close"); } catch (e) {}
    setStatus("no answer — radio on and in normal mode?", "err");
    // serial_close is ours, so no serial-closed event arrives to kick the
    // retry loop: schedule it here or a radio that is merely switched off at
    // boot would never be picked up when it comes back.
    if (radioWant) scheduleRadioReconnect();
    return;
  }
  connected = true;
  fwVersion = ver;
  setStatus("connected: " + ver + " — monitoring", "ok");
  $("btnConnect").textContent = "Disconnect";
  $("btnBeacon").disabled = false;
  if (!await ensureAprsListening())
    setStatus("connected: " + ver + " — but APRS listening is OFF at the radio", "err");
  if (!beaconPos) {                     // config override wins; else ask the radio
    try { beaconPos = await readRadioPosition(); } catch (e) {}
    showPos();
    if (beaconPos) addLog("sum", "· gate position from the radio: " +
      K5P.fmtCoord(beaconPos.lat, true) + " " + K5P.fmtCoord(beaconPos.lon, false));
  }
}
async function disconnect() {
  radioWant = false;                 // an operator disconnect must not self-heal
  clearTimeout(radioTimer);
  await inv("serial_close");
  onClosed("");
}
function onClosed(reason) {
  connected = false;
  $("btnConnect").textContent = "Connect";
  $("btnBeacon").disabled = true;
  setStatus(reason ? "disconnected: " + reason : "disconnected");
  if (radioWant) {
    addLog("err", "radio link lost" + (reason ? ": " + reason : ""));
    scheduleRadioReconnect();
  }
}

// The radio side had no recovery at all: unplug the USB adapter and the station
// stayed dead for good, while APRS-IS quietly kept its session. Same backoff
// shape as scheduleReconnect() below, and it re-scans ports each attempt
// because a replugged adapter can come back under a different name.
let radioWant = false, radioTries = 0, radioTimer = null, radioDueAt = 0;
function scheduleRadioReconnect() {
  if (!radioWant) return;
  const secs = Math.min(60, 5 * Math.pow(2, radioTries++));
  setStatus("radio gone — retrying in " + secs + " s", "err");
  radioDueAt = Date.now() + secs * 1000;   // the Rust tick fires it
}
async function radioRetry() {
  if (!radioWant || connected) return;
  await refreshPorts();
  if (!$("port").value) { scheduleRadioReconnect(); return; }
  await connect(true);
  if (!connected) scheduleRadioReconnect();
  else { radioTries = 0; addLog("sum", "· radio link restored"); }
}

// ---- wire up ----
window.addEventListener("DOMContentLoaded", async () => {
  const set = loadSettings();
  if (set.call) $("igCall").value = set.call;
  if (set.server) $("igServer").value = set.server;
  updatePasscode();

  $("btnRefresh").addEventListener("click", refreshPorts);
  $("btnConnect").addEventListener("click", () => (connected ? disconnect() : connect()));
  $("btnClear").addEventListener("click", () => { logArr = []; renderLog(); });
  $("btnBeacon").addEventListener("click", async () => {
    if (!connected) return;
    try {
      const p = await exchange(K5P.beaconFrame(), 3000);
      addLog(p && (p[0] | (p[1] << 8)) === 0x0703 ? "sum" : "err",
             p ? "· beacon transmitted" : "beacon: no ack from radio");
    } catch (e) { addLog("err", "beacon failed: " + e); }
  });
  $("igCall").addEventListener("input", () => { updatePasscode(); saveSettings(); });
  $("igServer").addEventListener("change", saveSettings);

  $("igToggle").addEventListener("click", () => (gate.want ? stopGating() : startGating()));

  await listen("serial-data", (e) => feedBytes(new Uint8Array(e.payload)));
  await listen("serial-closed", (e) => onClosed(e.payload));

  await listen("tcp-line", (e) => {
    const line = e.payload;
    gate.lastRx = Date.now();            // any traffic proves the socket is alive
    if (!line.startsWith("#")) return;   // no filter set, so anything else is noise
    if (/logresp/i.test(line)) {
      // "# logresp CALL verified, server ..." / "... unverified ..."
      gate.verified = /\bverified\b/i.test(line) && !/\bunverified\b/i.test(line);
      isStatus(gate.verified ? "verified — gating to " + $("igServer").value.split(":")[0]
                             : "passcode REJECTED (unverified)", gate.verified ? "ok" : "err");
      addLog("sum", "· " + line.replace(/^#\s*/, ""));
    }
  });
  await listen("tcp-closed", (e) => {
    gate.up = false;
    gate.verified = false;
    if (gate.want) {
      isStatus("connection lost: " + e.payload, "err");
      scheduleReconnect();
    }
  });

  // carry the previous life forward: counters, uptime and the tail of the log
  try {
    const s = await inv("load_stats");
    if (s) Object.assign(stats, s);
    if (!stats.first_start_unix) stats.first_start_unix = Math.floor(Date.now() / 1000);
  } catch (e) {}
  try {
    const tail = await inv("log_tail", { n: 200 });
    if (tail && tail.length) {
      logArr = tail.map(t => ({ t: 0, kind: "sum", text: t }));
      renderLog();
    }
  } catch (e) {}
  flushMark = Date.now();
  window.addEventListener("beforeunload", () => { flushState(); });
  await listen("app-quitting", () => { flushState(); });

  // Everything time-driven hangs off the 5 s tick emitted by Rust, because a
  // hidden webview's own timers get throttled and this app is expected to run
  // for weeks with its window shut.
  let lastFlush = Date.now();
  await listen("tick", async () => {
    renderStats();
    checkIsLiveness();
    if (Date.now() - lastFlush >= 30000) { lastFlush = Date.now(); await flushState(); }
    if (radioWant && !connected && radioDueAt && Date.now() >= radioDueAt) {
      radioDueAt = 0;
      await radioRetry();
    }
    if (gate.want && !gate.up && gate.dueAt && Date.now() >= gate.dueAt) {
      gate.dueAt = 0;
      await connectIS();
    }
    checkIsLiveness();
    await maybeBeacon();
  });

  await refreshPorts();
  renderStats();
  await autoStart();
});

// Unattended start (see startup_config in Rust): with UVK5_IGATE_AUTOSTART=1
// the station connects to the radio and begins gating on its own, so it
// survives a reboot or a launch-at-login without anyone clicking.
async function autoStart() {
  let cfg;
  try { cfg = await inv("startup_config"); } catch (e) { return; }
  if (!cfg) return;
  if (cfg.call) { $("igCall").value = cfg.call; updatePasscode(); }
  if (cfg.comment) $("igComment").value = cfg.comment;
  if (typeof cfg.beacon_mins === "number" && cfg.beacon_mins >= 0) $("igBeaconMins").value = cfg.beacon_mins;
  if (cfg.lat || cfg.lon) { beaconPos = { lat: cfg.lat, lon: cfg.lon }; }   // override
  showPos();
  if (cfg.server) {
    if (![...$("igServer").options].some(o => o.value === cfg.server))
      $("igServer").add(new Option(cfg.server, cfg.server));
    $("igServer").value = cfg.server;
    saveSettings();
  }
  if (cfg.port) {
    if (![...$("port").options].some(o => o.value === cfg.port))
      $("port").add(new Option(cfg.port, cfg.port));
    $("port").value = cfg.port;
  }
  if (!cfg.autostart) return;

  addLog("sum", "· auto-start: connecting to the radio…");
  await connect();
  // The two links are independent. If the radio is off right now the retry
  // loop will bring it back, so still bring up APRS-IS and beacon our
  // position — otherwise one radio hiccup at boot leaves the gate off the
  // map indefinitely, even after the radio returns.
  if (!connected) addLog("err", "auto-start: no radio yet — gating anyway, will keep retrying");
  await startGating();
}

function updatePasscode() {
  const pc = K5P.passcode($("igCall").value);
  $("igPass").value = pc === "" ? "" : String(pc);
}
