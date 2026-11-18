// =============================================================================
// File:    src/elitech/parameters.js
// Version: 1.2.0
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
  firmwareVersion: { offset: 0x1f, length: 1 },
  startMode: { offset: 0x20, length: 1 }, // bits 0..2
  temperatureUnit: { offset: 0x21, length: 1 }, // bit 3
  timezone: { offset: 0x24, length: 12 }, // hours in byte 0, minutes in byte 11
  deviceState: { offset: 0x25, length: 1 }, // bits 0..6, see DeviceState
  stopMode: { offset: 0x26, length: 1 }, // bits 0..2, see StopMode
  batteryLevel: { offset: 0x27, length: 1 }, // bits 0..3
  configurationTime: { offset: 0x28, length: 7 },
  startTime: { offset: 0x30, length: 7 },
  stopTime: { offset: 0x38, length: 7 },
  deviceCapacity: { offset: 0x42, length: 4 },
  recordNumber: { offset: 0x48, length: 2 },
  interval: { offset: 0x4c, length: 2 }, // units of 10 seconds
  deviceTime: { offset: 0x88, length: 7 },
  protocolVersion: { offset: 0x95, length: 1 },
});

/**
 * Contiguous blocks read from the device to obtain every field above.
 * Each block fits in one GetParameter frame (52 bytes maximum).
 *
 *   0x00..0x33  model .. start-mode .. timezone .. start-time
 *   0x34..0x4D  stop-time .. capacity .. record count .. interval
 *   0x88..0x95  device time .. protocol version
 */
export const READ_BLOCKS = Object.freeze([
  { offset: 0x00, length: 52 },
  { offset: 0x34, length: 26 },
  { offset: 0x88, length: 14 },
]);

/**
 * Run state stored in bits 0..6 of byte 0x25.
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
 * @param {number} state  Byte 0x25 masked to bits 0..6.
 * @returns {"ready"|"start-delay"|"recording"|"stopped"|"unknown"}
 */
export function decodeRunState(state) {
  switch (state) {
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
  return new TextDecoder().decode(data).replaceAll("\u0000", "").trim();
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
 * Decode every field this app needs from an assembled parameter image.
 *
 * @param {ParameterImage} image
 * @returns {object}
 */
export function decodeInfo(image) {
  const intervalUnits = decodeUnsigned(image.get(Param.interval));
  const startModeBits = image.get(Param.startMode)[0] & 0b111;
  const deviceState = image.get(Param.deviceState)[0] & 0x7f;

  return {
    model: decodeUnsigned(image.get(Param.model)),
    serialNumber: decodeString(image.get(Param.serialNumber)),
    firmwareVersion: image.get(Param.firmwareVersion)[0],
    protocolVersion: image.get(Param.protocolVersion)[0],
    startMode: START_MODES[startModeBits] ?? `Unknown (${startModeBits})`,
    temperatureUnit: image.get(Param.temperatureUnit)[0] & 0b1000 ? "F" : "C",
    timezone: decodeTimezone(image.get(Param.timezone)),
    deviceState,
    runState: decodeRunState(deviceState),
    stopMode: image.get(Param.stopMode)[0] & 0b111,
    batteryLevel: image.get(Param.batteryLevel)[0] & 0x0f,
    configurationTime: decodeDateTime(image.get(Param.configurationTime)),
    startTime: decodeDateTime(image.get(Param.startTime)),
    stopTime: decodeDateTime(image.get(Param.stopTime)),
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
