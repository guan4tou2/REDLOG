// When the Timeline may publish rows it has already stored (live batches and
// paged history). Measured under a 50 events/s burst at ~70 000 rows: four
// flushes a second, each a few hundred milliseconds, so the panel spent 9 s of
// a 15 s window in long tasks while every other page spent none.
//
// A publish is coalesced into the next animation frame, and the next one may
// not start until the panel has been idle for `factor` times as long as the
// last publish took. A cheap publish therefore runs every frame; an expensive
// one spaces itself out, and the panel never spends more than 1 / (factor + 1)
// of the time rendering, whatever the row count. A frame also never runs while
// the window is hidden, so a hidden window renders nothing and catches up in
// one publish.

export interface PacerClock {
  now: () => number
  frame: (cb: () => void) => unknown
  cancelFrame: (handle: unknown) => void
  timeout: (cb: () => void, ms: number) => unknown
  cancelTimeout: (handle: unknown) => void
}

export interface PublishPacer {
  /** Ask for a publish; several asks before it runs are one publish. */
  request: () => void
  /** Publish now, synchronously, and cancel the pending one. */
  flush: () => void
  /** Drop a pending publish (unmount). */
  cancel: () => void
  /** How long until a publish may start, 0 when it may now. */
  wait: () => number
}

const browserClock = (): PacerClock => ({
  now: () => performance.now(),
  frame: (cb) => requestAnimationFrame(() => cb()),
  cancelFrame: (h) => cancelAnimationFrame(h as number),
  timeout: (cb, ms) => setTimeout(cb, ms),
  cancelTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
})

export function createPublishPacer(
  publish: () => void,
  opts: { factor?: number; maxGapMs?: number; clock?: PacerClock } = {}
): PublishPacer {
  const factor = opts.factor ?? 3
  const maxGapMs = opts.maxGapMs ?? 1000
  const clock = opts.clock ?? browserClock()
  let frame: unknown = null
  let timer: unknown = null
  let notBefore = -Infinity

  const clear = (): void => {
    if (frame !== null) clock.cancelFrame(frame)
    if (timer !== null) clock.cancelTimeout(timer)
    frame = null
    timer = null
  }
  const run = (): void => {
    frame = null
    timer = null
    const start = clock.now()
    publish()
    const cost = clock.now() - start
    notBefore = clock.now() + Math.min(maxGapMs, cost * factor)
  }
  return {
    request() {
      if (frame !== null || timer !== null) return
      const wait = notBefore - clock.now()
      if (wait <= 0) frame = clock.frame(run)
      else timer = clock.timeout(() => { timer = null; frame = clock.frame(run) }, wait)
    },
    flush() {
      clear()
      run()
    },
    cancel: clear,
    wait: () => Math.max(0, notBefore - clock.now())
  }
}
