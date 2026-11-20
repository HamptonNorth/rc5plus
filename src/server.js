// =============================================================================
// File:    src/server.js
// Version: 1.6.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Hono HTTP server: JSON API for the logger plus the static web UI.
//
//   GET  /api/status            is a logger plugged in? (no USB traffic)
//   GET  /api/info              serial number, settings, record count
//   POST /api/reset             { minutes: 1..15, confirm: true,
//                                 description?: string, tripNumber?: string }
//                               new trip: set interval + clock (+ description,
//                               trip number), erase records
//                               (logger must be stopped or already reset);
//                               a full dump is saved to dumps/ first
//   GET  /api/export.csv        download all records as CSV (copy kept in exports/)
//   GET  /api/pdfs              list PDF reports on the logger's USB drive
//   GET  /api/pdfs/:name        view a PDF (?download=1 to save it)
//
// Environment:
//   PORT       default 3005
//   HOST       default 127.0.0.1 (the API controls hardware and has no auth)
//   RC5_MOCK   set to 1 to use the built-in simulator instead of hardware
//   RC5_DATA_DIR  where exports/ and dumps/ go (default: the repository root
//              from source, ~/.local/share/rc5plus-app for the compiled binary)
//
// Also runs as a single executable: `bun run build` → dist/rc5plus-app.
// The web UI is embedded (see lib/static-assets.js).
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";

import { csvFileName, recordsToCsv } from "./lib/csv.js";
import { LoggerService, NotConnectedError } from "./lib/logger-service.js";
import { TransportError } from "./elitech/hidraw.js";
import { FrameError } from "./elitech/frame.js";
import { NotAppliedError, NotStoppedError, SettingsErasedError } from "./elitech/rc5plus.js";
import { DeviceBusyError } from "./lib/device-lock.js";
import { saveSnapshot, takeSnapshot } from "./lib/dump.js";
import { isCompiled, resolveDataDir } from "./lib/paths.js";
import { STATIC_ASSETS } from "./lib/static-assets.js";
import pkg from "../package.json" with { type: "json" };

// -----------------------------------------------------------------------------
// Command line (mainly for the compiled binary)
// -----------------------------------------------------------------------------

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  console.log(`rc5plus-app ${pkg.version}`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  console.log(`rc5plus-app ${pkg.version} — web app for the Elitech RC-5+ temperature logger

Usage: rc5plus-app [--version | --help]

Starts the web UI on http://HOST:PORT (default http://127.0.0.1:3005).

Environment:
  PORT          port to listen on (3005)
  HOST          address to bind (127.0.0.1; the API has no authentication)
  RC5_MOCK=1    use the built-in simulated logger instead of hardware
  RC5_DATA_DIR  folder for exports/ and dumps/ (${resolveDataDir()})`);
  process.exit(0);
}
if (arg !== undefined) {
  console.error(`Unknown option: ${arg}  (try --help)`);
  process.exit(2);
}

const PORT = Number(process.env.PORT ?? 3005);
const HOST = process.env.HOST ?? "127.0.0.1";
const MOCK = process.env.RC5_MOCK === "1";

const ROOT = resolveDataDir();
const EXPORT_DIR = path.join(ROOT, "exports");
const DUMP_DIR = path.join(ROOT, "dumps");

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
  if (err instanceof SettingsErasedError) {
    return c.json({ error: err.message, code: "SETTINGS_ERASED" }, 409);
  }
  if (err instanceof DeviceBusyError) {
    // 423 Locked: another program (e.g. `bun run dump`) is using the logger.
    return c.json({ error: err.message, code: "BUSY" }, 423);
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
  // Omitted or null: keep the logger's current value.
  const description = body.description ?? undefined;
  const tripNumber = body.tripNumber ?? undefined;
  const info = await service.withLogger((logger, device) =>
    logger.resetForNewTrip(minutes, new Date(), {
      description,
      tripNumber,
      // A full dump (settings and shadow) before anything is written, so a
      // reset that goes wrong can be undone with `bun run restore`.
      onBackup: async () => {
        if (MOCK) return;
        const snapshot = await takeSnapshot(logger.transport, device, { shadow: true });
        const file = saveSnapshot(snapshot, DUMP_DIR, "before-reset");
        console.log(`Saved settings backup ${file}`);
      },
    }),
  );
  return c.json(info);
});

app.get("/api/export.csv", async (c) => {
  const { info, records } = await service.withLogger((logger) => logger.readRecords());

  const csv = recordsToCsv(info, records);
  const fileName = csvFileName(info.serialNumber);

  // Keep a server-side copy as well as sending it to the browser.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const savedAs = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(savedAs, csv);

  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "X-Record-Count": String(records.length),
    // Relative in the source tree; the full path for the compiled binary.
    "X-Saved-As": isCompiled() ? savedAs : path.relative(ROOT, savedAs),
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

// Only the files listed in STATIC_ASSETS: nothing else on disk is reachable.
app.get("/*", (c) => {
  const asset = STATIC_ASSETS.get(c.req.path);
  if (!asset) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  return new Response(Bun.file(asset.file), {
    headers: { "Content-Type": asset.type, "Cache-Control": "no-cache" },
  });
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  // Large record downloads can take a while over HID.
  idleTimeout: 120,
  // Bun's development mode adds error pages with source; off for the binary.
  development: !isCompiled(),
};

console.log(
  `RC-5+ app ${pkg.version} on http://${HOST}:${PORT}` +
    (MOCK ? "  (simulated logger: RC5_MOCK=1)" : ""),
);
if (isCompiled()) console.log(`Exports and dumps go to ${ROOT}`);
