// =============================================================================
// File:    src/elitech/mock-device.js
// Version: 1.5.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// A simulated RC-5+ that speaks the same frame protocol as the real logger.
// Used by the test suite and by `RC5_MOCK=1 bun start`, so the app can be
// developed and demonstrated with no hardware attached.
//
// The simulator implements GetParameter, SetParameter, GetRecord, Stop and
// Format against an in-memory parameter map and record list. It is NOT a
// substitute for testing on a real logger.
//
// Behaviour copied from a real RC-5+ (firmware 0x57, protocol 0x38):
//   - SetParameter is always acknowledged, but the value is only kept when
//     a Format follows. Until then reads return the old value.
//   - Format commits those pending writes, erases the records and leaves
//     the logger "configured" (0x25 = 0x04). Writing the configuration time
//     sets the clock.
//   - With { keepsUnwrittenSettings: false } it behaves like the RC-5+ TE
//     seen on 2026-11-19: a Format turns every settings byte in 0x10..0x7F
//     that wasn't written since the last Format into 0xFF (record counts
//     and capacity excepted), and keeps bits 6..7 of 0x25.
//   - While recording, writes are acknowledged and thrown away.
//   - A USB Stop marks the stop mode as "software".
//   - The shadow space (op 0x05) models the trip times at 0x01 (start),
//     0x08 (first record) and 0x12 (last record) and the 2-byte record
//     count at 0x84, as seen on a real RC-5+; after a Format the times read
//     as 0x00 / 0xFF like the hardware. Everything else is zero.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FRAME_HEADER,
  FRAME_PAYLOAD_INDEX,
  Operation,
  RC5PLUS_PRODUCT_ID,
  REPORT_SIZE,
} from "./constants.js";
import { checksum } from "./frame.js";
import {
  DeviceState,
  ShadowParam,
  encodeDateTime,
  encodeInterval,
  Param,
  StopMode,
} from "./parameters.js";
import { Flags } from "./records.js";

/**
 * Encode one record in the logger's packed 8-byte format
 * (the inverse of records.decodeRecord, for temperature-only records).
 *
 * @param {Date} time
 * @param {number} temperature  Degrees, one decimal place.
 * @param {number} [flags=0]
 * @returns {Uint8Array}
 */
export function encodeRecord(time, temperature, flags = 0) {
  const raw = Math.round(Math.abs(temperature) * 10);
  const sign = temperature < 0 ? Flags.Sign1 : 0;

  let q = 0n;
  q |= BigInt(time.getMinutes()) << 48n;
  q |= BigInt(raw & 0x7ff) << 37n;
  q |= BigInt(time.getHours()) << 32n;
  q |= BigInt(time.getDate()) << 27n;
  q |= BigInt(time.getMonth() + 1) << 23n;
  q |= BigInt(time.getFullYear() - 2000) << 16n;
  q |= BigInt(time.getSeconds()) << 10n;
  q |= BigInt((flags | sign) & 0xff);

  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((q >> BigInt(8 * i)) & 0xffn);
  }
  return bytes;
}

/**
 * Wrap a response payload in a frame with header, length and checksum.
 */
function responseFrame(opLow, offset, count, payload) {
  const frame = [
    ...FRAME_HEADER,
    0x00,
    opLow,
    0x00,
    0x00,
    (offset >> 8) & 0xff,
    offset & 0xff,
    (offset >> 16) & 0xff,
    count & 0xff,
    ...payload,
  ];
  frame[3] = frame.length + 1;
  frame.push(checksum(frame));

  const report = new Uint8Array(REPORT_SIZE);
  report.set(frame);
  return report;
}

/**
 * In-memory RC-5+.
 */
