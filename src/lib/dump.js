// =============================================================================
// File:    src/lib/dump.js
// Version: 1.2.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Read-only diagnostic snapshots of an RC-5+, for `bun run dump`
// (scripts/dump.js):
//   - ReadOnlyTransport   refuses every frame that is not a read
//   - takeSnapshot()      USB details, raw parameter memory, optional shadow
//                         memory and records
//   - redactSnapshot()    blanks serial number, description, password, ...
//   - diffSnapshots()     byte-level comparison labelled with field names
//   - formatSnapshot() / formatDiff() / formatChanges()  terminal text
//   - saveSnapshot()      write dumps/<serial>-<time>[-label].json (mode 0600);
//                         also used for the backup taken before every reset
//
// The field table follows python-elitech's parameter list (including the
// open PRs #9, #12 and #14). Many of those fields are marked "TODO test"
// upstream and none but the app's own have been confirmed on the RC-5+, so
// decoded values here are hints, not facts. The raw bytes are the truth.
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { MAX_FRAME_PAYLOAD, Operation, RECORD_LENGTH, RECORDS_PER_FRAME } from "../elitech/constants.js";
import { buildFrame, parseResponse } from "../elitech/frame.js";
import {
  decodeDateTime,
  decodeRunState,
  decodeString,
  decodeTimezone,
  decodeUnsigned,
} from "../elitech/parameters.js";
import { decodeRecord } from "../elitech/records.js";
import { findBlockDevices, mountPointOf } from "./usb-drive.js";

/** Identifies the JSON layout, so later versions can still read old dumps. */
export const DUMP_FORMAT = "rc5plus-dump/1";

/**
 * Memory range read from each space: 0x000 up to and including the end of
 * the device-name block at 0x13C (25 bytes), the last block the official
 * software writes (python-elitech PR #12).
 */
export const DUMP_START = 0x000;
export const DUMP_END = 0x13c + 0x19; // exclusive

/** The only operations the dump may send. */
const READ_ONLY_OPS = new Set([
  Operation.GetParameter,
  Operation.GetParameterShadow,
  Operation.GetRecord,
]);

/**
 * Wraps a transport and refuses anything but read requests, so the dump
 * cannot change the logger even through a bug.
 */
export class ReadOnlyTransport {
  /**
   * @param {{ exchange: Function, close: Function }} inner
   */
  constructor(inner) {
    this.inner = inner;
  }

  async exchange(frame, timeoutMs) {
    const op = frame[4] | (frame[5] << 8);
    if (!READ_ONLY_OPS.has(op)) {
      throw new Error(
        `Read-only dump refused to send operation 0x${op.toString(16).padStart(4, "0")}`,
      );
    }
    return this.inner.exchange(frame, timeoutMs);
  }

  close() {
    this.inner.close();
  }
}

// -----------------------------------------------------------------------------
// Field table
// -----------------------------------------------------------------------------

/**
 * Known fields of the main parameter space.
 *
 *   kind:  uint | hex | string | date | interval | timezone-hours |
 *          timezone-minutes | run-state | flags
 *   bits:  for "flags": [name, firstBit, width]
 *   secret:   masked in terminal output unless asked otherwise
 *   personal: blanked by --redact
 *   ticks:    changes by itself every second (a clock); --watch hides it
 *             unless something else changed at the same time
 */
