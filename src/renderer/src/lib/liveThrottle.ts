/** Run `work` for a stream of live triggers (event batches) at most once per
 *  `intervalMs`, one run at a time, and always once more after the last
 *  trigger of a burst, so the final state is read. A trigger during a run or
 *  inside the interval is folded into that trailing run, never dropped. */
export function liveThrottle(work: () => Promise<unknown> | void, intervalMs = 1000): { trigger: () => void; dispose: () => void } {
  let lastStart = -Infinity
  let running = false, pending = false, disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const start = (): void => {
    pending = false
    running = true
    lastStart = Date.now()
    let result: Promise<unknown> | void
    try { result = work() } catch { result = undefined }
    void Promise.resolve(result).catch(() => {}).finally(() => { running = false; if (pending) schedule() })
  }
  const schedule = (): void => {
    if (disposed || running || timer) return
    const wait = lastStart + intervalMs - Date.now()
    if (wait <= 0) { start(); return }
    timer = setTimeout(() => { timer = null; if (!disposed && pending && !running) start() }, wait)
  }
  return {
    trigger: () => { pending = true; schedule() },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); timer = null }
  }
}
