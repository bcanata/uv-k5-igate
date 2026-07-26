// Host-side test for the KISS transmit allow list.
//
// Extracts allowList/allowsAny/sourceCall/txAllowed VERBATIM out of src/kiss.js
// rather than restating them, so the test cannot drift away from what ships.
//   node test/kiss_allow_test.js
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "kiss.js"), "utf8");
const start = src.indexOf("function allowList()");
const end = src.indexOf("\n  }", src.indexOf("function txAllowed(frame)")) + 4;
if (start < 0 || end < 4) {
  console.error("could not find the allow-list block in src/kiss.js — did it move?");
  process.exit(1);
}
const block = src.slice(start, end);

// the only DOM the extracted code touches is $("kissAllow").value
let allowValue = "";
const $ = (id) => {
  if (id !== "kissAllow") throw new Error("unexpected element " + id);
  return { value: allowValue };
};
const factory = new Function("$", block + "\n return { allowList, allowsAny, sourceCall, txAllowed };");
const K = factory($);

function addr(call, ssid, last) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const c = i < call.length ? call[i] : " ";
    out.push(c.charCodeAt(0) << 1);
  }
  out.push(0x60 | ((ssid & 0x0F) << 1) | (last ? 1 : 0));
  return out;
}
function frameFrom(call, ssid) {
  return new Uint8Array([
    ...addr("APOVK5", 0, false),
    ...addr(call, ssid, false),
    ...addr("WIDE1", 1, false),
    ...addr("WIDE2", 1, true),
    0x03, 0xF0,
    ...Array.from(Buffer.from("!4059.60N/02735.98E>t")),
  ]);
}

let fail = 0, run = 0;
function check(desc, cond) {
  run++;
  if (!cond) { fail++; console.log("  FAIL: " + desc); }
}
function expect(allow, call, ssid, wantOk, wantCall) {
  allowValue = allow;
  const r = K.txAllowed(frameFrom(call, ssid));
  const label = `allow=${JSON.stringify(allow)} src=${call}${ssid ? "-" + ssid : ""}`;
  check(`${label} -> ok=${wantOk} (got ${r.ok})`, r.ok === wantOk);
  if (wantCall !== undefined) check(`${label} -> call=${wantCall} (got ${r.call})`, r.call === wantCall);
}

// --- source parsing -------------------------------------------------------
allowValue = "";
check("source of TA1JS-7 parses", K.sourceCall(frameFrom("TA1JS", 7)) === "TA1JS-7");
check("SSID 0 has no suffix", K.sourceCall(frameFrom("TA1JS", 0)) === "TA1JS");
check("SSID 10 renders as -10", K.sourceCall(frameFrom("TA1JS", 10)) === "TA1JS-10");
check("SSID 15 renders as -15", K.sourceCall(frameFrom("TB1AAW", 15)) === "TB1AAW-15");
check("short frame -> null", K.sourceCall(new Uint8Array(13)) === null);
check("non-callsign field -> null", K.sourceCall(new Uint8Array(20)) === null);

// --- allow-any modes ------------------------------------------------------
expect("", "TA1JS", 0, true);
expect("", "ZZ9ZZZ", 15, true);
expect("*", "ZZ9ZZZ", 15, true);
expect("   ", "ZZ9ZZZ", 0, true);          // whitespace only is still empty
expect("TA1JS, *", "ZZ9ZZZ", 0, true);     // an explicit * anywhere opens it

// --- bare callsign covers every SSID -------------------------------------
expect("TA1JS", "TA1JS", 0, true, "TA1JS");
expect("TA1JS", "TA1JS", 7, true, "TA1JS-7");
expect("TA1JS", "TA1JS", 10, true, "TA1JS-10");
expect("TA1JS", "TB1AAW", 0, false, "TB1AAW");

// --- an entry with an SSID is exact --------------------------------------
expect("TA1JS-7", "TA1JS", 7, true, "TA1JS-7");
expect("TA1JS-7", "TA1JS", 0, false, "TA1JS");
expect("TA1JS-7", "TA1JS", 10, false, "TA1JS-10");
expect("TA1JS-1", "TA1JS", 10, false, "TA1JS-10");   // -1 must not prefix-match -10

// --- multiple entries, separators, case ---------------------------------
expect("TA1JS, TB1AAW-7", "TA1JS", 3, true);
expect("TA1JS, TB1AAW-7", "TB1AAW", 7, true);
expect("TA1JS, TB1AAW-7", "TB1AAW", 8, false);
expect("ta1js", "TA1JS", 0, true);                   // field is case-insensitive
expect("TA1JS;TB1AAW\tYM3KZD", "YM3KZD", 0, true);   // ; and tab separate

// --- fail closed ---------------------------------------------------------
allowValue = "TA1JS";
let r = K.txAllowed(new Uint8Array(13));
check("short frame blocked when a list is set", r.ok === false && r.call === "unreadable");
r = K.txAllowed(new Uint8Array(20));
check("unparseable source blocked when a list is set", r.ok === false && r.call === "unreadable");
allowValue = "";
r = K.txAllowed(new Uint8Array(13));
check("short frame still passes when allowing any", r.ok === true);

console.log(fail === 0
  ? `ALL KISS ALLOW-LIST CHECKS PASSED (${run} assertions)`
  : `${fail} of ${run} assertions FAILED`);
process.exit(fail === 0 ? 0 : 1);
