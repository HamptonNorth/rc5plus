// =============================================================================
// File:    test/dump.test.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Tests for the read-only diagnostic dump (src/lib/dump.js) and the
// cross-process device lock (src/lib/device-lock.js).
//
// Run: bun test
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Operation } from "../src/elitech/constants.js";
import { buildFrame } from "../src/elitech/frame.js";
import { MockRc5Plus, MockTransport } from "../src/elitech/mock-device.js";
import { acquireDeviceLock, DeviceBusyError, readLock } from "../src/lib/device-lock.js";
import {
  bytesOf,
  diffSnapshots,
  withoutClockNoise,
  DUMP_END,
  fieldAt,
  formatChanges,
  formatDiff,
  formatSnapshot,
  ReadOnlyTransport,
  redactSnapshot,
  serialOf,
  takeSnapshot,
} from "../src/lib/dump.js";

const DEVICE = { devPath: "mock://rc5plus", usbDir: null };

/** Simulated logger with a description and password set, plus a dump client. */
function setup(options) {
  const logger = new MockRc5Plus({ serialNumber: "EF2400000042", ...options });
  logger.memory.set(new TextEncoder().encode("Fridge 3"), 0x98);
  logger.memory.set(new TextEncoder().encode("s3cr3t"), 0x80);
  const transport = new ReadOnlyTransport(new MockTransport(logger));
  return { logger, transport };
}

const opOf = (frame) => frame[4] | (frame[5] << 8);

describe("ReadOnlyTransport", () => {
  test("refuses SetParameter, Format and Stop before they reach the logger", async () => {
    const { logger, transport } = setup();
    logger.log.length = 0;

    const writes = [
      buildFrame(Operation.SetParameter, 0x4c, Uint8Array.of(0, 6)),
      buildFrame(Operation.Format, 0, Uint8Array.of(0)),
      buildFrame(Operation.Stop, 0, Uint8Array.of(0)),
    ];
    for (const frame of writes) {
      await expect(transport.exchange(frame)).rejects.toThrow(/Read-only dump refused/);
    }
    expect(logger.log.length).toBe(0);
  });

  test("lets reads through", async () => {
    const { transport } = setup();
    for (const op of [Operation.GetParameter, Operation.GetParameterShadow, Operation.GetRecord]) {
      const answer = await transport.exchange(buildFrame(op, 0, 2));
      expect(answer[4]).toBe(op & 0xff);
    }
  });
});

describe("takeSnapshot", () => {
  test("reads the whole range from both spaces using only reads", async () => {
    const { logger, transport } = setup({ recordCount: 20 });
    logger.log.length = 0;

    const snap = await takeSnapshot(transport, DEVICE, { shadow: true, usb: false, records: 3 });

    expect(bytesOf(snap.spaces.main).size).toBe(DUMP_END);
    expect(bytesOf(snap.spaces.shadow).size).toBe(DUMP_END);
    expect(snap.spaces.main.blocks.every((b) => b.error === undefined)).toBe(true);

    const ops = new Set(logger.log.map(opOf));
    expect([...ops].sort()).toEqual(
      [Operation.GetRecord, Operation.GetParameter, Operation.GetParameterShadow].sort(),
    );
  });

  test("decodes the known fields", async () => {
    const { transport } = setup({ intervalSeconds: 120, recordCount: 7 });
    const snap = await takeSnapshot(transport, DEVICE, { usb: false });
    const field = (name) => snap.fields.find((f) => f.name === name).value;

    expect(serialOf(snap)).toBe("EF2400000042");
    expect(field("serial-number")).toBe('"EF2400000042"');
    expect(field("interval")).toBe("120 s");
    expect(field("record-number")).toBe("7");
    expect(field("device-state")).toBe("stopped");
    expect(field("description")).toBe('"Fridge 3"');
    expect(field("model")).toBe("0x3005");
  });

  test("shadow record count matches the main one", async () => {
    const { transport } = setup({ recordCount: 7 });
    const snap = await takeSnapshot(transport, DEVICE, { shadow: true, usb: false });
    expect(formatSnapshot(snap)).toMatch(/record-count\?\s+00 07\s+7/);
  });

  test("reads the first and last N records with raw bytes", async () => {
    const { transport } = setup({ recordCount: 20 });
    const snap = await takeSnapshot(transport, DEVICE, { usb: false, records: 3 });

    expect(snap.records.total).toBe(20);
    expect(snap.records.read.map((r) => r.index)).toEqual([1, 2, 3, 18, 19, 20]);
    expect(snap.records.read[0].hex).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof snap.records.read[0].decoded.temperature).toBe("number");
  });

  test("carries on past a block the logger doesn't answer", async () => {
    const { transport } = setup();
    const inner = transport.inner;
    const original = inner.exchange.bind(inner);
    inner.exchange = async (frame) => {
      const offset = (frame[9] << 16) + (frame[7] << 8) + frame[8];
      if (offset >= 0x100) throw new Error("No response from logger within 2000 ms");
      return original(frame);
    };

    const snap = await takeSnapshot(transport, DEVICE, { usb: false });
    const failed = snap.spaces.main.blocks.filter((b) => b.error);
    expect(failed.length).toBeGreaterThan(0);
    expect(bytesOf(snap.spaces.main).get(0x02)).toBe("E".charCodeAt(0));
    expect(formatSnapshot(snap)).toContain("no answer: No response");
  });
});

