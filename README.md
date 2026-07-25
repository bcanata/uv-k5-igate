# UV-K5 iGate

Turn a Quansheng UV-K5 running the
[TA1JS APRS firmware](https://github.com/bcanata/uv-k5-firmware-ta1js) into a
receive-only APRS iGate, a Hamlib-controllable rig and a KISS TNC — by plugging
it into USB. Runs on macOS and Windows.

Built with [Tauri 2](https://tauri.app): a small native app, no Electron. The
Rust side is only byte pipes (serial port, TCP client, two TCP servers); all
protocol logic is plain JavaScript with no bundler and no npm dependencies.

## What it does

**iGate.** Forwards packets the radio decodes to APRS-IS with a `qAO` path,
applying the usual gating rules — drops `TCPIP`/`TCPXX`/`NOGATE`/`RFONLY`
paths, third-party frames and queries, and de-duplicates over 30 seconds. It
beacons its own position too, so the gate appears on aprs.fi as a station
rather than only as a via on someone else's packet; the position is read
straight from the radio's own `Loc` setting.

**Rig control (Hamlib).** A rigctld-compatible server on `127.0.0.1:4532`.
Any Hamlib app connects as rig model 2:

```
rigctl -m 2 -r 127.0.0.1:4532
```

Frequency, mode, PTT, VFO, S-meter and RF power. Setting the frequency types
the digits on the radio's keypad and verifies the readback, so a QSY takes
about a second. PTT is behind an explicit checkbox.

**KISS TNC.** A KISS-over-TCP server (default `127.0.0.1:8001`) so Xastir,
YAAC, APRSIS32 or [APRSSwift](https://github.com/bcanata/APRSSwift) can use the
radio as their modem. Receive works out of the box; letting clients transmit is
opt-in.

**Unattended.** Reconnects to the radio when the USB adapter disappears,
reconnects to APRS-IS with backoff, keeps running with its window closed
(tray icon), and carries counters, uptime and the packet log across restarts.

## Requirements

- A UV-K5/K6/5R running the TA1JS APRS firmware, menu **APRS = ON**, tuned to
  your region's APRS frequency (144.800 MHz in most of Europe). The app tells
  you if listening is off, and switches it on for you.
- The K5 programming cable.
- **macOS:** Apple's built-in CH34x driver is broken on recent releases, so
  install WCH's once: `brew install --cask wch-ch34x-usb-serial-driver`,
  approve it in System Settings, replug. The port then appears as
  `/dev/cu.wchusbserial*`.
- **Windows:** the CH340 driver usually installs itself.

## Installing

Grab the `.dmg` (macOS) or `.msi` (Windows) from
[Releases](https://github.com/bcanata/uv-k5-igate/releases).

Both are **unsigned**, because code-signing certificates cost money this
project does not have:

- **macOS** will refuse it on first launch. Right-click the app → **Open** →
  Open. Once only.
- **Windows** SmartScreen shows "Windows protected your PC" → **More info** →
  **Run anyway**.

The macOS build is Apple Silicon only.

## Running it as a station

Configuration lives in `config.json` under the app data directory
(`~/Library/Application Support/dev.canata.uvk5igate/` on macOS). Environment
variables override it, which is handy from a terminal:

```
UVK5_IGATE_CALL=TA1JS-10 UVK5_IGATE_AUTOSTART=1 \
UVK5_IGATE_PORT=/dev/cu.wchusbserial1130 \
"UV-K5 iGate.app/Contents/MacOS/uv-k5-igate"
```

Note that an app launched from Finder or a login item never sees a shell
profile, so for a permanent station put the settings in `config.json` and set
`autostart` there. Passing `--autostart` also starts it hidden in the tray.

## Known limits

- **Transmitting is not Bell 202.** This radio's modem produces FFSK
  1200/1800 Hz, not 1200/2200. Software modems (Dire Wolf, APRSDroid, other
  UV-K5s) decode it; a hardware TNC such as a Kenwood TH-D75 does not. That
  affects KISS transmit, not receive.
- **Frames over 78 bytes do not decode**, a limit in the firmware's receive
  buffer, so long weather and telemetry packets are neither gated nor passed
  to KISS clients.
- **Receive-only gating.** Nothing is gated from the internet back to RF.

## Development

```bash
npx @tauri-apps/cli@^2 dev      # run with hot frontend reload
npx @tauri-apps/cli@^2 build    # installer for the current OS
cd src-tauri && cargo test      # KISS codec tests
```

```
src/            frontend, all protocol logic, no build step
  k5proto.js    K5 envelope, AX.25 -> TNC2, gating rules, passcode, position
  main.js       serial session, APRS-IS session, beacon, UI
  rigctl.js     Hamlib rigctld protocol
  kiss.js       KISS command layer
src-tauri/      Rust: serial + TCP pipes, rigctl and KISS listeners, config,
                persisted stats and log, tray
```

If a macOS `.dmg` build fails, a previous run probably left its read-write
image mounted: `hdiutil detach /Volumes/dmg.*` and delete
`src-tauri/target/release/bundle/macos/rw.*.dmg`.

## Licence

Apache-2.0.
