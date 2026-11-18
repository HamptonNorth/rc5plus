// =============================================================================
// File:    src/lib/usb-drive.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Locates the RC-5+'s USB mass-storage volume (which holds the PDF report
// the logger generates) and lists the PDF files on it.
//
// The logger is a composite USB device: one HID interface (commands) and one
// mass-storage interface (PDF drive). Starting from the USB device's sysfs
// directory we find its block device, then its mount point in
// /proc/self/mounts. If the desktop has not auto-mounted it, we ask udisks
// to mount it (no root needed on a normal desktop session).
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

/**
 * Find block device names (e.g. "sdb", "sdb1") below a USB device directory.
 *
 * sysfs is full of symlinks that loop back on themselves; Dirent.isDirectory()
 * is false for symlinks, so they are skipped automatically.
 *
 * @param {string} usbDir  sysfs directory of the USB device.
 * @returns {string[]} Partition names first, then whole-disk names.
 */
export function findBlockDevices(usbDir) {
  const disks = [];

  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === "block") {
        for (const disk of fs.readdirSync(child)) {
          disks.push(disk);
        }
      } else {
        walk(child, depth + 1);
      }
    }
  }
  walk(usbDir, 0);

  // A disk may be formatted directly (sdb) or partitioned (sdb1).
  const partitions = [];
  for (const disk of disks) {
    try {
      for (const name of fs.readdirSync(path.join("/sys/block", disk))) {
        if (name.startsWith(disk) && name !== disk) {
          partitions.push(name);
        }
      }
    } catch {
      // Disk vanished between scans; ignore.
    }
  }
  return [...partitions, ...disks];
}

/**
 * Decode the octal escapes used in /proc/mounts (e.g. "\040" for a space).
 *
 * @param {string} s
 * @returns {string}
 */
function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Mount point of /dev/<name>, or null if it is not mounted.
 *
 * @param {string} name  e.g. "sdb"
 * @returns {string|null}
 */
export function mountPointOf(name) {
  const device = `/dev/${name}`;
  let mounts;
  try {
    mounts = fs.readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return null;
  }
  for (const line of mounts.split("\n")) {
    const [source, target] = line.split(" ");
    if (source === device && target) {
      return unescapeMount(target);
    }
  }
  return null;
}

/**
 * Ask udisks to mount a block device (what the desktop does on plug-in).
 *
 * @param {string} name  e.g. "sdb"
 * @returns {Promise<string|null>} Mount point, or null if mounting failed.
 */
async function udisksMount(name) {
  try {
    const proc = Bun.spawn(
      ["udisksctl", "mount", "--block-device", `/dev/${name}`, "--no-user-interaction"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
  } catch {
    // udisksctl not installed; fall through to the mount table check.
  }
  return mountPointOf(name);
}

/**
 * Find (and if necessary mount) the logger's drive.
 *
 * @param {string} usbDir
 * @returns {Promise<{ mountPoint: string|null, reason?: string }>}
 */
export async function locateDrive(usbDir) {
  const candidates = findBlockDevices(usbDir);
  if (candidates.length === 0) {
    return { mountPoint: null, reason: "The logger's USB drive is not visible to the system." };
  }

  for (const name of candidates) {
    const mounted = mountPointOf(name);
    if (mounted) return { mountPoint: mounted };
  }

  for (const name of candidates) {
    const mounted = await udisksMount(name);
    if (mounted) return { mountPoint: mounted };
  }

  return {
    mountPoint: null,
    reason: `Found /dev/${candidates[0]} but could not mount it. Open it once in Dolphin, then refresh.`,
  };
}

/**
 * List PDF files in the root of a mounted drive.
 *
 * @param {string} mountPoint
 * @returns {Array<{ name: string, size: number, modified: string }>}
 */
export function listPdfs(mountPoint) {
  let names;
  try {
    names = fs.readdirSync(mountPoint);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => {
      const stat = fs.statSync(path.join(mountPoint, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}
