import { useEffect, useState } from 'react'

// A live internal-network pivot node (ligolo-ng / chisel / ssh -D/-L/-R …) as
// surfaced by the main process. Shared by every consumer so the shape can't drift.
export interface ActivePivot {
  via: string
  tool: string
  route?: string
  ts: number
}

interface PivotsBridge {
  getActive?: () => Promise<ActivePivot[]>
  onChange?: (cb: (p: ActivePivot[]) => void) => () => void
}

export type PivotRead =
  | { status: 'loading'; pivots: ActivePivot[] }
  | { status: 'ready'; pivots: ActivePivot[] }
  | { status: 'error'; pivots: ActivePivot[] }

/**
 * Subscribe to the active pivots (the HUD overlay and the dashboard IP card) with the state of the read, so a failed read
 * is not drawn as "no pivots". `pivots` is the last good list, which a failed
 * re-read leaves in place for the caller to date, not to present as current.
 */
export function usePivotRead(): PivotRead & { retry: () => void } {
  const [state, setState] = useState<PivotRead>({ status: 'loading', pivots: [] })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const pv = (window.redlog as { pivots?: PivotsBridge }).pivots
    const fail = (): void => setState((prev) => ({ status: 'error', pivots: prev.pivots }))
    // An answer that is not a list is a failed read, not an empty one.
    const set = (pivots: ActivePivot[]): void => (Array.isArray(pivots) ? setState({ status: 'ready', pivots }) : fail())
    if (!pv?.getActive) { set([]); return }
    pv.getActive().then(set).catch(fail)
    return pv.onChange?.(set)
  }, [attempt])
  return { ...state, retry: () => setAttempt((n) => n + 1) }
}
