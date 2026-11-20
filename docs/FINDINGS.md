<!--
  File:    docs/FINDINGS.md
  Version: 1.0.0
  Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
  GPL-3.0-or-later. See LICENSE.
-->

# Elitech RC-5+ findings beyond python-elitech

This note lists what was learnt about the Elitech RC-5+ while building this app that is **not** in [python-elitech](https://github.com/pasccom/python-elitech)'s master branch. The protocol itself (frames, operation codes, memory map, record format) is Pascal Combes's work; see the README's Acknowledgements. Where an upstream issue or open pull request already pointed in the same direction, it is credited.

Everything here was observed between 2026-11-18 and 2026-11-19 on two loggers, both firmware `0x57` (V5.7) and protocol `0x38`, both model `0x3005`:

| Name used here | Model | Sensor |
|---|---|---|
| **Logger A** | RC-5+ | built-in |
| **Logger B** | RC-5+ TE | external probe |

Confidence:
- **Confirmed**: seen repeatedly, or checked against the logger's own PDF/CSV.
- **Observed**: seen once or on one logger.
- **Tentative**: a reasonable reading of the bytes, not yet proven.

The tool used for most of this is `bun run dump` (read-only snapshots, `--diff`, `--watch`); see the README.

---

## 1. Writing settings

### 1.1 Writes are held until a Format — Confirmed

SetParameter (`0x0004`) is always answered "accepted" (count 1, payload `01`), but a read straight afterwards still returns the old value. The new value only appears after a **Format** (`0x02C0`), which also erases every record.

- A Format on its own changes nothing.
- A Format sent *before* the writes doesn't apply them either.
- So on this firmware every settings change costs the stored readings.

python-elitech issue #1 reported RC-5+ writes being "ignored" on protocol `0x38`; this is the mechanism behind it.

### 1.2 The Format stores the whole pending settings buffer — Confirmed (Logger B), Observed (Logger A)

The two loggers behave differently when only some settings are written before a Format:

- **Logger A** kept every setting that wasn't written.
- **Logger B** (TE) lost almost all of them. After a write of only the interval (`0x4C`) and configuration time (`0x28`) followed by a Format:
  - the start mode, sensor options, alarm flags, time zone, start delay, alarm-threshold area (`0x4E..0x59`, `0x5E..0x69`, `0x70..0x7B`) and the start/stop times read `0xFF`
  - the trip number (`0x10`) and description (`0x98`) held unrelated bytes: what looked like a date (`1a 06 ff 0f 0e 2b 1e`, 2026-06-15 14:43:30) and alarm-like values (`0x0FA0`, `0x012A`, `0x0154`, `0x016D`)
  - the bytes that were written (interval, configuration time) were correct
  - the identity bytes (`0x00..0x0F`), capacity (`0x42..0x45`) and the area `0x90..0x97` were untouched

The safe sequence, which matches the official software as described in python-elitech PRs #12 and #14, is:
1. read the whole settings memory
2. change the fields you want
3. write **every** block: `0x000`+`0x30`, `0x030`+`0x30`, `0x060`+`0x30`, `0x098`+`0x34`, `0x0CC`+`0x30`, `0x0FD`+`0x2F`, `0x13C`+`0x19`
4. Format, then read everything back

This worked through the app's reset on both loggers. It also worked through `bun run restore`, which rebuilt Logger B's settings from a dump of Logger A.

The leftover bytes suggest the Format copies a RAM buffer that other code (perhaps report generation) also uses, but that is a guess (**Tentative**).

### 1.3 What a Format sets by itself — Confirmed

| Byte | After Format |
|---|---|
| `0x25` run state | low bits become `0x04` (ready); bits 6–7 are **kept** (`0xFF` → `0xC4` on Logger B) |
| `0x26` bits 0..2 | `3` |
| `0x46..0x49` record counts | `0` |
| Shadow `0x01..0x07` | all `00` |
| Shadow `0x08..0x0E`, `0x12..0x18` | all `ff` |
| Shadow `0x84..0x85` record count | `0` |
| Shadow `0x90`, `0x98`, `0xA0..0xA3` | `0F A0` (see 3.3) |

### 1.4 Setting the clock — Confirmed

Writing the **configuration time** (`0x28`), then a Format, sets the logger's running clock (`0x88`) to that time. For up to about 3 s afterwards the clock still reads the old value. The official software also writes the device time (`0x88`) in the same block; this app does the same.

### 1.5 Bytes the logger owns — Confirmed

These change by themselves, and writes to them are ignored or overwritten. They must be left out when comparing what was written with what reads back:

| Bytes | Meaning |
|---|---|
| `0x25` | run state |
| `0x26` bits 0..2 | how it last stopped |
| `0x27` bits 0..3 | battery level |
| `0x46..0x49` | record counts |
| `0x86..0x87` | current temperature (see 2.4) |
| `0x88..0x8E` | running clock |

### 1.6 Blank settings: how a logger looks — Observed (Logger B)

With its settings erased, Logger B:
- showed `NC f` on its display when unplugged (meaning unknown, perhaps "not configured")
- reported run state `0xC4`
- read `0x00 00` at `0x86` (no temperature reading)

Rewriting the settings brought it back to normal. A start mode (`0x20` bits 0..2) above 2, or an undecodable time zone (`0x24`/`0x2F`), is a reliable sign of erased settings; the app refuses to reset such a logger.

---

## 2. Main memory (op `0x0003`)

### 2.1 Run state, `0x25` — Confirmed

python-elitech master doesn't decode this byte. Values in bits 0..5:

| Value | State | Display when unplugged |
|---|---|---|
| `0x04` | configured / ready (after a Format, not started) | — |
| `0x05` | start delay (from python-elitech issue #1, **not seen here**) | — |
| `0x07` | recording | `Rec` |
| `0x09` | stopped | `Stop` |

- **Bits 6–7 must be ignored.** Logger B read `0xC4` after a Format, and python-elitech PR #14 lists `0x44`/`0xC4`/`0xC7` for the plain RC-5.
- While plugged into USB the display always shows `USB`, whatever the state. So the state can only be seen on the display after unplugging.

### 2.2 How it last stopped, `0x26` bits 0..2 — Confirmed

| Value | Meaning |
|---|---|
| `0` | stopped with its button |
| `3` | paused because it is on USB (while recording); also the value straight after a Format |
| `4` | stopped by the USB Stop command |

Bits 3 and 4 (python-elitech's `temporary-pdf` and `display-time`) were set on Logger A.

### 2.3 Start and stop times, `0x30` / `0x38` — Confirmed

On this firmware both fields only ever hold the placeholder `2012-01-01 01:01:01` (`0c 01 01 01 01 01 01`), even across a full start/stop. The real trip times are in the shadow space (3.1). After an erase they read `0xFF`, and writing them back as the placeholder is accepted.

### 2.4 Current temperature, `0x86..0x87` — Confirmed

A big-endian word in tenths of a degree, updated by the logger while it is on USB:

| Reading | Meaning |
|---|---|
| `0x0108` = 26.4 °C | Logger A; its record for the same minute read 26.4 °C |
| `0x00FE`, `0x0101` = 25.4, 25.7 °C | Logger B after its settings were restored; followed the probe when held |
| `0x0000` | Logger B with erased settings |

A write here was ignored. Negative temperatures have not been seen, so their encoding is unknown.

### 2.5 Mode code, `0xFD` — Observed

16 bytes of ASCII, `TLC30A08B` on Logger A. The same text appears as "Mode Code" in the CSV the logger writes to its drive. It was blank (zeros) on Logger B, both before and after its settings were erased, so it may be model-specific.

### 2.6 `0x1E` and the TE's probe — Observed

python-elitech names `0x1E` bits 0..3 "product-properties":
- Logger A: `0x00`
- Logger B (TE): `0x02`, which survived the erase

So it probably identifies the TE model (**Tentative**). Logger B was restored with `0x21` (sensor options) set to `0x00`, copied from Logger A, and its readings still followed the external probe. So `0x21`'s "temperature-sensor-location" bit does not choose the probe on this model.

### 2.7 `0x90..0x97` — Observed

`40 00 00 7d 40 38 00 01` on both loggers. This area is not in any block the official software writes, and Logger B's erase left it untouched. `0x95` is the protocol version (`0x38`); the other bytes are unknown.

---

## 3. Shadow memory (op `0x0005`)

python-elitech PR #14 describes a second read-only memory space for the plain RC-5. **It also answers on the RC-5+.** Layout as seen here:

### 3.1 Trip times — Confirmed (one trip checked against the logger's own CSV)

| Offset | Meaning | After a Format |
|---|---|---|
| `0x01..0x07` | trip start time | all `00` |
| `0x08..0x0E` | first record time | all `ff` |
| `0x12..0x18` | last record time | all `ff` |

- These are 7-byte dates in the usual layout, but the day-of-week byte is `00` or `ff` rather than a real day.
- On the trips seen, the start time equalled the first record time, and the last record time equalled the stop time in the logger's own CSV.
- Whether the start time differs from the first record time when a start delay is used is **not yet known**.

### 3.2 Counters — Observed

| Offset | Meaning |
|---|---|
| `0x84..0x85` | record count (word). PR #14 places it at `0x85` on the RC-5; on the RC-5+ it is the word at `0x84` |
| `0x8B..0x8E` | a counter that goes up once a second while plugged in |

### 3.3 Trip statistics — Tentative

After a 16-record trip on Logger A (readings around 22–25 °C), three 2-byte values read as tenths of a degree:

| Offset | Value |
|---|---|
| `0x90..0x91` | `0x00F7` = 24.7 |
| `0x98..0x99` | `0x00DE` = 22.2 |
| `0xA0..0xA1` | `0x00E0` = 22.4 |

They are probably the maximum, minimum and mean, but which is which isn't confirmed. After a Format these, plus `0xA2..0xA3`, `0xB0`, `0xB8` and `0xC0`, read `0x0FA0` (4000 = "400.0", apparently "no value").

### 3.4 Unexplained — Observed

- `0x10`: `00` with a trip stored, `03` after a Format.
- `0x80..0x83`: `00 00 23 28` with a trip stored, `ff ff fd a8` after a Format. `0x2328` = 9000; `0xFDA8` = −600 as a signed word.

---

## 4. Records

### 4.1 Record layout on protocol `0x38` — Confirmed

python-elitech PR #13 says protocol `0x30` and later use a new record layout. **Not so on this RC-5+:** the original layout decodes `0x38` records correctly, checked reading by reading against the logger's own CSV.

### 4.2 No sampling on USB — Confirmed

While plugged in, the logger does not record: a recording logger shows stop mode `3` ("paused for USB").

### 4.3 Starting a trip discards the old records — Observed

Starting a new trip with the button (without a reset) dropped the previous trip's records: the count went from 14 to 4 during testing.

---

## 5. Buttons, display and drive

- **Stopping an already stopped logger** leaves `0x25` at `0x09`. The display shows `pdf C`, and the logger writes `<serial>-<trip>.csv` next to the PDF on its USB drive. That CSV has a trip summary (start and stop times, interval, stop mode, "Mode Code") followed by the readings. — Confirmed
- **The PDF only appears or updates when recording stops.** An empty drive in the middle of a trip is normal. — Confirmed
- **After a Format**, Linux's cached view of the drive can be stale until the logger is unplugged and plugged back in. — Observed

---

## 6. Things to avoid

- **The USB Stop command (`0x03C0`).** About 1 s after it the logger drops off USB and re-enumerates. The next request then fails (`EPROTO` on Linux), so the session is lost. Stop the logger with its button instead. — Confirmed
- **Writing only the fields you change**, then a Format. This erased Logger B's settings (1.2). — Confirmed
- **Two programs using the hidraw device at once.** Each gets some of the other's answers (offset mismatches), because answers aren't tagged with a request ID. This app and its tools share a lock file to prevent it. This is a host-side issue, not a logger bug. — Confirmed

---

## 7. Open questions

- What `NC f` on the display means exactly, and whether a logger with erased settings can record at all.
- The trip-statistics layout (3.3), and the unexplained shadow bytes (3.4).
- Whether held writes survive an unplug before the Format.
- How negative temperatures are stored at `0x86`.
- Whether the shadow start time differs from the first record time with a start delay.
- Whether a new description (`0x98`) and trip number (`0x10`) show on the logger's own PDF and CSV after a reset through the app (written and read back correctly, but the reports haven't been checked).
