// =============================================================================
// File:    public/app.js
// Version: 1.2.1
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// Browser side: polls for the logger, renders its details, and drives the
// reset (interval + clock + erase), CSV and PDF actions through the JSON API.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

const POLL_MS = 2500;

const $ = (id) => document.getElementById(id);

/** Last device info received, or null when disconnected. */
let currentInfo = null;
/** Connection state from the last poll, to detect plug/unplug. */
let wasConnected = null;
/** Pause polling while an action is talking to the logger. */
let busy = false;

// -----------------------------------------------------------------------------
// API helper
// -----------------------------------------------------------------------------

/**
 * Call the JSON API and throw an Error carrying the server's message.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 */
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error ?? `Request failed (${response.status})`);
    error.code = body.code;
    throw error;
  }
  return response;
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/** Show a message under an action, styled as success or error. */
function setResult(id, message, kind = "ok") {
  const el = $(id);
  el.textContent = message;
  el.className = `result ${message ? kind : ""}`;
}

/** Human-readable interval, e.g. 300 -> "5 min". */
function formatInterval(seconds) {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Wording for how the logger last stopped (bits 0..2 of byte 0x26). */
const STOP_MODES = { 0: "stop button", 4: "this app" };

/** Run states in which the logger may be reset (mirrors the server). */
const CONFIGURABLE_STATES = ["stopped", "ready"];

/** Human-readable run state, e.g. "Stopped (stop button)". */
function formatRunState(info) {
  if (info.runState === "ready") {
    return "Ready, not started";
  }
  if (info.runState === "start-delay") {
    return "Started, waiting for start delay";
  }
  if (info.runState === "recording") {
    return "Recording (paused while on USB)";
  }
  if (info.runState === "stopped") {
    const how = STOP_MODES[info.stopMode];
    return how ? `Stopped (${how})` : "Stopped";
  }
  return `Unknown (0x${info.deviceState.toString(16).padStart(2, "0")})`;
}

/** Banner text when the logger can't be reset, or "" when it can. */
function stateWarning(info) {
  if (info.runState === "recording" || info.runState === "start-delay") {
    const what = info.runState === "recording"
      ? "The logger is still recording."
      : "The logger has been started and is waiting for its start delay.";
    return `${what} To reset it, unplug it, press and hold its stop button until ` +
      "the display shows \"Stop\", then plug it back in and click Refresh.";
  }
  if (!CONFIGURABLE_STATES.includes(info.runState)) {
    return "The logger reports a state this app doesn't recognise, so changing settings " +
      "is disabled. Unplug it and check that the display shows \"Stop\", then plug it " +
      "back in and click Refresh.";
  }
  return "";
}

/**
 * Enable or disable the action buttons for the current state:
 *   - nothing while another action is running
 *   - CSV export only when there are records
 *   - reset only when the logger is stopped (or already reset)
 */
function updateControls() {
  const configurable = CONFIGURABLE_STATES.includes(currentInfo?.runState);
  $("export-csv").disabled = busy || !currentInfo || currentInfo.recordCount === 0;
  $("reset-open").disabled = busy || !configurable;
}

/** Update the connection pill in the top bar. */
function renderConnection(status) {
  const pill = $("connection");
  if (status.connected) {
    pill.textContent = status.mock ? "Simulated logger" : `Connected · ${status.devPath}`;
    pill.className = "pill pill-on";
  } else {
    pill.textContent = "Not connected";
    pill.className = "pill pill-off";
  }
  $("connected").hidden = !status.connected;
  $("empty").hidden = status.connected;
}

/** Fill in the identity and status cards. */
function renderInfo(info) {
  currentInfo = info;

  $("serial").textContent = info.serialNumber || "(blank)";
  $("model-line").textContent =
    `Elitech RC-5+ · firmware 0x${info.firmwareVersion.toString(16).padStart(2, "0")}` +
    ` · protocol 0x${info.protocolVersion.toString(16).padStart(2, "0")}`;

  $("records").textContent =
    `${info.recordCount.toLocaleString("en-GB")} / ${info.deviceCapacity.toLocaleString("en-GB")}`;
  $("interval").textContent = formatInterval(info.intervalSeconds);
  $("device-time").textContent = info.deviceTime ?? "—";
  $("timezone").textContent = info.timezone ? `UTC${info.timezone}` : "—";
  $("start-time").textContent = info.startTime ?? "—";
  $("stop-time").textContent = info.stopTime ?? "—";
  $("config-time").textContent = info.configurationTime ?? "—";
  $("battery").textContent = `level ${info.batteryLevel}`;
  $("run-state").textContent = formatRunState(info);

  const warning = stateWarning(info);
  $("state-warning").textContent = warning;
  $("state-warning").hidden = warning === "";

  // Pre-select the current interval if it is within 1..15 minutes.
  const minutes = info.intervalSeconds / 60;
  if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 15) {
    $("interval-select").value = String(minutes);
  }

  updateControls();
}

