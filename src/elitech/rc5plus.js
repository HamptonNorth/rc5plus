// =============================================================================
// File:    src/elitech/rc5plus.js
// Version: 1.5.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// High-level RC-5+ operations built on a transport:
//   - readInfo()            serial number, settings, record count, clock
//   - resetForNewTrip()     set the interval, clock and optionally description
//                           and trip number; erase records; verify
//   - readSettingsBytes()   the whole settings memory, for backups/restores
//   - applySettings()       write a whole settings image, Format, verify
//   - readRecords()         download every stored measurement
//
// How the RC-5+ takes new settings (firmware 0x57, protocol 0x38, confirmed
// on hardware on 2026-11-18/19, and matching python-elitech issue #1):
//   - SetParameter is always answered "accepted", but the logger only keeps
//     the new values once a Format follows. A Format on its own, or a Format
//     before the writes, changes nothing.
//   - The Format stores the logger's whole pending settings buffer. On one
//     RC-5+ that buffer held the current settings, so writing two fields
//     was enough; on an RC-5+ TE it did not, and a two-field reset erased
//     nearly every other setting. So, like the official software, we write
//     every settings block before the Format, and check every byte after.
//   - Format also erases every record. So any settings change erases the
//     readings, which is why this module offers one "reset for a new trip"
//     operation instead of separate "set interval" and "clear" ones.
//   - Writing the configuration time (then Format) also sets the logger's
//     clock, which settles within a few seconds.
//
// A reset is refused when the settings memory already looks erased:
// copying damaged settings back would only make it permanent. Such a
// logger needs `bun run restore` or the official software first.
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
  encodeDescription,
  encodeInterval,
  encodeTripNumber,
  Param,
  ParameterImage,
  READ_BLOCKS,
  SETTINGS_END,
  SETTINGS_WRITE_BLOCKS,
  settingsMismatches,
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

/** Largest payload of one GetParameter frame. */
const MAX_READ_LENGTH = 52;

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
 * Raised when a reset is attempted on a logger whose settings memory
 * looks blank or damaged. The message is written for the end user.
 */
