// =============================================================================
// File:    src/lib/device-lock.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Cross-process lock for the logger's HID interface.
//
// Two programs talking to /dev/hidrawN at the same time receive each other's
// answers (seen on hardware: "Answer offset 32 does not match 136"). Inside
// the server, LoggerService already runs one session at a time; this lock
// extends that to other processes, such as `bun run dump`.
//
// How it works:
//   - The lock is a file created with O_EXCL (atomic: only one process can
//     create it), holding the owner's PID, a label and the start time.
//   - A lock whose PID no longer exists is stale (the owner crashed or was
//     killed) and is removed, so a crash never blocks the logger for good.
//   - Waiting is done by polling, so the event loop is never blocked.
//
// Location: $XDG_RUNTIME_DIR/rc5plus.lock (normally /run/user/<uid>/, which
// is private to the user and cleared at logout), else the temp directory.
// It is advisory: only programs that use this module respect it.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How often to retry while another process holds the lock. */
const POLL_MS = 100;

/**
 * Raised when the lock could not be taken in time. The message is written
 * for the end user.
 */
export class DeviceBusyError extends Error {
  /**
   * @param {{ pid: number, label: string, since: string } | null} holder
   */
  constructor(holder) {
    const who = holder
      ? `${holder.label} (process ${holder.pid}, since ${holder.since})`
      : "another program";
    super(`The logger is busy: ${who} is using it. Try again in a moment.`);
    this.name = "DeviceBusyError";
    this.holder = holder;
  }
}

/**
 * Default lock file path.
 *
 * @returns {string}
 */
export function defaultLockPath() {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, "rc5plus.lock");
}

/**
 * Read the lock file, or null if it is missing or unreadable.
 *
 * @param {string} lockPath
 * @returns {{ pid: number, label: string, since: string } | null}
 */
export function readLock(lockPath) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return Number.isInteger(holder.pid) ? holder : null;
  } catch {
    return null;
  }
}

/**
 * Is a process with this PID still running?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else, so it is alive.
    return err.code === "EPERM";
  }
}

/**
 * Try once to create the lock file.
 *
 * @returns {boolean} true if this process now holds the lock.
 */
function tryCreate(lockPath, label) {
  const holder = { pid: process.pid, label, since: new Date().toISOString() };
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600); // fails if it exists
    fs.writeSync(fd, JSON.stringify(holder));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

/**
 * Remove the lock file if it belongs to a process that no longer exists.
 * Re-reads it just before removing so a lock that was meanwhile replaced by
 * a live owner is left alone.
 */
function removeIfStale(lockPath) {
  const holder = readLock(lockPath);
  if (holder === null) {
    // Empty or half-written file: only stale if it stays that way. Give the
    // writer a moment by treating it as held for this round.
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return; // gone already
    }
    if (age > 2_000) {
      fs.rmSync(lockPath, { force: true });
    }
    return;
  }
  if (!isAlive(holder.pid)) {
    const again = readLock(lockPath);
    if (again && again.pid === holder.pid && again.since === holder.since) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Take the lock, waiting up to `timeoutMs` for the current holder.
 *
 * @param {string} label  Shown to whoever has to wait, e.g. "rc5plus server".
 * @param {object} [options]
 * @param {number} [options.timeoutMs=15000]
 * @param {string} [options.lockPath]
 * @param {(holder: object|null) => void} [options.onWait]
 *   Called once if the lock is held by someone else, before waiting.
 * @returns {Promise<() => void>} Call the returned function to release.
 */
export async function acquireDeviceLock(label, options = {}) {
  const { timeoutMs = 15_000, lockPath = defaultLockPath(), onWait } = options;
  const deadline = Date.now() + timeoutMs;
  let told = false;

  for (;;) {
    if (tryCreate(lockPath, label)) {
      const mine = readLock(lockPath);
      return () => {
        // Only remove the file if it is still ours.
        const current = readLock(lockPath);
        if (current && mine && current.pid === mine.pid && current.since === mine.since) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    }

    removeIfStale(lockPath);

    if (Date.now() >= deadline) {
      throw new DeviceBusyError(readLock(lockPath));
    }
    if (!told && onWait) {
      onWait(readLock(lockPath));
      told = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
