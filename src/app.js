// =============================================================================
// File:    src/app.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// HTTP routes for the JSON API and the web UI, using Bun.serve's built-in
// router (no framework). src/server.js starts the server; tests start one
// on a free port with createApp(), against the simulated logger.
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
//   GET  /, /app.js, …          the web UI (only the files in STATIC_ASSETS)
//
// Anything else: 404, or 405 for a known path with the wrong method. Errors
// thrown by a handler are mapped to HTTP statuses by errorResponse().
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { csvFileName, recordsToCsv } from "./lib/csv.js";
import { NotConnectedError } from "./lib/logger-service.js";
import { TransportError } from "./elitech/hidraw.js";
import { FrameError } from "./elitech/frame.js";
import { NotAppliedError, NotStoppedError, SettingsErasedError } from "./elitech/rc5plus.js";
import { DeviceBusyError } from "./lib/device-lock.js";
import { saveSnapshot, takeSnapshot } from "./lib/dump.js";
import { STATIC_ASSETS } from "./lib/static-assets.js";

/**
 * A JSON error body: { error, code, ...extra }.
 * @param {number} status
 * @param {string} code - Machine-readable code, e.g. "NOT_STOPPED".
 * @param {string} message - Text shown to the user.
 * @param {object} [extra] - More fields for the body.
 * @returns {Response}
 */
function jsonError(status, code, message, extra = {}) {
  return Response.json({ error: message, code, ...extra }, { status });
}

/**
 * Map an error thrown while handling a request to a clear HTTP response.
 * @param {Error} err
 * @returns {Response}
 */
export function errorResponse(err) {
  if (err instanceof NotConnectedError) {
    return jsonError(404, "NOT_CONNECTED", err.message);
  }
  if (err instanceof NotStoppedError) {
    // 409 Conflict: the request is fine, the logger's state is not.
    return jsonError(409, "NOT_STOPPED", err.message, {
      runState: err.runState,
      deviceState: err.deviceState,
    });
  }
  if (err instanceof SettingsErasedError) {
    return jsonError(409, "SETTINGS_ERASED", err.message);
  }
  if (err instanceof DeviceBusyError) {
    // 423 Locked: another program (e.g. `bun run dump`) is using the logger.
    return jsonError(423, "BUSY", err.message);
  }
  if (err instanceof NotAppliedError) {
    // 502: the logger answered, but did not do what it acknowledged.
    return jsonError(502, "NOT_APPLIED", err.message);
  }
  if (err instanceof RangeError) {
    return jsonError(400, "BAD_REQUEST", err.message);
  }
  if (err instanceof TransportError) {
    return jsonError(err.code === "EACCES" ? 403 : 503, err.code, err.message);
  }
  if (err instanceof FrameError) {
    return jsonError(502, "PROTOCOL", `Unexpected answer from logger: ${err.message}`);
  }
  console.error(err);
  return jsonError(500, "INTERNAL", err?.message ?? "Internal error");
}

/**
 * Build the routes and handlers to pass to Bun.serve().
 *
 * @param {object} options
 * @param {import("./lib/logger-service.js").LoggerService} options.service
 * @param {string} options.dataDir - exports/ and dumps/ go here.
 * @param {boolean} [options.mock] - Simulated logger: skip the before-reset dump.
 * @param {boolean} [options.fullPaths] - Report full paths rather than paths
 *   relative to dataDir (the compiled binary).
 * @returns {{ routes: object, fetch: (req: Request) => Response, error: (err: Error) => Response }}
 */
export function createApp({ service, dataDir, mock = false, fullPaths = false }) {
  const exportDir = path.join(dataDir, "exports");
  const dumpDir = path.join(dataDir, "dumps");

  // ---------------------------------------------------------------------------
  // Logger API
  // ---------------------------------------------------------------------------

  const status = () => Response.json(service.status());

  const info = async () => Response.json(await service.withLogger((logger) => logger.readInfo()));

  // Reset for a new trip. On the RC-5+ any settings change erases the
  // readings, so setting the interval and clearing are one operation.
  const reset = async (req) => {
    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== true) {
      return jsonError(400, "BAD_REQUEST", 'Resetting erases all readings and requires { "confirm": true }');
    }
    const minutes = Number(body.minutes);
    // Omitted or null: keep the logger's current value.
    const description = body.description ?? undefined;
    const tripNumber = body.tripNumber ?? undefined;
    const result = await service.withLogger((logger, device) =>
      logger.resetForNewTrip(minutes, new Date(), {
        description,
        tripNumber,
        // A full dump (settings and shadow) before anything is written, so a
        // reset that goes wrong can be undone with `bun run restore`.
        onBackup: async () => {
          if (mock) return;
          const snapshot = await takeSnapshot(logger.transport, device, { shadow: true });
          const file = saveSnapshot(snapshot, dumpDir, "before-reset");
          console.log(`Saved settings backup ${file}`);
        },
      }),
    );
    return Response.json(result);
  };

  const exportCsv = async () => {
    const { info: loggerInfo, records } = await service.withLogger((logger) => logger.readRecords());

    const csv = recordsToCsv(loggerInfo, records);
    const fileName = csvFileName(loggerInfo.serialNumber);

    // Keep a server-side copy as well as sending it to the browser.
    fs.mkdirSync(exportDir, { recursive: true });
    const savedAs = path.join(exportDir, fileName);
    fs.writeFileSync(savedAs, csv);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Record-Count": String(records.length),
        "X-Saved-As": fullPaths ? savedAs : path.relative(dataDir, savedAs),
      },
    });
  };

  // ---------------------------------------------------------------------------
  // PDF reports on the logger's USB drive
  // ---------------------------------------------------------------------------

  const pdfList = async () => Response.json(await service.pdfs());

  const pdfFile = async (req) => {
    const requested = req.params.name; // already URL-decoded by Bun
    const { mountPoint, files } = await service.pdfs();

    // Only serve a file that appears in the listing: no path traversal.
    const match = files.find((f) => f.name === requested);
    if (!mountPoint || !match) {
      return jsonError(404, "NOT_FOUND", "PDF not found on the logger");
    }

    const download = new URL(req.url).searchParams.get("download");
    return new Response(Bun.file(path.join(mountPoint, match.name)), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${match.name.replaceAll('"', "")}"`,
        "Cache-Control": "no-store",
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const routes = {
    "/api/status": { GET: status },
    "/api/info": { GET: info },
    "/api/reset": { POST: reset },
    "/api/export.csv": { GET: exportCsv },
    "/api/pdfs": { GET: pdfList },
    "/api/pdfs/:name": { GET: pdfFile },
  };

  // Web UI: only the files listed in STATIC_ASSETS, so nothing else on disk
  // is reachable.
  for (const [urlPath, asset] of STATIC_ASSETS) {
    routes[urlPath] = {
      GET: () =>
        new Response(Bun.file(asset.file), {
          headers: { "Content-Type": asset.type, "Cache-Control": "no-cache" },
        }),
    };
  }

  /** Anything the routes don't match. */
  const fetch = (req) => {
    const route = routes[new URL(req.url).pathname];
    if (route) {
      return new Response(
        JSON.stringify({ error: `${req.method} is not allowed here`, code: "METHOD_NOT_ALLOWED" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: Object.keys(route).join(", ") },
        },
      );
    }
    return jsonError(404, "NOT_FOUND", "Not found");
  };

  return { routes, fetch, error: errorResponse };
}
