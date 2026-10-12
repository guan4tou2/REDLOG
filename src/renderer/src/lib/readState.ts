import { useCallback, useEffect, useRef, useState } from 'react'

// A read the UI depends on, in one of three phases (#298).
//
// The failure this exists for: `.catch(() => {})` with a state that starts at
// [] or 0. A rejected read then looks exactly like "there is nothing" — an
// empty project list, zero recordings pending, no agent types — and a screen
// that says "nothing" on the strength of a query that never answered is the
// one thing this product cannot do. Keeping the phase next to the value makes
// "has not answered" and "could not answer" things a component has to decide
// how to word, instead of things it can forget.
//
// `value` survives a failed refresh: stale-and-labelled beats empty-and-silent.

export type ReadState<T> =
  | { phase: 'loading'; value: T | null }
  | { phase: 'loaded'; value: T }
  | { phase: 'failed'; value: T | null; error: string }

export function initialRead<T>(): ReadState<T> {
  return { phase: 'loading', value: null }
}

/** A (re)read is in flight. Whatever was known stays visible meanwhile. */
export function readStarted<T>(prev: ReadState<T>): ReadState<T> {
  return { phase: 'loading', value: prev.value }
}

export function readSucceeded<T>(value: T): ReadState<T> {
  return { phase: 'loaded', value }
}

export function readFailed<T>(prev: ReadState<T>, error: string): ReadState<T> {
  return { phase: 'failed', value: prev.value, error }
}

/** The value was changed locally (a rename, a delete). The phase is not
 *  evidence of anything new, so it stays. */
export function readValueUpdated<T>(prev: ReadState<T>, value: T): ReadState<T> {
  return { ...prev, value }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export interface UseReadState<T> {
  state: ReadState<T>
  /** Read again. Callable in any phase; a stale answer from an earlier read is dropped. */
  retry: () => void
  /** Apply a local change to the known value without a re-read. */
  update: (fn: (prev: T | null) => T) => void
}

/**
 * Run `load` when mounted (and whenever `deps` change or `retry` is called) and
 * track its outcome. `enabled: false` leaves it in `loading` without calling.
 */
export function useReadState<T>(
  load: () => Promise<T>,
  enabled = true,
  deps: readonly unknown[] = []
): UseReadState<T> {
  const [state, setState] = useState<ReadState<T>>(initialRead)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!enabled) return
    let live = true
    setState(readStarted)
    // `new Promise` so a loader that throws before returning a promise is a
    // failure like any other, not an exception in an effect.
    new Promise<T>((resolve) => resolve(loadRef.current()))
      .then(
        (value) => { if (live) setState(readSucceeded(value)) },
        (error: unknown) => { if (live) setState((prev) => readFailed(prev, describeError(error))) }
      )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const update = useCallback(
    (fn: (prev: T | null) => T) => setState((prev) => readValueUpdated(prev, fn(prev.value))),
    []
  )
  return { state, retry, update }
}