export class MockRc5Plus {
  /**
   * @param {object} [options]
   * @param {string} [options.serialNumber]
   * @param {number} [options.recordCount]      Records to pre-load.
   * @param {number} [options.intervalSeconds]
   * @param {number} [options.protocolVersion]  Default 0x38, as the real RC-5+.
   * @param {boolean} [options.keepsUnwrittenSettings=true]
   *   false: a Format erases settings that weren't written first (RC-5+ TE).
   * @param {number[]} [options.ignoredOffsets]
   *   Bytes whose writes are acknowledged but never kept (to test read-back).
   * @param {"stopped"|"recording"|"ready"} [options.state]
   *   "stopped" (default) is a logger stopped with its button;
   *   "recording" is one that is recording and paused for USB;
   *   "ready" is one that has been reset and not started.
   */
  constructor({
    serialNumber = "EF2412345678",
    recordCount = 288,
    intervalSeconds = 300,
    state = "stopped",
    protocolVersion = 0x38,
    keepsUnwrittenSettings = true,
    ignoredOffsets = [],
  } = {}) {
    this.keepsUnwrittenSettings = keepsUnwrittenSettings;
    this.ignoredOffsets = new Set(ignoredOffsets);
    this.memory = new Uint8Array(0x200);
    this.records = [];
    this.log = []; // every request frame received, for tests
    /** @type {Array<{offset: number, bytes: Uint8Array}>} writes awaiting a Format */
    this.pending = [];
    /** Second "shadow" memory space read by op 0x05 (layout is a guess). */
    this.shadow = new Uint8Array(0x200);
    /** Device clock minus real time, in ms (changed by a committed config time). */
    this.clockOffsetMs = 0;

    // Identity and settings.
    this.memory.set([(RC5PLUS_PRODUCT_ID >> 8) & 0xff, RC5PLUS_PRODUCT_ID & 0xff], Param.model.offset);
    this.memory.set(new TextEncoder().encode(serialNumber.padEnd(12, "\0")), Param.serialNumber.offset);
    this.memory[Param.firmwareVersion.offset] = 0x15;
    this.memory[Param.startMode.offset] = 0b001; // Manual (button)
    this.memory[Param.batteryLevel.offset] = 0x04;
    this.memory[Param.protocolVersion.offset] = protocolVersion;
    // Like the real logger: the main start/stop times hold a placeholder.
    const placeholder = [0x0c, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01];
    this.memory.set([0x00, 0x00, 0x7d, 0x00], Param.deviceCapacity.offset); // 32000
    this.memory.set(encodeInterval(intervalSeconds), Param.interval.offset);
    // Bits 3 and 4 of 0x26 (temporary-pdf, display-time) are set on the
    // real logger; keep them so the byte looks the same (0x18 / 0x1b).
    this.memory[Param.stopMode.offset] = 0b0001_1000;
    // A valid time zone (UTC: hours 0, minutes 0) and start delay, like a
    // logger set up by the official software.
    this.memory[Param.timezone.offset] = 0x00;
    this.memory[Param.timezone.offset + 11] = 0x00;
    this.memory.set(new TextEncoder().encode("Mock fridge"), Param.description.offset);
    this.setRunState(state);

    // A recording that started `recordCount` intervals ago.
    const now = new Date();
    now.setSeconds(0, 0);
    const start = new Date(now.getTime() - recordCount * intervalSeconds * 1000);
    this.memory.set(encodeDateTime(start), Param.configurationTime.offset);
    this.memory.set(placeholder, Param.startTime.offset);
    this.memory.set(placeholder, Param.stopTime.offset);

    for (let i = 0; i < recordCount; i++) {
      const t = new Date(start.getTime() + i * intervalSeconds * 1000);
      // A fridge cycling around 4 °C, with a door-open spike.
      const temp = 4 + 1.2 * Math.sin(i / 9) + (i % 97 === 50 ? 5.5 : 0);
      this.records.push(encodeRecord(t, Math.round(temp * 10) / 10));
    }
    this.syncRecordCount();
    this.clearShadowTimes();
    if (recordCount > 0) {
      const last = new Date(start.getTime() + (recordCount - 1) * intervalSeconds * 1000);
      this.setShadowTime(ShadowParam.tripStartTime, start, 0x00);
      this.setShadowTime(ShadowParam.firstRecordTime, start, 0xff);
      this.setShadowTime(ShadowParam.lastRecordTime, last, 0xff);
    }
  }

  /**
   * Write a shadow trip time. The real logger puts 0x00 or 0xFF in the
   * day-of-week byte here, so the caller chooses which.
   */
  setShadowTime(field, date, dowByte) {
    const bytes = encodeDateTime(date);
    bytes[2] = dowByte;
    this.shadow.set(bytes, field.offset);
  }

  /** Shadow trip times as seen on hardware straight after a reset. */
  clearShadowTimes() {
    this.shadow.fill(0x00, ShadowParam.tripStartTime.offset, ShadowParam.tripStartTime.offset + 7);
    this.shadow.fill(0xff, ShadowParam.firstRecordTime.offset, ShadowParam.firstRecordTime.offset + 7);
    this.shadow.fill(0xff, ShadowParam.lastRecordTime.offset, ShadowParam.lastRecordTime.offset + 7);
  }

  /**
   * Put the simulated logger into a run state.
   *
   * @param {"stopped"|"recording"|"ready"|number} state  A name, or a raw 0x25 value.
   */
  setRunState(state) {
    const stopModeByte = this.memory[Param.stopMode.offset] & ~0b111;
    if (state === "ready") {
      this.memory[Param.deviceState.offset] = DeviceState.Configured;
      this.memory[Param.stopMode.offset] = stopModeByte | StopMode.UsbPause;
    } else if (state === "recording") {
      this.memory[Param.deviceState.offset] = DeviceState.Recording;
      this.memory[Param.stopMode.offset] = stopModeByte | StopMode.UsbPause;
    } else if (state === "stopped") {
      this.memory[Param.deviceState.offset] = DeviceState.Stopped;
      this.memory[Param.stopMode.offset] = stopModeByte | StopMode.Button;
    } else {
      this.memory[Param.deviceState.offset] = state;
    }
  }

  /** True when the simulated logger is recording. */
  get recording() {
    return (this.memory[Param.deviceState.offset] & 0x3f) === DeviceState.Recording;
  }

  /** Mirror the record list length into the record-number parameter. */
  syncRecordCount() {
    const n = this.records.length;
    this.memory.set([(n >> 8) & 0xff, n & 0xff], Param.recordNumber.offset);
    this.shadow.set([(n >> 8) & 0xff, n & 0xff], 0x84);
  }

