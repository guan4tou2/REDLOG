import { useEffect, useRef, useState, useCallback } from 'react'

// A panel whose size the operator drags, remembered across reloads.
//
// The Timeline has two horizontal splits and they were not the same thing: the
// detail panel could be dragged and the event log could not, so the one a
// three-day engagement spends all day looking at — the log — was the one stuck
// at a hardcoded 22vh. The machinery was already written; it was written into
// one panel rather than into a function.
//
// Drag semantics: the handle sits on the panel's TOP edge and the panel grows
// downward, so dragging up makes it bigger. `null` means the operator has
// never chosen, and the caller falls back to its CSS default — which keeps the
// default responsive to window height instead of freezing a pixel count taken
// on somebody else's monitor.

/** A stored size, or null when there is none to trust: nothing written, a
 *  value this panel's floor rejects, or storage that cannot be read at all. */
function readStored(storageKey: string, min: number): number | null {
  try {
    const raw = localStorage.getItem(storageKey)
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) && n > min && n < 2000 ? n : null
  } catch { return null }
}

interface PanelSize {
  /** Chosen size in px, or null while the CSS default applies. */
  px: number | null
  /** Pass the mousedown from the drag handle, with the panel's current size. */
  beginResize: (e: { clientX: number; clientY: number; preventDefault: () => void }, current: number) => void
  /** Back to the CSS default. Bound to double-click on the handle. */
  reset: () => void
}

/** `axis: 'y'` is a handle on the top edge growing downward; `'x'` is a handle
 *  on the left edge growing rightward. Both grow when dragged AWAY from the
 *  panel, which is the only gesture that feels the same in either direction. */
export function usePanelHeight(
  storageKey: string,
  opts: { min?: number; maxRatio?: number; axis?: 'x' | 'y' } = {}
): PanelSize {
  const min = opts.min ?? 80
  const maxRatio = opts.maxRatio ?? 0.85
  const axis = opts.axis ?? 'y'

  const [px, setPx] = useState<number | null>(() => readStored(storageKey, min))
  // The key is the panel AND the axis it is laid out on. The Timeline's detail
  // pane passes `…-detail-h` below the list and `…-detail-w` beside it,
  // precisely because 320px of height and 320px of width are not the same
  // request. Reading storage only in the initializer above meant the key could
  // change and the NUMBER could not: switching layouts carried the height
  // across as a width, so a pane dragged to 320px tall came back 320px wide —
  // under the 440px the side layout is drawn for, which is how the operator
  // first met it, with its header squeezed to one character per line.
  //
  // Set during render rather than in an effect: React re-runs this call before
  // committing, so the pane never paints one frame at the other axis's size.
  const lastKey = useRef(storageKey)
  if (lastKey.current !== storageKey) {
    lastKey.current = storageKey
    // The new key's floor, not the old one's — the two layouts have different
    // minimums (the side pane cannot be narrower than 280).
    setPx(readStored(storageKey, min))
  }
  const drag = useRef<{ start: number; size: number } | null>(null)
  // The live value, so the mouseup listener persists what the last mousemove
  // set rather than what the render that installed it had. Without it the
  // effect has to depend on `px` and re-subscribe on every pixel of the drag.
  const latest = useRef<number | null>(px)
  latest.current = px

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const s = drag.current
      if (!s) return
      const limit = (axis === 'y' ? window.innerHeight : window.innerWidth) * maxRatio
      const delta = axis === 'y' ? s.start - e.clientY : s.start - e.clientX
      setPx(Math.max(min, Math.min(limit, s.size + delta)))
    }
    const onUp = (): void => {
      if (!drag.current) return
      drag.current = null
      document.body.classList.remove('timeline-resizing')
      try {
        if (latest.current != null) localStorage.setItem(storageKey, String(Math.round(latest.current)))
      } catch { /* private window or full storage: the drag simply does not stick */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [storageKey, min, maxRatio, axis])

  const beginResize = useCallback((e: { clientX: number; clientY: number; preventDefault: () => void }, current: number) => {
    e.preventDefault()
    drag.current = { start: axis === 'y' ? e.clientY : e.clientX, size: current }
    // Suppresses text selection and pointer events on the panes while dragging
    // — without it the drag selects the event rows it passes over.
    document.body.classList.add('timeline-resizing')
  }, [axis])

  const reset = useCallback(() => {
    setPx(null)
    try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
  }, [storageKey])

  return { px, beginResize, reset }
}
