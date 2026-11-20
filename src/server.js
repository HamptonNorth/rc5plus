// =============================================================================
// File:    src/server.js
// Version: 1.7.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Starts the web app: command-line options, environment, then Bun.serve()
// with the routes from app.js (Bun's built-in router; no framework).
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

import { createApp } from "./app.js";
import { LoggerService } from "./lib/logger-service.js";
import { isCompiled, resolveDataDir } from "./lib/paths.js";
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

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3005);
const HOST = process.env.HOST ?? "127.0.0.1";
const MOCK = process.env.RC5_MOCK === "1";
const COMPILED = isCompiled();
const DATA_DIR = resolveDataDir();

const app = createApp({
  service: new LoggerService({ mock: MOCK }),
  dataDir: DATA_DIR,
  mock: MOCK,
  fullPaths: COMPILED,
});

Bun.serve({
  ...app,
  port: PORT,
  hostname: HOST,
  // Large record downloads can take a while over HID.
  idleTimeout: 120,
  // Bun's development mode adds error pages with source; off for the binary.
  development: !COMPILED,
});

console.log(
  `RC-5+ app ${pkg.version} on http://${HOST}:${PORT}` +
    (MOCK ? "  (simulated logger: RC5_MOCK=1)" : ""),
);
if (COMPILED) console.log(`Exports and dumps go to ${DATA_DIR}`);
