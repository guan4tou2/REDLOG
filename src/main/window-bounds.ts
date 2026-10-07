// A saved window position is only good while the display it was saved on is
// still there.
//
// RedLog restores `~/.redlog/window-state.json` verbatim. Unplug a monitor,
// change the arrangement, or reconnect to the machine over RDP with a
// different desktop geometry, and the window opens where nobody can see it:
// alive, in the task bar, focusable, drawing nothing. That reads as "the app
// did not start", which is the worst way for a tool whose job is to be
// recording to appear broken — the operator restarts it, and it goes right
// back to the same invisible rectangle.
//
// Seen on this project: bounds saved at y=1191 (a monitor stacked below),
// restored onto a 3720x1125 desktop over RDP. Entirely below the bottom edge.

export interface Rect { x: number; y: number; width: number; height: number }

// What counts as "visible enough to use". A title bar's worth of window is
// enough to grab and drag back, so a window hanging mostly off one edge is the
// operator's own arrangement and is left alone. Less than this and we move it.
const MIN_VISIBLE_W = 120
const MIN_VISIBLE_H = 48

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function area(r: { width: number; height: number }): number {
  return r.width * r.height
}

/** Centre the rect in `work` if it does not fit, else slide it inside. Size is
 *  preserved where it can be: an operator who sized the window to a big
 *  monitor and moved to a small one gets it shrunk to fit, not reset. */
function fitInto(saved: Rect, work: Rect): Rect {
  const width = Math.min(saved.width, work.width)
  const height = Math.min(saved.height, work.height)
  const x = Math.round(Math.min(Math.max(saved.x, work.x), work.x + work.width - width))
  const y = Math.round(Math.min(Math.max(saved.y, work.y), work.y + work.height - height))
  return { x, y, width, height }
}

/**
 * The bounds to actually open with, given the work areas of the displays that
 * exist right now.
 *
 * Returns the saved bounds untouched when a usable piece of them lands on some
 * display — including the deliberately half-off-screen window — and otherwise
 * moves them onto the display they overlap most, or the first one (Electron
 * lists the primary display first) when they overlap nothing at all.
 */
export function visibleWindowBounds(saved: Rect | undefined, workAreas: Rect[]): Rect | undefined {
  if (!saved || workAreas.length === 0) return saved

  const seen = workAreas.map((w) => ({ work: w, shown: overlap(saved, w) }))
  if (seen.some(({ shown }) => shown.width >= MIN_VISIBLE_W && shown.height >= MIN_VISIBLE_H)) return saved

  // Nothing usable is on screen. Put it on the display it was closest to —
  // the one it still overlaps at all, by area — so a window that slipped off
  // the bottom of its own monitor comes back to that monitor and not to the
  // other one.
  const best = seen.reduce((a, b) => (area(b.shown) > area(a.shown) ? b : a))
  return fitInto(saved, area(best.shown) > 0 ? best.work : workAreas[0])
}
