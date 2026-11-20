// =============================================================================
// File:    src/lib/static-assets.js
// Version: 1.0.0
// Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
//
// The web UI files, imported as files so `bun build --compile` embeds them in
// the executable. From source each import is the real path in public/; in the
// compiled binary it is a path inside the executable. Bun.file() reads both.
//
// Add a new file in public/ here as well, or it won't be served.
//
// GPL-3.0-or-later. See LICENSE.
// =============================================================================

import indexHtml from "../../public/index.html" with { type: "file" };
import appJs from "../../public/app.js" with { type: "file" };
import stylesCss from "../../public/styles.css" with { type: "file" };

/**
 * URL path → { file, type }.
 * @type {Map<string, { file: string, type: string }>}
 */
export const STATIC_ASSETS = new Map([
  ["/", { file: indexHtml, type: "text/html; charset=utf-8" }],
  ["/index.html", { file: indexHtml, type: "text/html; charset=utf-8" }],
  ["/app.js", { file: appJs, type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: stylesCss, type: "text/css; charset=utf-8" }],
]);
