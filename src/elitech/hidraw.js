// =============================================================================
// File:    src/elitech/hidraw.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Linux hidraw transport: locates the RC-5+ through /sys/class/hidraw and
// exchanges 64-byte reports with /dev/hidrawN.
//
// No native addon is used: the device node is opened non-blocking and polled,
// so a silent device can never block Bun's event loop.
//
// Device discovery mirrors python-elitech by Pascal Combes
// (https://github.com/pasccom/python-elitech), licensed GPL-3.0-or-later.
// This file is therefore also GPL-3.0-or-later. See LICENSE.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import {
  REPORT_SIZE,
  RESPONSE_TIMEOUT_MS,
  RC5PLUS_PRODUCT_ID,
  RC5PLUS_VENDOR_ID,
} from "./constants.js";

const HIDRAW_CLASS_DIR = "/sys/class/hidraw";

/**
 * Error raised for transport problems (missing device, permissions, timeout).
 */
export class TransportError extends Error {
  constructor(message, code = "TRANSPORT") {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

/**
 * Read a small sysfs text file, returning null if it does not exist.
 *
 * @param {string} file
 * @returns {string|null}
 */
function readSysfs(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Walk up from a hidraw sysfs node to the owning USB device directory
 * (the first ancestor containing idVendor and idProduct).
 *
 * @param {string} hidrawName  e.g. "hidraw3"
 * @returns {{ usbDir: string, vendorId: number, productId: number } | null}
 */
function resolveUsbDevice(hidrawName) {
  let dir;
  try {
    dir = fs.realpathSync(path.join(HIDRAW_CLASS_DIR, hidrawName));
  } catch {
    return null;
  }

  while (dir !== "/" && dir !== ".") {
    const vendor = readSysfs(path.join(dir, "idVendor"));
    const product = readSysfs(path.join(dir, "idProduct"));
    if (vendor !== null && product !== null) {
      return {
        usbDir: dir,
        vendorId: parseInt(vendor, 16),
        productId: parseInt(product, 16),
      };
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Find every connected RC-5+.
 *
 * @returns {Array<{ devPath: string, usbDir: string }>}
 *   devPath: /dev/hidrawN to open
 *   usbDir:  sysfs directory of the USB device (used to find its USB drive)
 */
export function findRc5PlusDevices() {
  let entries;
  try {
    entries = fs.readdirSync(HIDRAW_CLASS_DIR);
  } catch {
    // No hidraw class at all: no HID devices, or not running on Linux.
    return [];
  }

  const found = [];
  for (const name of entries.sort()) {
    const usb = resolveUsbDevice(name);
    if (
      usb &&
      usb.vendorId === RC5PLUS_VENDOR_ID &&
      usb.productId === RC5PLUS_PRODUCT_ID
    ) {
      found.push({ devPath: path.join("/dev", name), usbDir: usb.usbDir });
    }
  }
  return found;
}

/**
 * Promise-based delay.
 *
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One open hidraw device node.
 *
 * Usage:
 *   const t = HidrawTransport.open("/dev/hidraw3");
 *   try { const reply = await t.exchange(frame); } finally { t.close(); }
 */
export class HidrawTransport {
  /**
   * @param {number} fd
   * @param {string} devPath
   */
  constructor(fd, devPath) {
    this.fd = fd;
    this.devPath = devPath;
  }

  /**
   * Open the device node read/write and non-blocking.
   *
   * @param {string} devPath
   * @returns {HidrawTransport}
   */
  static open(devPath) {
    try {
      const fd = fs.openSync(
        devPath,
        fs.constants.O_RDWR | fs.constants.O_NONBLOCK,
      );
      return new HidrawTransport(fd, devPath);
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new TransportError(
          `Permission denied opening ${devPath}. Install the udev rule ` +
            `(see README) and replug the logger.`,
          "EACCES",
        );
      }
      throw new TransportError(`Cannot open ${devPath}: ${err.message}`);
    }
  }

  /**
   * Discard any input reports already queued (e.g. a late answer to an
   * earlier timed-out request) so the next read pairs with the next write.
   */
  drain() {
    const scratch = Buffer.alloc(REPORT_SIZE);
    for (;;) {
      try {
        if (fs.readSync(this.fd, scratch, 0, REPORT_SIZE, null) <= 0) {
          return;
        }
      } catch (err) {
        if (err.code === "EAGAIN" || err.code === "EWOULDBLOCK") {
          return;
        }
        throw new TransportError(`Read failed: ${err.message}`);
      }
    }
  }

  /**
   * Send one frame as a zero-padded 64-byte output report.
   *
   * The RC-5+ has no numbered reports. Like python-elitech we write the frame
   * directly: its first byte (0x33) is non-zero, so the kernel sends the
   * whole 64-byte buffer to the device unchanged.
   *
   * @param {Uint8Array} frame
   */
  write(frame) {
    if (frame.length > REPORT_SIZE) {
      throw new TransportError(`Frame too long: ${frame.length} bytes`);
    }
    const report = Buffer.alloc(REPORT_SIZE);
    report.set(frame);

    try {
      const written = fs.writeSync(this.fd, report);
      if (written !== REPORT_SIZE) {
        throw new TransportError(`Short write: ${written} of ${REPORT_SIZE}`);
      }
    } catch (err) {
      if (err instanceof TransportError) {
        throw err;
      }
      throw new TransportError(`Write failed: ${err.message}`);
    }
  }

  /**
   * Wait for one 64-byte input report.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<Uint8Array>}
   */
  async read(timeoutMs = RESPONSE_TIMEOUT_MS) {
    const buffer = Buffer.alloc(REPORT_SIZE);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        const n = fs.readSync(this.fd, buffer, 0, REPORT_SIZE, null);
        if (n > 0) {
          return new Uint8Array(buffer.subarray(0, n));
        }
      } catch (err) {
        if (err.code !== "EAGAIN" && err.code !== "EWOULDBLOCK") {
          // ENODEV / EIO typically mean the logger was unplugged.
          throw new TransportError(`Read failed: ${err.message}`, err.code);
        }
      }

      if (Date.now() >= deadline) {
        throw new TransportError(
          `No response from logger within ${timeoutMs} ms`,
          "TIMEOUT",
        );
      }
      await sleep(5);
    }
  }

  /**
   * Write a request and wait for its response.
   *
   * @param {Uint8Array} frame
   * @param {number} [timeoutMs]
   * @returns {Promise<Uint8Array>}
   */
  async exchange(frame, timeoutMs = RESPONSE_TIMEOUT_MS) {
    this.drain();
    this.write(frame);
    return this.read(timeoutMs);
  }

  /**
   * Close the device node. Safe to call twice.
   */
  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } finally {
        this.fd = null;
      }
    }
  }
}
