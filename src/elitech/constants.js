// =============================================================================
// File:    src/elitech/constants.js
// Version: 1.1.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Protocol constants for the Elitech RC-5+ USB HID interface.
//
// Derived from python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

/**
 * USB identifiers of the Elitech RC-5+.
 *
 * Elitech uses Microchip's vendor id (0x04D8) for this generation of loggers.
 * The RC-5+ is the only device this app targets.
 */
export const RC5PLUS_VENDOR_ID = 0x04d8;
export const RC5PLUS_PRODUCT_ID = 0x3005;
export const RC5PLUS_NAME = "Elitech RC-5+";

/**
 * HID report sizes in bytes.
 *
 * Taken from the RC-5+ report descriptor
 * (05 01 09 00 a1 01 15 00 25 ff 19 01 29 08 95 40 75 08 81 02 ... 91 02 c0):
 * one 64-byte input report and one 64-byte output report, neither numbered.
 */
export const REPORT_SIZE = 64;

/**
 * Every frame (request and response) starts with this 3-byte header.
 */
export const FRAME_HEADER = [0x33, 0xcc, 0x00];

/**
 * Size of the fixed part of a frame:
 *   header(3) + length(1) + operation(2) + reserved(1) + offset(3) + count(1)
 * The payload starts at this index.
 */
export const FRAME_PAYLOAD_INDEX = 11;

/**
 * Largest payload (in bytes) a single frame may carry.
 */
export const MAX_FRAME_PAYLOAD = 52;

/**
 * Operation codes (16-bit, sent little-endian in bytes 4..5 of the frame).
 *
 * GetParameterShadow reads a second "shadow" memory space (record count at
 * 0x85, per python-elitech PR #14 doc/RC-5.md, found on an RC-5). Read only
 * as far as is known, unconfirmed on the RC-5+, and used only by the
 * diagnostic dump (`bun run dump --shadow`).
 */
export const Operation = Object.freeze({
  GetRecord: 0x0001,
  GetParameter: 0x0003,
  SetParameter: 0x0004,
  GetParameterShadow: 0x0005,
  Format: 0x02c0,
  Stop: 0x03c0,
});

/**
 * Each record in the logger's memory is a packed 8-byte little-endian word.
 */
export const RECORD_LENGTH = 8;

/**
 * Number of records requested per GetRecord frame.
 * 51 // 8 = 6 records (48 bytes) fits inside the 52-byte payload limit.
 */
export const RECORDS_PER_FRAME = Math.floor(51 / RECORD_LENGTH);

/**
 * How long to wait for the device to answer a request, in milliseconds.
 */
export const RESPONSE_TIMEOUT_MS = 2000;

/**
 * Sampling interval limits enforced by this app (in minutes).
 * The device itself stores the interval in units of 10 seconds.
 */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 15;
