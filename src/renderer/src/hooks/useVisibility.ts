import { useState, useEffect, useMemo, useCallback } from 'react'
import { computeVisibility, shouldRefetch, EMPTY_SIGNALS, type VisibilitySignals } from '../lib/visibility'
import type { SidebarViewId } from '../lib/sidebarOrder'

type View = SidebarViewId | 'settings'

/** What the renderer assumes when the probe FAILS: everything visible. Hiding a
 *  page because a probe threw would be the worst reading of silence available.
 *  This is not what a `null` answer means — see the fetch effect below. */
const ALL_DISCLOSED: VisibilitySignals = { evidenceSeen: true, loggedEver: true }

interface UseVisibilityResult {
  visibility: ReturnType<typeof computeVisibility>
  firstRunActive: boolean
  /** Raw signals, or null while no project is open / the answer is in flight. */
  visSignals: VisibilitySignals | null
  setVisSignals: (s: VisibilitySignals | null) => void
}

export function useVisibility(
  project: { id: string; name: string } | null,
  view: View
): UseVisibilityResult {
  // `null` means "not asked yet" and is NOT the same as "nothing yet":
  // reading it as the latter would show a mature project's operator the
  // first-run screen while the real answer was still in flight.
  // Keyed by the project the answer belongs to. Between a project change and
  // its own probe resolving, the previous project's answer must not be read as
  // this one's: that is how a project with data reopened after a fresh one
  // showed the first-run screen.
  const [signalsFor, setSignalsFor] = useState<{ projectId: string | null; signals: VisibilitySignals | null }>(
    { projectId: null, signals: null }
  )
  const projectId = project?.id ?? null
  const visSignals = signalsFor.projectId === projectId ? signalsFor.signals : null
  const setVisSignals = useCallback(
    (s: VisibilitySignals | null) => setSignalsFor({ projectId, signals: s }),
    [projectId]
  )
  // Latched, not derived. `visibility.firstRun` goes false the instant the
  // first row lands — which is the exact moment the screen exists to show. Read
  // straight, the strip would be unmounted before the operator saw it light up,
  // and the answer to "is this being recorded" would be a flicker. It clears
  // when they leave the screen.
  const [firstRunActive, setFirstRunActive] = useState(false)
  // The latch belongs to one project. Opening another (or returning to the
  // picker) drops it, and the new project's own signals decide afresh.
  const [latchedFor, setLatchedFor] = useState<string | null>(projectId)
  if (latchedFor !== projectId) {
    setLatchedFor(projectId)
    setFirstRunActive(false)
  }

  // TDZ contract (this file and Timeline.tsx have both been bitten): the memo
  // sits immediately after the state block, and every effect that reads it is
  // BELOW. A dep array evaluates during render, so a hook above this line
  // naming `visibility` crashes only in the bundled build — vitest transforms
  // the source and never sees it.
  const visibility = useMemo(
    () => computeVisibility(visSignals ?? EMPTY_SIGNALS),
    [visSignals]
  )

  // Fetch visibility signals for the open project — and again when a project
  // opens, which is the whole point of the dependency.
  //
  // `visibility:signals` returns null while no project is active, and this used
  // to read that null as ALL_DISCLOSED on a single mount-time fetch. On a fresh
  // install that is exactly what happens: the app mounts at the picker with no
  // project, latches both flags true, and — because that also makes
  // `visibility.complete` true, switching off the re-probe below — never asks
  // again. The operator then creates their first project and gets no first-run
  // screen: the one screen that tells them what to do was suppressed by the
  // answer to a question asked before it could exist. A null answer means "not
  // asked yet", never "everything has been seen".
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void Promise.resolve()
      .then(() => window.redlog.visibility.signals())
      .then((signals) => { if (!cancelled) setSignalsFor({ projectId, signals: (signals as VisibilitySignals | null) ?? null }) })
      .catch(() => { if (!cancelled) setSignalsFor({ projectId, signals: ALL_DISCLOSED }) })
    return () => { cancelled = true }
  }, [projectId])

  // Re-probe only when a row arrives that could answer a question still open,
  // and only after the batch settles: a scan produces hundreds of rows a
  // second, and this must not sit on the hot path of capture.
  useEffect(() => {
    if (!project || visibility.complete) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = window.redlog.events.onNewBatch((batch: unknown[]) => {
      if (!shouldRefetch(visSignals ?? EMPTY_SIGNALS, batch as Parameters<typeof shouldRefetch>[1])) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void window.redlog.visibility.signals()
          .then((sig) => { if (sig) setSignalsFor({ projectId, signals: sig as VisibilitySignals }) })
          .catch(() => { /* a probe failure only delays a page appearing */ })
      }, 500)
    }) ?? (() => {})
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [project, projectId, visibility.complete, visSignals])

  useEffect(() => {
    if (visSignals === null) return
    if (visibility.firstRun) setFirstRunActive(true)
  }, [visSignals, visibility.firstRun])

  // Navigating anywhere else is the operator saying they are done with it.
  useEffect(() => {
    if (view !== 'dashboard' && firstRunActive && !visibility.firstRun) setFirstRunActive(false)
  }, [view, firstRunActive, visibility.firstRun])


  return { visibility, firstRunActive, visSignals, setVisSignals }
}
