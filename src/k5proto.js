// k5proto.js — UV-K5 serial protocol + APRS helpers, no I/O in here.
// The envelope/command code is ported from the web repo's k5.js (itself from
// utils/aprs_pc.py / k5flash.py); the AX.25 raw-frame decoder and the APRS-IS
// passcode are new for the iGate.
"use strict";

var K5P = (function () {

  // ---- AB CD .. DC BA envelope (XOR + CRC-16/XMODEM) ----
  var XOR = [0x16,0x6C,0x14,0xE6,0x2E,0x91,0x0D,0x40,0x21,0x35,0xD5,0x40,0x13,0x03,0xE9,0x80];
  var TS  = [0x46,0x9C,0x6F,0x64];  // fixed session timestamp used by K5TOOL/libuvk5

  function crc16(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (var b = 0; b < 8; b++)
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  }
  function xorApply(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ XOR[i % 16];
    return out;
  }
  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  // frame a fully-formed payload (ID + size + body): AB CD | len | XOR(payload+crc) | DC BA
  function frameRaw(payload) {
    var crc = crc16(payload);
    var body = new Uint8Array(payload.length + 2);
    body.set(payload, 0);
    body[payload.length] = crc & 0xFF; body[payload.length + 1] = (crc >> 8) & 0xFF;
    var enc = xorApply(body);
    var out = new Uint8Array(4 + enc.length + 2);
    out[0] = 0xAB; out[1] = 0xCD; out[2] = payload.length & 0xFF; out[3] = (payload.length >> 8) & 0xFF;
    out.set(enc, 4);
    out[out.length - 2] = 0xDC; out[out.length - 1] = 0xBA;
    return out;
  }
  // build ID(2) + len(2) + data, then frame it (normal-mode command shape)
  function frameCommand(id, data) {
    data = data || new Uint8Array(0);
    var payload = new Uint8Array(4 + data.length);
    payload[0] = id & 0xFF; payload[1] = (id >> 8) & 0xFF;
    payload[2] = data.length & 0xFF; payload[3] = (data.length >> 8) & 0xFF;
    payload.set(data, 4);
    return frameRaw(payload);
  }
  // extract one framed reply from a buffer; returns {payload, rest} or null.
  // Reply CRC is a placeholder (0xFFFF) on the radio side, so it is not checked
  // — same as aprs_pc.py and the web installer.
  function extractFrame(buf) {
    for (var s = 0; s + 8 <= buf.length; s++) {
      if (buf[s] !== 0xAB || buf[s + 1] !== 0xCD) continue;
      var len = buf[s + 2] | (buf[s + 3] << 8);
      var total = 4 + (len + 2) + 2;
      if (len > 2048) continue;
      if (s + total > buf.length) return null;      // wait for more bytes
      if (buf[s + total - 2] !== 0xDC || buf[s + total - 1] !== 0xBA) continue;
      var dec = xorApply(buf.slice(s + 4, s + 4 + len + 2));
      return { payload: dec.slice(0, len), rest: buf.slice(s + total) };
    }
    return null;
  }

  // ---- normal-mode commands the iGate uses ----
  var CMD = {
    HELLO: 0x0514,      // -> 0x0515, version string at payload[4..]
    APRS_MSG: 0x0700,   // dest[10] + text[30] -> 0x0701
    APRS_BEACON: 0x0702 // -> 0x0703
  };

  function helloFrame() { return frameCommand(CMD.HELLO, new Uint8Array(TS)); }

  function msgFrame(dest, text) {
    var d = new Uint8Array(40);
    dest = (dest || "").toUpperCase();
    for (var i = 0; i < 10 && i < dest.length; i++) d[i] = dest.charCodeAt(i) & 0x7F;
    for (var j = 0; j < 30 && j < text.length; j++) d[10 + j] = text.charCodeAt(j) & 0x7F;
    return frameCommand(CMD.APRS_MSG, d);
  }

  function beaconFrame() { return frameCommand(CMD.APRS_BEACON, new Uint8Array(0)); }

  // ---- APRSRAW: <hex of full AX.25 frame, FCS stripped> -> TNC2 monitor line ----
  // Returns {src, dst, path:[{call,h}], info, tnc2} or null if not a UI frame.
  function decodeRaw(hex) {
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length % 2 || hex.length < 34) return null;
    var b = new Uint8Array(hex.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);

    var addrs = [], o = 0;
    for (;;) {
      if (o + 7 > b.length || addrs.length >= 10) return null;
      var call = "";
      for (var j = 0; j < 6; j++) {
        var c = (b[o + j] >> 1) & 0x7F;
        if (c > 32) call += String.fromCharCode(c);
      }
      var sb = b[o + 6];
      var ssid = (sb >> 1) & 0x0F;
      addrs.push({ call: call + (ssid ? "-" + ssid : ""), h: (sb & 0x80) !== 0 });
      o += 7;
      if (sb & 1) break;
    }
    if (addrs.length < 2 || o + 2 > b.length) return null;
    if (b[o] !== 0x03 || b[o + 1] !== 0xF0) return null;  // UI frame, no layer 3

    var info = "";
    for (var k = o + 2; k < b.length; k++) info += String.fromCharCode(b[k]); // latin-1

    // TNC2: SRC>DEST,PATH*:info — '*' marks the last digi with the H bit set
    var lastH = -1;
    for (var d = 2; d < addrs.length; d++) if (addrs[d].h) lastH = d;
    var s = addrs[1].call + ">" + addrs[0].call;
    for (var d2 = 2; d2 < addrs.length; d2++)
      s += "," + addrs[d2].call + (d2 === lastH ? "*" : "");

    return { src: addrs[1].call, dst: addrs[0].call, path: addrs.slice(2), info: info, tnc2: s + ":" + info };
  }

  // ---- iGate rules (RX -> APRS-IS), per the IGate spec + Dire Wolf practice ----
  // Returns a drop reason string, or null if the frame should be gated.
  function gateCheck(f) {
    if (!f || !f.info || !f.info.length) return "empty info";
    if (f.info[0] === "}") return "3rd-party";          // already gated once
    if (f.info[0] === "?") return "query";              // general queries stay on RF
    if (!/^[A-Z0-9]{1,6}(-[0-9]{1,2})?$/.test(f.src)) return "bad source call";
    for (var i = 0; i < f.path.length; i++) {
      var c = f.path[i].call.toUpperCase();
      if (c === "TCPIP" || c === "TCPXX" || c === "NOGATE" || c === "RFONLY")
        return "no-gate path";
    }
    return null;
  }
  // The TNC2 line injected into APRS-IS: heard path (with '*' on the last
  // used digi) + ",qAO,MYCALL" — qAO marks a receive-only iGate.
  function gateLine(f, mycall) {
    var lastH = -1;
    for (var i = 0; i < f.path.length; i++) if (f.path[i].h) lastH = i;
    var s = f.src + ">" + f.dst;
    for (var j = 0; j < f.path.length; j++)
      s += "," + f.path[j].call + (j === lastH ? "*" : "");
    return s + ",qAO," + mycall + ":" + f.info;
  }

  // ---- our own position, as APRS wants it -------------------------------
  // micro-degrees -> "DDMM.mm" / "DDDMM.mm" with the hemisphere letter, using
  // the same integer maths as the firmware's APRS_PosDigits so a beacon sent
  // from here lands on exactly the same spot as one sent by the radio.
  function fmtCoord(udeg, isLat) {
    const neg = udeg < 0;
    const v = Math.abs(udeg);
    const deg = Math.floor(v / 1000000);
    const min100 = Math.floor(((v % 1000000) * 6) / 1000);   // hundredths of a minute
    const dd = String(deg).padStart(isLat ? 2 : 3, "0");
    const mm = String(Math.floor(min100 / 100)).padStart(2, "0");
    const hh = String(min100 % 100).padStart(2, "0");
    return dd + mm + "." + hh + (isLat ? (neg ? "S" : "N") : (neg ? "W" : "E"));
  }

  // The TNC2 line an iGate injects to put itself on the map. Path is TCPIP*
  // because this never touches RF, and the symbol is the "I" overlay on "&",
  // which is what aprs.fi draws as a gateway rather than a plain station.
  function igateBeacon(call, latUdeg, lonUdeg, comment) {
    return call + ">" + "APZUVK,TCPIP*:!" +
           fmtCoord(latUdeg, true) + "I" + fmtCoord(lonUdeg, false) + "&" +
           (comment || "");
  }

  // ---- APRS-IS passcode (standard algorithm, callsign without SSID) ----
  function passcode(callsign) {
    var cs = (callsign || "").toUpperCase().split("-")[0];
    if (!cs) return "";
    var hash = 0x73E2;
    for (var i = 0; i < cs.length; i += 2) {
      hash ^= cs.charCodeAt(i) << 8;
      if (i + 1 < cs.length) hash ^= cs.charCodeAt(i + 1);
    }
    return hash & 0x7FFF;
  }

  return {
    TS: TS, CMD: CMD,
    crc16: crc16, xorApply: xorApply, concat: concat,
    frameRaw: frameRaw, frameCommand: frameCommand, extractFrame: extractFrame,
    helloFrame: helloFrame, msgFrame: msgFrame, beaconFrame: beaconFrame,
    decodeRaw: decodeRaw, passcode: passcode,
    gateCheck: gateCheck, gateLine: gateLine,
    fmtCoord: fmtCoord, igateBeacon: igateBeacon
  };
})();