export class SettingsErasedError extends Error {
  constructor() {
    super(
      "This logger's settings look blank or damaged (its start mode and time " +
        "zone can't be read), so it was not reset: a reset would copy the " +
        "damage. Restore its settings first (bun run restore, or the official " +
        "ElitechLog software), then try again.",
    );
    this.name = "SettingsErasedError";
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
   * Read the whole settings memory, 0x00 up to SETTINGS_END.
   *
   * @returns {Promise<Uint8Array>} Indexed by absolute offset.
   */
  async readSettingsBytes() {
    const bytes = new Uint8Array(SETTINGS_END);
    for (let offset = 0; offset < SETTINGS_END; offset += MAX_READ_LENGTH) {
      const length = Math.min(MAX_READ_LENGTH, SETTINGS_END - offset);
      bytes.set(await this.readParameterBytes(offset, length), offset);
    }
    return bytes;
  }

  /**
   * Write every settings block from `image` (see SETTINGS_WRITE_BLOCKS).
   * Held by the logger until a Format.
   *
   * @param {Uint8Array} image  Indexed by absolute offset, SETTINGS_END long.
   */
  async writeSettingsBlocks(image) {
    for (const block of SETTINGS_WRITE_BLOCKS) {
      await this.writeParameter(block, image.slice(block.offset, block.offset + block.length));
    }
  }

  /**
   * Store a complete settings image: write every block, Format (which
   * erases every record), then check that every settings byte reads back
   * as written. If not, write every block once more, as the official
   * software does after a Format (python-elitech PR #14), and check again.
   *
   * Callers must have checked the logger may be changed (assertConfigurable)
   * and kept a backup. The configuration time in `image` also sets the clock.
   *
   * @param {Uint8Array} image  Full settings image (from readSettingsBytes,
   *   patched). The configuration time should be `now`.
   * @param {Date} now          The time written as configuration time.
   * @returns {Promise<object>} Device info after the clock has settled.
   */
  async applySettings(image, now) {
    if (image.length !== SETTINGS_END) {
      throw new RangeError(`Settings image must be ${SETTINGS_END} bytes, got ${image.length}`);
    }
    const startedAt = Date.now();

    await this.writeSettingsBlocks(image);
    await this.sendCommand(Operation.Format, FORMAT_TIMEOUT_MS);

    let bad = settingsMismatches(image, await this.readSettingsBytes());
    if (bad.length > 0) {
      await this.writeSettingsBlocks(image);
      bad = settingsMismatches(image, await this.readSettingsBytes());
    }
    if (bad.length > 0) {
      const where = bad.slice(0, 8).map((o) => `0x${o.toString(16).padStart(2, "0")}`).join(", ");
      throw new NotAppliedError(
        `The logger was formatted, but ${bad.length} settings ` +
          `${bad.length === 1 ? "byte" : "bytes"} read back ` +
          `differently from what was written (${where}${bad.length > 8 ? ", …" : ""}). ` +
          `A backup of the settings from before this change is in the dumps folder.`,
      );
    }

    let info = await this.readInfo();
    if (info.recordCount !== 0) {
      throw new NotAppliedError(
        `The reset did not complete: the logger still reports ` +
          `${info.recordCount} records.`,
      );
    }
    if (info.runState !== "ready") {
      throw new NotAppliedError(
        `The reset did not complete: the logger reports state ` +
          `0x${info.deviceState.toString(16).padStart(2, "0")} instead of ready.`,
      );
    }

    // The clock takes a moment to pick up the new time.
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
   * Prepare the logger for a new trip: set the interval and the clock
   * (and, if given, the description and trip number), erase every stored
   * record, keep every other setting, and verify.
   *
   * Sequence:
   *   1. Validate the interval. Read the logger and check it may be changed
   *      (stopped, or reset and not started) and that its settings don't
   *      look erased.
   *   2. Read the whole settings memory and hand it to `onBackup`, which
   *      must save it before anything is written.
   *   3. Patch the interval, configuration time and device time = now,
   *      and the description / trip number if given.
   *   4. applySettings(): write every block, Format, verify every byte,
   *      0 records, ready, and the clock within 10 s.
   *
   * The new interval applies from the next recording start.
   *
   * @param {number} minutes  Whole minutes, 1..15.
   * @param {Date} [now]      Clock value to write (defaults to the current time).
   * @param {object} [options]
   * @param {(settings: Uint8Array) => Promise<void>|void} [options.onBackup]
   *   Called with the settings read in step 2, before any write.
   * @param {string} [options.description]  New description; omit to keep.
   * @param {string} [options.tripNumber]   New trip number; omit to keep.
   * @returns {Promise<object>} Device info after the reset.
   */
  async resetForNewTrip(minutes, now = new Date(), { onBackup, description, tripNumber } = {}) {
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

    // Check the text settings before touching the logger, too.
    const descriptionBytes = description === undefined ? null : encodeDescription(description);
    const tripNumberBytes = tripNumber === undefined ? null : encodeTripNumber(tripNumber);

    // 1. Refuse to touch a logger that is recording, in an unknown state,
    //    or whose settings are already damaged.
    const before = await this.readInfo();
    assertConfigurable(before);
    if (before.settingsErased) {
      throw new SettingsErasedError();
    }

    // 2. Keep a copy of everything we are about to rewrite.
    const image = await this.readSettingsBytes();
    if (onBackup) {
      await onBackup(image.slice());
    }

    // 3. Change only the interval, the two clock fields and the text
    //    settings asked for.
    const clock = encodeDateTime(now);
    if (descriptionBytes) image.set(descriptionBytes, Param.description.offset);
    if (tripNumberBytes) image.set(tripNumberBytes, Param.tripNumber.offset);
    image.set(encodeInterval(minutes * 60), Param.interval.offset);
    image.set(clock, Param.configurationTime.offset);
    image.set(clock, Param.deviceTime.offset);

    // 4. Write it all, Format, verify.
    const info = await this.applySettings(image, now);
    if (info.intervalSeconds !== minutes * 60) {
      throw new NotAppliedError(
        `The logger acknowledged the reset but kept its interval at ` +
          `${info.intervalSeconds / 60} min (asked for ${minutes} min).`,
      );
    }
    const expectedConfigTime = decodeDateTime(clock);
    if (info.configurationTime !== expectedConfigTime) {
      throw new NotAppliedError(
        `The logger acknowledged the reset but its configuration time reads ` +
          `${info.configurationTime ?? "blank"} (expected ${expectedConfigTime}).`,
      );
    }
    return info;
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