/** List the PDFs found on the logger's drive. */
function renderPdfs(result) {
  const list = $("pdf-list");
  list.replaceChildren();

  if (!result.mountPoint) {
    setResult("pdf-result", result.reason ?? "USB drive not available.", "err");
    return;
  }
  if (result.files.length === 0) {
    setResult("pdf-result", "No PDF on the drive yet. The logger writes it when recording stops.", "ok");
    return;
  }
  setResult("pdf-result", "");

  for (const file of result.files) {
    const href = `/api/pdfs/${encodeURIComponent(file.name)}`;
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KB)`;

    const actions = document.createElement("span");
    actions.className = "actions";

    const view = document.createElement("button");
    view.type = "button";
    view.className = "btn-link";
    view.textContent = "View";
    view.addEventListener("click", () => openViewer(file.name, href));

    const download = document.createElement("a");
    download.href = `${href}?download=1`;
    download.textContent = "Download";

    actions.append(view, download);
    li.append(name, actions);
    list.append(li);
  }
}

/** Show a PDF in the embedded viewer. */
function openViewer(name, href) {
  $("pdf-viewer-title").textContent = name;
  $("pdf-viewer").src = href;
  $("pdf-viewer-card").hidden = false;
  $("pdf-viewer-card").scrollIntoView({ behavior: "smooth" });
}

// -----------------------------------------------------------------------------
// Data loading
// -----------------------------------------------------------------------------

async function loadInfo() {
  const response = await api("/api/info");
  renderInfo(await response.json());
}

async function loadPdfs() {
  try {
    const response = await api("/api/pdfs");
    renderPdfs(await response.json());
  } catch (err) {
    setResult("pdf-result", err.message, "err");
  }
}

/** Reload everything after a (re)connect or a manual refresh. */
async function loadAll() {
  try {
    await loadInfo();
  } catch (err) {
    $("connection").textContent = err.message;
    $("connection").className = "pill pill-warn";
  }
  await loadPdfs();
}

/**
 * Forget the outcome messages of earlier actions (export, reset). They
 * describe the logger as it was, so they're wrong once it has been
 * unplugged: it may have been started, stopped or swapped in the meantime.
 */
function clearActionResults() {
  setResult("export-result", "");
  setResult("reset-result", "");
}

/** Poll for plug/unplug and reload when the state changes. */
async function poll() {
  if (!busy) {
    try {
      const status = await (await fetch("/api/status")).json();
      renderConnection(status);
      if (status.connected && wasConnected !== true) {
        // Just plugged in (or page just opened): start from a clean slate.
        clearActionResults();
        await loadAll();
      }
      if (!status.connected && wasConnected !== false) {
        // Just unplugged: drop everything that described the old session.
        currentInfo = null;
        clearActionResults();
        $("pdf-viewer-card").hidden = true;
        $("pdf-viewer").removeAttribute("src");
      }
      wasConnected = status.connected;
    } catch {
      $("connection").textContent = "App server not reachable";
      $("connection").className = "pill pill-warn";
    }
  }
  setTimeout(poll, POLL_MS);
}

/**
 * Run an action with buttons disabled and polling paused.
 *
 * @param {HTMLButtonElement} button
 * @param {() => Promise<void>} action
 */
async function runBusy(button, action) {
  busy = true;
  button.disabled = true;
  try {
    await action();
  } finally {
    busy = false;
    button.disabled = false;
    updateControls();
  }
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/** Download the CSV through the API and hand it to the browser. */
async function exportCsv() {
  setResult("export-result", "Reading records from the logger…");
  try {
    const response = await api("/api/export.csv");
    const blob = await response.blob();

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "rc5plus.csv";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    const count = Number(response.headers.get("X-Record-Count")).toLocaleString("en-GB");
    setResult("export-result", `${count} readings exported to ${fileName}. Copy kept in ${response.headers.get("X-Saved-As")}.`);
  } catch (err) {
    setResult("export-result", err.message, "err");
  }
}

/**
 * If the server refused because the logger isn't stopped, re-read its info
 * so the State row, banner and buttons catch up with reality.
 *
 * @param {Error & { code?: string }} err
 */
async function refreshAfterRefusal(err) {
  if (err.code === "NOT_STOPPED") {
    await loadInfo().catch(() => {});
  }
}

/** Ask for confirmation before resetting the logger. */
function openResetDialog(event) {
  event.preventDefault();
  const minutes = Number($("interval-select").value);
  $("reset-serial").textContent = currentInfo?.serialNumber ?? "";
  $("reset-count").textContent = currentInfo
    ? `${currentInfo.recordCount.toLocaleString("en-GB")}`
    : "all";
  $("reset-interval").textContent = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  $("reset-dialog").showModal();
}

/** Reset the logger for a new trip once the dialog is confirmed. */
async function onResetDialogClose() {
  if ($("reset-dialog").returnValue !== "confirm") return;
  const minutes = Number($("interval-select").value);

  await runBusy($("reset-open"), async () => {
    setResult("reset-result", "Resetting the logger (this takes a few seconds)…");
    try {
      const response = await api("/api/reset", {
        method: "POST",
        body: JSON.stringify({ minutes, confirm: true }),
      });
      const info = await response.json();
      renderInfo(info);
      setResult(
        "reset-result",
        `Reset done: readings erased, interval ${formatInterval(info.intervalSeconds)}, ` +
          `clock ${info.deviceTime}. Start the logger with its button when you're ready. ` +
          "Unplug and replug it to refresh the USB drive.",
      );
      await loadPdfs();
    } catch (err) {
      setResult("reset-result", err.message, "err");
      await refreshAfterRefusal(err);
    }
  });
}

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

function init() {
  // Interval choices: 1..15 minutes.
  const select = $("interval-select");
  for (let m = 1; m <= 15; m++) {
    const option = document.createElement("option");
    option.value = String(m);
    option.textContent = `${m} minute${m === 1 ? "" : "s"}`;
    select.append(option);
  }

  $("refresh").addEventListener("click", () => runBusy($("refresh"), loadAll));
  $("export-csv").addEventListener("click", () => runBusy($("export-csv"), exportCsv));
  $("reset-form").addEventListener("submit", openResetDialog);
  $("reset-dialog").addEventListener("close", onResetDialogClose);
  $("pdf-close").addEventListener("click", () => {
    $("pdf-viewer-card").hidden = true;
    $("pdf-viewer").removeAttribute("src");
  });

  poll();
}

init();
