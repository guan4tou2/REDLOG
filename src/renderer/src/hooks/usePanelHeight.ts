import { useEffect, useRef, useState, useCallback } from 'react'

// A panel whose height the operator drags, remembered across reloads.
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

interface PanelHeight {
  /** Chosen height in px, or null while the CSS default applies. */
  px: number | null
  /** Pass the mousedown from the drag handle. */
  beginResize: (e: { clientY: number; preventDefault: () => void }, currentHeight: number) => void
  /** Back to the CSS default. Bound to double-click on the handle. */
  reset: () => void
}

export function usePanelHeight(storageKey: string, opts: { min?: number; maxRatio?: number } = {}): PanelHeight {
  const min = opts.min ?? 80
  const maxRatio = opts.maxRatio ?? 0.85

  const [px, setPx] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const n = raw ? parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n > min && n < 2000 ? n : null
    } catch { return null }
  })
  const drag = useRef<{ startY: number; startH: number } | null>(null)
  // The live value, so the mouseup listener persists what the last mousemove
  // set rather than what the render that installed it had. Without it the
  // effect has to depend on `px` and re-subscribe on every pixel of the drag.
  const latest = useRef<number | null>(px)
  latest.current = px

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const s = drag.current
      if (!s) return
      setPx(Math.max(min, Math.min(window.innerHeight * maxRatio, s.startH + (s.startY - e.clientY))))
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
  }, [storageKey, min, maxRatio])

  const beginResize = useCallback((e: { clientY: number; preventDefault: () => void }, currentHeight: number) => {
    e.preventDefault()
    drag.current = { startY: e.clientY, startH: currentHeight }
    // Suppresses text selection and pointer events on the panes while dragging
    // — without it the drag selects the event rows it passes over.
    document.body.classList.add('timeline-resizing')
  }, [])

  const reset = useCallback(() => {
    setPx(null)
    try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
  }, [storageKey])

  return { px, beginResize, reset }
}
