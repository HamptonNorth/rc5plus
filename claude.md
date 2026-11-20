<!--
  File:    CLAUDE.md
  Version: 1.8.0
  Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
  Purpose: Handover context for Claude Code (Zed agent panel / CLI)
-->

# CLAUDE.md — rc5plus-app

## What this is

A Bun web app (no dependencies) for one device only: the **Elitech RC-5+** USB temperature logger (VID `04d8`, PID `3005`). It runs on Linux and talks to the logger directly through `/dev/hidrawN`, with no ElitechLog, Windows VM or Python. The UI binds to `127.0.0.1:3005`.

Features:
1. Detect the logger and show its serial number and status
2. Reset for a new trip: set interval (1–15 min), description, trip number + clock, erase records, verify. On this firmware a settings change can't be made without erasing, so this is one action (user's decision, 2026-11-18)
3. View and download the PDF from the logger's USB mass-storage drive
4. Export all records to CSV (sent to the browser, with a copy saved in `exports/`)

## Status

- v1.8.0. Confirmed to run on the developer's Linux PC. Test logger: RC-5+, firmware `0x57` (V5.7), protocol `0x38`.
- 313 tests pass (`bun test`). The protocol is checked byte for byte against vectors generated from python-elitech.
- Hardware verification checklist (README "First run on a real logger"):
  - [x] Serial number and record count match the logger and the PDF (2026-11-18)
  - [x] CSV rows match the logger's own CSV report exactly (2026-11-18, 4 rows)
  - [x] Reset: write interval + configuration time → Format → 0 records, interval and clock as written, state `0x04` (2026-11-18, via `/api/reset`)
  - [ ] Starting a trip after a reset and reading the new records (not yet done)
  - [x] RC-5+ TE (2026-11-19): the two-field reset erased nearly every other setting (Format stored a buffer that only held our two writes); state then read `0xC4`. Fixed by writing every settings block before Format (v1.5.0)
  - [x] `bun run restore --write` on the RC-5+ TE (2026-11-19) from logger 1's dump: every byte stuck except `0x86..0x87`, which turned out to be the live temperature reading (tenths), now logger-owned
  - [x] Full-block reset via the app on the RC-5+ TE (2026-11-19)
  - [x] Full-block reset via the app on the plain RC-5+ (logger 1, 2026-11-19): main-space diff against the `-before-reset` dump showed only state, stop mode, configuration time, record count, clock and live temperature
  - [ ] Description (`0x98`) and trip number (`0x10`) set through the Reset card on hardware, and shown on the logger's own PDF/CSV (not yet done)
  - [ ] Shadow `0x90`/`0x98`/`0xA0` (2 bytes each) look like trip temperature statistics in tenths (`0x00F7` 24.7, `0x00DE` 22.2, `0x00E0` 22.4 after a 16-record trip; `0x0FA0` = unset after a reset). Unconfirmed: which is max/min/mean
  - [x] TE sensor setting: restored with `0x21 = 0x00` (copied from logger 1); readings follow the external probe (2026-11-19). So `0x21` bit 1 doesn't select the TE's probe; `0x1E = 02` (kept from the TE) probably marks the model

## Commands

```bash
bun start            # real hardware, http://127.0.0.1:3005
bun run dev          # --watch
bun run mock         # RC5_MOCK=1, simulated logger, no hardware needed
bun test             # protocol vectors + simulator tests
bun run vectors      # regenerate test/vectors.json (needs ../python-elitech clone)
bun run build        # single executable dist/rc5plus-app (build:arm64 for ARM)
bun run dump         # read-only diagnostic snapshot (--save --shadow --records[=N] --redact --watch[=S] --diff A B)
```

Env: `PORT` (3005), `HOST` (127.0.0.1), `RC5_MOCK=1`, `RC5_MOCK_STATE=recording|ready`, `RC5_DATA_DIR` (exports/ and dumps/; default repo root from source, `~/.local/share/rc5plus-app` compiled).

