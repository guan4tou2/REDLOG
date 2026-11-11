// The one pacing helper for reads that live batches ask for: a burst of
// triggers becomes at most one run per interval, one run at a time, and the
// last trigger of a burst always gets a trailing run, so the final state is
// read. Targets (aggregate), the dashboard (capture health + anchors) and the
// shared app counts all pace through this.
//
// `request()` is for the live channel: while a run is in flight it only
// remembers that another is wanted, and that trailing run starts no sooner
// than `minIntervalMs` after the previous one started — a burst of batches is
// one run now and one after it, not one per batch queued behind each other.
//
// `request({ immediate: true })` is for asks that must not wait out the
// interval (a mount, a config save, the operator's retry) but must still not
// overlap a run in flight: it starts at once if nothing is running, cancels a
// pending interval wait, and otherwise makes the trailing run start the moment
// the current one settles.
//
// `now()` starts a run at once even over one in flight. Runs are numbered, and
// a reply is applied only if no later run's reply has been applied before it,
// so an older reply that lands last cannot overwrite a newer one.
//
// `apply` and `fail` are optional: a caller whose `read` does its own work
// (and swallows its own errors) leaves them out, and a rejection is then
// dropped. A synchronous throw from `read` counts as a rejection. After
// `dispose()` no reply is applied and no further run starts.

export interface ThrottledRead {
  request: (opts?: { immediate?: boolean }) => void
  now: () => void
  dispose: () => void
}

export function createThrottledRead<T>(opts: {
  read: () => Promise<T> | T
  apply?: (value: T) => void
  fail?: (err: unknown) => void
  minIntervalMs: number
}): ThrottledRead {
  let seq = 0
  let appliedSeq = 0
  let inFlight = 0
  let wanted = false
  let wantedImmediate = false
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
    wantedImmediate = false
    const mine = ++seq
    inFlight++
    lastStart = Date.now()
    let reply: Promise<T>
    try { reply = Promise.resolve(opts.read()) } catch (err) { reply = Promise.reject(err) }
    reply.then(
      (v) => settle(mine, () => opts.apply?.(v)),
      (err: unknown) => settle(mine, () => opts.fail?.(err))
    ).finally(() => {
      inFlight--
      if (wanted && inFlight === 0) request({ immediate: wantedImmediate })
    })
  }

  function request(how?: { immediate?: boolean }): void {
    if (disposed) return
    const immediate = how?.immediate === true
    if (inFlight > 0) {
      wanted = true
      wantedImmediate ||= immediate
      return
    }
    if (immediate) { start(); return }
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
