// =============================================================================
// File:    test/server.test.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// The HTTP layer (src/app.js) through a real Bun.serve() on a free port,
// against the simulated logger: routes, status codes, headers, the web UI
// file list, and the error → HTTP mapping.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp, errorResponse } from "../src/app.js";
import { LoggerService, NotConnectedError } from "../src/lib/logger-service.js";
import { TransportError } from "../src/elitech/hidraw.js";
import { FrameError } from "../src/elitech/frame.js";
import { NotAppliedError, NotStoppedError, SettingsErasedError } from "../src/elitech/rc5plus.js";
import { DeviceBusyError } from "../src/lib/device-lock.js";

/**
 * Start a server on a free port with a fresh simulated logger.
 * @param {string} [mockState] - RC5_MOCK_STATE for the simulator.
 */
function startServer(mockState) {
  const saved = process.env.RC5_MOCK_STATE;
  if (mockState) process.env.RC5_MOCK_STATE = mockState;
  else delete process.env.RC5_MOCK_STATE;
  const service = new LoggerService({ mock: true });
  if (saved === undefined) delete process.env.RC5_MOCK_STATE;
  else process.env.RC5_MOCK_STATE = saved;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5-server-"));
  const server = Bun.serve({
    ...createApp({ service, dataDir, mock: true }),
    port: 0,
    hostname: "127.0.0.1",
    development: false,
  });
  return {
    server,
    dataDir,
    url: (p) => `http://127.0.0.1:${server.port}${p}`,
    stop: () => {
      server.stop(true);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const postJson = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("HTTP API (simulated logger, stopped)", () => {
  let s;
  beforeAll(() => {
    s = startServer();
  });
  afterAll(() => s.stop());

  test("GET /api/status", async () => {
    const res = await fetch(s.url("/api/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: true, mock: true });
  });

  test("GET /api/info", async () => {
    const res = await fetch(s.url("/api/info"));
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.serialNumber).toBe("EF2412345678");
    expect(info.description).toBe("Mock fridge");
  });

  test("GET /api/export.csv sends the CSV and keeps a copy", async () => {
    const res = await fetch(s.url("/api/export.csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="RC5_EF2412345678_\d{8}-\d{6}\.csv"$/);
    const csv = await res.text();
    const count = Number(res.headers.get("x-record-count"));
    expect(count).toBeGreaterThan(0);
    expect(csv.trim().split(/\r?\n/)).toHaveLength(count + 1);

    const savedAs = res.headers.get("x-saved-as");
    expect(savedAs).toMatch(/^exports\//);
    expect(fs.readFileSync(path.join(s.dataDir, savedAs), "utf8")).toBe(csv);
  });

  test("GET /api/pdfs and /api/pdfs/:name", async () => {
    const list = await (await fetch(s.url("/api/pdfs"))).json();
    expect(list.files.map((f) => f.name)).toEqual(["EF2412345678.pdf"]);

    const inline = await fetch(s.url("/api/pdfs/EF2412345678.pdf"));
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("application/pdf");
    expect(inline.headers.get("content-disposition")).toBe('inline; filename="EF2412345678.pdf"');
    expect((await inline.text()).startsWith("%PDF-")).toBe(true);

    const download = await fetch(s.url("/api/pdfs/EF2412345678.pdf?download=1"));
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="EF2412345678.pdf"');
  });

  test("a PDF not in the listing is 404, including traversal attempts", async () => {
    for (const p of ["/api/pdfs/other.pdf", "/api/pdfs/..%2F..%2Fetc%2Fpasswd", "/api/pdfs/a/b.pdf"]) {
      const res = await fetch(s.url(p));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("NOT_FOUND");
    }
  });

  test("POST /api/reset needs confirm: true", async () => {
    for (const body of [{ minutes: 5 }, { minutes: 5, confirm: "yes" }, "not json", "null"]) {
      const res = await fetch(s.url("/api/reset"), postJson(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("BAD_REQUEST");
    }
  });

  test("POST /api/reset rejects a bad interval or text with 400", async () => {
    for (const body of [
      { minutes: 0, confirm: true },
      { minutes: 16, confirm: true },
      { minutes: 5, confirm: true, tripNumber: "has space" },
      { minutes: 5, confirm: true, description: "café" },
    ]) {
      const res = await fetch(s.url("/api/reset"), postJson(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("BAD_REQUEST");
    }
  });

  test("POST /api/reset resets and sets the text fields", async () => {
    const res = await fetch(
      s.url("/api/reset"),
      postJson({ minutes: 7, confirm: true, description: "Server test", tripNumber: "T-0042" }),
    );
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.recordCount).toBe(0);
    expect(info.runState).toBe("ready");
    expect(info.description).toBe("Server test");
    expect(info.tripNumber).toBe("T-0042");
  });

  test("web UI files are served with their types", async () => {
    const expected = {
      "/": "text/html; charset=utf-8",
      "/index.html": "text/html; charset=utf-8",
      "/app.js": "text/javascript; charset=utf-8",
      "/styles.css": "text/css; charset=utf-8",
    };
    for (const [p, type] of Object.entries(expected)) {
      const res = await fetch(s.url(p));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
    }
    expect(await (await fetch(s.url("/"))).text()).toContain("<title>RC-5+ Logger</title>");
  });

  test("anything else is 404; nothing else on disk is reachable", async () => {
    for (const p of ["/package.json", "/src/server.js", "/public/app.js", "/../package.json", "/api/nope"]) {
      const res = await fetch(s.url(p));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("NOT_FOUND");
    }
  });

  test("a known path with the wrong method is 405 with Allow", async () => {
    const get = await fetch(s.url("/api/reset"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const post = await fetch(s.url("/api/info"), { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});

describe("HTTP API (simulated logger, recording)", () => {
  let s;
  beforeAll(() => {
    s = startServer("recording");
  });
  afterAll(() => s.stop());

  test("reset is refused with 409 NOT_STOPPED", async () => {
    const res = await fetch(s.url("/api/reset"), postJson({ minutes: 5, confirm: true }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("NOT_STOPPED");
    expect(body.runState).toBe("recording");
  });

  test("reading still works", async () => {
    expect((await fetch(s.url("/api/info"))).status).toBe(200);
  });
});

describe("errorResponse", () => {
  const cases = [
    [new NotConnectedError(), 404, "NOT_CONNECTED"],
    [new SettingsErasedError(), 409, "SETTINGS_ERASED"],
    [new DeviceBusyError(null), 423, "BUSY"],
    [new NotAppliedError("x"), 502, "NOT_APPLIED"],
    [new RangeError("x"), 400, "BAD_REQUEST"],
    [new TransportError("x", "EACCES"), 403, "EACCES"],
    [new TransportError("x", "EPROTO"), 503, "EPROTO"],
    [new FrameError("x"), 502, "PROTOCOL"],
    [new NotStoppedError({ deviceState: 0x07, runState: "recording" }), 409, "NOT_STOPPED"],
  ];

  for (const [err, status, code] of cases) {
    test(`${err.constructor.name}${err.code ? ` (${err.code})` : ""} → ${status} ${code}`, async () => {
      const res = errorResponse(err);
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    });
  }

  test("anything else → 500 INTERNAL", async () => {
    const spy = console.error;
    console.error = () => {};
    try {
      const res = errorResponse(new Error("boom"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "boom", code: "INTERNAL" });
    } finally {
      console.error = spy;
    }
  });
});
