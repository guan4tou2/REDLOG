import { useEffect, useRef } from 'react'

// The operator leaves RedLog, installs something in a terminal, and comes back.
// That return is the moment the machine's state changed, and RedLog used to do
// nothing with it — so every screen that showed a probe result grew a
// "Re-check" button. Ten of them across four components (see
// docs/UIUX-CONTROLS-AND-COPY.md §5), all compensating for one behaviour the
// app did not have.
//
// This is that behaviour. It is for re-asking a question whose answer may have
// gone stale — never for re-running an action that failed. A failed install or
// a failed read still gets its own retry, because coming back to the window
// says nothing about whether that action would succeed now.

/** Re-run `revalidate` when the window regains focus or the page becomes
 *  visible again.
 *
 *  `revalidate` is read through a ref, so a caller may pass a fresh closure
 *  every render without resubscribing. `minIntervalMs` guards the case that
 *  costs: focus and visibilitychange both fire on the same return, and some
 *  window managers fire focus repeatedly while a window settles. */
export function useRevalidateOnFocus(
  revalidate: () => void,
  opts: { minIntervalMs?: number } = {}
): void {
  const min = opts.minIntervalMs ?? 1_000
  const fn = useRef(revalidate)
  fn.current = revalidate
  const last = useRef(0)

  useEffect(() => {
    const run = (): void => {
      // A hidden page is not a return: a background window can take focus
      // events it never shows anyone.
      if (typeof document !== 'undefined' && document.hidden) return
      const now = Date.now()
      if (now - last.current < min) return
      last.current = now
      fn.current()
    }
    const onVisible = (): void => { if (!document.hidden) run() }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [min])
}
