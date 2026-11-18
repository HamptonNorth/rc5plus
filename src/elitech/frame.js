// =============================================================================
// File:    src/elitech/frame.js
// Version: 1.1.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Building request frames and parsing response frames.
//
// Frame layout (request and response share it):
//
//   index  0..2   0x33 0xCC 0x00          fixed header
//   index  3      total frame length       (including the checksum byte)
//   index  4..5   operation                little-endian 16-bit
//   index  6      0x00                     reserved
//   index  7      offset bits 15..8
//   index  8      offset bits  7..0
//   index  9      offset bits 23..16
//   index 10      count                    bytes (parameters) or records
//   index 11..    payload                  only for SetParameter requests
//   last          checksum                 sum of all previous bytes & 0xFF
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

import {
  FRAME_HEADER,
  FRAME_PAYLOAD_INDEX,
  MAX_FRAME_PAYLOAD,
  Operation,
  RECORD_LENGTH,
} from "./constants.js";

/**
 * Error raised when a response frame cannot be trusted.
 */
export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
}

/**
 * Sum all bytes and keep the low 8 bits.
 *
 * @param {ArrayLike<number>} bytes
 * @returns {number}
 */
export function checksum(bytes) {
  let total = 0;
  for (const b of bytes) {
    total += b;
  }
  return total & 0xff;
}

/**
 * The device refuses single-byte parameter reads, so python-elitech widens
 * them to a 2-byte read starting one byte earlier. We do the same so that the
 * requests on the wire are identical to the tested library.
 *
 * @param {number} op
 * @param {number} offset
 * @param {number} count
 * @returns {{ offset: number, count: number }}
 */
function correctRange(op, offset, count) {
  if (op === Operation.GetParameter && count === 1) {
    return { offset: Math.max(0, offset - 1), count: 2 };
  }
  return { offset, count };
}

/**
 * Build a request frame.
 *
 * @param {number} op            One of `Operation`.
 * @param {number} offset        Parameter address or record index (0..0xFFFFFF).
 * @param {number|Uint8Array} countOrPayload
 *   - number:     how many bytes/records to read (1..52)
 *   - Uint8Array: the bytes to write (SetParameter, Stop, Format)
 * @returns {Uint8Array} The frame, without HID padding.
 */
export function buildFrame(op, offset, countOrPayload) {
  if (!Object.values(Operation).includes(op)) {
    throw new RangeError(`Invalid operation: ${op}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffff) {
    throw new RangeError(`Invalid offset: ${offset}`);
  }

  // Work out the count byte and the payload bytes.
  let count;
  let payload;
  if (countOrPayload instanceof Uint8Array) {
    if (countOrPayload.length > MAX_FRAME_PAYLOAD) {
      throw new RangeError(`Too much data: ${countOrPayload.length}`);
    }
    count = countOrPayload.length;
    payload = Array.from(countOrPayload);
  } else if (Number.isInteger(countOrPayload)) {
    if (countOrPayload <= 0 || countOrPayload > MAX_FRAME_PAYLOAD) {
      throw new RangeError(`Invalid length: ${countOrPayload}`);
    }
    count = countOrPayload;
    payload = [];
  } else {
    throw new TypeError("countOrPayload must be a number or Uint8Array");
  }

  const corrected = correctRange(op, offset, count);

  const frame = [
    ...FRAME_HEADER,
    0x00, // length placeholder, filled in below
    op & 0xff,
    (op >> 8) & 0xff,
    0x00,
    (corrected.offset >> 8) & 0xff,
    corrected.offset & 0xff,
    (corrected.offset >> 16) & 0xff,
    corrected.count & 0xff,
    ...payload,
  ];

  // Total length includes the checksum byte appended next.
  frame[3] = frame.length + 1;
  frame.push(checksum(frame));

  return Uint8Array.from(frame);
}

/**
 * Decode the 24-bit offset from a frame (same byte order as buildFrame).
 *
 * @param {Uint8Array} frame
 * @returns {number}
 */
function frameOffset(frame) {
  return (frame[9] << 16) + (frame[7] << 8) + frame[8];
}

/**
 * Parse and validate a response to a request built with `buildFrame`.
 *
 * Validation is stricter than python-elitech (which only warns) because a
 * web app should never silently act on a mismatched answer:
 *   - header, operation, offset and count must all match the request
 *   - the checksum must be correct
 *
 * @param {number} op          The request's operation.
 * @param {number} offset      The request's offset (before range correction).
 * @param {number} count       The request's count (bytes or records).
 * @param {Uint8Array} answer  Raw 64-byte input report.
 * @returns {Uint8Array|boolean}
 *   - GetParameter / GetParameterShadow: exactly `count` bytes from `offset`
 *   - GetRecord:    exactly `count * 8` bytes of record data
 *   - SetParameter: true if the device accepted the write
 */
export function parseResponse(op, offset, count, answer) {
  if (answer.length < FRAME_PAYLOAD_INDEX) {
    throw new FrameError(`Answer too short: ${answer.length} bytes`);
  }
  for (let i = 0; i < FRAME_HEADER.length; i++) {
    if (answer[i] !== FRAME_HEADER[i]) {
      throw new FrameError("Invalid answer header");
    }
  }

  // python-elitech compares only the low byte of the operation code.
  if (answer[4] !== (op & 0xff)) {
    throw new FrameError(
      `Answer operation 0x${answer[4].toString(16)} does not match request`,
    );
  }

  // The checksum covers everything before the checksum byte.
  const frameLength = answer[3];
  if (frameLength < FRAME_PAYLOAD_INDEX + 1 || frameLength > answer.length) {
    throw new FrameError(`Invalid answer length byte: ${frameLength}`);
  }
  const expectedSum = checksum(answer.subarray(0, frameLength - 1));
  if (answer[frameLength - 1] !== expectedSum) {
    throw new FrameError("Invalid answer checksum");
  }

  const corrected = correctRange(op, offset, count);
  const expectedCount = op === Operation.SetParameter ? 1 : corrected.count;

  if (frameOffset(answer) !== corrected.offset) {
    throw new FrameError(
      `Answer offset ${frameOffset(answer)} does not match ${corrected.offset}`,
    );
  }
  if (answer[10] !== expectedCount) {
    throw new FrameError(
      `Answer count ${answer[10]} does not match ${expectedCount}`,
    );
  }

  // SetParameter: a single status byte, 1 = accepted.
  if (op === Operation.SetParameter) {
    return answer[FRAME_PAYLOAD_INDEX] === 1;
  }

  // GetRecord: `count` records of 8 bytes each.
  if (op === Operation.GetRecord) {
    const bytes = count * RECORD_LENGTH;
    if (answer.length < FRAME_PAYLOAD_INDEX + bytes) {
      throw new FrameError("Answer does not contain all records");
    }
    return answer.slice(FRAME_PAYLOAD_INDEX, FRAME_PAYLOAD_INDEX + bytes);
  }

  // GetParameter (or the shadow read): strip the extra leading byte that
  // correctRange() adds to 1-byte GetParameter reads (none for shadow).
  const skip = offset - corrected.offset;
  if (answer.length < FRAME_PAYLOAD_INDEX + corrected.count) {
    throw new FrameError("Answer does not contain all data");
  }
  return answer.slice(
    FRAME_PAYLOAD_INDEX + skip,
    FRAME_PAYLOAD_INDEX + skip + count,
  );
}
