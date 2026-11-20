// =============================================================================
// File:    src/lib/paths.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Where the app keeps its files (exports/ and dumps/).
//
//   - Run from the source tree (`bun start`): the repository root, as before.
//   - Run as the compiled binary (`bun run build`): the code lives inside the
//     executable (/$bunfs/...), so files go to $XDG_DATA_HOME/rc5plus-app
//     (normally ~/.local/share/rc5plus-app) instead.
//   - RC5_DATA_DIR overrides both.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import os from "node:os";
import path from "node:path";

/** Prefix Bun gives to modules embedded in a `bun build --compile` binary. */
const EMBEDDED_PREFIX = "/$bunfs/";

/**
 * True when running as a compiled executable rather than from source.
 * @param {string} [dir] - Module directory to test (defaults to this module's).
 * @returns {boolean}
 */
export function isCompiled(dir = import.meta.dir) {
  return dir.startsWith(EMBEDDED_PREFIX);
}

/**
 * Decide the data directory.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Environment to read.
 * @param {boolean} [options.compiled] - Whether this is the compiled binary.
 * @param {string} [options.home] - Home directory (for the XDG default).
 * @returns {string} Absolute path.
 */
export function resolveDataDir({
  env = process.env,
  compiled = isCompiled(),
  home = os.homedir(),
} = {}) {
  if (env.RC5_DATA_DIR) return path.resolve(env.RC5_DATA_DIR);
  if (!compiled) return path.resolve(import.meta.dir, "..", "..");
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
  return path.join(xdg, "rc5plus-app");
}
