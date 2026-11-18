// =============================================================================
// File:    src/server.js
// Version: 1.2.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Hono HTTP server: JSON API for the logger plus the static web UI.
//
//   GET  /api/status            is a logger plugged in? (no USB traffic)
//   GET  /api/info              serial number, settings, record count
//   POST /api/reset             { minutes: 1..15, confirm: true }
//                               new trip: set interval + clock, erase records
//                               (logger must be stopped or already reset)
//   GET  /api/export.csv        download all records as CSV (copy kept in exports/)
//   GET  /api/pdfs              list PDF reports on the logger's USB drive
//   GET  /api/pdfs/:name        view a PDF (?download=1 to save it)
//
// Environment:
//   PORT       default 3005
//   HOST       default 127.0.0.1 (the API controls hardware and has no auth)
//   RC5_MOCK   set to 1 to use the built-in simulator instead of hardware
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import { csvFileName, recordsToCsv } from "./lib/csv.js";
import { LoggerService, NotConnectedError } from "./lib/logger-service.js";
import { TransportError } from "./elitech/hidraw.js";
import { FrameError } from "./elitech/frame.js";
import { NotAppliedError, NotStoppedError } from "./elitech/rc5plus.js";

const PORT = Number(process.env.PORT ?? 3005);
const HOST = process.env.HOST ?? "127.0.0.1";
const MOCK = process.env.RC5_MOCK === "1";

const ROOT = path.resolve(import.meta.dir, "..");
const EXPORT_DIR = path.join(ROOT, "exports");

const service = new LoggerService({ mock: MOCK });
const app = new Hono();

// -----------------------------------------------------------------------------
// Error handling: map known failures to clear HTTP responses
// -----------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof NotConnectedError) {
    return c.json({ error: err.message, code: "NOT_CONNECTED" }, 404);
  }
  if (err instanceof NotStoppedError) {
    // 409 Conflict: the request is fine, the logger's state is not.
    return c.json(
      { error: err.message, code: "NOT_STOPPED", runState: err.runState, deviceState: err.deviceState },
      409,
    );
  }
  if (err instanceof NotAppliedError) {
    // 502: the logger answered, but did not do what it acknowledged.
    return c.json({ error: err.message, code: "NOT_APPLIED" }, 502);
  }
  if (err instanceof RangeError) {
    return c.json({ error: err.message, code: "BAD_REQUEST" }, 400);
  }
  if (err instanceof TransportError) {
    const status = err.code === "EACCES" ? 403 : 503;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof FrameError) {
    return c.json({ error: `Unexpected answer from logger: ${err.message}`, code: "PROTOCOL" }, 502);
  }
  console.error(err);
  return c.json({ error: err.message ?? "Internal error", code: "INTERNAL" }, 500);
});

// -----------------------------------------------------------------------------
// Logger API
// -----------------------------------------------------------------------------

app.get("/api/status", (c) => c.json(service.status()));

app.get("/api/info", async (c) => {
  const info = await service.withLogger((logger) => logger.readInfo());
  return c.json(info);
});

// Reset for a new trip. On the RC-5+ any settings change erases the
// readings, so setting the interval and clearing are one operation.
app.post("/api/reset", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return c.json(
      { error: "Resetting erases all readings and requires { \"confirm\": true }", code: "BAD_REQUEST" },
      400,
    );
  }
  const minutes = Number(body.minutes);
  const info = await service.withLogger((logger) => logger.resetForNewTrip(minutes));
  return c.json(info);
});

app.get("/api/export.csv", async (c) => {
  const { info, records } = await service.withLogger((logger) => logger.readRecords());

  const csv = recordsToCsv(info, records);
  const fileName = csvFileName(info.serialNumber);

  // Keep a server-side copy as well as sending it to the browser.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXPORT_DIR, fileName), csv);

  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "X-Record-Count": String(records.length),
    "X-Saved-As": path.join("exports", fileName),
  });
});

// -----------------------------------------------------------------------------
// PDF reports on the logger's USB drive
// -----------------------------------------------------------------------------

app.get("/api/pdfs", async (c) => c.json(await service.pdfs()));

app.get("/api/pdfs/:name", async (c) => {
  const requested = c.req.param("name");
  const { mountPoint, files } = await service.pdfs();

  // Only serve a file that appears in the listing: no path traversal.
  const match = files.find((f) => f.name === requested);
  if (!mountPoint || !match) {
    return c.json({ error: "PDF not found on the logger", code: "NOT_FOUND" }, 404);
  }

  const file = Bun.file(path.join(mountPoint, match.name));
  const disposition = c.req.query("download") ? "attachment" : "inline";
  return new Response(file, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${match.name.replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
    },
  });
});

// -----------------------------------------------------------------------------
// Web UI
// -----------------------------------------------------------------------------

app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, "public")) || "." }));

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  // Large record downloads can take a while over HID.
  idleTimeout: 120,
};

console.log(
  `RC-5+ app on http://${HOST}:${PORT}` + (MOCK ? "  (simulated logger: RC5_MOCK=1)" : ""),
);
