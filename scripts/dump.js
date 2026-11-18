// =============================================================================
// File:    scripts/dump.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// `bun run dump` — read-only diagnostic snapshot of a connected RC-5+.
//
// Never writes to the logger: every request goes through ReadOnlyTransport,
// which refuses anything but reads. Takes the same cross-process lock as
// the server, so it never talks to the logger while the app is.
//
// Usage (run on the PC the logger is plugged into):
//   bun run dump                      snapshot to the terminal
//   bun run dump --save               also write dumps/<serial>-<time>.json
//   bun run dump --shadow             also read the shadow space (op 0x05)
//   bun run dump --records[=N]        also read records (all, or first/last N)
//   bun run dump --redact             blank serial, description, password, …
//   bun run dump --watch[=SECONDS]    print only bytes that change (default 3 s)
//   bun run dump --diff A.json B.json compare two saved dumps
//   bun run dump --device /dev/hidrawN    pick a logger if several are attached
//   bun run dump --show-password      don't mask the PDF password
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { findRc5PlusDevices, HidrawTransport } from "../src/elitech/hidraw.js";
import { acquireDeviceLock, DeviceBusyError } from "../src/lib/device-lock.js";
import {
  diffSnapshots,
  formatChanges,
  formatDiff,
  formatSnapshot,
  ReadOnlyTransport,
  redactSnapshot,
  serialOf,
  takeSnapshot,
  withoutClockNoise,
} from "../src/lib/dump.js";

const ROOT = path.resolve(import.meta.dir, "..");
const DUMP_DIR = path.join(ROOT, "dumps");

/** How long a one-off dump waits for the app to finish with the logger. */
const LOCK_TIMEOUT_MS = 60_000;
/** In --watch mode, skip a cycle rather than wait long. */
const WATCH_LOCK_TIMEOUT_MS = 2_000;

const USAGE = `Read-only diagnostic dump of an Elitech RC-5+.

  bun run dump [options]
  bun run dump --diff A.json B.json

Options:
  --save               also write dumps/<serial>-<time>.json
  --shadow             also read the shadow memory space (op 0x05, unconfirmed on the RC-5+)
  --records[=N]        also read records: all, or the first and last N
  --redact             blank serial number, description, password and device name
  --watch[=SECONDS]    re-read every SECONDS (default 3) and print only changes
  --diff A B           compare two saved dumps
  --device PATH        use this /dev/hidrawN
  --show-password      don't mask the PDF password
  --help               this text`;

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

/**
 * Parse argv into options. Supports --flag, --flag=value and --device PATH.
 */
