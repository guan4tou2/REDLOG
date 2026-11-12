// A whole-table read that live batches ask for, at most one at a time.
//
// `request()` is for the live channel: while a read is in flight it only
// remembers that another is wanted, and that trailing read starts no sooner
// than `minIntervalMs` after the previous one started — a burst of batches is
// one read now and one after it, not one per batch queued behind each other.
// `now()` starts a read at once, for mount and the operator's retry.
//
// Reads are numbered, and a reply is applied only if no later read's reply has
// been applied before it: `now()` can overlap a read already in flight, and
// the older reply must not overwrite the newer one when it lands last.

export interface ThrottledRead {
  request: () => void
  now: () => void
  dispose: () => void
}

export function createThrottledRead<T>(opts: {
  read: () => Promise<T>
  apply: (value: T) => void
  fail: (err: unknown) => void
  minIntervalMs: number
}): ThrottledRead {
  let seq = 0
  let appliedSeq = 0
  let inFlight = 0
  let wanted = false
  let lastStart = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const settle = (mine: number, deliver: () => void): void => {
    if (disposed || mine <= appliedSeq) return
    appliedSeq = mine
    deliver()
  }

  const start = (): void => {
    if (disposed) return
    if (timer) { clearTimeout(timer); timer = null }
    wanted = false
    const mine = ++seq
    inFlight++
    lastStart = Date.now()
    let reply: Promise<T>
    try { reply = opts.read() } catch (err) { reply = Promise.reject(err) }
    reply.then(
      (v) => settle(mine, () => opts.apply(v)),
      (err: unknown) => settle(mine, () => opts.fail(err))
    ).finally(() => {
      inFlight--
      if (wanted && inFlight === 0) request()
    })
  }

  function request(): void {
    if (disposed) return
    if (inFlight > 0) { wanted = true; return }
    if (timer) return
    const wait = lastStart + opts.minIntervalMs - Date.now()
    if (wait <= 0) start()
    else timer = setTimeout(() => { timer = null; start() }, wait)
  }

  return {
    request,
    now: start,
    dispose: () => {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
    }
  }
}
