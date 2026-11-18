// =============================================================================
// File:    src/lib/csv.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Converts downloaded records to CSV (RFC 4180: CRLF line endings, fields
// quoted only when needed). Opens cleanly in LibreOffice Calc and Excel.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

/**
 * Quote a CSV field if it contains a comma, quote or line break.
 *
 * @param {unknown} value
 * @returns {string}
 */
function field(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Describe the event flags of a record in words (empty for a normal sample).
 *
 * @param {object} record
 * @returns {string}
 */
function eventLabel(record) {
  if (record.error) return "sensor error";
  if (record.stop) return "stop";
  if (record.pause) return "pause";
  return "";
}

/**
 * Build the CSV document.
 *
 * Timestamps are the logger's local wall-clock time, exactly as recorded.
 * The temperature column name carries the unit configured on the logger.
 *
 * @param {object} info     Result of Rc5Plus.readInfo().
 * @param {object[]} records Result of Rc5Plus.readRecords().records.
 * @returns {string}
 */
export function recordsToCsv(info, records) {
  const unit = info.temperatureUnit === "F" ? "f" : "c";
  const lines = [["index", "timestamp", `temperature_${unit}`, "marked", "event"]];

  for (const r of records) {
    lines.push([
      r.index,
      r.time,
      r.temperature.toFixed(1),
      r.mark ? "yes" : "no",
      eventLabel(r),
    ]);
  }

  return lines.map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}

/**
 * File name for an export, e.g. "RC5_EF2412345678_20261118-154630.csv".
 *
 * @param {string} serialNumber
 * @param {Date} [when]
 * @returns {string}
 */
export function csvFileName(serialNumber, when = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-` +
    `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const safeSerial = serialNumber.replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  return `RC5_${safeSerial}_${stamp}.csv`;
}
