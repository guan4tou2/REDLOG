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

/**
 * Subscribe to the active pivot chain. Used by both the HUD overlay and the
 * dashboard IP card so the subscription wiring and the (previously untyped,
 * cast-through) bridge access live in exactly one place.
 */
export function usePivots(): ActivePivot[] {
  const [pivots, setPivots] = useState<ActivePivot[]>([])
  useEffect(() => {
    const pv = (window.redlog as { pivots?: PivotsBridge }).pivots
    pv?.getActive?.().then(setPivots).catch(() => {})
    return pv?.onChange?.(setPivots)
  }, [])
  return pivots
}
