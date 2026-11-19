// =============================================================================
// File:    src/elitech/rc5plus.js
// Version: 1.3.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// High-level RC-5+ operations built on a transport:
//   - readInfo()         serial number, settings, record count, clock
//   - resetForNewTrip()  set the interval and clock, erase records, verify
//   - readRecords()      download every stored measurement
//
// How the RC-5+ takes new settings (firmware 0x57, protocol 0x38, confirmed
// on hardware on 2026-11-18, and matching python-elitech issue #1):
//   - SetParameter is always answered "accepted", but the logger only keeps
//     the new values once a Format follows. A Format on its own, or a Format
//     before the writes, changes nothing.
//   - Format also erases every record. So any settings change erases the
//     readings, which is why this module offers one "reset for a new trip"
//     operation instead of separate "set interval" and "clear" ones.
//   - Writing the configuration time (then Format) also sets the logger's
//     clock, which settles within a few seconds.
//
// Changing settings is only allowed when the logger is stopped (by its own
// button) or already reset and not started. Reading is always allowed.
//
// A transport is any object with:
//   exchange(frame: Uint8Array, timeoutMs?: number): Promise<Uint8Array>
//   close(): void
// (see hidraw.js for the real one and mock-device.js for the simulator).
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

import {
  FRAME_HEADER,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  Operation,
  RECORDS_PER_FRAME,
  RECORD_LENGTH,
} from "./constants.js";
import { buildFrame, FrameError, parseResponse } from "./frame.js";
import {
  CONFIGURABLE_STATES,
  SHADOW_MIN_PROTOCOL,
  SHADOW_READ_BLOCK,
  decodeDateTime,
  decodeInfo,
  encodeDateTime,
  encodeInterval,
  Param,
  ParameterImage,
  READ_BLOCKS,
} from "./parameters.js";
import { decodeRecord } from "./records.js";

/**
 * Formatting erases the record flash, which can take a few seconds.
 */
const FORMAT_TIMEOUT_MS = 10_000;

/**
 * After a reset the logger's clock still reads the old value for a moment
 * (seen on hardware: wrong straight after Format, right 3 s later).
 * Poll this many times, this far apart, before giving up.
 */
const CLOCK_SETTLE_ATTEMPTS = 10;
const CLOCK_SETTLE_DELAY_MS = 1_000;

/**
 * How far the logger's clock may differ from the time we set, in seconds.
 */
const CLOCK_TOLERANCE_S = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raised when an operation that changes the logger is attempted while the
 * logger is recording (or in a state we don't recognise). The message is
 * written for the end user.
 */
export class NotStoppedError extends Error {
  /**
   * @param {object} info  Result of readInfo().
   */
  constructor(info) {
    const hex = `0x${info.deviceState.toString(16).padStart(2, "0")}`;
    let message;
    if (info.runState === "recording") {
      message =
        "The logger is still recording. Unplug it, press and hold its stop " +
        "button until the display shows \"Stop\", then plug it back in and " +
        "try again.";
    } else if (info.runState === "start-delay") {
      message =
        "The logger has been started and is waiting for its start delay. " +
        "Unplug it, press and hold its stop button until the display shows " +
        "\"Stop\", then plug it back in and try again.";
    } else {
      message =
        `The logger reports an unrecognised state (${hex}), so it was not ` +
        "changed. Unplug it and check that the display shows \"Stop\" (press " +
        "and hold its stop button if not), then plug it back in and try again.";
    }
    super(message);
    this.name = "NotStoppedError";
    this.runState = info.runState;
    this.deviceState = info.deviceState;
  }
}

/**
 * Raised when the logger acknowledged a reset but its settings read back
 * differently. The message is written for the end user.
 */
export class NotAppliedError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotAppliedError";
  }
}

/**
 * Throw NotStoppedError unless the logger may be reconfigured
 * (stopped, or reset and not yet started).
 *
 * @param {object} info  Result of readInfo().
 */
export function assertConfigurable(info) {
  if (!CONFIGURABLE_STATES.includes(info.runState)) {
    throw new NotStoppedError(info);
  }
}

