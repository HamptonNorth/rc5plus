// =============================================================================
// File:    src/lib/logger-service.js
// Version: 1.3.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Owns access to the logger:
//   - detection (cheap sysfs scan, no USB traffic)
//   - one-at-a-time HID sessions, so two browser requests can never
//     interleave frames on the same device; on real hardware each session
//     also takes the cross-process lock (device-lock.js), so other tools
//     such as `bun run dump` never talk to the logger at the same time
//   - the real hidraw driver, or the simulator when RC5_MOCK=1
//     (RC5_MOCK_STATE=recording or =ready starts the simulator in that
//     state instead of stopped, to try out the "logger must be stopped" checks)
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import { findRc5PlusDevices, HidrawTransport } from "../elitech/hidraw.js";
import {
  createMockDrive,
  MockRc5Plus,
  MockTransport,
} from "../elitech/mock-device.js";
import { Rc5Plus } from "../elitech/rc5plus.js";
import { acquireDeviceLock } from "./device-lock.js";
import { listPdfs, locateDrive } from "./usb-drive.js";

/**
 * Raised when no RC-5+ is plugged in.
 */
export class NotConnectedError extends Error {
  constructor() {
    super("No Elitech RC-5+ detected. Plug the logger into a USB port.");
    this.name = "NotConnectedError";
  }
}

/**
 * How long a server request waits for another program (e.g. a dump) to
 * finish with the logger before giving up with "busy".
 */
const LOCK_TIMEOUT_MS = 20_000;

/**
 * Real hardware: hidraw for commands, mass storage for the PDF.
 */
function hardwareDriver() {
  return {
    mock: false,
    lock: () => acquireDeviceLock("rc5plus server", { timeoutMs: LOCK_TIMEOUT_MS }),
    find: () => findRc5PlusDevices(),
    open: (device) => HidrawTransport.open(device.devPath),
    locateDrive: (device) => locateDrive(device.usbDir),
  };
}

/**
 * Simulator: one always-connected logger and a temp directory as its drive.
 */
function mockDriver() {
  const state = ["recording", "ready"].includes(process.env.RC5_MOCK_STATE)
    ? process.env.RC5_MOCK_STATE
    : "stopped";
  const logger = new MockRc5Plus({ state });
  const serial = new TextDecoder()
    .decode(logger.memory.slice(0x02, 0x0e))
    .replaceAll("\u0000", "");
  const drive = createMockDrive(serial);
  const device = { devPath: "mock://rc5plus", usbDir: null };

  return {
    mock: true,
    lock: null, // in-process simulator: the session queue is enough
    find: () => [device],
    open: () => new MockTransport(logger),
    locateDrive: async () => ({ mountPoint: drive }),
  };
}

export class LoggerService {
  /**
   * @param {{ mock?: boolean }} [options]
   */
  constructor({ mock = false } = {}) {
    this.driver = mock ? mockDriver() : hardwareDriver();
    // Tail of the queue of HID sessions; each new session waits for it.
    this.queue = Promise.resolve();
  }

  /**
   * Is a logger plugged in? Does not talk to it.
   *
   * @returns {{ connected: boolean, devPath: string|null, mock: boolean, count: number }}
   */
  status() {
    const devices = this.driver.find();
    return {
      connected: devices.length > 0,
      devPath: devices[0]?.devPath ?? null,
      count: devices.length,
      mock: this.driver.mock,
    };
  }

  /**
   * Run `fn` with exclusive access to the first connected logger.
   * The device node is opened for the session and always closed afterwards,
   * so unplugging and replugging between requests just works.
   *
   * @template T
   * @param {(logger: Rc5Plus, device: object) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  withLogger(fn) {
    const run = async () => {
      const device = this.driver.find()[0];
      if (!device) {
        throw new NotConnectedError();
      }
      const release = this.driver.lock ? await this.driver.lock() : () => {};
      try {
        const transport = this.driver.open(device);
        try {
          return await fn(new Rc5Plus(transport), device);
        } finally {
          transport.close();
        }
      } finally {
        release();
      }
    };

    // Chain onto the queue; a failed session must not block the next one.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Locate the logger's drive and list its PDF reports.
   *
   * @returns {Promise<{ mountPoint: string|null, files: object[], reason?: string }>}
   */
  async pdfs() {
    const device = this.driver.find()[0];
    if (!device) {
      throw new NotConnectedError();
    }
    const drive = await this.driver.locateDrive(device);
    if (!drive.mountPoint) {
      return { mountPoint: null, files: [], reason: drive.reason };
    }
    return { mountPoint: drive.mountPoint, files: listPdfs(drive.mountPoint) };
  }
}
