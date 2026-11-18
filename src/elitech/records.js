// =============================================================================
// File:    src/elitech/records.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Decoding of the 8-byte packed measurement records.
//
// Each record is a 64-bit little-endian word laid out as:
//
//   bits 63..54  humidity      (10 bits, tenths; 0 on the RC-5+)
//   bits 53..48  minute        (6 bits)
//   bits 47..37  temperature   (11 bits, tenths, magnitude only)
//   bits 36..32  hour          (5 bits)
//   bits 31..27  day           (5 bits)
//   bits 26..23  month         (4 bits)
//   bits 22..16  year - 2000   (7 bits)
//   bits 15..10  second        (6 bits)
//   bit  9       temperature bit 10 extension (protocol >= 0x23)
//   bits  7..0   flags         (see Flags)
//
// An all-0xFF record marks unused memory.
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { RECORD_LENGTH } from "./constants.js";

/**
 * Flag bits in the low byte of each record.
 */
export const Flags = Object.freeze({
  Mark: 0b00000001, // user double-clicked the right key
  Pause: 0b00000010,
  Stop: 0b00000100,
  Sign1: 0b00001000, // temperature is negative
  Light: 0b00010000,
  Vibr: 0b00100000,
  Sign2: 0b01000000, // humidity is negative
  Error: 0b10000000, // sensor error
});

/**
 * Extract `width` bits starting at bit `shift` from a 64-bit BigInt.
 *
 * @param {bigint} q
 * @param {number} shift
 * @param {number} width
 * @returns {number}
 */
function bits(q, shift, width) {
  return Number((q >> BigInt(shift)) & ((1n << BigInt(width)) - 1n));
}

/**
 * Decode one 8-byte record.
 *
 * @param {Uint8Array} bytes             Exactly 8 bytes.
 * @param {number} [protocolVersion=0x20] From the `protocolVersion` parameter.
 * @returns {null | {
 *   time: string,
 *   temperature: number,
 *   humidity: number|null,
 *   flags: number,
 *   mark: boolean, pause: boolean, stop: boolean, error: boolean
 * }} null for an empty (all 0xFF) slot.
 */
export function decodeRecord(bytes, protocolVersion = 0x20) {
  if (bytes.length !== RECORD_LENGTH) {
    throw new RangeError(`Invalid record length: ${bytes.length}`);
  }

  // Assemble the little-endian 64-bit word.
  let q = 0n;
  for (let i = RECORD_LENGTH - 1; i >= 0; i--) {
    q = (q << 8n) | BigInt(bytes[i]);
  }

  if (q === 0xffffffffffffffffn) {
    return null;
  }

  const humidityRaw = bits(q, 54, 10);
  const minute = bits(q, 48, 6);
  let temperatureRaw = bits(q, 37, 11);
  const hour = bits(q, 32, 5);
  const day = bits(q, 27, 5);
  const month = bits(q, 23, 4);
  const year = bits(q, 16, 7);
  const second = bits(q, 10, 6);
  const flags = bits(q, 0, 8);

  // Newer protocol revisions extend the temperature with bit 9 as bit 10.
  if (protocolVersion >= 0x23) {
    temperatureRaw |= bits(q, 9, 1) << 10;
  }

  const temperature = (flags & Flags.Sign1 ? -temperatureRaw : temperatureRaw) / 10;
  const humidityValue = (flags & Flags.Sign2 ? -humidityRaw : humidityRaw) / 10;

  const pad = (n) => String(n).padStart(2, "0");
  const time =
    `${2000 + year}-${pad(month)}-${pad(day)} ` +
    `${pad(hour)}:${pad(minute)}:${pad(second)}`;

  return {
    time,
    temperature,
    // python-elitech treats a humidity of exactly 0 as "no humidity sensor".
    humidity: humidityValue === 0 ? null : humidityValue,
    flags,
    mark: Boolean(flags & Flags.Mark),
    pause: Boolean(flags & Flags.Pause),
    stop: Boolean(flags & Flags.Stop),
    error: Boolean(flags & Flags.Error),
  };
}