describe("redaction and secrets", () => {
  test("redactSnapshot blanks personal fields and stray serial numbers", async () => {
    const { logger, transport } = setup();
    // A copy of the serial in the shadow space, as a real logger might have.
    logger.shadow.set(new TextEncoder().encode("EF2400000042"), 0x10);

    const snap = await takeSnapshot(transport, DEVICE, { shadow: true, usb: false });
    const red = redactSnapshot(snap);
    const json = JSON.stringify(red);

    const main = bytesOf(red.spaces.main);
    for (const offset of [0x02, 0x0d, 0x80, 0x98, 0x9f]) {
      expect(main.get(offset)).toBe(0);
    }
    expect(bytesOf(red.spaces.shadow).get(0x10)).toBe(0);
    expect(json).not.toContain(Buffer.from("EF2400000042").toString("hex"));
    expect(json).not.toContain(Buffer.from("s3cr3t").toString("hex"));
    expect(json).not.toContain("Fridge");
    expect(red.redacted).toBe(true);
    // Non-personal data survives.
    expect(main.get(0x4d)).toBe(bytesOf(snap.spaces.main).get(0x4d));
  });

  test("redaction scrubs the serial from file names and the user from the mount point", () => {
    const snap = {
      format: "rc5plus-dump/1",
      createdAt: "2026-11-18T17:00:00.000Z",
      redacted: false,
      range: { start: 0, end: 16 },
      usb: {
        devPath: "/dev/hidraw3", mountPoint: "/run/media/someone/Data Logger",
        files: [{ name: "EF2400000042-0000001.pdf", size: 1, modified: null }],
      },
      spaces: {
        main: { op: 3, blocks: [{ offset: 0, length: 16, hex: "3005" + Buffer.from("EF2400000042\0\0").toString("hex") }] },
      },
    };
    const red = redactSnapshot(snap);
    expect(red.usb.files[0].name).toBe("<serial>-0000001.pdf");
    expect(red.usb.mountPoint).toBe("/run/media/<user>/Data Logger");
  });

  test("the terminal output masks the password unless asked", async () => {
    const { transport } = setup();
    const snap = await takeSnapshot(transport, DEVICE, { usb: false });

    const masked = formatSnapshot(snap);
    expect(masked).not.toContain("s3cr3t");
    expect(masked).toContain("--show-password");

    expect(formatSnapshot(snap, { showSecrets: true })).toContain("s3cr3t");
  });
});

