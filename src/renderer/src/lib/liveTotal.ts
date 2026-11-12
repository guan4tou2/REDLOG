// The M of the Timeline's "N of M" while rows are being admitted live.
//
// A count is a whole-project scan; a row admitted while it is in flight may or
// may not be in it, and nothing in its reply says which. The panel used to
// re-issue the count whenever that happened. When counting takes longer than
// the gap between admitted rows that never ends: every reply finds a newer
// row, counts run back to back for as long as anything is recording, and M
// stays pending the whole time.
//
// What can be said is that the total lies between the reply and the reply plus
// the rows admitted during the flight. This shows the upper bound — the one
// that keeps N ≤ M — and counts once more after a pause, which is exact when
// that count is not overtaken. One more, not a chain: if it is overtaken too,
// its bound is accepted and the live increments carry it from there.

export type TotalState = { state: 'pending' } | { state: 'ok'; value: number } | { state: 'failed' }

export interface LiveTotal {
  /** Count now: on a new filter, or the operator's retry. */
  request: () => void
  /** `n` rows were admitted live. */
  admitted: (n: number) => void
  /** The filter changed or the panel went away: publish nothing more. */
  dispose: () => void
}

export function createLiveTotal(opts: {
  count: () => Promise<number>
  publish: (t: TotalState) => void
  /** How long after an overtaken count the one recount is taken. */
  recountDelayMs?: number
}): LiveTotal {
  const delay = opts.recountDelayMs ?? 2000
  let current: TotalState = { state: 'pending' }
  let inFlight = false
  let overtaken = 0
  let recounted = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const publish = (t: TotalState): void => {
    current = t
    if (!disposed) opts.publish(t)
  }

  const run = (): void => {
    if (disposed || inFlight) return
    inFlight = true
    overtaken = 0
    // A recount keeps the last value on screen; only a first count is pending.
    if (current.state !== 'ok') publish({ state: 'pending' })
    let reply: Promise<number>
    try { reply = opts.count() } catch (err) { reply = Promise.reject(err) }
    reply.then(
      (n) => {
        inFlight = false
        if (disposed) return
        const during = overtaken
        overtaken = 0
        publish({ state: 'ok', value: n + during })
        if (during > 0 && !recounted) {
          recounted = true
          timer = setTimeout(() => { timer = null; run() }, delay)
        }
      },
      () => {
        inFlight = false
        overtaken = 0
        if (disposed) return
        // A failed recount leaves a running total that is still a bound.
        if (current.state !== 'ok') publish({ state: 'failed' })
      }
    )
  }

  return {
    request: run,
    admitted: (n) => {
      if (disposed || n <= 0) return
      if (inFlight) overtaken += n
      if (current.state === 'ok') publish({ state: 'ok', value: current.value + n })
    },
    dispose: () => {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
    }
  }
}
