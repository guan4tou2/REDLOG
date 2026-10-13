import { useEffect, useState } from 'react'
import { BASE_ZOOM } from '../lib/uiScale'

// Is there room for two columns of chrome and a page?
//
// The window has a floor of 800px (windows.ts), and the interface is drawn at
// `body { zoom }` — 0.9 by default, up to ~1.26 at the largest UI scale — on
// top of whatever zoom the shell itself applies. All three divide the same
// width: at 800px, 150% shell zoom and the default scale the page has 592 CSS
// pixels, and the main sidebar plus Settings' 212px category column took two
// thirds of them, so the Scope editor was below the fold of a window that had
// no scrollbar to say so (#298).
//
// The number that matters is the one the layout sees, in the same units the
// `w-[150px]` and `212px` classes are written in: the viewport divided by the
// body zoom. `innerWidth` alone already includes the shell's zoom and not the
// body's, which is why a media query cannot answer this.

/** Below this many layout pixels the chrome gives way to the page. At the
 *  default scale a window at its 800px floor is 889 wide here, so this only
 *  triggers when something — the operator's UI scale, the shell's zoom, a
 *  window narrower than the floor on a platform that allows it — has taken the
 *  room. */
const NARROW_BELOW_PX = 760

function layoutWidth(): number {
  let zoom = BASE_ZOOM
  try {
    const z = parseFloat(getComputedStyle(document.body).zoom)
    if (Number.isFinite(z) && z > 0) zoom = z
  } catch { /* no layout engine (tests): the default zoom */ }
  return window.innerWidth / zoom
}

/** True while the layout is narrower than the chrome can share. Read on
 *  resize, and on any change to the body's own size — a UI-scale change moves
 *  the zoom without moving the window, and `resize` does not fire for it. */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => layoutWidth() < NARROW_BELOW_PX)
  useEffect(() => {
    const update = (): void => setNarrow(layoutWidth() < NARROW_BELOW_PX)
    update()
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(document.body)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])
  return narrow
}
