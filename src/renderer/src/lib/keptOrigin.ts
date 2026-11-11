// The page a Timeline jump came from, kept mounted and hidden for the length of
// that one visit so "back" returns to it as it was (#692): its search text,
// filters, open row and selection are React state, and a remount threw them
// away. Only one page is ever kept, and only while the visit lasts.
//
// HTTP history is deliberately not in the list. It contributes the export
// menu's "this view" scope from an effect that does not know whether it is on
// screen, so while hidden it can take that scope over from the Timeline (any
// shared-filter change re-runs it), and on return it has lost the scope the
// Timeline's unmount cleared. It needs the `active` gate SearchPanel has before
// it can be kept.
const KEEPABLE: ReadonlySet<string> = new Set(['http_history', 'targets', 'scope', 'loot', 'bookmarks', 'screenshots'])

type ScrollSnapshot = ReadonlyArray<{ el: Element; top: number }>

export interface KeptOrigin {
  view: string
  projectId: string
  /** Scroll offsets taken while the page was still on screen: Chromium does not
   *  keep a scroller's offset across `display: none`. */
  scroll: ScrollSnapshot
}

/** Decided at the jump, while the origin is still on screen. A page with a
 *  dialog open is not kept: the dialog's window-level Escape and Tab handlers
 *  would go on running on the Timeline, invisible. */
export function keepOnJump(origin: string, projectId: string | undefined, root: HTMLElement | null | undefined): KeptOrigin | null {
  if (!projectId || !root || !KEEPABLE.has(origin)) return null
  if (root.querySelector('[aria-modal="true"]')) return null
  const scroll: Array<{ el: Element; top: number }> = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.scrollTop > 0) scroll.push({ el, top: el.scrollTop })
  }
  return { view: origin, projectId, scroll }
}

/** The view to keep mounted behind the current one, or null. Anything other
 *  than sitting on the Timeline with the back link to that origin drops it —
 *  a sidebar or palette move clears `returnTo`, another jump replaces it. */
export function keptView(s: { view: string; returnTo: string | null; projectId: string; kept: KeptOrigin | null }): string | null {
  const { view, returnTo, projectId, kept } = s
  if (!kept || view !== 'timeline' || returnTo !== kept.view || kept.projectId !== projectId) return null
  return kept.view
}

/** Put the snapshot's offsets back. A list may still be filling in, so it
 *  retries for a few frames; the operator scrolling or typing ends it. */
export function restoreScroll(snapshot: ScrollSnapshot, frames = 30): () => void {
  let pending = snapshot.filter((s) => s.el.isConnected)
  let raf = 0
  let left = frames
  const stop = (): void => {
    pending = []
    cancelAnimationFrame(raf)
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.removeEventListener(type, stop, true)
  }
  const step = (): void => {
    pending = pending.filter(({ el, top }) => {
      if (!el.isConnected) return false
      if (el.scrollHeight - el.clientHeight >= top) el.scrollTop = top
      return Math.abs(el.scrollTop - top) > 2
    })
    if (pending.length > 0 && --left > 0) raf = requestAnimationFrame(step)
    else stop()
  }
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(type, stop, { capture: true, passive: true })
  step()
  return stop
}
