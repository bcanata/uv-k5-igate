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
const stats = { heard: 0, decoded: 0, gated: 0, duped: 0 };

// ---- persisted settings ----
const SET_KEY = "igate.settings";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify({
    call: $("igCall").value.trim().toUpperCase(),
    server: $("igServer").value
  }));
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
  renderLog();
}
function renderLog() {
  const el = $("monLog");
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = logArr.map(e =>
    `<div class="ln ${e.kind}"><span class="tm">${timeStr(e.t)}</span>${escapeHtml(e.text)}</div>`
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
}

// ---- serial byte stream -> frames + text lines ----
function feedBytes(bytes) {
  rxBuf = K5P.concat(rxBuf, bytes);
  if (rxBuf.length > 8192) rxBuf = rxBuf.slice(-4096);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  textBuf += s;
  extractTextLines();
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
const gate = { want: false, up: false, verified: false, retries: 0, timer: null, lastSent: 0 };
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
  clearTimeout(gate.timer);
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
  clearTimeout(gate.timer);
  gate.timer = setTimeout(connectIS, secs * 1000);
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

// server keepalives arrive as "#" comment lines; we also make sure the
// connection is never silent for 15 min from our side
setInterval(() => {
  if (gate.up && Date.now() - gate.lastSent > 15 * 60 * 1000) {
    inv("tcp_send", { line: "#uv-k5-igate keepalive" })
      .then(() => { gate.lastSent = Date.now(); })
      .catch(() => {});
  }
}, 60 * 1000);
function onSummaryLine(line) {
  addLog("sum", "· " + line);   // the radio's own display line, secondary info
}

// ---- framed-reply waiter (for hello & friends) ----
function waitFrame(ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = K5P.extractFrame(rxBuf);
      if (f) { rxBuf = f.rest; clearInterval(iv); resolve(f.payload); return; }
      if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
    }, 50);
  });
}
async function sendCmd(frame) {
  await inv("serial_write", { data: Array.from(frame) });
}
async function hello() {
  rxBuf = new Uint8Array(0);
  await sendCmd(K5P.helloFrame());
  const p = await waitFrame(1500);
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
async function connect() {
  const path = $("port").value;
  if (!path) { setStatus("select a serial port", "err"); return; }
  setStatus("connecting…");
  try {
    await inv("serial_open", { path });
  } catch (e) {
    setStatus("open failed: " + e, "err");
    return;
  }
  const ver = await hello();
  if (!ver) {
    await inv("serial_close");
    setStatus("no answer — radio on and in normal mode?", "err");
    return;
  }
  connected = true;
  setStatus("connected: " + ver + " — monitoring", "ok");
  $("btnConnect").textContent = "Disconnect";
  $("btnBeacon").disabled = false;
}
async function disconnect() {
  await inv("serial_close");
  onClosed("");
}
function onClosed(reason) {
  connected = false;
  $("btnConnect").textContent = "Connect";
  $("btnBeacon").disabled = true;
  setStatus(reason ? "disconnected: " + reason : "disconnected");
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
      await sendCmd(K5P.beaconFrame());
      const p = await waitFrame(3000);
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

  await refreshPorts();
  renderStats();
});

function updatePasscode() {
  const pc = K5P.passcode($("igCall").value);
  $("igPass").value = pc === "" ? "" : String(pc);
}
