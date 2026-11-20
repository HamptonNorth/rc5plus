// =============================================================================
// File:    test/paths.test.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Data directory choice (source tree vs compiled binary) and the embedded
// web UI file list.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { isCompiled, resolveDataDir } from "../src/lib/paths.js";
import { STATIC_ASSETS } from "../src/lib/static-assets.js";

const REPO = path.resolve(import.meta.dir, "..");

describe("isCompiled", () => {
  test("false from the source tree", () => {
    expect(isCompiled()).toBe(false);
    expect(isCompiled("/home/user/rc5plus-app/src/lib")).toBe(false);
  });

  test("true inside a compiled binary", () => {
    expect(isCompiled("/$bunfs/root")).toBe(true);
  });
});

describe("resolveDataDir", () => {
  test("repository root from source", () => {
    expect(resolveDataDir({ env: {}, compiled: false })).toBe(REPO);
  });

  test("~/.local/share/rc5plus-app for the compiled binary", () => {
    expect(resolveDataDir({ env: {}, compiled: true, home: "/home/u" }))
      .toBe("/home/u/.local/share/rc5plus-app");
  });

  test("honours an absolute XDG_DATA_HOME, ignores a relative one", () => {
    expect(resolveDataDir({ env: { XDG_DATA_HOME: "/data" }, compiled: true, home: "/home/u" }))
      .toBe("/data/rc5plus-app");
    expect(resolveDataDir({ env: { XDG_DATA_HOME: "rel" }, compiled: true, home: "/home/u" }))
      .toBe("/home/u/.local/share/rc5plus-app");
  });

  test("RC5_DATA_DIR overrides both", () => {
    expect(resolveDataDir({ env: { RC5_DATA_DIR: "/srv/rc5" }, compiled: true })).toBe("/srv/rc5");
    expect(resolveDataDir({ env: { RC5_DATA_DIR: "/srv/rc5" }, compiled: false })).toBe("/srv/rc5");
  });
});

describe("STATIC_ASSETS", () => {
  test("every file in public/ is listed, and every listed file exists", () => {
    const listed = new Set([...STATIC_ASSETS.values()].map((a) => path.basename(a.file)));
    const onDisk = fs.readdirSync(path.join(REPO, "public"));
    expect([...listed].sort()).toEqual([...onDisk].sort());
    for (const { file } of STATIC_ASSETS.values()) expect(fs.existsSync(file)).toBe(true);
  });

  test("/ serves index.html", () => {
    expect(path.basename(STATIC_ASSETS.get("/").file)).toBe("index.html");
  });
});
