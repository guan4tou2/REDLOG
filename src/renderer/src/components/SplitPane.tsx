import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { splitPaneClamp } from '../lib/splitPane'

// A reusable two-pane split with a draggable divider (DESIGN-SYSTEM.md §6.2).
// Generalises the Timeline detail-panel resize so any "list | detail" or
// "top / bottom" view can let the operator set the proportion. The FIRST child
// is the resizable pane (its px size persists per `id`); the SECOND fills the
// rest. All bounds go through the pure, tested `splitPaneClamp` seam.
//
//   <SplitPane id="findings" direction="horizontal" min={220} max={520} defaultSize={320}>
//     <List />     // resizable
//     <Detail />   // fills remainder
//   </SplitPane>

interface SplitPaneProps {
  /** Stable id — the size persists to localStorage as `redlog-split-{id}`. */
  id: string
  /** horizontal = left|right (resize the first pane's width); vertical = top/bottom (height). */
  direction?: 'horizontal' | 'vertical'
  /** Resting size of the resizable (first) pane: px when > 1, or a fraction of
   *  the container when in (0, 1] (e.g. 0.5 = half). */
  defaultSize: number
  min?: number
  max?: number
  /** px the OTHER pane must always keep. */
  otherMin?: number
  children: [ReactNode, ReactNode]
  className?: string
}

const KEY = (id: string): string => `redlog-split-${id}`
const STEP = 16 // keyboard resize step (px)

export function SplitPane({
  id,
  direction = 'horizontal',
  defaultSize,
  min = 160,
  max = 640,
  otherMin = 160,
  children,
  className = ''
}: SplitPaneProps): JSX.Element {
  const horizontal = direction === 'horizontal'
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<number>(() => {
    try {
      const saved = parseFloat(localStorage.getItem(KEY(id)) || '')
      if (Number.isFinite(saved) && saved > 0) return saved
    } catch { /* private mode */ }
    return defaultSize
  })
  const drag = useRef<{ start: number; startSize: number } | null>(null)

  const containerPx = (): number => {
    const el = containerRef.current
    if (!el) return Infinity
    return horizontal ? el.clientWidth : el.clientHeight
  }

  // Re-clamp on mount and whenever the container resizes — a window shrink must
  // not leave the resizable pane wider than the container now allows.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Resolve a fractional default (0 < s ≤ 1) against the measured container the
    // first time we can; persisted sizes are always px (≥ min), so this only
    // fires for the initial fraction.
    const reclamp = (): void => setSize((s) => {
      const c = containerPx()
      const px = s > 0 && s <= 1 && Number.isFinite(c) ? c * s : s
      return splitPaneClamp(px, min, max, c, otherMin)
    })
    reclamp()
    const ro = new ResizeObserver(reclamp)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, otherMin, horizontal])

  const persist = (px: number): void => {
    try { localStorage.setItem(KEY(id), String(Math.round(px))) } catch { /* ignore */ }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = drag.current
      if (!d) return
      const pos = horizontal ? e.clientX : e.clientY
      const next = splitPaneClamp(d.startSize + (pos - d.start), min, max, containerPx(), otherMin)
      setSize(next)
    }
    const onUp = (): void => {
      if (!drag.current) return
      drag.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setSize((s) => { persist(s); return s })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizontal, min, max, otherMin, id])

  const onHandleDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    drag.current = { start: horizontal ? e.clientX : e.clientY, startSize: size }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
  }

  const reset = (): void => {
    setSize(defaultSize)
    try { localStorage.removeItem(KEY(id)) } catch { /* ignore */ }
  }

  const onHandleKey = (e: React.KeyboardEvent): void => {
    const grow = horizontal ? e.key === 'ArrowRight' : e.key === 'ArrowDown'
    const shrink = horizontal ? e.key === 'ArrowLeft' : e.key === 'ArrowUp'
    if (!grow && !shrink) return
    e.preventDefault()
    setSize((s) => {
      const next = splitPaneClamp(s + (grow ? STEP : -STEP), min, max, containerPx(), otherMin)
      persist(next)
      return next
    })
  }

  const firstStyle = horizontal ? { width: size } : { height: size }

  return (
    <div ref={containerRef} className={`flex ${horizontal ? '' : 'flex-col'} h-full min-h-0 ${className}`}>
      <div className={`shrink-0 ${horizontal ? 'h-full' : 'w-full'} min-w-0 min-h-0 overflow-hidden`} style={firstStyle}>
        {children[0]}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize panels"
        tabIndex={0}
        onMouseDown={onHandleDown}
        onDoubleClick={reset}
        onKeyDown={onHandleKey}
        title="Drag to resize · double-click to reset"
        className={`shrink-0 relative bg-redlog-border hover:bg-redlog-accent/50 focus-visible:bg-redlog-accent/60 focus-visible:outline-none transition-colors hit-target ${
          horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
        }`}
      />
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        {children[1]}
      </div>
    </div>
  )
}
