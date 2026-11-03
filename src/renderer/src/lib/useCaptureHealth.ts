import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  acquireCaptureHealth, getCaptureHealth, listenCaptureHealth, refreshCaptureHealth,
  type CaptureHealthState
} from './captureHealthStore'

// The shared capture-health snapshot (captureHealthStore.ts), for a component.
//
// `pollMs` is how often this reader wants it kept fresh; the store polls at the
// fastest cadence any mounted reader asks for. `signature` is the state the
// snapshot depends on: when it changes the snapshot is read again, so a row does
// not sit contradicting the switch the operator just touched until the next
// poll.

/** Everything the store knows, for a reader that has to say what it cannot
 *  confirm — the status bar and the dashboard card. */
export function useCaptureHealthState(pollMs = 0, signature?: string): CaptureHealthState & { refresh: () => void } {
  useEffect(() => acquireCaptureHealth(pollMs), [pollMs])
  const first = useRef(true)
  useEffect(() => {
    // Arriving is already a read.
    if (first.current) { first.current = false; return }
    refreshCaptureHealth()
  }, [signature])
  const state = useSyncExternalStore(listenCaptureHealth, getCaptureHealth, getCaptureHealth)
  // Stable between reads, so an effect that depends on it runs once per read.
  return useMemo(() => ({ ...state, refresh: refreshCaptureHealth }), [state])
}

// #435: an operator configuring a source wants to know whether it is
// delivering, and the only honest answer is a fact about the record ("last
// received at 15:02"), not a switch position.
//
// For a settings row. It fails soft: a read that failed leaves the settings
// usable — the source list is not the health card, and a failing health read
// must not blank the controls that configure the capture — but the row shows
// no "last received" at all rather than the last one, which would read as
// current.
export function useCaptureHealth(pollMs = 0, signature?: string): { health: CaptureHealthInfo | null; refresh: () => void } {
  const { health, status, refresh } = useCaptureHealthState(pollMs, signature)
  return { health: status === 'ok' ? health : null, refresh }
}