export const MAIN_FIELDS = Object.freeze([
  { name: "model", offset: 0x00, length: 2, kind: "hex" },
  { name: "serial-number", offset: 0x02, length: 12, kind: "string", personal: true },
  { name: "travel-number", offset: 0x10, length: 13, kind: "string" },
  { name: "pdf-language", offset: 0x1d, length: 1, kind: "uint" },
  {
    name: "product-properties", offset: 0x1e, length: 1, kind: "flags",
    bits: [["product-properties", 0, 4], ["light-on", 4, 1], ["allow-cycle", 7, 1]],
  },
  { name: "firmware-version", offset: 0x1f, length: 1, kind: "hex" },
  {
    name: "start-mode", offset: 0x20, length: 1, kind: "flags",
    bits: [["start-mode", 0, 3], ["button-stop", 3, 1], ["software-stop", 4, 1],
      ["repeat", 6, 1], ["pause-allowed", 7, 1]],
  },
  {
    name: "sensor-options", offset: 0x21, length: 1, kind: "flags",
    bits: [["pdf-password-protected", 0, 1], ["temperature-sensor-location", 1, 1],
      ["humidity-sensor-location", 2, 1], ["temperature-unit-F", 3, 1],
      ["temperature-alarm-mode", 4, 1], ["humidity-alarm-mode", 6, 1]],
  },
  {
    name: "alarm-types", offset: 0x22, length: 1, kind: "flags",
    bits: [["high-temp-alarm3", 0, 1], ["high-temp-alarm2", 1, 1], ["high-temp-alarm1", 2, 1],
      ["low-temp-alarm1", 3, 1], ["low-temp-alarm2", 4, 1], ["low-temp-alarm3", 5, 1],
      ["high-humidity-alarm", 6, 1], ["low-humidity-alarm", 7, 1]],
  },
  {
    name: "sensor-type", offset: 0x23, length: 1, kind: "flags",
    bits: [["exact-sensor-type", 0, 2], ["light-intensity", 4, 4]],
  },
  { name: "timezone-hours", offset: 0x24, length: 1, kind: "timezone-hours" },
  { name: "device-state", offset: 0x25, length: 1, kind: "run-state" },
  {
    name: "stop-mode", offset: 0x26, length: 1, kind: "flags",
    bits: [["actual-stop-mode", 0, 3], ["temporary-pdf", 3, 1], ["display-time", 4, 1]],
  },
  {
    name: "battery", offset: 0x27, length: 1, kind: "flags",
    bits: [["battery-level", 0, 4], ["csv", 4, 1]],
  },
  { name: "configuration-time", offset: 0x28, length: 7, kind: "date" },
  { name: "timezone-minutes", offset: 0x2f, length: 1, kind: "timezone-minutes" },
  { name: "start-time", offset: 0x30, length: 7, kind: "date" },
  { name: "stop-time", offset: 0x38, length: 7, kind: "date" },
  { name: "start-delay", offset: 0x40, length: 2, kind: "interval" },
  { name: "device-capacity", offset: 0x42, length: 4, kind: "uint" },
  { name: "record-number-high", offset: 0x46, length: 2, kind: "uint" },
  { name: "record-number", offset: 0x48, length: 2, kind: "uint" },
  { name: "interval", offset: 0x4c, length: 2, kind: "interval" },
  { name: "password", offset: 0x80, length: 6, kind: "string", secret: true, personal: true },
  // 2026-11-19: 0x0108 on an RC-5+ whose record of the same minute read
  // 26.4 °C; 0x0000 on an RC-5+ TE with erased settings, 0x00FE once
  // restored. Negative values not seen yet.
  { name: "current-temperature?", offset: 0x86, length: 2, kind: "tenths" },
  { name: "device-time", offset: 0x88, length: 7, kind: "date", ticks: true },
  { name: "protocol-version", offset: 0x95, length: 1, kind: "hex" },
  { name: "description", offset: 0x98, length: 100, kind: "string", personal: true },
  // Seen on an RC-5+ (2026-11-18): the "Mode Code" printed in the logger's CSV.
  { name: "mode-code", offset: 0xfd, length: 16, kind: "string" },
  { name: "device-name", offset: 0x13c, length: 25, kind: "string", personal: true },
]);

/**
 * Fields of the shadow space (op 0x05). Tentative ("?"): worked out from a
 * single RC-5+ dump on 2026-11-18 (7 records, 17:10:50..17:16:50), where the
 * main space's start/stop times only held the 2012 placeholder.
 * python-elitech PR #14 places the record count "at 0x85" on an RC-5; on
 * the RC-5+ it is the 2-byte word 0x84..0x85.
 */
export const SHADOW_FIELDS = Object.freeze([
  { name: "start-time?", offset: 0x01, length: 7, kind: "date" },
  { name: "first-record-time?", offset: 0x08, length: 7, kind: "date" },
  { name: "last-record-time?", offset: 0x12, length: 7, kind: "date" },
  { name: "record-count?", offset: 0x84, length: 2, kind: "uint" },
  // The last byte goes up by exactly the seconds elapsed between reads.
  { name: "seconds-counter?", offset: 0x8b, length: 4, kind: "uint", ticks: true },
]);

const FIELDS_BY_SPACE = { main: MAIN_FIELDS, shadow: SHADOW_FIELDS };

/**
 * The field covering a byte, or null if unmapped.
 *
 * @param {"main"|"shadow"} space
 * @param {number} offset
 */
