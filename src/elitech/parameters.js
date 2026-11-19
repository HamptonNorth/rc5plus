// =============================================================================
// File:    src/elitech/parameters.js
// Version: 1.5.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// The subset of the RC-5+ parameter memory map this app reads or writes,
// with decoders and encoders for each field.
//
// All multi-byte integers in parameter memory are big-endian.
// Date/times are 7 bytes: [yy, mm, dow, dd, hh, mi, ss], year = 2000 + yy,
// dow = day of the week (0 = Sunday), in the device's local time (no time
// zone attached). python-elitech writes 0 for dow; the official software
// writes the real day, and so do we.
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

/**
 * Parameter addresses and lengths (bytes) in the device memory map.
 * Only the fields this app uses are listed.
 */
export const Param = Object.freeze({
  model: { offset: 0x00, length: 2 },
  serialNumber: { offset: 0x02, length: 12 },
  tripNumber: { offset: 0x10, length: 13 }, // "Trip Id" on the report (python-elitech: travel-number)
  firmwareVersion: { offset: 0x1f, length: 1 },
  startMode: { offset: 0x20, length: 1 }, // bits 0..2
  temperatureUnit: { offset: 0x21, length: 1 }, // bit 3
  timezone: { offset: 0x24, length: 12 }, // hours in byte 0, minutes in byte 11
  deviceState: { offset: 0x25, length: 1 }, // bits 0..5, see DeviceState
  stopMode: { offset: 0x26, length: 1 }, // bits 0..2, see StopMode
  batteryLevel: { offset: 0x27, length: 1 }, // bits 0..3
  configurationTime: { offset: 0x28, length: 7 },
  startTime: { offset: 0x30, length: 7 },
  stopTime: { offset: 0x38, length: 7 },
  startDelay: { offset: 0x40, length: 2 },
  deviceCapacity: { offset: 0x42, length: 4 },
  recordNumber: { offset: 0x48, length: 2 },
  interval: { offset: 0x4c, length: 2 }, // units of 10 seconds
  deviceTime: { offset: 0x88, length: 7 },
  description: { offset: 0x98, length: 100 },
  protocolVersion: { offset: 0x95, length: 1 },
});

/**
 * Fields of the "shadow" memory space, read with GetParameterShadow (0x0005).
 *
 * Tentative layout, from a real RC-5+ (firmware 0x57, protocol 0x38):
 *   - a stopped trip of 7 records (2026-11-18): 0x01 and 0x08 both held the
 *     first record's time, 0x12 the last record's time
 *   - after a reset: 0x01..0x07 all 0x00, 0x08..0x0E and 0x12..0x18 all 0xFF
 *     (both decode as unset)
 * The main space's start/stop times (0x30, 0x38) only ever held the
 * placeholder 2012-01-01 01:01:01 on that logger, so these are the only
 * real trip times available over USB.
 */
export const ShadowParam = Object.freeze({
  tripStartTime: { offset: 0x01, length: 7 },
  firstRecordTime: { offset: 0x08, length: 7 },
  lastRecordTime: { offset: 0x12, length: 7 },
});

/** The one shadow block readInfo() reads: 0x00..0x18 covers all three. */
export const SHADOW_READ_BLOCK = Object.freeze({ offset: 0x00, length: 0x19 });

/**
 * Only loggers of this protocol version or later are asked for the shadow
 * space (python-elitech PR #12 draws the same line for the newer devices).
 * Older ones may not answer at all, which would cost a timeout on every read.
 */
export const SHADOW_MIN_PROTOCOL = 0x30;

/**
 * Value the RC-5+ keeps in the main start/stop time fields when they are
 * not maintained. Decoded as "unset".
 */
const PLACEHOLDER_DATE_TIME = "2012-01-01 01:01:01";

/**
 * Contiguous blocks read from the device to obtain every field above.
 * Each block fits in one GetParameter frame (52 bytes maximum).
 *
 *   0x00..0x33  model .. start-mode .. timezone .. start-time
 *   0x34..0x4D  stop-time .. capacity .. record count .. interval
 *   0x88..0x95  device time .. protocol version
 *   0x98..0xFB  description (two frames)
 */