/**
 * Parse a decoded "YYYY-MM-DD HH:MM:SS" device time as local time.
 *
 * @param {string|null} text
 * @returns {number|null} Milliseconds since the epoch.
 */
function parseDeviceTime(text) {
  if (!text) {
    return null;
  }
  const [date, time] = text.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export class Rc5Plus {
  /**
   * @param {{ exchange: Function, close: Function }} transport
   */
  constructor(transport) {
    this.transport = transport;
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

  /**
   * Read `length` bytes of parameter memory starting at `offset`.
   *
   * @param {number} offset
   * @param {number} length  1..52
   * @returns {Promise<Uint8Array>}
   */
  async readParameterBytes(offset, length) {
    const frame = buildFrame(Operation.GetParameter, offset, length);
    const answer = await this.transport.exchange(frame);
    return parseResponse(Operation.GetParameter, offset, length, answer);
  }

  /**
   * Write bytes to parameter memory and confirm the device acknowledged them.
   *
   * On the RC-5+ an acknowledgement does not mean the value was kept: it is
   * only committed by a following Format (see the file header).
   *
   * @param {{offset: number, length: number}} field
   * @param {Uint8Array} bytes
   */
  async writeParameter(field, bytes) {
    if (bytes.length !== field.length) {
      throw new RangeError(
        `Expected ${field.length} bytes for 0x${field.offset.toString(16)}, got ${bytes.length}`,
      );
    }
    const frame = buildFrame(Operation.SetParameter, field.offset, bytes);
    const answer = await this.transport.exchange(frame);
    const accepted = parseResponse(
      Operation.SetParameter,
      field.offset,
      bytes.length,
      answer,
    );
    if (!accepted) {
      throw new Error(
        `Logger rejected write to parameter 0x${field.offset.toString(16)}`,
      );
    }
  }

  /**
   * Send a command (Format) that carries a single 0x00 payload byte.
   *
   * python-elitech does not interpret these answers; we only insist that a
   * well-formed frame came back so we know the logger is still listening.
   *
   * The Stop command (0x03C0) is deliberately not used anywhere: on real
   * hardware it makes the logger drop off USB and re-enumerate about a
   * second later, which breaks the session. Users stop it with its button.
   *
   * @param {number} op
   * @param {number} [timeoutMs]
   */
  async sendCommand(op, timeoutMs) {
    const frame = buildFrame(op, 0, Uint8Array.of(0x00));
    const answer = await this.transport.exchange(frame, timeoutMs);
    for (let i = 0; i < FRAME_HEADER.length; i++) {
      if (answer[i] !== FRAME_HEADER[i]) {
        throw new FrameError("Invalid answer header to command");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------

  /**
   * Read and decode the device's identity, settings and status.
   *
   * @returns {Promise<object>} See parameters.decodeInfo().
   */
  async readInfo() {
    const image = new ParameterImage();
    for (const block of READ_BLOCKS) {
      image.add(block.offset, await this.readParameterBytes(block.offset, block.length));
    }

    // The real trip start and last-reading times live in the shadow space
    // (see parameters.ShadowParam). Optional: on failure, info still loads.
    let shadow = null;
    if (image.get(Param.protocolVersion)[0] >= SHADOW_MIN_PROTOCOL) {
      try {
        shadow = await this.readShadowBytes(SHADOW_READ_BLOCK.offset, SHADOW_READ_BLOCK.length);
      } catch {
        shadow = null;
      }
    }
    return decodeInfo(image, shadow);
  }

  /**
   * Read `length` bytes of the shadow space starting at `offset`.
   *
   * @param {number} offset
   * @param {number} length  1..52
   * @returns {Promise<Uint8Array>}
   */
  async readShadowBytes(offset, length) {
    const op = Operation.GetParameterShadow;
    const answer = await this.transport.exchange(buildFrame(op, offset, length));
    return parseResponse(op, offset, length, answer);
  }

  /**
   * Prepare the logger for a new trip: set the interval and the clock,
   * erase every stored record, and verify the result.
   *
   * Sequence:
   *   1. Validate the interval, read the logger and check it may be changed
   *      (stopped, or reset and not started).
   *   2. Write the interval (2 bytes at 0x4C).
   *   3. Write the configuration time = now (7 bytes at 0x28).
   *   4. Format: commits steps 2 and 3, erases the records, sets the clock.
   *   5. Verify: 0 records, interval and configuration time as written.
   *   6. Wait for the clock to settle and verify it is within 10 s.
   *
   * The new interval applies from the next recording start.
   *
   * @param {number} minutes  Whole minutes, 1..15.
   * @param {Date} [now]      Clock value to write (defaults to the current time).
   * @returns {Promise<object>} Device info after the reset.
   */
  async resetForNewTrip(minutes, now = new Date()) {
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_INTERVAL_MINUTES ||
      minutes > MAX_INTERVAL_MINUTES
    ) {
      throw new RangeError(
        `Interval must be a whole number of minutes between ` +
          `${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
      );
    }

    // 1. Refuse to touch a logger that is recording or in an unknown state.
    assertConfigurable(await this.readInfo());

    // 2..4. Write the settings, then Format to commit them.
    const configTime = encodeDateTime(now);
    const startedAt = Date.now();
    await this.writeParameter(Param.interval, encodeInterval(minutes * 60));
    await this.writeParameter(Param.configurationTime, configTime);
    await this.sendCommand(Operation.Format, FORMAT_TIMEOUT_MS);

    // 5. Check the logger kept what we wrote.
    let info = await this.readInfo();
    if (info.recordCount !== 0) {
      throw new NotAppliedError(
        `The reset did not complete: the logger still reports ` +
          `${info.recordCount} records.`,
      );
    }
    if (info.intervalSeconds !== minutes * 60) {
      throw new NotAppliedError(
        `The logger acknowledged the reset but kept its interval at ` +
          `${info.intervalSeconds / 60} min (asked for ${minutes} min).`,
      );
    }
    const expectedConfigTime = decodeDateTime(configTime);
    if (info.configurationTime !== expectedConfigTime) {
      throw new NotAppliedError(
        `The logger acknowledged the reset but its configuration time reads ` +
          `${info.configurationTime ?? "blank"} (expected ${expectedConfigTime}).`,
      );
    }

    // 6. The clock takes a moment to pick up the new time.
    for (let attempt = 1; ; attempt++) {
      const expected = now.getTime() + (Date.now() - startedAt);
      const actual = parseDeviceTime(info.deviceTime);
      if (actual !== null && Math.abs(actual - expected) <= CLOCK_TOLERANCE_S * 1000) {
        return info;
      }
      if (attempt >= CLOCK_SETTLE_ATTEMPTS) {
        throw new NotAppliedError(
          `The logger was reset, but its clock reads ${info.deviceTime ?? "blank"} ` +
            `instead of this computer's time.`,
        );
      }
      await sleep(CLOCK_SETTLE_DELAY_MS);
      info = await this.readInfo();
    }
  }

  /**
   * Download every stored record.
   *
   * @param {object} [info]  Result of readInfo(); read fresh if omitted.
   * @returns {Promise<{ info: object, records: object[] }>}
   */
  async readRecords(info) {
    const deviceInfo = info ?? (await this.readInfo());
    const total = deviceInfo.recordCount;
    const records = [];

    for (let index = 0; index < total; index += RECORDS_PER_FRAME) {
      const count = Math.min(RECORDS_PER_FRAME, total - index);
      const frame = buildFrame(Operation.GetRecord, index, count);
      const answer = await this.transport.exchange(frame);
      const data = parseResponse(Operation.GetRecord, index, count, answer);

      for (let i = 0; i < count; i++) {
        const record = decodeRecord(
          data.subarray(i * RECORD_LENGTH, (i + 1) * RECORD_LENGTH),
          deviceInfo.protocolVersion,
        );
        // An empty slot before the reported count means memory ended early.
        if (record === null) {
          return { info: deviceInfo, records };
        }
        records.push({ index: index + i + 1, ...record });
      }
    }

    return { info: deviceInfo, records };
  }
}
