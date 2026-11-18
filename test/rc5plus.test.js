// =============================================================================
// File:    test/rc5plus.test.js
// Version: 1.2.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Exercises the high-level Rc5Plus operations and CSV export against the
// simulated logger in src/elitech/mock-device.js.
//
// Run: bun test
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { describe, expect, test } from "bun:test";

import { Operation } from "../src/elitech/constants.js";
import { MockRc5Plus, MockTransport } from "../src/elitech/mock-device.js";
import {
  decodeInfo,
  encodeDateTime,
  ParameterImage,
  StopMode,
} from "../src/elitech/parameters.js";
import { NotAppliedError, NotStoppedError, Rc5Plus } from "../src/elitech/rc5plus.js";
import { recordsToCsv } from "../src/lib/csv.js";

/** Fresh simulated logger + client for each test. */
function setup(options) {
  const device = new MockRc5Plus(options);
  const logger = new Rc5Plus(new MockTransport(device));
  return { device, logger };
}

/** Operation code of a logged request frame. */
const opOf = (frame) => frame[4] | (frame[5] << 8);

/** Offset of a logged request frame. */
const offsetOf = (frame) => (frame[9] << 16) + (frame[7] << 8) + frame[8];

describe("Rc5Plus against the simulated logger", () => {
  test("readInfo returns serial number and settings", async () => {
    const { logger } = setup({ serialNumber: "EF2400000042", recordCount: 10, intervalSeconds: 120 });
    const info = await logger.readInfo();

    expect(info.serialNumber).toBe("EF2400000042");
    expect(info.model).toBe(0x3005);
    expect(info.recordCount).toBe(10);
    expect(info.intervalSeconds).toBe(120);
    expect(info.deviceCapacity).toBe(32000);
    expect(info.startMode).toBe("Manual");
  });

  test("readRecords downloads every record in order", async () => {
    const { logger } = setup({ recordCount: 293, intervalSeconds: 60 });
    const { records } = await logger.readRecords();

    expect(records.length).toBe(293);
    expect(records[0].index).toBe(1);
    expect(records.at(-1).index).toBe(293);

    // Consecutive timestamps one minute apart.
    const t0 = Date.parse(records[0].time.replace(" ", "T"));
    const t1 = Date.parse(records[1].time.replace(" ", "T"));
    expect(t1 - t0).toBe(60_000);
  });

  test("readRecords on an empty logger returns nothing", async () => {
    const { logger } = setup({ recordCount: 0 });
    const { records } = await logger.readRecords();
    expect(records).toEqual([]);
  });
});

describe("resetForNewTrip", () => {
  test("writes interval and clock, then Format, and never sends Stop", async () => {
    const { device, logger } = setup({ recordCount: 500, intervalSeconds: 120 });
    device.log.length = 0;

    await logger.resetForNewTrip(1);

    const commands = device.log
      .filter((f) => opOf(f) !== Operation.GetParameter)
      .map((f) => [opOf(f), offsetOf(f)]);
    expect(commands).toEqual([
      [Operation.SetParameter, 0x4c], // interval
      [Operation.SetParameter, 0x28], // configuration time
      [Operation.Format, 0], // commits both, erases records
    ]);

    const intervalWrite = device.log.find((f) => opOf(f) === Operation.SetParameter);
    expect(Array.from(intervalWrite.slice(11, 13))).toEqual([0x00, 6]); // 60 s / 10
  });

  test("leaves 0 records, the new interval and the clock set", async () => {
    const { logger } = setup({ recordCount: 500, intervalSeconds: 600 });

    const now = new Date(2026, 10, 18, 15, 46, 30);
    const info = await logger.resetForNewTrip(15, now);

    expect(info.recordCount).toBe(0);
    expect(info.intervalSeconds).toBe(900);
    expect(info.configurationTime).toBe("2026-11-18 15:46:30");
    expect(info.deviceTime.startsWith("2026-11-18 15:46:")).toBe(true);
    expect(info.runState).toBe("ready");
  });

  test("writes the day of the week in the date, as the official software does", () => {
    // 2026-11-18 is a Wednesday (3); 2026-11-22 a Sunday (0).
    expect(Array.from(encodeDateTime(new Date(2026, 10, 18, 16, 59, 9)))).toEqual([26, 11, 3, 18, 16, 59, 9]);
    expect(encodeDateTime(new Date(2026, 10, 22, 0, 0, 0))[2]).toBe(0);
  });

  test("works again on a logger that has already been reset", async () => {
    const { logger } = setup({ state: "ready", recordCount: 0 });
    const info = await logger.resetForNewTrip(5);
    expect(info.intervalSeconds).toBe(300);
  });

  test("rejects intervals outside 1..15 before touching the logger", async () => {
    const { device, logger } = setup();
    device.log.length = 0;
    for (const bad of [0, 16, 2.5, -1, Number.NaN]) {
      await expect(logger.resetForNewTrip(bad)).rejects.toThrow(RangeError);
    }
    expect(device.log.length).toBe(0);
  });

  test("reports a logger that acknowledges but does not apply the settings", async () => {
    const { device, logger } = setup({ intervalSeconds: 120, recordCount: 4 });

    // A logger whose Format commits nothing (the old Clear order showed this).
    device.commitPending = () => {
      device.pending = [];
    };

    const error = await logger.resetForNewTrip(1).catch((e) => e);
    expect(error).toBeInstanceOf(NotAppliedError);
    expect(error.message).toBe(
      "The logger acknowledged the reset but kept its interval at 2 min (asked for 1 min).",
    );
  });

  test("reports records left behind by a Format", async () => {
    const { device, logger } = setup({ recordCount: 4 });
    const original = device.handle.bind(device);
    device.handle = (request) => {
      const kept = device.records.slice();
      const answer = original(request);
      if (opOf(request) === Operation.Format) {
        device.records = kept;
        device.syncRecordCount();
      }
      return answer;
    };

    await expect(logger.resetForNewTrip(1)).rejects.toThrow(
      "The reset did not complete: the logger still reports 4 records.",
    );
  });
});