export const READ_BLOCKS = Object.freeze([
  { offset: 0x00, length: 52 },
  { offset: 0x34, length: 26 },
  { offset: 0x88, length: 14 },
  { offset: 0x98, length: 52 },
  { offset: 0xcc, length: 48 },
]);

/**
 * Limits for the two text settings the app writes.
 *   - Description: printed on the PDF/CSV. 100 bytes of memory; we keep it
 *     to 64 so it fits the report's line and always ends in NUL padding.
 *   - Trip number: becomes part of the report file names
 *     (<serial>-<trip>.pdf), so only letters, digits, "-" and "_".
 */
export const DESCRIPTION_MAX_LENGTH = 64;
export const TRIP_NUMBER_MAX_LENGTH = 12;
const TRIP_NUMBER_PATTERN = /^[A-Za-z0-9_-]+$/;

// -----------------------------------------------------------------------------
// Whole settings memory (used by resets and restores)
// -----------------------------------------------------------------------------

/**
 * End (exclusive) of the settings memory the official software writes.
 */
export const SETTINGS_END = 0x13c + 0x19;

/**
 * The blocks the official software writes, in this order, when it
 * configures a logger (python-elitech PRs #12/#14). Each fits one
 * SetParameter frame (52 bytes maximum). 0x90..0x97 (capacity copy,
 * protocol version, …) and 0xFC are never written.
 *
 * Why the app writes all of them, not just the fields it changes: on an
 * RC-5+ TE (firmware 0x57, protocol 0x38) a reset that wrote only the
 * interval and configuration time left almost every other setting erased
 * after the Format (2026-11-19). The Format stores the logger's whole
 * pending settings buffer, so every block must be written first.
 */
export const SETTINGS_WRITE_BLOCKS = Object.freeze([
  { offset: 0x000, length: 0x30 },
  { offset: 0x030, length: 0x30 },
  { offset: 0x060, length: 0x30 },
  { offset: 0x098, length: 0x34 },
  { offset: 0x0cc, length: 0x30 },
  { offset: 0x0fd, length: 0x2f },
  { offset: 0x13c, length: 0x19 },
]);

/**
 * Bits the logger sets itself, so they are not compared after a write.
 * Offset -> mask of logger-owned bits.
 *   0x25        run state (Format sets it to "configured")
 *   0x26 0..2   how it last stopped
 *   0x27 0..3   battery level
 *   0x46..0x49  record counts (Format clears them)
 *   0x86..0x87  the current temperature reading, in tenths (an RC-5+ TE
 *               ignored a write here on 2026-11-19)
 *   0x88..0x8E  the running clock
 */
export const LOGGER_OWNED_BITS = Object.freeze(new Map([
  [0x25, 0xff],
  [0x26, 0x07],
  [0x27, 0x0f],
  [0x46, 0xff], [0x47, 0xff], [0x48, 0xff], [0x49, 0xff],
  [0x86, 0xff], [0x87, 0xff],
  [0x88, 0xff], [0x89, 0xff], [0x8a, 0xff], [0x8b, 0xff],
  [0x8c, 0xff], [0x8d, 0xff], [0x8e, 0xff],
]));

/**
 * Offsets whose settings bits differ between what was written and what
 * the logger holds, ignoring LOGGER_OWNED_BITS.
 *
 * @param {Uint8Array} expected  Settings image that was written (from 0x00).
 * @param {Uint8Array} actual    Settings image read back (from 0x00).
 * @returns {number[]}
 */
export function settingsMismatches(expected, actual) {
  const bad = [];
  for (const { offset, length } of SETTINGS_WRITE_BLOCKS) {
    for (let i = offset; i < offset + length; i++) {
      const mask = ~(LOGGER_OWNED_BITS.get(i) ?? 0) & 0xff;
      if ((expected[i] & mask) !== (actual[i] & mask)) {
        bad.push(i);
      }
    }
  }
  return bad;
}

