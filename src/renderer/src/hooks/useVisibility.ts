import { useState, useEffect, useMemo } from 'react'
import { computeVisibility, shouldRefetch, EMPTY_SIGNALS, type VisibilitySignals } from '../lib/visibility'
import { storedShowAllPages, SHOW_ALL_PAGES_EVENT } from '../lib/showAllPages'
import type { SidebarViewId } from '../lib/sidebarOrder'

type View = SidebarViewId | 'settings'

/** What the renderer assumes when the main process cannot answer: everything
 *  visible. Hiding a page because a probe failed would be the worst reading of
 *  silence available. */
const ALL_DISCLOSED: VisibilitySignals = {
  evidenceSeen: true, transcriptSeen: true, targetCount: 2, lootSeen: true,
  screenshotSeen: true, bookmarkSeen: true, httpFlowSeen: true, loggedEver: true
}

interface UseVisibilityResult {
  visibility: ReturnType<typeof computeVisibility>
  firstRunActive: boolean
  /** Raw signals — App's initial fetch writes here via setVisSignals. */
  visSignals: VisibilitySignals | null
  setVisSignals: (s: VisibilitySignals) => void
}

export function useVisibility(
  project: { id: string; name: string } | null,
  view: View
): UseVisibilityResult {
  // §22. `null` means "not asked yet" and is NOT the same as "nothing yet":
  // rendering the day-one sidebar while the answer is in flight would flash a
  // four-row nav on a mature project, and show its operator a first-run screen.
  const [visSignals, setVisSignals] = useState<VisibilitySignals | null>(null)
  const [showAllPages, setShowAllPages] = useState(false)
  // Latched, not derived. `visibility.firstRun` goes false the instant the
  // first row lands — which is the exact moment the screen exists to show. Read
  // straight, the strip would be unmounted before the operator saw it light up,
  // and the answer to "is this being recorded" would be a flicker. It clears
  // when they leave the screen.
  const [firstRunActive, setFirstRunActive] = useState(false)

  // TDZ contract (this file and Timeline.tsx have both been bitten): the memo
  // sits immediately after the state block, and every effect that reads it is
  // BELOW. A dep array evaluates during render, so a hook above this line
  // naming `visibility` crashes only in the bundled build — vitest transforms
  // the source and never sees it.
  const visibility = useMemo(
    () => computeVisibility(visSignals ?? EMPTY_SIGNALS, showAllPages),
    [visSignals, showAllPages]
  )

  // Fetch initial visibility signals (project fetch stays in App).
  useEffect(() => {
    void (window.redlog.visibility?.signals?.().catch(() => null) ?? Promise.resolve(null))
      .then((signals) => {
        setVisSignals((signals as VisibilitySignals | null) ?? ALL_DISCLOSED)
      })
  }, [])

  // Re-probe only when a row arrives that could open a gate still closed, and
  // only after the batch settles: a scan produces hundreds of rows a second,
  // and the disclosure model must not sit on the hot path of capture.
  useEffect(() => {
    if (!project || visibility.complete) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = window.redlog.events.onNewBatch?.((batch: unknown[]) => {
      if (!shouldRefetch(visSignals ?? EMPTY_SIGNALS, batch as Parameters<typeof shouldRefetch>[1])) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void window.redlog.visibility?.signals?.()
          .then((sig) => { if (sig) setVisSignals(sig as VisibilitySignals) })
          .catch(() => { /* a probe failure only delays a page appearing */ })
      }, 500)
    }) ?? (() => {})
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [project, visibility.complete, visSignals])

  useEffect(() => {
    if (visSignals === null) return
    if (visibility.firstRun) setFirstRunActive(true)
  }, [visSignals, visibility.firstRun])

  // Navigating anywhere else is the operator saying they are done with it.
  useEffect(() => {
    if (view !== 'dashboard' && firstRunActive && !visibility.firstRun) setFirstRunActive(false)
  }, [view, firstRunActive, visibility.firstRun])

  // 5c is per project: switching projects reloads the same origin, so a global
  // key would turn disclosure off permanently for every later engagement after
  // one tick.
  useEffect(() => {
    if (!project) return
    setShowAllPages(storedShowAllPages(project.id))
    const onChange = (): void => setShowAllPages(storedShowAllPages(project.id))
    window.addEventListener(SHOW_ALL_PAGES_EVENT, onChange)
    return () => window.removeEventListener(SHOW_ALL_PAGES_EVENT, onChange)
  }, [project])

  return { visibility, firstRunActive, visSignals, setVisSignals }
}
