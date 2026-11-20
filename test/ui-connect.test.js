// =============================================================================
// File:    test/ui-connect.test.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// The browser's connect logic (public/app.js poll()), run in Bun with a
// minimal fake page, fake timers and a scripted API: after a plug-in the
// first reads fail (as on real hardware while Linux sets the logger up)
// and the USB drive mounts late. The page must show "Reading the logger…",
// retry by itself, and never sit on a blank details view.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const INFO = {
  serialNumber: "EF2412345678", firmwareVersion: 0x57, protocolVersion: 0x38,
  recordCount: 5, deviceCapacity: 32000, intervalSeconds: 300, deviceTime: "2026-11-20 10:00:00",
  timezone: "+0000", tripStartTime: null, startTime: null, lastRecordTime: null, stopTime: null,
  configurationTime: null, batteryLevel: 5, runState: "stopped", stopMode: 0, deviceState: 0x09,
  description: "Fridge", tripNumber: "0000001", settingsErased: false,
};

/** A fake element with just what app.js touches. */
function fakeElement() {
  return {
    hidden: false, textContent: "", className: "", value: "", disabled: false, src: "",
    children: [],
    append(...c) { this.children.push(...c); },
    replaceChildren() { this.children = []; },
    addEventListener() {},
    removeAttribute(name) { this[name] = ""; },
    reportValidity: () => true,
    showModal() {},
    scrollIntoView() {},
  };
}

/** Scripted API state. */
const api = { connected: false, infoFailuresLeft: 0, driveMounted: false, calls: [] };
const elements = new Map();
/** Pending poll callback (setTimeout with POLL_MS). */
let nextPoll = null;
/** Every sleep requested by app.js. */
const sleeps = [];
let now = 1_000_000;

function respond(status, body) {
  return {
    ok: status < 400, status,
    json: async () => body,
  };
}

/** The real globals, put back after this file so other test files aren't affected. */
const real = {
  document: globalThis.document,
  setTimeout: globalThis.setTimeout,
  fetch: globalThis.fetch,
  dateNow: Date.now,
};

const fakeDocument = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  },
  createElement: () => fakeElement(),
};
const fakeSetTimeout = (fn, ms) => {
  if (ms === 2500) nextPoll = fn;
  else { sleeps.push(ms); now += ms; fn(); } // sleep(): resolve at once
  return 0;
};
const fakeFetch = async (url) => {
  api.calls.push(url);
  if (url === "/api/status") return respond(200, { connected: api.connected, devPath: "/dev/hidraw3", mock: false });
  if (!api.connected) return respond(404, { error: "No RC-5+ logger connected.", code: "NOT_CONNECTED" });
  if (url === "/api/info") {
    if (api.infoFailuresLeft > 0) {
      api.infoFailuresLeft -= 1;
      return respond(403, { error: "Permission denied opening /dev/hidraw3.", code: "EACCES" });
    }
    return respond(200, INFO);
  }
  if (url === "/api/pdfs") {
    return respond(200, api.driveMounted
      ? { mountPoint: "/media/u/RC5", files: [{ name: "EF2412345678.pdf", size: 2048 }] }
      : { mountPoint: null, files: [], reason: "USB drive not mounted." });
  }
  throw new Error(`unexpected ${url}`);
};


const $ = (id) => elements.get(id);
/** Run one poll cycle (the 2.5 s timer), 2.5 s later. */
async function tick() {
  now += 2500;
  const fn = nextPoll;
  nextPoll = null;
  await fn();
  await Bun.sleep(0);
}
const visible = () => ["empty", "loading", "connected"].filter((id) => !$(id).hidden);

describe("connect flow in the browser", () => {
  beforeAll(async () => {
    globalThis.document = fakeDocument;
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.fetch = fakeFetch;
    Date.now = () => now;
    // app.js starts polling as soon as it is imported (the first poll runs now).
    await import("../public/app.js");
  });

  afterAll(() => {
    // app.js's next poll stays parked in nextPoll and never runs.
    if (real.document === undefined) delete globalThis.document;
    else globalThis.document = real.document;
    globalThis.setTimeout = real.setTimeout;
    globalThis.fetch = real.fetch;
    Date.now = real.dateNow;
  });

  beforeEach(() => {
    api.calls = [];
    sleeps.length = 0;
  });

  test("page opened with nothing plugged in shows 'no logger'", async () => {
    await Bun.sleep(0);
    expect(visible()).toEqual(["empty"]);
  });

  test("plug-in: settle pause, failed reads keep 'Reading the logger…', then details", async () => {
    api.connected = true;
    api.infoFailuresLeft = 4;
    await tick(); // detects the logger: settles, first read fails
    expect(sleeps).toEqual([1500]);
    expect(visible()).toEqual(["loading"]);
    expect($("loading-detail").textContent).toBe("This takes a moment after plugging it in.");

    await tick(); // 2nd failure
    await tick(); // 3rd failure: reason shown, still retrying
    expect(visible()).toEqual(["loading"]);
    expect($("loading-detail").textContent).toBe("Permission denied opening /dev/hidraw3. Still trying…");

    await tick(); // 4th failure
    await tick(); // succeeds
    expect(visible()).toEqual(["connected"]);
    expect($("serial").textContent).toBe("EF2412345678");
    expect(sleeps).toEqual([1500]); // only once per plug-in
  });

  test("USB drive mounting late: waiting message, then the PDF list", async () => {
    expect($("pdf-result").textContent).toBe("Waiting for the logger's USB drive to appear…");
    expect($("pdf-result").className).toBe("result ok");
    api.driveMounted = true;
    await tick();
    expect($("pdf-list").children).toHaveLength(1);
    expect($("pdf-result").textContent).toBe("");

    await tick(); // found: no more PDF requests
    expect(api.calls).toEqual(["/api/status", "/api/pdfs", "/api/status"]);
  });

  test("unplug, then replug a logger that answers at once", async () => {
    api.connected = false;
    await tick();
    expect(visible()).toEqual(["empty"]);

    api.connected = true;
    api.driveMounted = false;
    await tick();
    expect(visible()).toEqual(["connected"]);
    expect($("pdf-list").children).toHaveLength(0); // old list cleared
  });

  test("a drive that never mounts: retries for 30 s, then shows why", async () => {
    for (let i = 0; i < 12; i++) await tick(); // past the 30 s window
    expect($("pdf-result").textContent).toBe("USB drive not mounted.");
    expect($("pdf-result").className).toBe("result err");
    api.calls = [];
    await tick();
    expect(api.calls).toEqual(["/api/status"]); // stopped retrying
  });
});