/**
 * Run state stored in bits 0..5 of byte 0x25.
 *
 * python-elitech master leaves this byte undecoded. The values come from
 * python-elitech issue #1 / PR #14 (RC-51H and RC-5+), and 0x04, 0x07 and
 * 0x09 were confirmed on a real RC-5+ (firmware 0x57, protocol 0x38) on
 * 2026-11-18:
 *   0x04  configured: reset and ready, not started yet
 *   0x05  start delay: started, waiting for its start delay (not confirmed)
 *   0x07  recording (display shows "Rec" when unplugged)
 *   0x09  stopped   (display shows "Stop" when unplugged), by button or
 *         by USB command; pressing stop again leaves it at 0x09
 * While plugged in the display always shows "USB", whatever the state.
 * Bits 6 and 7 are ignored: python-elitech PR #14 reports the plain RC-5
 * setting bit 6 (0x44, 0xC4, 0xC7), and an RC-5+ TE read 0xC4 after a
 * Format (2026-11-19), the Format having set the low bits to 0x04.
 * Any other value is treated as unknown, and the app refuses to change
 * settings rather than guess.
 */
export const DeviceState = Object.freeze({
  Configured: 0x04,
  StartDelay: 0x05,
  Recording: 0x07,
  Stopped: 0x09,
});

/**
 * How the logger last stopped, stored in bits 0..2 of byte 0x26
 * (python-elitech calls this "actual-stop-mode"). Observed values:
 *   0b000  stopped with the button
 *   0b011  paused because it is connected to USB (while recording); also
 *          seen straight after a reset, so only meaningful with the run state
 *   0b100  stopped by the USB Stop command
 */
export const StopMode = Object.freeze({
  Button: 0b000,
  UsbPause: 0b011,
  Software: 0b100,
});

/**
 * Map the raw 0x25 value to a run state name.
 *
 * @param {number} state  Byte 0x25 (bits 6 and 7 are ignored).
 * @returns {"ready"|"start-delay"|"recording"|"stopped"|"unknown"}
 */