udev: `60-elitech-rc5plus.rules` → `/etc/udev/rules.d/`, using `TAG+="uaccess"`. Without it, opening the device fails with an EACCES error and the API returns 403.

## Layout

```
src/
  server.js                 CLI options, env, Bun.serve() with app.js
  app.js                    createApp(): Bun.serve routes (API + embedded UI), 404/405 fallback, errorResponse()
  elitech/
    constants.js            VID/PID, report size, op codes, limits
    frame.js                buildFrame / parseResponse (strict validation)
    parameters.js           memory map subset, decodeInfo, encoders
    records.js              8-byte packed record decoder (BigInt)
    hidraw.js               sysfs discovery + non-blocking /dev/hidraw I/O
    rc5plus.js              readInfo / resetForNewTrip / readSettingsBytes / applySettings / readRecords
    mock-device.js          simulated RC-5+ (tests + RC5_MOCK) and fake PDF drive
  lib/
    logger-service.js       driver selection, one-HID-session-at-a-time queue
    usb-drive.js            sysfs → /dev/sdX → /proc/self/mounts → udisksctl mount
    csv.js                  RFC 4180 CSV, file naming
    device-lock.js          cross-process lock file for the hidraw node (server + dump)
    dump.js                 read-only snapshot, field table, redaction, diff, text output
    paths.js                data directory (repo root / XDG for the binary / RC5_DATA_DIR)
    static-assets.js        public/ files imported `with { type: "file" }` so --compile embeds them
scripts/
  dump.js                   `bun run dump` CLI (read-only; takes the device lock)
  restore.js                `bun run restore` CLI: settings from a saved dump; dry run unless --write
public/                     index.html, app.js (vanilla JS), styles.css
test/
  gen_vectors.py            builds vectors.json from python-elitech (stubs hid_parser)
  vectors.json              reference vectors — do not hand-edit
  protocol.test.js          JS port vs python-elitech
  rc5plus.test.js           high-level ops + CSV against the simulator
  dump.test.js              read-only guard, dump, redaction, diff, device lock
  paths.test.js             data directory choice, embedded UI file list
  server.test.js            HTTP layer on a real Bun.serve (port 0) against the simulator; error mapping
60-elitech-rc5plus.rules    udev rule
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | sysfs scan only, no USB traffic. The UI polls it every 2.5 s |
| GET | `/api/info` | 3 GetParameter frames, plus 1 shadow read (op `0x0005`, `0x00..0x18`) when protocol ≥ `0x30`. Adds `tripStartTime`, `firstRecordTime`, `lastRecordTime`, `shadowRead` |
| POST | `/api/reset` | `{ minutes: 1..15, confirm: true, description?, tripNumber? }`. Sets interval + clock (+ description, trip number; omitted = keep), erases records |
| GET | `/api/export.csv` | headers `X-Record-Count`, `X-Saved-As` |
| GET | `/api/pdfs` | `{ mountPoint, files[], reason? }` |
| GET | `/api/pdfs/:name` | `?download=1` for attachment. The name must be in the listing (prevents path traversal) |

Error mapping in `app.js` (`errorResponse`): NotConnected → 404, DeviceBusy → 423 (`BUSY`, another program holds the device lock), NotStopped → 409 (`NOT_STOPPED`), NotApplied → 502 (`NOT_APPLIED`), RangeError → 400, Transport EACCES → 403, other Transport errors → 503, FrameError → 502.

## Protocol (from python-elitech)

- HID reports are 64 bytes in and 64 out, unnumbered. Write the frame directly, zero-padded. Its first byte is `0x33` (non-zero), so the kernel sends all 64 bytes.
- Frame layout: `33 CC 00 len opLo opHi 00 off[15:8] off[7:0] off[23:16] count payload… sum&0xFF`. `len` includes the checksum byte. Maximum payload is 52 bytes.
- Op codes: GetRecord `0x0001`, GetParameter `0x0003`, SetParameter `0x0004`, GetParameterShadow `0x0005` (dump only), Format `0x02C0`, Stop `0x03C0`. The answer echoes only the low byte at index 4.
- Shadow space (op `0x0005`, from python-elitech PR #14): answers on the RC-5+ (2026-11-18). Tentative layout from one dump: `0x01` start time, `0x08` first record time, `0x12` last record time (7-byte dates; the main space's `0x30`/`0x38` only hold the 2012 placeholder), `0x84` record count (word; PR #14 says `0x85` on an RC-5), `0x8B..0x8E` a counter that goes up once a second. Main space `0xFD` holds the "Mode Code" (`TLC30A08B`).
- A 1-byte GetParameter is widened to `(offset-1, 2)`. Keep this so the requests stay identical to the tested library.
- SetParameter answer: count = 1, payload byte `1` = "accepted". **On protocol `0x38` this doesn't mean the value was kept.** Writes are held until a Format follows; the Format commits them and also erases all records. A Format on its own, or before the writes, changes nothing. Confirmed on hardware 2026-11-18; matches python-elitech issue #1 (RC-5+ V5.2, protocol `0x38`). Unconfirmed: whether pending writes survive an unplug.
- Stop/Format: payload is a single `0x00`. The answer is only header-checked (python-elitech doesn't interpret it). Format timeout is 10 s.
- Parameter memory is big-endian. Key offsets:
  - `0x02` serial number (12 bytes, ASCII)
  - `0x1F` firmware version
  - `0x21` bit 3: °F
  - `0x24` time zone (12-byte block: hours in byte 0, minutes in byte 11)
  - `0x27` battery level (low nibble)
  - `0x25` run state (see Gotchas), `0x26` bits 0..2 how it stopped
  - `0x28` configuration time (writing it, then Format, sets the clock; the clock reads the old value for up to ~3 s)
  - `0x30` start time, `0x38` stop time
  - `0x42` capacity (dword)
  - `0x48` record count (word)
  - `0x4C` interval (word, units of 10 s)
  - `0x88` device time
  - `0x95` protocol version
- Date/times are 7 bytes `[yy, mm, dow, dd, hh, mi, ss]` (dow 0 = Sunday, ignored on read), local wall-clock time with no zone. We write the real day of the week, as the official software does.
- Records are 8-byte little-endian 64-bit words, read 6 per frame:
  - bits 63..54 humidity, 53..48 minute, 47..37 temperature (tenths, magnitude), 36..32 hour, 31..27 day, 26..23 month, 22..16 year−2000, 15..10 second
  - bit 9 is temperature bit 10 when protocol ≥ `0x23`
  - bits 7..0 are flags: Mark 0x01, Pause 0x02, Stop 0x04, Sign1 0x08 (negative temperature), Error 0x80
  - All `0xFF` means an empty slot.

## Design decisions (keep unless told otherwise)

- **No native addons.** hidraw is opened `O_RDWR | O_NONBLOCK` and polled every 5 ms with a deadline, so the event loop never blocks. `drain()` runs before each write to drop stale reports. Don't swap in `node-hid`.
- **One HID session at a time.** `LoggerService.withLogger()` chains every operation on a promise queue, and opens and closes the fd per session so replugging needs no restart.
- **Strict response validation.** Throw on any mismatch of header, op, offset, count or checksum (python-elitech only warns).
- **Write every settings block, then Format** (user's decision, 2026-11-19). Reset reads `0x000`–`0x154`, patches interval (`0x4C`), configuration time (`0x28`) and device time (`0x88`), writes the official software's blocks (`SETTINGS_WRITE_BLOCKS`: `0x00`/`0x30`/`0x60`/`0x98`/`0xCC`/`0xFD`/`0x13C`), Formats, and compares every byte except the logger-owned bits (`LOGGER_OWNED_BITS`). On a mismatch it writes all blocks once more (the official write → Format → write) and checks again. Writing only the changed fields erased an RC-5+ TE's settings on 2026-11-19; don't go back to it.
- **Back up before every write.** The server saves a full dump (`dumps/<serial>-<time>-before-reset.json`) through `onBackup` before resetting; `bun run restore` saves `-before-restore`. A backup failure aborts the reset.
- **Never reset a logger whose settings look erased** (`settingsErased`: start mode or time zone undecodable). `SettingsErasedError` → `409 SETTINGS_ERASED`. Use `bun run restore` from a good dump instead.
- **Text settings:** description max 64 printable ASCII characters (memory holds 100; keeping NUL padding and the report line in mind); trip number 1–12 of `A–Z a–z 0–9 - _`, because the logger puts it in its report file names (`<serial>-<trip>.pdf`). Validated in `encodeDescription`/`encodeTripNumber` before the logger is touched (`RangeError` → 400). The UI pre-fills both from the logger and has a "Next" button for the trip number.
- **One reset operation.** Since any settings change erases the records, `resetForNewTrip(minutes)` is the only write operation (`POST /api/reset`). There is no separate set-interval or clear.
- **Change settings only when stopped or ready.** `resetForNewTrip` calls `assertConfigurable()` first and throws `NotStoppedError` unless `runState` is `stopped` (`0x09`) or `ready` (`0x04`). Recording, start delay and unknown states are refused, not guessed. The user stops the logger with its own button. Reading is allowed in any state.
- **Never send USB Stop.** On real hardware a Stop (`0x03C0`) makes the logger drop off USB and re-enumerate about 1 s later. The next write then fails with `EPROTO`, so the rest of the session is lost.
- **Reset always verifies** every written settings byte, record count 0, state ready, and the clock within 10 s (polled for up to 10 s while it settles). Mismatch → `NotAppliedError`.
- **Device lock across processes.** Every HID session (server: `LoggerService.withLogger`, hardware only; `bun run dump`) takes `$XDG_RUNTIME_DIR/rc5plus.lock` (O_EXCL file holding PID, label and start time; a dead holder's lock is reclaimed). Server waits up to 20 s then answers 423; the dump waits up to 60 s; `--watch` skips a cycle after 2 s. Hold it per session, never for a whole watch.
- **The dump never writes.** `scripts/dump.js` sends everything through `ReadOnlyTransport`, which refuses any operation but GetParameter, GetParameterShadow and GetRecord. It never mounts the drive either. Dumps go to `dumps/` (gitignored, mode 0600) and may hold the PDF password; `--redact` for anything shared.
- **Localhost only.** There is no auth, so don't default to `0.0.0.0`.
- Plain JavaScript (ESM) with JSDoc, not TypeScript. Vanilla front end, no framework or build step.
- Linux only (`"os": ["linux"]`).
- **Compiled binary** (`bun run build`, v1.7.0): `bun build --compile`. Inside it `import.meta.dir` is `/$bunfs/root`, so nothing may locate files relative to the source tree: data paths come from `resolveDataDir()`, and the UI is served only from `STATIC_ASSETS` (a new file in `public/` must be added there; a test checks the list matches the folder). Bun's development mode is off in the binary. dump/restore are not included.

## Conventions

- Every file starts with a header block: `File`, `Version`, `Project`, purpose, and the licence line. Bump `Version` on every change.
- Files ported from python-elitech keep the "Derived from python-elitech … GPL-3.0-or-later" note.
- Comment thoroughly and prefer readable code over concise code.
- When proposing changes, give complete, copy-paste-ready files rather than fragments.
- Use GitHub-flavoured Markdown in docs.
- When giving commands, label the target host (for example "Run on Kubuntu-WS").
- British English in UI text, with `en-GB` number formatting.

## Licence

**GPL-3.0-or-later**, because the protocol is ported from python-elitech (© 2023 Pascal Combes). Any new protocol code keeps this licence.

## Gotchas

- After Clear, the host's cached view of the mass-storage FAT can be stale. The UI tells the user to replug.
- The PDF only appears or updates when recording stops. An empty drive is normal mid-trip.
- `allow-cycle` and the `csv` parameter bits don't work on the RC-5+ (per python-elitech). Don't build features on them.
- `deviceState` (0x25) isn't decoded in python-elitech master. Values: `0x04` configured/ready (seen after reset), `0x05` start delay (from python-elitech issue #1, not seen here), `0x07` recording (display "Rec"), `0x09` stopped (display "Stop"). While plugged in the display always shows "USB", whatever the state, so the user must unplug the logger to stop it and to see its state. These are decoded as `runState` from bits 0..5; bits 6..7 are ignored (an RC-5+ TE read `0xC4` after a Format, and python-elitech PR #14 lists `0x44`/`0xC4`/`0xC7` for the RC-5). `deviceState` in the API is the raw byte. Add any new value to `DeviceState` in `parameters.js` once it has been confirmed on hardware.
- `0x26` bits 0..2 = how it stopped: `0` button, `3` paused for USB (still recording), `4` USB Stop command. The logger doesn't sample while connected to USB.
- The RC-5+ answers SetParameter "accepted" even when it doesn't keep the write (see Protocol). Always read back, after the Format.
- Record layout: python-elitech PR #13 says protocol ≥ `0x30` uses a new record layout. Not true for this RC-5+: the old layout decodes `0x38` records correctly (checked against the logger's own CSV).
- `0x86..0x87` is the current temperature in tenths (`0x0108` = 26.4 °C on logger 1, matching its record; `0x0000` on the TE with erased settings, `0x00FE` after the restore). Read-only in practice: the TE ignored a write there. Negative values not seen yet.
- Pressing stop on an already stopped logger leaves `0x25` at `0x09`. The display shows "pdf C" and the logger writes `<serial>-<trip>.csv` next to the PDF on its drive. That CSV has a trip summary (start/stop times, interval, stop mode) and the readings. The app's PDF panel lists only `*.pdf`.
- Starting a new trip with the button discards the previous records (14 → 4 seen during testing).
- Start time (`0x30`) and stop time (`0x38`) stayed at the 2012-01-01 01:01:01 placeholder on this firmware, even across a start/stop. `decodeInfo` treats that value as unset (null). The real trip times come from the shadow space (`ShadowParam` in `parameters.js`); the UI shows `tripStartTime` as "Recording started" and `lastRecordTime` as "Last reading" (not "stopped": it's the last record's time, which matched the logger's own stop time on the one trip checked).
- Shadow trip times after a reset: `0x01..0x07` all `00`, `0x08..0x0E` and `0x12..0x18` all `ff`, so they decode as null. Seen 2026-11-19. Still to confirm on more trips: whether `0x01` (start) ever differs from `0x08` (first record), e.g. with a start delay.
- Two processes talking to the hidraw node at once get each other's answers (`Answer offset … does not match`). The device lock prevents this for the server and the dump; any new tool that opens the device must take it too.
- Mapping unknown bytes: `bun run dump --save`, change one thing on the logger, `bun run dump --save` again, then `bun run dump --diff A B`. Or `bun run dump --watch --shadow` while pressing buttons.
- `RC5_MOCK_STATE=recording` (or `ready`) starts the simulator in that state, to try out the state checks. The simulator holds writes until a Format, like the hardware.
- References: python-elitech issue #1 (RC-5+ writes ignored), PRs #12–#14 by honx (full config write, reset sequence, `doc/RC-5.md` protocol notes from the official software).
- Interval changes take effect from the next recording start.
- No HTTP framework (Hono removed in v1.8.0, user's decision 2026-11-20): Bun.serve's built-in `routes` (Bun ≥ 1.2.3). `req.params` arrive URL-decoded; a method missing from a route's `{ GET, POST }` object falls through to `fetch`, which answers 405 with `Allow`; errors thrown in a handler go to `error` → `errorResponse()`. Keep it dependency-free unless told otherwise.

## Possible next steps

- Show a chart of readings in the UI (data is already available from `readRecords`)
- Start mode / start delay controls (`0x20` bits 0..2, `0x40`)
- Alarm thresholds (offsets not yet mapped in `parameters.js`; see the upstream table)
- Optional SQLite archive of exports per serial number (`bun:sqlite`, built in)
