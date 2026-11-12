import { useRef } from 'react'
import type { RedLogEvent } from '../../../core/db/event-types'
import { stepDerivation, type Derivation, type DerivationCache } from '../lib/timelineIncremental'

/** A derivation of the Timeline's rows, recomputed like `useMemo` but folding
 *  in only the appended tail when the rows grew at the end (the live case).
 *  The cache is a ref written during render: a step is a pure function of the
 *  cached result and the new rows, so a repeated or discarded render either
 *  finds its own input cached or rebuilds. */
export function useTimelineDerived<S, P extends readonly unknown[]>(
  derivation: Derivation<S, P>,
  rows: readonly RedLogEvent[],
  ...params: P
): S {
  const cache = useRef<DerivationCache<S, P> | null>(null)
  cache.current = stepDerivation(derivation, cache.current, rows, ...params)
  return cache.current.state
}
