// kiss.js — the radio presented to other software as a KISS TNC.
//
// Rust owns the socket and the FEND/FESC framing (transport, same category as
// the line-splitting it already does elsewhere); everything above that is here:
// the KISS command byte, and the two directions of traffic.
//
//   radio -> clients : APRSRAW frames the firmware already decoded and
//                      FCS-checked, re-emitted as KISS data frames
//   clients -> radio : KISS data frames handed to the firmware's 0x0708 raw-TX
//                      command, which appends the FCS and keys up
//
// Transmit is opt-in. An iGate that unexpectedly transmits is worse than one
// that stays quiet, and on this radio a repeat also goes out as FFSK 1200/1800,
// which hardware TNCs cannot decode.
"use strict";

const KISS = (() => {
  const KISS_KEY = "igate.kiss";
  const MAX_TX = 150;              // APRS_RAWTX_MAX in the firmware
  let running = false, clients = 0;

  function line(text, cls) {
    const el = $("kissStatus");
    el.textContent = "KISS: " + text;
    el.className = "isline" + (cls ? " " + cls : "");
  }
  function refresh() {
    $("kissToggle").textContent = running ? "Stop server" : "Start server";
    $("kissToggle").classList.toggle("on", running);
    line(running
      ? "listening on " + ($("kissBind").checked ? "0.0.0.0" : "127.0.0.1") + ":" +
        $("kissPort").value + " — " + clients + " client" + (clients === 1 ? "" : "s")
      : "off");
  }
  function save() {
    localStorage.setItem(KISS_KEY, JSON.stringify({
      port: parseInt($("kissPort").value, 10) || 8001,
      lan: $("kissBind").checked,
      tx: $("kissTx").checked
    }));
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KISS_KEY)) || {};
      if (s.port) $("kissPort").value = s.port;
      $("kissBind").checked = !!s.lan;
      $("kissTx").checked = !!s.tx;
    } catch (e) {}
  }

  async function start() {
    const port = parseInt($("kissPort").value, 10) || 8001;
    const bind = $("kissBind").checked ? "0.0.0.0" : "127.0.0.1";
    try {
      await inv("kiss_start", { bind, port });
      running = true;
      addLog("sum", "· KISS TNC listening on " + bind + ":" + port);
    } catch (e) {
      running = false;
      line("start failed: " + e, "err");
      return;
    }
    refresh(); save();
  }
  async function stop() {
    await inv("kiss_stop");
    running = false; clients = 0;
    refresh();
  }

  // A frame the radio decoded: hand it to every client as KISS data (port 0).
  function onRadioFrame(hexOrBytes) {
    if (!running) return;
    let b = hexOrBytes;
    if (typeof b === "string") {
      if (!/^[0-9A-Fa-f]+$/.test(b) || b.length % 2) return;
      const n = new Uint8Array(b.length / 2);
      for (let i = 0; i < n.length; i++) n[i] = parseInt(b.substr(i * 2, 2), 16);
      b = n;
    }
    const data = new Uint8Array(b.length + 1);
    data[0] = 0x00;                       // command 0 / port 0 = data frame
    data.set(b, 1);
    inv("kiss_broadcast", { data: Array.from(data) }).catch(() => {});
  }

  // A frame from a client. Only command 0 carries data; the TNC parameter
  // commands (TXDELAY, P, SlotTime…) are meaningless here, so acknowledge them
  // by ignoring them rather than transmitting garbage.
  async function onClientFrame(payload) {
    if (!payload || !payload.length) return;
    const cmd = payload[0] & 0x0F;
    if (cmd === 0x0F) { return; }                       // Return from KISS mode
    if (cmd !== 0x00) return;                           // a parameter, not data
    const frame = payload.slice(1);
    if (!frame.length) return;
    if (!$("kissTx").checked) {
      addLog("drop", "✗ KISS TX disabled — dropped " + frame.length + " B from a client");
      return;
    }
    if (!connected) { addLog("err", "KISS TX: no radio"); return; }
    if (frame.length > MAX_TX) {
      addLog("err", "KISS TX: frame is " + frame.length + " B, the radio caps at " + MAX_TX);
      return;
    }
    try {
      const p = await exchange(K5P.frameCommand(0x0708, new Uint8Array(frame)), 2500);
      // No reply at all means the firmware predates the raw-TX command, which
      // is a completely different problem from the radio declining the frame.
      if (!p || (p[0] | (p[1] << 8)) !== 0x0709) {
        addLog("err", "KISS TX: this firmware has no raw-TX command — reflash the radio");
      } else if (p[4] === 1) {
        addLog("gate", "▲ KISS TX " + frame.length + " B");
      } else {
        addLog("err", "KISS TX refused: radio busy, no callsign set, or over " + MAX_TX + " B");
      }
    } catch (e) { addLog("err", "KISS TX failed: " + e); }
  }

  // Applied by main.js's autoStart from config.json, so an unattended station
  // can bring the TNC up without anyone opening the window.
  async function applyConfig(cfg) {
    if (!cfg) return;
    if (cfg.kiss_port) $("kissPort").value = cfg.kiss_port;
    if (typeof cfg.kiss_lan === "boolean") $("kissBind").checked = cfg.kiss_lan;
    if (typeof cfg.kiss_tx === "boolean") $("kissTx").checked = cfg.kiss_tx;
    refresh();
    if (cfg.kiss_autostart && !running) await start();
  }

  async function init() {
    load(); refresh();
    $("kissToggle").addEventListener("click", () => (running ? stop() : start()));
    $("kissPort").addEventListener("change", save);
    $("kissBind").addEventListener("change", save);
    $("kissTx").addEventListener("change", save);

    await listen("kiss-frame", (e) => onClientFrame(e.payload.data));
    await listen("kiss-count", (e) => { clients = e.payload; refresh(); });
  }

  return { init, onRadioFrame, applyConfig };
})();

window.addEventListener("DOMContentLoaded", () => { KISS.init(); });
