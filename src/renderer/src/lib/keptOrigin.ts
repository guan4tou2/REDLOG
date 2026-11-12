// The page a return trail started from (lib/returnTrail.ts), kept mounted and
// hidden for as long as the trail lasts — on the Timeline and on to Activity —
// so going back returns to it as it was (#692): its search text, filters, open
// row and selection are React state, and a remount threw them away. Only one
// page is ever kept, and only while the trail lasts.
//
// A hidden page must not act on the page in front. HTTP history contributes
// the export menu's "this view" scope and owns list keys; both are gated on the
// `active` prop App passes it, as SearchPanel's are, which is what lets it be
// kept. Loot takes `active` for its open readers. The other pages contribute
// no scope and listen for no window keys. What every kept page still does is
// re-read on live batches and on a shared-filter change, as it would on screen.
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

/** The view to keep mounted behind the current one, or null: only while the
 *  trail in force on `view` starts at that origin and the operator is further
 *  along it. A sidebar or palette move ends the trail; a jump that starts a new
 *  one replaces it. */
export function keptView(s: { view: string; trail: readonly string[]; projectId: string; kept: KeptOrigin | null }): string | null {
  const { view, trail, projectId, kept } = s
  if (!kept || kept.projectId !== projectId || trail.length < 2) return null
  if (trail[0] !== kept.view || trail[trail.length - 1] !== view || view === kept.view) return null
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
