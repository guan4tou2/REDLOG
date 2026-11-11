import { describe, it, expect, vi } from 'vitest'

// `emit` drops values already recorded and repeats within one call. The
// repeats were found by searching an array of every key kept so far, once per
// match: quadratic in the number of distinct values. 256 KiB of distinct crypt
// hashes (18.7k values) spent 4.4 s there, 1 MiB 78 s, on the main thread, in
// ingest and in POST /api/loot/scan alike. These pin both halves: what is
// recorded is unchanged, and the work grows with the values, not their square.

const written: Array<{ matches: Array<{ type: string; preview: string }>; count: number }> = []
vi.mock('../src/core/db/events', () => ({
  insertEvent: (_type: string, data: { matches: Array<{ type: string; preview: string }>; count: number }) => {
    written.push(data)
    return { id: `e${written.length}`, agentType: 'loot', data }
  }
}))

const { LootDetector } = await import('../src/core/loot-detector')
const identity = { engagementId: 'eng', operatorId: 'op' } as never
const match = (value: string) => ({ ruleId: 'password_hash', type: 'password_hash', value, line: value, confidence: 'high' as const })

describe('loot emit dedup', () => {
  it('records each new value once, in first-seen order', () => {
    const d = new LootDetector()
    d.configure({ identity })
    written.length = 0
    expect(d.emit(['a1', 'b2', 'a1', 'c3', 'b2'].map(match), { targetId: 't' })).toBe(true)
    expect(written[0].matches.map((m) => m.preview)).toEqual(['a1', 'b2', 'c3'])
    expect(written[0].count).toBe(3)
    // already recorded for this target: nothing new, no write
    expect(d.emit(['c3', 'a1'].map(match), { targetId: 't' })).toBe(true)
    expect(written).toHaveLength(1)
    // a second target is a second fact
    d.emit([match('a1')], { targetId: 'u' })
    expect(written[1].matches.map((m) => m.preview)).toEqual(['a1'])
  })

  // Wall-clock, so the bound is a ratio: four times the distinct values may
  // take at most eleven times as long (linear 4x, quadratic 16x), best of three.
  // Always on, and not a measurement: 64 000 distinct values took over a
  // minute through the quadratic dedup and take well under a second now.
  it('records 64 000 distinct values within seconds', () => {
    const ms = Array.from({ length: 64_000 }, (_, i) => match(`$6$s$${i.toString(16).padStart(8, '0')}`))
    const d = new LootDetector()
    d.configure({ identity })
    const t0 = performance.now()
    d.emit(ms, {})
    expect(performance.now() - t0).toBeLessThan(15_000)
  }, 120_000)

  // The ratio is a measurement; a shared CI runner is not an instrument. On
  // request: REDLOG_PERF=1.
  it.runIf(process.env.REDLOG_PERF === '1')('takes at most 11x as long for 4x the distinct values', () => {
    const time = (n: number): number => {
      const ms = Array.from({ length: n }, (_, i) => match(`$6$s$${i.toString(16).padStart(8, '0')}`))
      let best = Infinity
      for (let r = 0; r < 3; r++) {
        const d = new LootDetector()
        d.configure({ identity })
        const t0 = performance.now()
        d.emit(ms, {})
        best = Math.min(best, performance.now() - t0)
      }
      return best
    }
    let ok = false
    let last = ''
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      const t = time(4000)
      const t4 = time(16000)
      ok = t4 <= 11 * Math.max(t, 0.5)
      last = `4000 values ${t.toFixed(1)} ms -> 16000 values ${t4.toFixed(1)} ms`
    }
    expect({ ok, last }).toEqual({ ok: true, last })
  }, 120_000)
})
