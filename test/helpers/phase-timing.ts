// Names the phase when a slow DB test is slow (#669). A 15 s Vitest timeout
// reports the test, not the step, and says nothing about whether the process
// was working or waiting. Each phase is timed with wall-clock and this
// process's CPU time; a phase over the threshold prints one JSON line.
// wallMs far above cpuMs means the time went to waiting (disk sync, a child
// process, a scanner holding the file), not to computing. Children such as
// icacls are not in cpuMs, so a spawn shows up as exactly that gap.
//
// Nothing changes for a test that is fast: no output, same return value.

export const SLOW_PHASE_MS = 2000

export interface SlowPhase {
  slowPhase: string
  wallMs: number
  cpuMs: number
  platform: string
}

export function timePhase<T>(
  label: string,
  fn: () => T,
  report: (line: string) => void = (line) => console.warn(line),
  thresholdMs: number = SLOW_PHASE_MS
): T {
  const wall = performance.now()
  const cpu = process.cpuUsage()
  try {
    return fn()
  } finally {
    const wallMs = performance.now() - wall
    if (wallMs > thresholdMs) {
      const used = process.cpuUsage(cpu)
      const line: SlowPhase = {
        slowPhase: label,
        wallMs: Math.round(wallMs),
        cpuMs: Math.round((used.user + used.system) / 1000),
        platform: process.platform
      }
      report(JSON.stringify(line))
    }
  }
}