export function decodeRunState(state) {
  switch (state & 0x3f) {
    case DeviceState.Configured:
      return "ready";
    case DeviceState.StartDelay:
      return "start-delay";
    case DeviceState.Recording:
      return "recording";
    case DeviceState.Stopped:
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * Run states in which the logger may be reconfigured: it is not recording
 * and has not been started.
 */
export const CONFIGURABLE_STATES = Object.freeze(["stopped", "ready"]);

/**
 * Start modes stored in bits 0..2 of byte 0x20.
 */
const START_MODES = { 0b000: "Immediate", 0b001: "Manual", 0b010: "Timer" };

// -----------------------------------------------------------------------------
// Memory image helper
// -----------------------------------------------------------------------------

/**
 * Sparse view of parameter memory assembled from several read blocks.
 * Lets decoders address bytes by absolute offset.
 */
export class ParameterImage {
  constructor() {
    /** @type {Map<number, number>} absolute offset -> byte */
    this.bytes = new Map();
  }

  /**
   * Store a block that was read starting at `offset`.
   *
   * @param {number} offset
   * @param {Uint8Array} data
   */
  add(offset, data) {
    data.forEach((b, i) => this.bytes.set(offset + i, b));
  }

  /**
   * Return the bytes of a parameter field.
   *
   * @param {{offset: number, length: number}} field
   * @returns {Uint8Array}
   */
  get(field) {
    const out = new Uint8Array(field.length);
    for (let i = 0; i < field.length; i++) {
      const b = this.bytes.get(field.offset + i);
      if (b === undefined) {
        throw new RangeError(
          `Parameter byte 0x${(field.offset + i).toString(16)} was not read`,
        );
      }
      out[i] = b;
    }
    return out;
  }
}

// -----------------------------------------------------------------------------
// Decoders
// -----------------------------------------------------------------------------

/**
 * Big-endian unsigned integer.
 *
 * @param {Uint8Array} data
 * @returns {number}
 */
export function decodeUnsigned(data) {
  let value = 0;
  for (const b of data) {
    value = value * 256 + b;
  }
  return value;
}

/**
 * NUL-padded ASCII string.
 *
 * @param {Uint8Array} data
 * @returns {string}
 */
export function decodeString(data) {
  // Erased memory reads 0xFF; treat it as padding like NUL.
  const bytes = Uint8Array.from(data, (b) => (b === 0xff ? 0 : b));
  return new TextDecoder().decode(bytes).replaceAll("\u0000", "").trim();
}

/**
 * 7-byte device date/time to "YYYY-MM-DD HH:MM:SS".
 * Returns null for unset values (all 0x00 or all 0xFF, or impossible dates).
 *
 * @param {Uint8Array} data
 * @returns {string|null}
 */
export function decodeDateTime(data) {
  const [yy, mo, , dd, hh, mi, ss] = data;

  const valid =
    mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 &&
    hh <= 23 && mi <= 59 && ss <= 59 && yy <= 99;
  if (!valid) {
    return null;
  }

  const pad = (n) => String(n).padStart(2, "0");
  return `${2000 + yy}-${pad(mo)}-${pad(dd)} ${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

/**
 * Time zone block to "+HHMM" / "-HHMM".
 *
 * Hours are in the low 5 bits of the first byte; values above 12 encode
 * negative offsets as (24 - hours). Minutes are in the last byte.
 *
 * @param {Uint8Array} data  12 bytes starting at 0x24
 * @returns {string|null}
 */
export function decodeTimezone(data) {
  const h = data[0] & 0x1f;
  const m = data[11];
  if (h > 24 || m >= 60 || (h === 12 && m !== 0)) {
    return null;
  }

  const minutes = h > 12 ? -((24 - h) * 60 + m) : h * 60 + m;
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}${mm}`;
}

/**
 * Like decodeDateTime(), but the RC-5+'s 2012 placeholder also means unset.
 *
 * @param {Uint8Array} data
 * @returns {string|null}
 */
function decodeTripTime(data) {
  const text = decodeDateTime(data);
  return text === PLACEHOLDER_DATE_TIME ? null : text;
}

/**
 * Decode the trip times from the shadow block (see ShadowParam).
 *
 * @param {Uint8Array|null} shadow  SHADOW_READ_BLOCK bytes, or null if the
 *   logger was not asked or did not answer.
 * @returns {{ tripStartTime: string|null, firstRecordTime: string|null,
 *             lastRecordTime: string|null }}
 */
export function decodeShadowTimes(shadow) {
  const pick = (field) =>
    shadow ? decodeTripTime(shadow.subarray(field.offset, field.offset + field.length)) : null;
  return {
    tripStartTime: pick(ShadowParam.tripStartTime),
    firstRecordTime: pick(ShadowParam.firstRecordTime),
    lastRecordTime: pick(ShadowParam.lastRecordTime),
  };
}

/**
 * Does the settings memory look blank or damaged? True when the start mode
 * or the time zone can't be decoded: both were 0xFF on the RC-5+ TE whose
 * settings a partial reset erased, and both are always valid on a logger
 * set up by the official software.
 *
 * @param {ParameterImage} image  Must include 0x20 and 0x24..0x2F.
 * @returns {boolean}
 */
export function settingsLookErased(image) {
  const startModeBits = image.get(Param.startMode)[0] & 0b111;
  return !(startModeBits in START_MODES) || decodeTimezone(image.get(Param.timezone)) === null;
}

/**
 * Decode every field this app needs from an assembled parameter image.
 *
 * @param {ParameterImage} image
 * @param {Uint8Array|null} [shadow]  SHADOW_READ_BLOCK bytes, if read.
 * @returns {object}
 */
export function decodeInfo(image, shadow = null) {
  const intervalUnits = decodeUnsigned(image.get(Param.interval));
  const startModeBits = image.get(Param.startMode)[0] & 0b111;
  const deviceState = image.get(Param.deviceState)[0];

  return {
    model: decodeUnsigned(image.get(Param.model)),
    serialNumber: decodeString(image.get(Param.serialNumber)),
    tripNumber: decodeString(image.get(Param.tripNumber)),
    description: decodeString(image.get(Param.description)),
    firmwareVersion: image.get(Param.firmwareVersion)[0],
    protocolVersion: image.get(Param.protocolVersion)[0],
    startMode: START_MODES[startModeBits] ?? `Unknown (${startModeBits})`,
    temperatureUnit: image.get(Param.temperatureUnit)[0] & 0b1000 ? "F" : "C",
    timezone: decodeTimezone(image.get(Param.timezone)),
    deviceState, // the raw byte, for messages
    runState: decodeRunState(deviceState),
    settingsErased: settingsLookErased(image),
    stopMode: image.get(Param.stopMode)[0] & 0b111,
    batteryLevel: image.get(Param.batteryLevel)[0] & 0x0f,
    configurationTime: decodeDateTime(image.get(Param.configurationTime)),
    // Main-space start/stop: only the 2012 placeholder on the RC-5+ seen so far.
    startTime: decodeTripTime(image.get(Param.startTime)),
    stopTime: decodeTripTime(image.get(Param.stopTime)),
    // Shadow-space trip times: null when unset, not read or not answered.
    shadowRead: shadow !== null,
    ...decodeShadowTimes(shadow),
    deviceTime: decodeDateTime(image.get(Param.deviceTime)),
    deviceCapacity: decodeUnsigned(image.get(Param.deviceCapacity)),
    recordCount: decodeUnsigned(image.get(Param.recordNumber)),
    intervalSeconds: intervalUnits * 10,
  };
}

// -----------------------------------------------------------------------------
// Encoders
// -----------------------------------------------------------------------------

/**
 * Sampling interval (whole seconds, multiple of 10) to the 2-byte field.
 *
 * @param {number} seconds
 * @returns {Uint8Array}
 */
export function encodeInterval(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds % 10 !== 0) {
    throw new RangeError(`Interval must be a positive multiple of 10 s: ${seconds}`);
  }
  const units = seconds / 10;
  if (units > 0xffff) {
    throw new RangeError(`Interval too large: ${seconds} s`);
  }
  return Uint8Array.of((units >> 8) & 0xff, units & 0xff);
}

/**
 * Text to a NUL-padded ASCII field (description, travel number).
 *
 * @param {string} text
 * @param {number} length  Field length in bytes.
 * @returns {Uint8Array}
 */
export function encodeString(text, length) {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new RangeError("Only plain ASCII letters, digits and punctuation can be stored");
  }
  if (text.length > length) {
    throw new RangeError(`Too long: at most ${length} characters`);
  }
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(text));
  return out;
}