  /** Keep the device clock parameter current. */
  syncClock() {
    const clock = new Date(Date.now() + this.clockOffsetMs);
    this.memory.set(encodeDateTime(clock), Param.deviceTime.offset);
  }

  /**
   * Apply the writes held since the last Format. A committed configuration
   * time also sets the device clock, as on the real logger.
   */
  commitPending() {
    const written = new Set();
    for (const { offset, bytes } of this.pending) {
      bytes.forEach((b, i) => {
        if (!this.ignoredOffsets.has(offset + i)) {
          this.memory[offset + i] = b;
          written.add(offset + i);
        }
      });

      const cfg = Param.configurationTime;
      if (offset <= cfg.offset && offset + bytes.length >= cfg.offset + cfg.length) {
        const [yy, mo, , dd, hh, mi, ss] = bytes.subarray(cfg.offset - offset);
        const configured = new Date(2000 + yy, mo - 1, dd, hh, mi, ss);
        this.clockOffsetMs = configured.getTime() - Date.now();
      }
    }
    if (!this.keepsUnwrittenSettings) {
      for (let i = 0x10; i < 0x80; i++) {
        const kept = i >= 0x42 && i < 0x4a; // capacity and record counts
        if (!kept && !written.has(i)) {
          this.memory[i] = 0xff;
        }
      }
    }
    this.pending = [];
  }

  /**
   * Handle one 64-byte request and return the 64-byte answer.
   *
   * @param {Uint8Array} request
   * @returns {Uint8Array}
   */
  handle(request) {
    this.log.push(Uint8Array.from(request));
    this.syncClock();

    const length = request[3];
    if (checksum(request.subarray(0, length - 1)) !== request[length - 1]) {
      throw new Error("Mock: bad request checksum");
    }

    const op = request[4] | (request[5] << 8);
    const offset = (request[9] << 16) + (request[7] << 8) + request[8];
    const count = request[10];
    const payload = request.slice(FRAME_PAYLOAD_INDEX, FRAME_PAYLOAD_INDEX + count);

    switch (op) {
      case Operation.GetParameter:
        return responseFrame(op & 0xff, offset, count, this.memory.slice(offset, offset + count));

      case Operation.GetParameterShadow:
        return responseFrame(op & 0xff, offset, count, this.shadow.slice(offset, offset + count));

      case Operation.SetParameter:
        // Like the real logger: always acknowledge. Hold the write until a
        // Format commits it, or throw it away while recording.
        if (!this.recording) {
          this.pending.push({ offset, bytes: Uint8Array.from(payload) });
        }
        return responseFrame(op & 0xff, offset, 1, [1]);

      case Operation.GetRecord: {
        const data = [];
        for (let i = 0; i < count; i++) {
          data.push(...(this.records[offset + i] ?? new Uint8Array(8).fill(0xff)));
        }
        return responseFrame(op & 0xff, offset, count, data);
      }

      case Operation.Stop:
        // The real logger leaves the main stop time at its placeholder.
        this.memory[Param.deviceState.offset] = DeviceState.Stopped;
        this.memory[Param.stopMode.offset] =
          (this.memory[Param.stopMode.offset] & ~0b111) | StopMode.Software;
        return responseFrame(op & 0xff, 0, 1, [1]);

      case Operation.Format:
        this.commitPending();
        this.records = [];
        this.syncRecordCount();
        this.clearShadowTimes();
        // Seen on hardware after a reset: 0x25 = 0x04, 0x26 = 0x1b; on the
        // TE whose settings were erased, 0x25 = 0xC4 (bits 6..7 kept).
        this.memory[Param.deviceState.offset] =
          (this.memory[Param.deviceState.offset] & 0xc0) | DeviceState.Configured;
        this.memory[Param.stopMode.offset] =
          (this.memory[Param.stopMode.offset] & ~0b111) | StopMode.UsbPause;
        return responseFrame(op & 0xff, 0, 1, [1]);

      default:
        throw new Error(`Mock: unsupported operation 0x${op.toString(16)}`);
    }
  }
}

/**
 * Transport adapter so MockRc5Plus can stand in for HidrawTransport.
 */
export class MockTransport {
  constructor(device) {
    this.device = device;
  }

  async exchange(frame) {
    const report = new Uint8Array(REPORT_SIZE);
    report.set(frame);
    return this.device.handle(report);
  }

  close() {}
}

/**
 * Create a fake mounted "USB drive" containing a sample PDF report, so the
 * PDF view/download path can be exercised without hardware.
 *
 * @param {string} serialNumber
 * @returns {string} Directory acting as the mount point.
 */
export function createMockDrive(serialNumber) {
  const dir = path.join(os.tmpdir(), "rc5plus-mock-drive");
  fs.mkdirSync(dir, { recursive: true });

  // Minimal valid one-page PDF.
  const text = `Elitech RC-5+ mock report - ${serialNumber}`;
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) {
    pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  fs.writeFileSync(path.join(dir, `${serialNumber}.pdf`), pdf);
  return dir;
}
