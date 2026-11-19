<!--
  File:    README.md
  Version: 1.4.0
  Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
-->

# rc5plus-app

A Bun + Hono web app for the **Elitech RC-5+** USB temperature logger on Linux. No ElitechLog, Windows VM or Python needed.

- Detects a connected RC-5+ and shows its serial number and status
- Resets the logger for a new trip: sets the logging interval (1–15 minutes) and the clock, and erases the stored readings. The RC-5+ only accepts new settings together with an erase, so these are one action.
- Lets you view and download the PDF report from the logger's USB drive
- Exports every reading to CSV

The HID protocol is a JavaScript port of [python-elitech](https://github.com/pasccom/python-elitech) by Pascal Combes, which was reverse-engineered from the official software and tested on an RC-5+. Because it is a derived work, this app is licensed **GPL-3.0-or-later**.

## Requirements

- Linux. The app uses `/dev/hidraw*` and `/sys`.
- Bun 1.1 or newer
- `udisks2` (`udisksctl`), which is standard on Kubuntu/KDE. It's only used to mount the PDF drive if the desktop hasn't already mounted it.

## Install

Run these on the Linux PC the logger plugs into:

```bash
cd rc5plus-app
bun install

# Allow your desktop user to talk to the logger without sudo
sudo cp 60-elitech-rc5plus.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# Unplug and replug the logger
```

Check that the rule applied:

```bash
lsusb | grep 04d8:3005          # the RC-5+
ls -l /dev/hidraw*              # one node should show a "+" (ACL) for your user
```

## Run

```bash
bun start                 # http://127.0.0.1:3005
```

| Command | Purpose |
|---|---|
| `bun start` | Run against real hardware |
| `bun run dev` | Same, restarting on file changes |
| `bun run mock` | Run against a built-in simulated RC-5+ (no hardware needed) |
| `bun test` | Run the protocol and simulator tests |

Environment variables: `PORT` (default `3005`), `HOST` (default `127.0.0.1`), `RC5_MOCK=1` (simulator).

The API controls hardware and has no authentication, so it binds to localhost only. Don't set `HOST=0.0.0.0` on an untrusted network.

## First run on a real logger

The protocol port matches python-elitech byte for byte. It has been checked on one RC-5+ (firmware V5.7, protocol `0x38`); go through these checks in order the first time on another logger:

**Stop the logger first.** The app only changes settings on a logger that has been stopped with its own stop button: unplug it, press and hold stop until the display shows "Stop", then plug it back in. While plugged in the display always shows "USB", so check the **State** row in the app instead. While the logger is recording, **Reset logger…** is disabled and the API answers `409 NOT_STOPPED`. Reading, CSV export and PDFs work in any state.

1. **Read only.** Plug in the logger and open the page. Check that the serial number matches the label on the logger, and that the record count and interval match what ElitechLog or the PDF shows.
2. **Export.** Click **Download CSV**. Compare a few rows with the PDF.
3. **Reset**, only after steps 1–2 look right and you've exported anything you need. Pick the interval and click **Reset logger…**. The app checks the logger is stopped, writes the interval and the configuration time, then sends *Format*, which commits them, erases the readings and sets the clock. It then checks 0 records, the interval, the configuration time and the clock. The **State** row should then read "Ready, not started".

If anything misbehaves, the app reports the logger's error. ElitechLog in a Windows VM can still reset the logger.

## How it works

```
Browser ──HTTP──▶ Hono (src/server.js)
                    │
                    ├─ LoggerService ── one HID session at a time
                    │     └─ Rc5Plus ── readInfo / resetForNewTrip / readRecords
                    │           └─ HidrawTransport ── /dev/hidrawN, 64-byte reports, non-blocking
                    │
                    └─ usb-drive.js ── sysfs → /dev/sdX → mount point → *.pdf
```

- **Detection** scans `/sys/class/hidraw` for VID `04d8` / PID `3005`, with no USB traffic. The page polls it every 2.5 s.
- **Frames**: `33 CC 00 <len> <op lo> <op hi> 00 <off 15..8> <off 7..0> <off 23..16> <count> <payload…> <sum & 0xFF>`, zero-padded to 64 bytes.
- **Records**: 8-byte little-endian packed words (time, temperature in tenths, flags), 6 per request.
- **Run state** is byte `0x25`: `0x04` ready (reset, not started), `0x05` start delay, `0x07` recording, `0x09` stopped. A reset is allowed only when stopped or ready; anything else is refused.
- **Settings** are committed by Format. The logger acknowledges a parameter write but keeps the old value until a Format follows, and Format erases the readings. Reset therefore writes the interval and configuration time, sends Format, then reads everything back.
- **Trip times** ("Recording started", "Last reading") come from the logger's second "shadow" memory space (read with operation `0x05`), because the RC-5+ never fills in the start/stop times in its main settings memory. This layout was worked out from one logger and is still being confirmed; if the shadow read fails, the rest of the info still loads.
- **Times** are the logger's local wall-clock time. Clear writes this PC's local time.

## API

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/status` | | `{ connected, devPath, mock }` |
| GET | `/api/info` | | Serial number, settings, record count, clock |
| POST | `/api/reset` | `{ "minutes": 1..15, "confirm": true }` | Info after reset (0 records), `409 NOT_STOPPED` or `502 NOT_APPLIED` |

Any request that talks to the logger answers `423 BUSY` if another program (such as `bun run dump`) holds the device lock for more than 20 s.
| GET | `/api/export.csv` | | CSV download (copy saved in `exports/`) |
| GET | `/api/pdfs` | | PDFs on the logger's drive |
| GET | `/api/pdfs/:name` | `?download=1` | The PDF, inline or as an attachment |

## Diagnostic dump

`bun run dump` prints a read-only snapshot of the connected logger: USB details, the files on its drive, a hex dump of its settings memory (`0x000`–`0x154`) with every known field decoded, and the unmapped bytes that hold data. Run it on the PC the logger is plugged into.

| Command | Does |
|---|---|
| `bun run dump` | Snapshot to the terminal |
| `bun run dump --save` | Also writes `dumps/<serial>-<time>.json` |
| `bun run dump --shadow` | Also reads the second "shadow" memory space (operation `0x05`), which holds the real trip start/stop times and record count |
| `bun run dump --records[=N]` | Also reads records with their raw bytes: all, or the first and last N |
| `bun run dump --redact` | Blanks the serial number, description, PDF password and device name, for sharing (e.g. in an upstream issue) |
| `bun run dump --watch[=SECONDS]` | Re-reads every few seconds (default 3) and prints only the bytes that change, labelled with field names. Handles unplug/replug |
| `bun run dump --diff A.json B.json` | Compares two saved dumps byte by byte |
| `bun run dump --device /dev/hidrawN` | Picks a logger when several are plugged in |
| `bun run dump --show-password` | Shows the PDF password, which is masked by default |

The dump **never writes to the logger**: it can only send read requests, and anything else is refused before it reaches the device. It doesn't mount the drive either. It shares a lock with the app, so the two never talk to the logger at the same time; if the app is busy, the dump waits.

Saved dumps are only readable by you and are kept out of git (`dumps/`). They contain the serial number and description, and the PDF password if one is set, so use `--redact` before sharing one.

## CSV format

```
index,timestamp,temperature_c,marked,event
1,2026-11-17 15:54:00,4.0,no,
```

`marked` is a reading tagged by double-clicking the logger's right key. `event` is `pause`, `stop` or `sensor error` when the logger flagged one. The column is `temperature_f` if the logger is set to Fahrenheit.

## Tests

`test/vectors.json` is generated from python-elitech itself, so the JavaScript port is checked against the reference implementation:

```bash
git clone https://github.com/pasccom/python-elitech ../python-elitech
bun run vectors
bun test

# Includes tests for the dump's read-only guard, redaction, diff and the device lock.
```

## Licence

GPL-3.0-or-later. See `LICENSE`. Protocol knowledge © 2023 Pascal Combes (python-elitech).