/**
 * Description text to its 100-byte field.
 *
 * @param {string} text  Printable ASCII, at most DESCRIPTION_MAX_LENGTH.
 * @returns {Uint8Array}
 */
export function encodeDescription(text) {
  if (typeof text !== "string" || text.trim() !== text) {
    throw new RangeError("Description must be text without leading or trailing spaces");
  }
  if (text.length > DESCRIPTION_MAX_LENGTH) {
    throw new RangeError(`Description is too long: at most ${DESCRIPTION_MAX_LENGTH} characters`);
  }
  return encodeString(text, Param.description.length);
}

/**
 * Trip number to its 13-byte field.
 *
 * @param {string} text  1..TRIP_NUMBER_MAX_LENGTH letters, digits, "-" or "_".
 * @returns {Uint8Array}
 */
export function encodeTripNumber(text) {
  if (typeof text !== "string" || !TRIP_NUMBER_PATTERN.test(text)) {
    throw new RangeError("Trip number must be letters, digits, \"-\" or \"_\" (no spaces)");
  }
  if (text.length > TRIP_NUMBER_MAX_LENGTH) {
    throw new RangeError(`Trip number is too long: at most ${TRIP_NUMBER_MAX_LENGTH} characters`);
  }
  return encodeString(text, Param.tripNumber.length);
}

/**
 * Local wall-clock time to the 7-byte date/time field.
 * Writing this to `configurationTime` (committed by a Format) also sets the
 * device clock on the RC-5+.
 *
 * @param {Date} date  Interpreted in the server's local time zone.
 * @returns {Uint8Array}
 */
export function encodeDateTime(date) {
  return Uint8Array.of(
    date.getFullYear() - 2000,
    date.getMonth() + 1,
    date.getDay(), // day of the week, 0 = Sunday

    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}