export function fieldAt(space, offset) {
  return (
    (FIELDS_BY_SPACE[space] ?? []).find(
      (f) => offset >= f.offset && offset < f.offset + f.length,
    ) ?? null
  );
}

/**
 * Decode one field from a byte map. Returns null when bytes are missing.
 *
 * @param {object} field
 * @param {Map<number, number>} bytes  offset -> byte
 * @returns {string|null}
 */
export function decodeField(field, bytes) {
  const raw = new Uint8Array(field.length);
  for (let i = 0; i < field.length; i++) {
    const b = bytes.get(field.offset + i);
    if (b === undefined) {
      return null;
    }
    raw[i] = b;
  }

  switch (field.kind) {
    case "uint":
      return String(decodeUnsigned(raw));
    case "hex":
      return `0x${Buffer.from(raw).toString("hex")}`;
    case "string": {
      // Erased bytes read 0xFF on some firmware; treat them as padding.
      const text = decodeString(raw.map((b) => (b === 0xff ? 0 : b)));
      return JSON.stringify(text);
    }
    case "date":
      return decodeDateTime(raw) ?? "(unset)";
    case "interval":
      return `${decodeUnsigned(raw) * 10} s`;
    case "tenths":
      return `${(decodeUnsigned(raw) / 10).toFixed(1)} (raw ${decodeUnsigned(raw)})`;
    case "timezone-hours": {
      // Hours here, minutes at 0x2F: decode the pair like decodeInfo does.
      const block = new Uint8Array(12);
      block[0] = raw[0];
      block[11] = bytes.get(0x2f) ?? 0;
      return `UTC${decodeTimezone(block) ?? "?"}`;
    }
    case "timezone-minutes":
      return `${raw[0]} min (see timezone-hours)`;
    case "run-state":
      return decodeRunState(raw[0]);
    case "flags":
      return field.bits
        .map(([name, first, width]) => `${name}=${(raw[0] >> first) & ((1 << width) - 1)}`)
        .join(" ");
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

/**
 * Read a memory range in frame-sized blocks. A block that fails (e.g. the
 * logger stays silent) is recorded with its error and the dump carries on.
 *
 * @param {{ exchange: Function }} transport
 * @param {number} op      Operation.GetParameter or GetParameterShadow.
 * @param {number} start
 * @param {number} end     Exclusive.
 * @returns {Promise<Array<{offset: number, length: number, hex?: string, error?: string}>>}
 */
export async function readSpace(transport, op, start = DUMP_START, end = DUMP_END) {
  const blocks = [];
  for (let offset = start; offset < end; offset += MAX_FRAME_PAYLOAD) {
    const length = Math.min(MAX_FRAME_PAYLOAD, end - offset);
    try {
      const answer = await transport.exchange(buildFrame(op, offset, length));
      const data = parseResponse(op, offset, length, answer);
      blocks.push({ offset, length, hex: Buffer.from(data).toString("hex") });
    } catch (err) {
      blocks.push({ offset, length, error: err.message });
    }
  }
  return blocks;
}

/**
 * Turn a space's blocks into an offset -> byte map (failed blocks omitted).
 *
 * @param {{ blocks: object[] } | undefined} space
 * @returns {Map<number, number>}
 */
export function bytesOf(space) {
  const bytes = new Map();
  for (const block of space?.blocks ?? []) {
    if (block.hex === undefined) continue;
    const data = Buffer.from(block.hex, "hex");
    data.forEach((b, i) => bytes.set(block.offset + i, b));
  }
  return bytes;
}

/**
 * Read stored records with their raw bytes.
 *
 * @param {{ exchange: Function }} transport
 * @param {number} total            Record count reported by the logger.
 * @param {number} protocolVersion
 * @param {number|null} limit       First and last `limit` records, or all if null.
 */
async function readRawRecords(transport, total, protocolVersion, limit) {
  // Work out which 0-based indexes to fetch.
  const wanted = [];
  if (limit === null || total <= 2 * limit) {
    for (let i = 0; i < total; i++) wanted.push(i);
  } else {
    for (let i = 0; i < limit; i++) wanted.push(i);
    for (let i = total - limit; i < total; i++) wanted.push(i);
  }

  const out = [];
  let k = 0;
  while (k < wanted.length) {
    // Group consecutive indexes into frames of up to RECORDS_PER_FRAME.
    const first = wanted[k];
    let count = 1;
    while (
      k + count < wanted.length &&
      count < RECORDS_PER_FRAME &&
      wanted[k + count] === first + count
    ) {
      count++;
    }

    try {
      const answer = await transport.exchange(buildFrame(Operation.GetRecord, first, count));
      const data = parseResponse(Operation.GetRecord, first, count, answer);
      for (let i = 0; i < count; i++) {
        const raw = data.subarray(i * RECORD_LENGTH, (i + 1) * RECORD_LENGTH);
        out.push({
          index: first + i + 1,
          hex: Buffer.from(raw).toString("hex"),
          decoded: decodeRecord(raw, protocolVersion),
        });
      }
    } catch (err) {
      out.push({ index: first + 1, count, error: err.message });
    }
    k += count;
  }
  return out;
}

/**
 * USB details from sysfs and the mass-storage drive, with no logger traffic.
 * Does not mount anything.
 *
 * @param {{ devPath: string, usbDir: string|null }} device
 */
export function usbInfo(device) {
  const read = (name) => {
    if (!device.usbDir) return null;
    try {
      return fs.readFileSync(path.join(device.usbDir, name), "utf8").trim();
    } catch {
      return null;
    }
  };

  const blockDevices = device.usbDir ? findBlockDevices(device.usbDir) : [];
  let mountPoint = null;
  for (const name of blockDevices) {
    mountPoint = mountPointOf(name);
    if (mountPoint) break;
  }

  let files = [];
  if (mountPoint) {
    try {
      files = fs.readdirSync(mountPoint).sort().map((name) => {
        const stat = fs.statSync(path.join(mountPoint, name));
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      });
    } catch (err) {
      files = [{ name: `(cannot list: ${err.message})`, size: 0, modified: null }];
    }
  }

  return {
    devPath: device.devPath,
    usbDir: device.usbDir,
    vendorId: read("idVendor"),
    productId: read("idProduct"),
    manufacturer: read("manufacturer"),
    product: read("product"),
    usbSerial: read("serial"),
    bcdDevice: read("bcdDevice"),
    busnum: read("busnum"),
    devnum: read("devnum"),
    speed: read("speed"),
    blockDevices: blockDevices.map((n) => `/dev/${n}`),
    mountPoint,
    files,
  };
}

/**
 * Take a full read-only snapshot.
 *
 * @param {{ exchange: Function }} transport  Should be a ReadOnlyTransport.
 * @param {{ devPath: string, usbDir: string|null }} device
 * @param {object} [options]
 * @param {boolean} [options.shadow=false]   Also read the shadow space (op 0x05).
 * @param {boolean} [options.usb=true]       Include USB and drive details.
 * @param {false|number|null} [options.records=false]
 *   false: no records; null: all; a number: first and last N.
 */
export async function takeSnapshot(transport, device, options = {}) {
  const { shadow = false, usb = true, records = false } = options;

  const snapshot = {
    format: DUMP_FORMAT,
    createdAt: new Date().toISOString(),
    redacted: false,
    range: { start: DUMP_START, end: DUMP_END },
    usb: usb ? usbInfo(device) : null,
    spaces: {
      main: { op: Operation.GetParameter, blocks: await readSpace(transport, Operation.GetParameter) },
    },
  };

  if (shadow) {
    snapshot.spaces.shadow = {
      op: Operation.GetParameterShadow,
      blocks: await readSpace(transport, Operation.GetParameterShadow),
    };
  }

  const main = bytesOf(snapshot.spaces.main);
  snapshot.fields = MAIN_FIELDS.map((f) => ({
    name: f.name,
    offset: f.offset,
    length: f.length,
    value: decodeField(f, main),
  }));

  if (records !== false) {
    const count = Number(decodeField({ offset: 0x48, length: 2, kind: "uint" }, main));
    const protocol = main.get(0x95) ?? 0;
    snapshot.records = {
      total: Number.isFinite(count) ? count : null,
      limit: records,
      read: Number.isFinite(count) ? await readRawRecords(transport, count, protocol, records) : [],
    };
  }

  return snapshot;
}

/**
 * File name for a saved snapshot: <serial>-YYYYMMDD-HHMMSS[-label].json
 *
 * @param {object} snapshot
 * @param {string} [label]  e.g. "before-reset"
 * @returns {string}
 */
export function dumpFileName(snapshot, label = "") {
  const d = new Date(snapshot.createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const who = snapshot.redacted ? "redacted" : (serialOf(snapshot) ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${who}-${stamp}${label ? `-${label}` : ""}.json`;
}

/**
 * Write a snapshot to `dir` (created if needed), readable only by the
 * owner since it may hold the PDF password.
 *
 * @param {object} snapshot
 * @param {string} dir
 * @param {string} [label]
 * @returns {string} Path of the file written.
 */
export function saveSnapshot(snapshot, dir, label = "") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, dumpFileName(snapshot, label));
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  return file;
}

/**
 * The main-space bytes of a saved snapshot as a settings image
 * (0x00 up to `end`), for restores. Throws if any byte is missing.
 *
 * @param {object} snapshot
 * @param {number} end  Exclusive.
 * @returns {Uint8Array}
 */
export function settingsImageOf(snapshot, end) {
  if (snapshot?.format !== DUMP_FORMAT) {
    throw new Error(`Not an rc5plus dump (format ${snapshot?.format ?? "missing"})`);
  }
  if (snapshot.redacted) {
    throw new Error("A redacted dump can't be used: its serial, description and password are blank");
  }
  const bytes = bytesOf(snapshot.spaces.main);
  const image = new Uint8Array(end);
  for (let i = 0; i < end; i++) {
    const b = bytes.get(i);
    if (b === undefined) {
      throw new Error(`The dump has no byte at 0x${i.toString(16)} (that block failed to read)`);
    }
    image[i] = b;
  }
  return image;
}

/**
 * The logger's serial number from a snapshot, or null.
 */
export function serialOf(snapshot) {
  const field = MAIN_FIELDS.find((f) => f.name === "serial-number");
  const value = decodeField(field, bytesOf(snapshot.spaces.main));
  const text = value ? JSON.parse(value) : "";
  return text || null;
}

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

/**
 * A copy of the snapshot with personal data removed, safe to share:
 *   - serial number, password, description and device name blanked (0x00)
 *   - any other copy of the serial number, in either space, blanked
 *   - the serial number replaced in file names and USB strings
 *   - the user name removed from the mount point
 *
 * @param {object} snapshot
 * @returns {object}
 */
export function redactSnapshot(snapshot) {
  const copy = structuredClone(snapshot);
  const serial = serialOf(snapshot);
  const serialBytes = serial ? Buffer.from(serial, "ascii") : null;

  for (const [spaceName, space] of Object.entries(copy.spaces)) {
    for (const block of space.blocks) {
      if (block.hex === undefined) continue;
      const data = Buffer.from(block.hex, "hex");

      // Known personal fields (main space only).
      if (spaceName === "main") {
        for (const f of MAIN_FIELDS.filter((x) => x.personal)) {
          for (let i = f.offset; i < f.offset + f.length; i++) {
            const at = i - block.offset;
            if (at >= 0 && at < data.length) data[at] = 0;
          }
        }
      }

      // Stray copies of the serial number anywhere.
      if (serialBytes) {
        let at = data.indexOf(serialBytes);
        while (at !== -1) {
          data.fill(0, at, at + serialBytes.length);
          at = data.indexOf(serialBytes, at + 1);
        }
      }
      block.hex = data.toString("hex");
    }
  }

  const scrub = (text) =>
    typeof text === "string" && serial ? text.replaceAll(serial, "<serial>") : text;

  if (copy.usb) {
    for (const key of Object.keys(copy.usb)) {
      if (typeof copy.usb[key] === "string") copy.usb[key] = scrub(copy.usb[key]);
    }
    if (copy.usb.mountPoint) {
      copy.usb.mountPoint = copy.usb.mountPoint.replace(/^\/run\/media\/[^/]+/, "/run/media/<user>");
    }
    copy.usb.files = copy.usb.files.map((f) => ({ ...f, name: scrub(f.name) }));
  }

  const main = bytesOf(copy.spaces.main);
  copy.fields = MAIN_FIELDS.map((f) => ({
    name: f.name,
    offset: f.offset,
    length: f.length,
    value: f.personal ? "(redacted)" : decodeField(f, main),
  }));
  copy.redacted = true;
  return copy;
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

/**
 * Byte-level differences between two snapshots, per memory space.
 *
 * @returns {Array<{ space: string, offset: number, field: string|null,
 *                   before: number|undefined, after: number|undefined }>}
 */
export function diffSnapshots(a, b) {
  const changes = [];
  const spaces = new Set([...Object.keys(a.spaces ?? {}), ...Object.keys(b.spaces ?? {})]);
  for (const space of spaces) {
    const before = bytesOf(a.spaces[space]);
    const after = bytesOf(b.spaces[space]);
    const offsets = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => x - y);
    for (const offset of offsets) {
      if (before.get(offset) !== after.get(offset)) {
        changes.push({
          space,
          offset,
          field: fieldAt(space, offset)?.name ?? null,
          before: before.get(offset),
          after: after.get(offset),
        });
      }
    }
  }
  return changes;
}

/**
 * Drop changes to clocks (fields marked `ticks`) unless something else
 * changed too, so a watch only prints when the logger actually did something.
 *
 * @param {Array} changes  From diffSnapshots().
 * @returns {Array}
 */
export function withoutClockNoise(changes) {
  const ticking = (c) => Boolean(fieldAt(c.space, c.offset)?.ticks);
  return changes.some((c) => !ticking(c)) ? changes : [];
}

// -----------------------------------------------------------------------------
// Text output
// -----------------------------------------------------------------------------

const hex2 = (b) => (b === undefined ? "--" : b.toString(16).padStart(2, "0"));
const addr = (n) => `0x${n.toString(16).padStart(3, "0")}`;

/** Should this byte be masked as a secret in terminal output? */
function isSecret(space, offset) {
  const f = space === "main" ? fieldAt("main", offset) : null;
  return Boolean(f?.secret);
}

/**
 * Classic 16-bytes-per-line hex and ASCII dump.
 */
function hexDump(space, bytes, start, end, showSecrets) {
  const lines = [];
  for (let line = start - (start % 16); line < end; line += 16) {
    const hex = [];
    let ascii = "";
    for (let i = line; i < line + 16; i++) {
      if (i < start || i >= end) {
        hex.push("  ");
        ascii += " ";
        continue;
      }
      const b = bytes.get(i);
      if (b !== undefined && !showSecrets && isSecret(space, i)) {
        hex.push("**");
        ascii += "*";
        continue;
      }
      hex.push(hex2(b));
      ascii += b === undefined ? " " : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    lines.push(`  ${addr(line)}  ${hex.slice(0, 8).join(" ")}  ${hex.slice(8).join(" ")}  |${ascii}|`);
  }
  return lines;
}

/**
 * Runs of unmapped bytes that are neither 0x00 nor 0xFF.
 */
function unmappedRuns(space, bytes) {
  const runs = [];
  let run = null;
  const offsets = [...bytes.keys()].sort((x, y) => x - y);
  for (const offset of offsets) {
    const b = bytes.get(offset);
    const interesting = !fieldAt(space, offset) && b !== 0x00 && b !== 0xff;
    if (interesting && run && offset === run.start + run.bytes.length) {
      run.bytes.push(b);
    } else if (interesting) {
      run = { start: offset, bytes: [b] };
      runs.push(run);
    } else {
      run = null;
    }
  }
  return runs;
}

/**
 * Human-readable snapshot.
 *
 * @param {object} snapshot
 * @param {{ showSecrets?: boolean }} [options]
 * @returns {string}
 */
export function formatSnapshot(snapshot, { showSecrets = false } = {}) {
  const out = [];
  out.push(`RC-5+ dump  ${snapshot.createdAt}  (read-only${snapshot.redacted ? ", redacted" : ""})`);

  if (snapshot.usb) {
    const u = snapshot.usb;
    out.push("", "USB");
    out.push(`  ${u.devPath}  ${u.vendorId}:${u.productId}  "${u.manufacturer} ${u.product}"  ` +
      `serial "${u.usbSerial}"  bcdDevice ${u.bcdDevice}  bus ${u.busnum} dev ${u.devnum}  ${u.speed} Mb/s`);
    if (u.blockDevices.length === 0) {
      out.push("  Drive: no block device");
    } else {
      out.push(`  Drive: ${u.blockDevices.join(", ")}  ${u.mountPoint ? `mounted at ${u.mountPoint}` : "not mounted"}`);
    }
    for (const f of u.files) {
      out.push(`    ${f.name}  ${f.size.toLocaleString("en-GB")} bytes  ${f.modified ?? ""}`);
    }
  }

  for (const [name, space] of Object.entries(snapshot.spaces)) {
    const opHex = `0x${space.op.toString(16).padStart(4, "0")}`;
    const label = name === "main" ? "Main memory" : "Shadow memory (unconfirmed on the RC-5+)";
    out.push("", `${label}, read with operation ${opHex}, ${addr(snapshot.range.start)}..${addr(snapshot.range.end - 1)}`);
    const bytes = bytesOf(space);
    out.push(...hexDump(name, bytes, snapshot.range.start, snapshot.range.end, showSecrets));
    for (const block of space.blocks.filter((b) => b.error)) {
      out.push(`  ${addr(block.offset)}..${addr(block.offset + block.length - 1)}  no answer: ${block.error}`);
    }

    out.push("", `  Fields (${name}):`);
    for (const f of FIELDS_BY_SPACE[name]) {
      let value = decodeField(f, bytes);
      if (snapshot.redacted && f.personal) value = "(redacted)";
      else if (f.secret && !showSecrets && value !== null) value = "(hidden; --show-password to show)";
      const raw = [];
      for (let i = f.offset; i < f.offset + Math.min(f.length, 8); i++) {
        raw.push(f.secret && !showSecrets ? "**" : hex2(bytes.get(i)));
      }
      const more = f.length > 8 ? " …" : "";
      out.push(`    ${addr(f.offset)}  ${f.name.padEnd(22)} ${raw.join(" ")}${more}`.padEnd(70) + `  ${value ?? "(not read)"}`);
    }

    const runs = unmappedRuns(name, bytes);
    out.push("", `  Unmapped bytes that are not 00/ff (${name}):`);
    if (runs.length === 0) out.push("    none");
    for (const run of runs) {
      out.push(`    ${addr(run.start)}  ${run.bytes.map(hex2).join(" ")}`);
    }
  }

  if (snapshot.records) {
    const r = snapshot.records;
    const which = r.limit === null ? "all" : `first and last ${r.limit}`;
    out.push("", `Records: ${r.total ?? "?"} stored, showing ${which}`);
    for (const rec of r.read) {
      if (rec.error) {
        out.push(`  #${rec.index} (+${rec.count - 1})  no answer: ${rec.error}`);
      } else if (rec.decoded === null) {
        out.push(`  #${String(rec.index).padStart(5)}  ${rec.hex}  (empty slot)`);
      } else {
        const d = rec.decoded;
        const flags = d.flags ? `  flags 0x${d.flags.toString(16)}` : "";
        out.push(`  #${String(rec.index).padStart(5)}  ${rec.hex}  ${d.time}  ${d.temperature}${flags}`);
      }
    }
  }

  return out.join("\n");
}

/**
 * Describe a list of byte changes, grouped by field, with decoded values.
 *
 * @param {Array} changes  From diffSnapshots().
 * @param {object} a       Snapshot before.
 * @param {object} b       Snapshot after.
 * @returns {string[]}
 */
export function formatChanges(changes, a, b) {
  const lines = [];
  const seenFields = new Set();
  for (const c of changes) {
    const bytesLine = `${c.space.padEnd(6)} ${addr(c.offset)}  ${hex2(c.before)} → ${hex2(c.after)}`;
    if (c.field === null) {
      lines.push(`${bytesLine}  (unmapped)`);
      continue;
    }
    const key = `${c.space}:${c.field}`;
    if (seenFields.has(key)) {
      lines.push(`${bytesLine}  ${c.field}`);
      continue;
    }
    seenFields.add(key);
    const field = FIELDS_BY_SPACE[c.space].find((f) => f.name === c.field);
    const was = decodeField(field, bytesOf(a.spaces[c.space]));
    const now = decodeField(field, bytesOf(b.spaces[c.space]));
    const secret = field.secret;
    lines.push(`${bytesLine}  ${c.field}: ${secret ? "(hidden)" : was} → ${secret ? "(hidden)" : now}`);
  }
  return lines;
}

/**
 * Human-readable comparison of two snapshots.
 *
 * @returns {string}
 */
export function formatDiff(a, b) {
  const changes = diffSnapshots(a, b);
  const out = [`Comparing ${a.createdAt} → ${b.createdAt}`];
  if (a.redacted !== b.redacted) {
    out.push("Note: one dump is redacted and the other is not; personal fields will differ.");
  }
  if (changes.length === 0) {
    out.push("No differences.");
  } else {
    out.push(`${changes.length} byte(s) differ:`, ...formatChanges(changes, a, b));
  }
  return out.join("\n");
}
