// Renderer-side mirror of the defaults the main process ships in
// `src/core/config.ts`. The renderer deliberately imports nothing across the
// process boundary (see electron.vite.config.ts — the two bundles share no
// module graph), so the handful of values a form needs before the config
// round-trips have to be restated here rather than imported.
//
// Keep this list short. A value belongs here only if the renderer needs it
// synchronously, before any IPC has answered; anything the main process can
// report should be read from it instead. The CDP port is the cautionary tale:
// the setup guidance used to hardcode 9222 in the i18n string itself, so it
// kept telling operators to launch Chrome on a port the app had stopped
// listening on. The hints now quote `BrowserTabInfo.port` — the port the
// connector is actually polling — and fall back to this only when no status
// has arrived yet.

/** Must match `cdpPort` in `src/core/config.ts`. */
export const DEFAULT_CDP_PORT = 9222