describe("Simulator matches the real logger's write behaviour", () => {
  test("a write without Format is acknowledged but not kept", async () => {
    const { device, logger } = setup({ intervalSeconds: 120 });
    const { Param, encodeInterval } = await import("../src/elitech/parameters.js");

    await logger.writeParameter(Param.interval, encodeInterval(60));
    expect((await logger.readInfo()).intervalSeconds).toBe(120);
    expect(device.pending.length).toBe(1);
  });
});

describe("Run state guard (logger must be stopped)", () => {
  /** Parameter bytes captured from a real RC-5+ (serial blanked). */
  function realImage(state0x25, stop0x26) {
    const memory = new Uint8Array(0x100);
    memory.set([0x30, 0x05], 0x00);
    memory.set([0x59, 0x00, 0x00, 0x00, 0x00, state0x25, stop0x26, 0x04], 0x20);
    memory.set([0x1a, 0x05, 0x06, 0x09, 0x08, 0x17, 0x00], 0x28);
    memory.set([0x00, 0x0c], 0x4c);
    const image = new ParameterImage();
    image.add(0, memory);
    return image;
  }

  test("decodes the states seen on a real logger", () => {
    const recording = decodeInfo(realImage(0x07, 0x1b));
    expect(recording.runState).toBe("recording");
    expect(recording.stopMode).toBe(StopMode.UsbPause);

    const buttonStop = decodeInfo(realImage(0x09, 0x18));
    expect(buttonStop.runState).toBe("stopped");
    expect(buttonStop.stopMode).toBe(StopMode.Button);

    const usbStop = decodeInfo(realImage(0x09, 0x1c));
    expect(usbStop.runState).toBe("stopped");
    expect(usbStop.stopMode).toBe(StopMode.Software);

    const afterReset = decodeInfo(realImage(0x04, 0x1b));
    expect(afterReset.runState).toBe("ready");

    expect(decodeInfo(realImage(0x05, 0x18)).runState).toBe("start-delay");
    expect(decodeInfo(realImage(0x01, 0x18)).runState).toBe("unknown");
  });

  test("simulator starts stopped by default", async () => {
    const { logger } = setup();
    const info = await logger.readInfo();
    expect(info.runState).toBe("stopped");
    expect(info.deviceState).toBe(0x09);
  });

  test("a recording logger is refused and nothing is written or erased", async () => {
    const { device, logger } = setup({ state: "recording", intervalSeconds: 120, recordCount: 40 });
    device.log.length = 0;

    await expect(logger.resetForNewTrip(1)).rejects.toThrow(NotStoppedError);
    await expect(logger.resetForNewTrip(1)).rejects.toThrow(/still recording/);

    const ops = device.log.map(opOf);
    expect(ops).not.toContain(Operation.SetParameter);
    expect(ops).not.toContain(Operation.Format);
    expect(ops).not.toContain(Operation.Stop);

    const info = await logger.readInfo();
    expect(info.intervalSeconds).toBe(120);
    expect(info.recordCount).toBe(40);
  });

  test("a logger waiting for its start delay is refused", async () => {
    const { device, logger } = setup();
    device.setRunState(0x05);
    await expect(logger.resetForNewTrip(1)).rejects.toThrow(/start delay/);
  });

  test("an unrecognised state is refused with its raw value in the message", async () => {
    const { device, logger } = setup();
    device.setRunState(0x01);

    const error = await logger.resetForNewTrip(5).catch((e) => e);
    expect(error).toBeInstanceOf(NotStoppedError);
    expect(error.runState).toBe("unknown");
    expect(error.message).toContain("0x01");
  });

  test("once the logger is stopped it can be reset", async () => {
    const { device, logger } = setup({ state: "recording" });
    await expect(logger.resetForNewTrip(3)).rejects.toThrow(NotStoppedError);

    device.setRunState("stopped"); // user presses the stop button
    const info = await logger.resetForNewTrip(3);
    expect(info.intervalSeconds).toBe(180);
    expect(info.recordCount).toBe(0);
  });
});

describe("CSV export", () => {
  test("has a header, one row per record and escapes nothing unexpectedly", async () => {
    const { logger } = setup({ serialNumber: "EF2400000042", recordCount: 7 });
    const { info, records } = await logger.readRecords();
    const csv = recordsToCsv(info, records);
    const lines = csv.trimEnd().split("\r\n");

    expect(lines[0]).toBe("index,timestamp,temperature_c,marked,event");
    expect(lines.length).toBe(1 + 7);
    expect(lines[1]).toMatch(/^1,\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,-?\d+\.\d,(yes|no),$/);
  });
});
