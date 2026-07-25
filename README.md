# UV-K5 iGate

Desktop companion for the [TA1JS UV-K5 APRS firmware](https://github.com/bcanata/uv-k5-firmware-ta1js):
plug the radio into USB and turn it into a receive-only APRS iGate, with a live
packet monitor and beacon/message control.

Built with [Tauri 2](https://tauri.app) — small native app for macOS and Windows
(Linux builds for free). All radio protocol logic is plain JavaScript shared in
spirit with the [web tools](https://github.com/bcanata/uv-k5-aprs-beacon); the
Rust side is only a serial-port and TCP byte pipe.

## Status

**Working iGate.** Port picker, connect + firmware handshake, live monitor
decoding `APRSRAW:` frames to TNC2 lines, beacon-now button, and the APRS-IS
session: passcode login, receive-only gating with `,qAO,CALL`, drop rules
(TCPIP/TCPXX/NOGATE/RFONLY paths, third-party `}` frames, `?` queries), a 30 s
duplicate window, auto-reconnect with backoff, and 15-min keepalives.

**Rig control (Hamlib).** The app runs a rigctld-compatible server
(localhost-only, default port 4532). Any Hamlib-aware program connects as rig
model 2 (`rigctl -m 2 -r 127.0.0.1:4532`): get/set frequency (set types the
keypad, verified with a readback + one retry), get/set mode (FM/AM/USB,
wide/narrow), get/set PTT (behind an explicit "Allow PTT" checkbox), VFO A/B,
signal strength (STRENGTH/RAWSTR), RF power. Verified against Hamlib 4.7.2 on
the air, including keypad-injected QSY round trips.

Roadmap: chat/messaging tab, KISS-over-TCP server (radio as a standard TNC for
Xastir/YAAC/APRSIS32), CI-built installers. Later, once the firmware grows a
raw-TX UART command: digipeater mode.

## Requirements

- UV-K5/K6/5R running the TA1JS APRS firmware, menu **APRS = ON**, tuned to
  your region's APRS frequency (144.800 MHz in Europe).
- The K5 programming cable.
- **macOS:** Apple's built-in CH34x serial driver is broken on recent macOS —
  install the WCH driver once: `brew install --cask wch-ch34x-usb-serial-driver`
  (approve it in System Settings, replug). The port then shows up as
  `/dev/cu.wchusbserial*`.
- **Windows:** the CH340 driver usually installs itself; otherwise get it from
  the WCH site.

## Development

```bash
# prerequisites: Rust (rustup.rs) + Node
npx @tauri-apps/cli@^2 dev     # run with hot frontend reload
npx @tauri-apps/cli@^2 build   # produce the installer for this OS
```

The frontend (`src/`) is plain HTML/CSS/JS — no bundler, no npm dependencies.

## Architecture

```
src/            frontend (all protocol logic)
  k5proto.js    AB CD..DC BA envelope, K5 commands, AX.25 raw-frame -> TNC2,
                APRS-IS passcode
  main.js       serial session, line extraction, UI
src-tauri/      Rust: serial + TCP byte pipes as Tauri commands/events
```

Serial events: `serial-data` (bytes), `serial-closed`. TCP events: `tcp-line`,
`tcp-closed`. Commands: `list_ports`, `serial_open/close/write`,
`tcp_connect/send/disconnect`.
