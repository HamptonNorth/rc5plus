// =============================================================================
// File:    scripts/restore.js
// Version: 1.0.1
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// `bun run restore` — rebuild a logger's settings from a saved dump.
//
// For a logger whose settings were erased (e.g. the RC-5+ TE on 2026-11-19,
// after a reset that wrote only two fields), or to undo a reset using the
// "-before-reset" dump the server saves.
//
// Dry run by default: reads the logger, saves a backup dump, and prints
// every byte that would change. Nothing is written without --write.
//
// What goes into the new settings:
//   - everything from the template dump's settings blocks
//   - except, always from the logger itself: model and serial number
//     (0x00..0x0F), state/stop/battery bytes (0x25..0x27), capacity and
//     record counts (0x42..0x49)
//   - and except the bytes listed with --keep (default: 0x1E product
//     properties, and the 16-byte mode code at 0xFD), which differ between
//     models and are kept from the logger
//   - then --set OFFSET=VALUE overrides, --interval and --description
//   - configuration time and device time = now (this also sets the clock)
//
// Then, with --write: write every settings block, Format (erases every
// record), and check every byte, exactly like the app's reset.
//
// Usage (run on the PC the logger is plugged into, with the app stopped
// or idle — the device lock keeps them apart):
//   bun run restore --template dumps/A.json                 dry run
//   bun run restore --template dumps/A.json --write         do it
//   options: --interval MIN  --description TEXT  --keep LIST|none
//            --set 0x21=0x02 (repeatable)  --device /dev/hidrawN
//   bun run restore --template A.json --against B.json    preview against a
//                                       saved dump, no logger needed
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import { findRc5PlusDevices, HidrawTransport } from "../src/elitech/hidraw.js";
import {
  decodeDateTime,
  encodeDateTime,
  encodeInterval,
  encodeString,
  LOGGER_OWNED_BITS,
  Param,
  SETTINGS_END,
  SETTINGS_WRITE_BLOCKS,
} from "../src/elitech/parameters.js";
import { assertConfigurable, Rc5Plus } from "../src/elitech/rc5plus.js";
import { acquireDeviceLock } from "../src/lib/device-lock.js";
import {
  DUMP_END,
  DUMP_FORMAT,
  DUMP_START,
  MAIN_FIELDS,
  decodeField,
  diffSnapshots,
  formatChanges,
  saveSnapshot,
  settingsImageOf,
  takeSnapshot,
} from "../src/lib/dump.js";
import { Operation } from "../src/elitech/constants.js";

const ROOT = path.resolve(import.meta.dir, "..");
const DUMP_DIR = path.join(ROOT, "dumps");
const LOCK_TIMEOUT_MS = 60_000;

/** Always taken from the logger being restored, never from the template. */
const FROM_LOGGER = [
  [0x00, 0x10], // model, serial number
  [0x25, 0x28], // run state, stop mode, battery (the logger owns these)
  [0x42, 0x4a], // capacity, record counts
];

/** Default --keep: model-specific bytes whose meaning isn't known. */
const DEFAULT_KEEP = "0x1e,0xfd-0x10c";

const USAGE = `Rebuild an RC-5+'s settings from a saved dump. Dry run unless --write.

  bun run restore --template dumps/FILE.json [options]

Options:
  --template FILE      dump to copy settings from (required)
  --write              actually write, Format (erases all records) and verify
  --interval MIN       recording interval, 1..15 minutes (default: template's)
  --description TEXT   description printed on reports (default: template's)
  --keep LIST          offsets kept from the logger, e.g. 0x1e,0xfd-0x10c
                       (default ${DEFAULT_KEEP}); "none" to keep nothing extra
  --set OFF=VAL        force one byte, e.g. --set 0x21=0x02 (repeatable)
  --device PATH        use this /dev/hidrawN
  --against FILE       preview against a saved dump instead of the logger
                       (never writes)
  --help               this text`;

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

function parseByte(text, what) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`${what} must be 0..0xFF: ${text}`);
  return n;
}

function parseOffset(text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n >= SETTINGS_END) {
    throw new Error(`Offset must be 0..0x${(SETTINGS_END - 1).toString(16)}: ${text}`);
  }
  return n;
}