describe("diffSnapshots", () => {
  test("labels changed bytes with field names and decoded values", async () => {
    const { logger, transport } = setup({ intervalSeconds: 120 });
    const before = await takeSnapshot(transport, DEVICE, { usb: false });

    logger.setRunState("recording"); // 0x25 09 -> 07, 0x26 low bits 0 -> 3
    logger.memory[0x86] = 0x42; // an unmapped byte
    const after = await takeSnapshot(transport, DEVICE, { usb: false });

    const changes = diffSnapshots(before, after).filter((c) => c.field !== "device-time");
    expect(changes.map((c) => [c.offset, c.field])).toEqual([
      [0x25, "device-state"],
      [0x26, "stop-mode"],
      [0x86, null],
    ]);

    const text = formatChanges(changes, before, after).join("\n");
    expect(text).toContain("device-state: stopped → recording");
    expect(text).toContain("actual-stop-mode=0");
    expect(text).toContain("actual-stop-mode=3");
    expect(text).toContain("0x086  00 → 42  (unmapped)");
  });

  test("clock-only changes are hidden from a watch, but kept with real changes", () => {
    const tick = { space: "main", offset: 0x8e, field: "device-time", before: 1, after: 2 };
    const counter = { space: "shadow", offset: 0x8e, field: "seconds-counter?", before: 1, after: 2 };
    const state = { space: "main", offset: 0x25, field: "device-state", before: 9, after: 7 };

    expect(withoutClockNoise([tick, counter])).toEqual([]);
    expect(withoutClockNoise([tick, counter, state])).toEqual([tick, counter, state]);
  });

  test("identical dumps have no differences", async () => {
    const { transport } = setup();
    const snap = await takeSnapshot(transport, DEVICE, { usb: false });
    expect(formatDiff(snap, structuredClone(snap))).toContain("No differences.");
  });

  test("fieldAt finds the field covering a byte", () => {
    expect(fieldAt("main", 0x4d).name).toBe("interval");
    expect(fieldAt("main", 0xa0).name).toBe("description");
    expect(fieldAt("main", 0x86)).toBe(null);
    expect(fieldAt("shadow", 0x85).name).toBe("record-count?");
    expect(fieldAt("shadow", 0x12).name).toBe("last-record-time?");
  });
});

describe("device lock", () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5plus-lock-test-"));
    lockPath = path.join(dir, "rc5plus.lock");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("acquire writes the holder and release removes it", async () => {
    const release = await acquireDeviceLock("test", { lockPath });
    expect(readLock(lockPath)).toMatchObject({ pid: process.pid, label: "test" });
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("a held lock makes others wait, then fail as busy", async () => {
    const release = await acquireDeviceLock("rc5plus server", { lockPath });
    let waitedFor = null;

    const attempt = acquireDeviceLock("rc5plus dump", {
      lockPath,
      timeoutMs: 300,
      onWait: (holder) => {
        waitedFor = holder.label;
      },
    });
    const error = await attempt.catch((e) => e);

    expect(error).toBeInstanceOf(DeviceBusyError);
    expect(error.message).toContain("rc5plus server");
    expect(waitedFor).toBe("rc5plus server");
    release();
  });

  test("a waiter gets the lock as soon as it is released", async () => {
    const release = await acquireDeviceLock("first", { lockPath });
    const second = acquireDeviceLock("second", { lockPath, timeoutMs: 2_000 });
    setTimeout(release, 150);

    const releaseSecond = await second;
    expect(readLock(lockPath).label).toBe("second");
    releaseSecond();
  });

  test("a lock left by a dead process is reclaimed", async () => {
    // PID 2^22+1 is above Linux's default pid_max, so it cannot be running.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4194305, label: "crashed", since: "x" }));
    const release = await acquireDeviceLock("test", { lockPath, timeoutMs: 1_000 });
    expect(readLock(lockPath).label).toBe("test");
    release();
  });

  test("release does not remove a lock that someone else now holds", async () => {
    const release = await acquireDeviceLock("test", { lockPath });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, label: "other", since: "later" }));
    release();
    expect(readLock(lockPath).label).toBe("other");
  });
});
