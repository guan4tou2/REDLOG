// Renderer-side defaults a form needs before the config round-trips.
// `src/core/config.ts` reads the filesystem, so the renderer cannot import it;
// a default that lives in an import-free core module (core/browser-defaults.ts)
// is imported from there instead of restated.
//
// Keep this list short. A value belongs here only if the renderer needs it
// synchronously, before any IPC has answered; anything the main process can
// report should be read from it instead. The CDP port is the cautionary tale:
// the setup guidance used to hardcode 9222 in the i18n string itself, so it
// kept telling operators to launch Chrome on a port the app had stopped
// listening on. The hints now quote `BrowserTabInfo.port` — the port the
// connector is actually polling — and fall back to this only when no status
// has arrived yet.

import { DEFAULT_BROWSER } from '../../../core/browser-defaults'
import { DEFAULT_CONFIG } from '../../../core/config'

export const DEFAULT_CDP_PORT = DEFAULT_BROWSER.cdpPort

// Same reason, for the capture endpoint: the panel used to hardcode 8080 as
// its own fallback, so it drifted from DEFAULT_CONFIG the moment that moved.
export const DEFAULT_CAPTURE_PORT = DEFAULT_CONFIG.httpCapture.port
export const DEFAULT_CAPTURE_HOST = DEFAULT_CONFIG.httpCapture.listenHost
