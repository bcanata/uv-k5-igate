// rigctl.js — a rigctld-compatible server (Hamlib "NET rigctl", model 2).
// Any Hamlib-aware app connects with `rigctl -m 2 -r 127.0.0.1:<port>` and the
// commands are answered from the radio's ENABLE_UART_RC remote-control block:
// 0x0B02 get-state (live freq/mode/PTT/RSSI/battery), 0x0B01 key injection
// (PTT, frequency entry via keypad digits), 0x0B03/04/05 power/bandwidth/
// modulation setters. Frequency setting types digits on the keypad, so a QSY
// takes ~1 s; everything else is a single native command round-trip.
"use strict";

const RIG = (() => {
  const KEY = { MENU: 10, UP: 11, DOWN: 12, EXIT: 13, STAR: 14, F: 15, PTT: 16 };
  const MODES = ["FM", "AM", "USB"];
  const RIG_KEY = "igate.rig";

  let listening = false;
  let clients = 0;

  // netrigctl handshake blob (protocol 0). Shape follows SDR++'s known-good
  // minimal dump_state; ranges/masks adapted to the UV-K5 (modes 0x25 =
  // AM|USB|FM, level masks: get STRENGTH|RAWSTR|RFPOWER, set RFPOWER).
  const DUMP =
    "0\n2\n2\n" +
    "18000000.000000 620000000.000000 0x25 -1 -1 0x3 0x0\n" +
    "0 0 0 0 0 0 0\n" +
    "136000000.000000 174000000.000000 0x25 1000 5000 0x3 0x0\n" +
    "400000000.000000 470000000.000000 0x25 1000 5000 0x3 0x0\n" +
    "0 0 0 0 0 0 0\n" +
    "0 0\n0 0\n" +
    "0\n0\n0\n0\n" +
    "\n\n" +
    "0x0\n0x0\n0x44001000\n0x1000\n0x0\n0x0\n";

  const LETTER = {
    F: "set_freq", f: "get_freq", M: "set_mode", m: "get_mode",
    T: "set_ptt", t: "get_ptt", V: "set_vfo", v: "get_vfo",
    L: "set_level", l: "get_level", S: "set_split_vfo", s: "get_split_vfo",
    _: "get_info", q: "quit", Q: "quit"
  };

  function rigLine(text, cls) {
    const el = $("rigStatus");
    el.textContent = "rigctl: " + text;
    el.className = "isline" + (cls ? " " + cls : "");
  }
  function refresh() {
    $("rigToggle").textContent = listening ? "Stop server" : "Start server";
    $("rigToggle").classList.toggle("on", listening);
    if (listening)
      rigLine("listening on 127.0.0.1:" + $("rigPort").value + " — " +
              clients + " client" + (clients === 1 ? "" : "s"), "ok");
    else rigLine("off");
  }

  async function start() {
    const port = parseInt($("rigPort").value, 10) || 4532;
    try {
      await inv("rigctl_start", { port });
      listening = true;
    } catch (e) {
      listening = false;
      rigLine("start failed: " + e, "err");
    }
    if (listening) refresh();
    save();
  }
  async function stop() {
    await inv("rigctl_stop");
    listening = false;
    refresh();
  }

  function save() {
    localStorage.setItem(RIG_KEY, JSON.stringify({
      port: parseInt($("rigPort").value, 10) || 4532,
      ptt: $("rigPtt").checked
    }));
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(RIG_KEY)) || {};
      if (s.port) $("rigPort").value = s.port;
      $("rigPtt").checked = !!s.ptt;
    } catch (e) {}
  }

  // ---- radio primitives (all through the serialized exchange queue) ----
  async function getState() {
    if (!connected) return null;
    const p = await exchange(K5P.frameCommand(0x0B02), 900);
    if (!p || (p[0] | (p[1] << 8)) !== 0x0B82 || p.length < 26) return null;
    const u16 = (o) => p[o] | (p[o + 1] << 8);
    const u32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
    return { txvfo: p[4], screen: p[5], func: p[6], tx: p[7],
             rx: u32(8), txf: u32(12), mod: p[16], bw: p[17],
             pwr: p[18], ch: p[19], sql: p[20], rssi: u16(22), batt: u16(24) };
  }
  async function key(code, down) {
    if (!connected) return false;
    const p = await exchange(K5P.frameCommand(0x0B01, new Uint8Array([code, down ? 1 : 0])), 900);
    return !!(p && (p[0] | (p[1] << 8)) === 0x0B81 && p[6] === 1);
  }
  async function press(code) { return (await key(code, true)) & (await key(code, false)); }
  async function setter(cmd, value) {
    const p = await exchange(K5P.frameCommand(cmd, new Uint8Array([value])), 900);
    return !!(p && (p[0] | (p[1] << 8)) === 0x0B81 && p[6] === 1);
  }

  // frequency entry: EXIT twice (leave any menu), then six keypad digits
  // "MMMkkk" — the firmware commits after the 6th. kHz resolution; on the
  // amateur-band image out-of-band input snaps to the nearest band edge.
  async function setFreq(hz) {
    const khz = Math.round(hz / 1000);
    const mhz = Math.floor(khz / 1000);
    if (mhz < 15 || mhz > 999) return "RPRT -1\n";
    const s = String(mhz).padStart(3, "0") + String(khz % 1000).padStart(3, "0");
    // a digit can rarely get lost to an input-state race on the radio
    // (seen once on air: "144800" landed as 18 MHz), so verify and retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      await press(KEY.EXIT);
      await press(KEY.EXIT);
      for (const c of s)
        if (!await press(c.charCodeAt(0) - 48)) return "RPRT -6\n";
      const r = await getState();
      if (r && Math.round(r.rx / 100) === khz) return "RPRT 0\n";  // rx is 10 Hz units
    }
    return "RPRT -6\n";
  }

  const vfoName = (r) => (r.txvfo ? "VFOB" : "VFOA");

  // ---- one rigctld command line -> reply text ----
  async function handle(line0) {
    let line = line0.trim();
    if (/^[+;|,#]/.test(line)) line = line.slice(1).trim();  // extended prefixes: answer plain
    const parts = line.split(/\s+/);
    let name = parts[0].replace(/^\\/, "");
    if (name.length === 1) name = LETTER[name] || name;
    const err = (n) => "RPRT " + n + "\n";

    if (name === "dump_state") return DUMP;
    if (name === "chk_vfo") return "CHKVFO 0\n";
    if (name === "get_powerstat") return "1\n";
    if (name === "set_powerstat") return "RPRT 0\n";
    if (name === "get_info") return "UV-K5 " + (fwVersion || "(radio not connected)") + "\n";
    if (name === "quit") return null;

    // everything below needs the radio
    const KNOWN = new Set(["get_freq", "set_freq", "get_mode", "set_mode",
      "get_ptt", "set_ptt", "get_vfo", "set_vfo", "get_split_vfo",
      "get_level", "set_level"]);
    if (!KNOWN.has(name)) return err(-11);
    if (!connected) return err(-6);

    if (name === "get_freq") {
      const r = await getState();
      return r ? (r.rx * 10) + "\n" : err(-5);
    }
    if (name === "set_freq") {
      const hz = parseFloat(parts[1]);
      if (!isFinite(hz) || hz <= 0) return err(-1);
      return await setFreq(hz);
    }
    if (name === "get_mode") {
      const r = await getState();
      return r ? MODES[r.mod] + "\n" + (r.bw ? 8000 : 15000) + "\n" : err(-5);
    }
    if (name === "set_mode") {
      if (parts[1] === "?") return MODES.join(" ") + "\n";
      const idx = MODES.indexOf(parts[1]);
      if (idx < 0) return err(-1);
      if (!await setter(0x0B05, idx)) return err(-6);
      const pb = parseFloat(parts[2] || "0");
      if (pb > 0 && !await setter(0x0B04, pb <= 10000 ? 1 : 0)) return err(-6);
      return "RPRT 0\n";
    }
    if (name === "get_ptt") {
      const r = await getState();
      return r ? (r.tx ? "1\n" : "0\n") : err(-5);
    }
    if (name === "set_ptt") {
      if (!$("rigPtt").checked) return err(-9);   // rejected: PTT not allowed in UI
      return (await key(KEY.PTT, parts[1] !== "0")) ? "RPRT 0\n" : err(-6);
    }
    if (name === "get_vfo") {
      const r = await getState();
      return r ? vfoName(r) + "\n" : err(-5);
    }
    if (name === "set_vfo") {
      const want = /B/i.test(parts[1] || "") ? 1 : 0;
      const r = await getState();
      if (!r) return err(-5);
      if (r.txvfo !== want) { await press(KEY.F); await press(2); }
      return "RPRT 0\n";
    }
    if (name === "get_split_vfo") {
      const r = await getState();
      return r ? "0\n" + vfoName(r) + "\n" : err(-5);
    }
    if (name === "get_level") {
      const r = await getState();
      if (!r) return err(-5);
      if (parts[1] === "STRENGTH") return Math.round(r.rssi / 2 - 160 + 93) + "\n";
      if (parts[1] === "RAWSTR")   return r.rssi + "\n";
      if (parts[1] === "RFPOWER")  return [0.33, 0.66, 1.0][r.pwr] + "\n";
      if (parts[1] === "SQL")      return (r.sql / 9).toFixed(2) + "\n";
      return err(-11);
    }
    if (name === "set_level") {
      if (parts[1] === "RFPOWER") {
        const v = parseFloat(parts[2]);
        if (!isFinite(v)) return err(-1);
        return (await setter(0x0B03, v <= 0.34 ? 0 : v <= 0.67 ? 1 : 2)) ? "RPRT 0\n" : err(-6);
      }
      return err(-11);
    }
    return err(-11);   // not available
  }

  async function init() {
    load();
    $("rigToggle").addEventListener("click", () => (listening ? stop() : start()));
    $("rigPort").addEventListener("change", save);
    $("rigPtt").addEventListener("change", save);

    await listen("rigctl-cmd", async (e) => {
      const { id, line } = e.payload;
      let out;
      try { out = await handle(line); }
      catch (err2) { out = "RPRT -7\n"; }
      if (out != null) inv("rigctl_reply", { id, text: out }).catch(() => {});
    });
    await listen("rigctl-count", (e) => { clients = e.payload; refresh(); });

    await start();   // server is harmless without a radio: localhost only
  }

  return { init, handle };   // handle exposed for offline tests
})();

window.addEventListener("DOMContentLoaded", () => { RIG.init(); });