/** "0x1e,0xfd-0x10c" -> Set of offsets. */
function parseKeep(text) {
  const out = new Set();
  if (text === "none") return out;
  for (const part of text.split(",").filter(Boolean)) {
    const [a, b] = part.split("-");
    const from = parseOffset(a);
    const to = b === undefined ? from : parseOffset(b);
    for (let i = from; i <= to; i++) out.add(i);
  }
  return out;
}

function parseArgs(argv) {
  const opts = {
    template: null, write: false, interval: null, description: null,
    keep: parseKeep(DEFAULT_KEEP), set: [], device: null, against: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.includes("=") && arg.startsWith("--") && !arg.startsWith("--set")
      ? arg.split(/=(.*)/s)
      : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case "--help": case "-h": opts.help = true; break;
      case "--write": opts.write = true; break;
      case "--template": opts.template = value(); break;
      case "--device": opts.device = value(); break;
      case "--against": opts.against = value(); break;
      case "--description": opts.description = value(); break;
      case "--keep": opts.keep = parseKeep(value()); break;
      case "--interval": {
        const m = Number(value());
        if (!Number.isInteger(m) || m < 1 || m > 15) throw new Error("--interval must be 1..15 minutes");
        opts.interval = m;
        break;
      }
      case "--set": {
        const v = argv[++i];
        const match = /^([^=]+)=(.+)$/.exec(v ?? "");
        if (!match) throw new Error("--set needs OFFSET=VALUE, e.g. 0x21=0x02");
        opts.set.push([parseOffset(match[1]), parseByte(match[2], "--set value")]);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.help && !opts.template) throw new Error("--template is required");
  if (opts.against && opts.write) throw new Error("--against only previews; it can't be used with --write");
  return opts;
}

// -----------------------------------------------------------------------------
// Building and showing the new settings
// -----------------------------------------------------------------------------

/** A minimal snapshot around a settings image, so the dump's diff can label it. */
function imageSnapshot(image, createdAt) {
  return {
    format: DUMP_FORMAT,
    createdAt,
    redacted: false,
    range: { start: DUMP_START, end: DUMP_END },
    usb: null,
    spaces: {
      main: {
        op: Operation.GetParameter,
        blocks: [{ offset: 0, length: image.length, hex: Buffer.from(image).toString("hex") }],
      },
    },
    fields: [],
  };
}

/** Is this offset one the official software writes? */
const isWritten = (i) => SETTINGS_WRITE_BLOCKS.some((b) => i >= b.offset && i < b.offset + b.length);

/**
 * The settings to write: template, with the logger's own identity and the
 * kept bytes, then the overrides.
 */
function buildImage(template, current, opts, now) {
  const image = template.slice();
  const fromLogger = (i) => FROM_LOGGER.some(([a, b]) => i >= a && i < b) || opts.keep.has(i);
  for (let i = 0; i < SETTINGS_END; i++) {
    if (fromLogger(i)) image[i] = current[i];
  }
  for (const [offset, value] of opts.set) image[offset] = value;
  if (opts.interval !== null) image.set(encodeInterval(opts.interval * 60), Param.interval.offset);
  if (opts.description !== null) {
    image.set(encodeString(opts.description, Param.description.length), Param.description.offset);
  }
  const clock = encodeDateTime(now);
  image.set(clock, Param.configurationTime.offset);
  image.set(clock, Param.deviceTime.offset);
  return image;
}

/** Print the byte changes, hiding the password's bytes. */
function printChanges(current, image) {
  const a = imageSnapshot(current, "logger now");
  const b = imageSnapshot(image, "after restore");
  const changes = diffSnapshots(a, b).filter((c) =>
    isWritten(c.offset) && LOGGER_OWNED_BITS.get(c.offset) !== 0xff,
  );
  const visible = changes.filter((c) => c.field !== "password");
  const hidden = changes.length - visible.length;
  console.log(`\n${changes.length} settings byte(s) will change (clock and record counts not shown):`);
  for (const line of formatChanges(visible, a, b)) console.log(`  ${line}`);
  if (hidden) console.log(`  … and ${hidden} byte(s) of the PDF password (hidden)`);
}

/** Key fields of the new settings, decoded, for a final check by eye. */
function printSummary(image) {
  const bytes = new Map(Array.from(image, (b, i) => [i, b]));
  const show = ["serial-number", "product-properties", "start-mode", "sensor-options", "alarm-types",
    "timezone-hours", "timezone-minutes", "start-delay", "interval", "description", "mode-code"];
  console.log("\nNew settings (as python-elitech names them; only the app's own fields are confirmed):");
  for (const name of show) {
    const field = MAIN_FIELDS.find((f) => f.name === name);
    console.log(`  ${name.padEnd(20)} ${decodeField(field, bytes)}`);
  }
  console.log(`  ${"configuration-time".padEnd(20)} ${decodeDateTime(image.subarray(0x28, 0x2f))} (now)`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(opts) {
  const templateSnap = JSON.parse(fs.readFileSync(opts.template, "utf8"));
  const template = settingsImageOf(templateSnap, SETTINGS_END);

  if (opts.against) {
    const currentSnap = JSON.parse(fs.readFileSync(opts.against, "utf8"));
    const current = settingsImageOf(currentSnap, SETTINGS_END);
    if (template[0] !== current[0] || template[1] !== current[1]) {
      throw new Error("The template is from a different model of logger; refusing.");
    }
    console.log(`Preview: ${path.basename(opts.template)} applied to ${path.basename(opts.against)}. Nothing is written.`);
    const image = buildImage(template, current, opts, new Date());
    printChanges(current, image);
    printSummary(image);
    return;
  }

  const devices = findRc5PlusDevices();
  const device = opts.device ? devices.find((d) => d.devPath === opts.device) : devices[0];
  if (!device) throw new Error(opts.device ? `No RC-5+ at ${opts.device}` : "No Elitech RC-5+ detected.");
  if (!opts.device && devices.length > 1) {
    throw new Error(`Several loggers attached (${devices.map((d) => d.devPath).join(", ")}). Use --device.`);
  }

  const release = await acquireDeviceLock("rc5plus restore", {
    timeoutMs: LOCK_TIMEOUT_MS,
    onWait: (holder) => console.error(`Waiting for ${holder?.label ?? "another program"} to finish with the logger…`),
  });
  try {
    const transport = HidrawTransport.open(device.devPath);
    try {
      const logger = new Rc5Plus(transport);
      const info = await logger.readInfo();
      console.log(`Logger ${info.serialNumber} on ${device.devPath}: state 0x${info.deviceState.toString(16)} ` +
        `(${info.runState}), ${info.recordCount} records, settings ${info.settingsErased ? "look ERASED" : "look valid"}.`);
      console.log(`Template ${path.basename(opts.template)} (taken ${templateSnap.createdAt}).`);

      const current = await logger.readSettingsBytes();
      if (template[0] !== current[0] || template[1] !== current[1]) {
        throw new Error("The template is from a different model of logger; refusing.");
      }

      // Always keep a backup of what is there now.
      const backup = saveSnapshot(await takeSnapshot(transport, device, { shadow: true }), DUMP_DIR, "before-restore");
      console.log(`Backup of the logger as it is now: ${path.relative(process.cwd(), backup)}`);

      const now = new Date();
      const image = buildImage(template, current, opts, now);
      printChanges(current, image);
      printSummary(image);

      if (!opts.write) {
        console.log("\nDry run: nothing was written. Add --write to write these settings, " +
          "Format the logger (erasing its " + info.recordCount + " records) and verify.");
        return;
      }

      assertConfigurable(info);
      console.log("\nWriting settings, formatting and verifying…");
      const writeTime = new Date();
      const after = await logger.applySettings(buildImage(template, current, opts, writeTime), writeTime);
      console.log(`Done: state ${after.runState}, ${after.recordCount} records, interval ${after.intervalSeconds / 60} min, ` +
        `time zone UTC${after.timezone}, clock ${after.deviceTime}.`);
      console.log("Check it with: bun run dump --shadow --save");
    } finally {
      transport.close();
    }
  } finally {
    release();
  }
}

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
  await main(opts);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
