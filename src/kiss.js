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

  // ---- who may transmit -------------------------------------------------
  // The TNC hands frames straight to the transmitter, so whatever can reach
  // the port is operating under our licence. The allow list is checked against
  // the AX.25 *source* address of each frame, which is the callsign that will
  // actually go on the air.
  //
  // "TA1JS"   -> any SSID of TA1JS        (TA1JS, TA1JS-7, TA1JS-10 …)
  // "TA1JS-7" -> only that SSID
  // "*" or "" -> anything, which is what this did before the list existed
  function allowList() {
    return ($("kissAllow").value || "")
      .toUpperCase().split(/[\s,;]+/).filter(Boolean);
  }
  function allowsAny(list) {
    return list.length === 0 || list.includes("*");
  }

  // Source callsign of an AX.25 frame: second address field, characters held in
  // the top 7 bits, SSID in bits 4..1 of the seventh byte. Returns null if the
  // frame is too short or the field is not a plausible callsign — callers must
  // treat null as "not allowed" whenever a list is set.
  function sourceCall(frame) {
    if (frame.length < 14) return null;
    let call = "";
    for (let i = 7; i < 13; i++) {
      const c = String.fromCharCode(frame[i] >> 1);
      if (c !== " ") call += c;
    }
    if (!/^[A-Z0-9]{1,6}$/.test(call)) return null;
    const ssid = (frame[13] >> 1) & 0x0F;
    return ssid ? call + "-" + ssid : call;
  }

  function txAllowed(frame) {
    const list = allowList();
    if (allowsAny(list)) return { ok: true, call: sourceCall(frame) || "?" };
    const call = sourceCall(frame);
    if (!call) return { ok: false, call: "unreadable" };
    const base = call.split("-")[0];
    // a bare entry covers every SSID; an entry with one must match exactly
    const ok = list.some((e) => (e.includes("-") ? e === call : e === base));
    return { ok, call };
  }
  function refresh() {
    $("kissToggle").textContent = running ? "Stop server" : "Start server";
    $("kissToggle").classList.toggle("on", running);
    // Spell out the transmit policy: "any callsign" is a real exposure and the
    // operator should be able to see it without opening a config file.
    let policy = "";
    if ($("kissTx").checked) {
      const list = allowList();
      policy = " — TX as " + (allowsAny(list) ? "ANY callsign" : list.join(", "));
    }
    line(running
      ? "listening on " + ($("kissBind").checked ? "0.0.0.0" : "127.0.0.1") + ":" +
        $("kissPort").value + " — " + clients + " client" + (clients === 1 ? "" : "s") + policy
      : "off");
  }
  function save() {
    localStorage.setItem(KISS_KEY, JSON.stringify({
      port: parseInt($("kissPort").value, 10) || 8001,
      lan: $("kissBind").checked,
      tx: $("kissTx").checked,
      allow: $("kissAllow").value || ""
    }));
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KISS_KEY)) || {};
      if (s.port) $("kissPort").value = s.port;
      $("kissBind").checked = !!s.lan;
      $("kissTx").checked = !!s.tx;
      if (typeof s.allow === "string") $("kissAllow").value = s.allow;
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
    const who = txAllowed(frame);
    if (!who.ok) {
      addLog("drop", "✗ KISS TX blocked: " + who.call + " is not in the allow list");
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
    if (typeof cfg.kiss_allow === "string") $("kissAllow").value = cfg.kiss_allow;
    refresh();
    if (cfg.kiss_autostart && !running) await start();
  }

  async function init() {
    load(); refresh();
    $("kissToggle").addEventListener("click", () => (running ? stop() : start()));
    $("kissPort").addEventListener("change", save);
    $("kissBind").addEventListener("change", save);
    $("kissTx").addEventListener("change", () => { save(); refresh(); });
    $("kissAllow").addEventListener("change", () => { save(); refresh(); });

    await listen("kiss-frame", (e) => onClientFrame(e.payload.data));
    await listen("kiss-count", (e) => { clients = e.payload; refresh(); });
  }

  return { init, onRadioFrame, applyConfig };
})();

window.addEventListener("DOMContentLoaded", () => { KISS.init(); });