function parseArgs(argv) {
  const opts = {
    save: false, shadow: false, records: false, redact: false, watch: null,
    diff: null, device: null, showSecrets: false, help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, value] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    switch (name) {
      case "--help": case "-h": opts.help = true; break;
      case "--save": opts.save = true; break;
      case "--shadow": opts.shadow = true; break;
      case "--redact": opts.redact = true; break;
      case "--show-password": opts.showSecrets = true; break;
      case "--records": {
        if (value === undefined) { opts.records = null; break; }
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--records needs a whole number: ${value}`);
        opts.records = n;
        break;
      }
      case "--watch": {
        const s = value === undefined ? 3 : Number(value);
        if (!(s >= 1)) throw new Error(`--watch needs at least 1 second: ${value}`);
        opts.watch = s;
        break;
      }
      case "--device": {
        const v = value ?? argv[++i];
        if (!v) throw new Error("--device needs a path, e.g. /dev/hidraw3");
        opts.device = v;
        break;
      }
      case "--diff": opts.diff = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (opts.diff) {
    if (positional.length !== 2) throw new Error("--diff needs two dump files");
    opts.diff = positional;
  } else if (positional.length) {
    throw new Error(`Unexpected argument: ${positional[0]}`);
  }
  return opts;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const time = () => new Date().toTimeString().slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The logger to use, or null if none is attached. */
function pickDevice(devicePath) {
  const devices = findRc5PlusDevices();
  if (devicePath) {
    return devices.find((d) => d.devPath === devicePath) ?? null;
  }
  if (devices.length > 1) {
    console.error(`Several loggers attached (${devices.map((d) => d.devPath).join(", ")}); using ${devices[0].devPath}. Use --device to choose.`);
  }
  return devices[0] ?? null;
}

/**
 * Take the lock, open the logger read-only, run fn, then close and release.
 */
async function withReadOnlyLogger(device, timeoutMs, fn, quiet = false) {
  const release = await acquireDeviceLock("rc5plus dump", {
    timeoutMs,
    onWait: quiet ? undefined : (holder) =>
      console.error(`Waiting for ${holder?.label ?? "another program"} to finish with the logger…`),
  });
  try {
    const transport = new ReadOnlyTransport(HidrawTransport.open(device.devPath));
    try {
      return await fn(transport);
    } finally {
      transport.close();
    }
  } finally {
    release();
  }
}

/** File name for a saved dump: <serial>-YYYYMMDD-HHMMSS.json */
function dumpFileName(snapshot) {
  const d = new Date(snapshot.createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const who = snapshot.redacted ? "redacted" : (serialOf(snapshot) ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${who}-${stamp}.json`;
}

// -----------------------------------------------------------------------------
// Modes
// -----------------------------------------------------------------------------

async function runDiff([fileA, fileB]) {
  const a = JSON.parse(fs.readFileSync(fileA, "utf8"));
  const b = JSON.parse(fs.readFileSync(fileB, "utf8"));
  console.log(formatDiff(a, b));
}

async function runOnce(opts) {
  const device = pickDevice(opts.device);
  if (!device) {
    throw new Error(opts.device ? `No RC-5+ at ${opts.device}` : "No Elitech RC-5+ detected.");
  }

  let snapshot = await withReadOnlyLogger(device, LOCK_TIMEOUT_MS, (t) =>
    takeSnapshot(t, device, { shadow: opts.shadow, records: opts.records }),
  );
  if (opts.redact) {
    snapshot = redactSnapshot(snapshot);
  }

  console.log(formatSnapshot(snapshot, { showSecrets: opts.showSecrets }));

  if (opts.save) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const file = path.join(DUMP_DIR, dumpFileName(snapshot));
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
  }
}

async function runWatch(opts) {
  console.log(`Watching the logger every ${opts.watch} s (read-only). Ctrl+C to stop.`);
  let previous = null;
  let present = null;

  for (;;) {
    const device = pickDevice(opts.device);
    if (!device) {
      if (present !== false) console.log(`${time()} not connected`);
      present = false;
      previous = null;
    } else {
      try {
        let snap = await withReadOnlyLogger(device, WATCH_LOCK_TIMEOUT_MS,
          (t) => takeSnapshot(t, device, { shadow: opts.shadow, usb: false }), true);
        if (opts.redact) snap = redactSnapshot(snap);

        if (present !== true || previous === null) {
          const state = snap.fields.find((f) => f.name === "device-state")?.value;
          const count = snap.fields.find((f) => f.name === "record-number")?.value;
          console.log(`${time()} connected ${device.devPath}: state ${state}, ${count} records`);
        } else {
          // Clocks tick every second; only report them with other changes.
          const changes = withoutClockNoise(diffSnapshots(previous, snap));
          for (const line of formatChanges(changes, previous, snap)) {
            console.log(`${time()} ${line}`);
          }
        }
        present = true;
        previous = snap;
      } catch (err) {
        if (err instanceof DeviceBusyError) {
          console.log(`${time()} busy: ${err.holder?.label ?? "another program"} is using the logger; skipping`);
        } else {
          console.log(`${time()} error: ${err.message}`);
        }
      }
    }
    await sleep(opts.watch * 1000);
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

try {
  if (opts.diff) {
    await runDiff(opts.diff);
  } else if (opts.watch) {
    await runWatch(opts);
  } else {
    await runOnce(opts);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
