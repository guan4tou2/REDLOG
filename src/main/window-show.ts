/** How long after the page loads a still-hidden window is shown anyway. Long
 *  enough for the first React render, short enough not to read as a hang. */
export const SHOW_FALLBACK_MS = 500

interface ShowableWindow {
  once(event: 'ready-to-show', listener: () => void): unknown
  isVisible(): boolean
  isDestroyed(): boolean
  show(): void
  webContents: { once(event: 'did-finish-load', listener: () => void): unknown }
}

/** Show a window created with `show: false` once its content is there.
 *
 *  `ready-to-show` waits for a first paint, and on some Windows GPU setups a
 *  window that has never been shown never paints: the event never comes and
 *  the window stays hidden for good (2026-10-28 acceptance, Intel Iris Xe —
 *  `--disable-gpu` brought it back). So the page having loaded is enough too;
 *  the window's background colour matches the app, so showing a frame early
 *  does not flash. */
export function showWhenReady(win: ShowableWindow): void {
  const show = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', show)
  win.webContents.once('did-finish-load', () => { setTimeout(show, SHOW_FALLBACK_MS) })
}
