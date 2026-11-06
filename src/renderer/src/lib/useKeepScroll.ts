import { useEffect, useRef, type RefObject } from 'react'

/** Keep a list's scroll position across the view being hidden.
 *
 *  A hidden view stays mounted (`display: none`), which keeps its state — but
 *  Chromium discards the scroll offset of anything inside it, so coming back
 *  from the Timeline put the operator at the top of a list they had read 40
 *  rows into (#589). The offset is remembered from `scroll` events, which do
 *  not fire while the box is gone, and put back when the view is active again.
 *
 *  The list is usually reloading at that moment, so the offset is applied as
 *  soon as the content is tall enough to hold it, for a short while, and
 *  dropped the instant the operator scrolls themselves. */
export function useKeepScroll(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const saved = useRef(0)
  const restoring = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => { if (!restoring.current) saved.current = el.scrollTop }
    const stop = (): void => { restoring.current = false }
    el.addEventListener('scroll', onScroll, { passive: true })
    // The operator taking over cancels a restore in progress.
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) el.addEventListener(type, stop, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) el.removeEventListener(type, stop)
    }
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!active || !el || saved.current <= 0) return
    const target = saved.current
    restoring.current = true
    let frame = 0
    let tries = 0
    const step = (): void => {
      if (!restoring.current) return
      if (el.scrollHeight - el.clientHeight >= target) {
        el.scrollTop = target
        if (Math.abs(el.scrollTop - target) <= 2) { restoring.current = false; return }
      }
      // ~2 s of frames: past that the list is not coming back to that length.
      if (++tries < 120) frame = requestAnimationFrame(step)
      else restoring.current = false
    }
    frame = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(frame); restoring.current = false }
  }, [active, ref])
}
