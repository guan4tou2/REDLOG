import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// v0.11.7 (AUDIT W19 + V11). Both are properties of Timeline.tsx that regress
// silently: the panel keeps working, it just burns every frame recomputing, or
// stacks labels no one can read. Neither is visible to a rendering test at the
// scale where it matters.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'Timeline.tsx'), 'utf-8'
)

// Capture through the closing dependency array, not just up to it — a
// non-greedy match that stops at `}, [` cuts the deps off, which is half of
// what these tests are about.
const memoBody = (name: string): string => {
  const m = new RegExp(`const ${name} = useMemo[\\s\\S]*?\\n  \\}, \\[[^\\]]*\\]\\)`).exec(SRC)
  if (!m) throw new Error(`${name} memo not found`)
  return m[0]
}

describe('per-batch work (W19)', () => {
  it('the search index is not built while idle', () => {
    // Measured on a real 131,833-event project: 116 ms to build, and it ran on
    // every flush whether or not anything was being filtered. It was the most
    // expensive thing on the panel by a factor of three.
    const body = memoBody('searchIndex')
    expect(body, 'must bail before the loop when no query is active')
      .toMatch(/if \(!filterQueryDebounced\.trim\(\)\) return idx/)
    // The guard has to come before the loop, not after it.
    expect(body.indexOf('return idx')).toBeLessThan(body.indexOf('for (const e of events)'))
  })

  it('the index rebuilds when the query changes', () => {
    // Making it lazy without this dep would leave the index empty forever.
    expect(memoBody('searchIndex')).toMatch(/\}, \[events, operatorNames, filterQueryDebounced\]/)
  })

  it('flushes coalesce once the event set is large', () => {
    // Every flush replaces the events array and invalidates every memo —
    // ~68 ms per pass at 131k even with the index lazy. Asking for that 60
    // times a second means the panel never paints.
    expect(SRC).toMatch(/const BIG_SET = 5_000/)
    expect(SRC).toMatch(/sortedRef\.current\.length > BIG_SET\) window\.setTimeout\(flush, SLOW_FLUSH_MS\)/)
    // Small sets keep the frame-accurate path — a live tail should look live.
    expect(SRC).toMatch(/else requestAnimationFrame\(flush\)/)
  })
})

describe('session band labels (V11)', () => {
  it('assigns overlapping bands to different rows', () => {
    // Two terminals open at once is the normal case for an operator with a
    // shell and a listener; both labels drew at their own top-left and neither
    // was readable.
    const body = memoBody('sessionBands')
    expect(body, 'greedy interval colouring over x0-sorted bands')
      .toMatch(/rowEnds\.findIndex\(\(end\) => end <= b\.x0\)/)
    expect(body, 'clearance must account for the label, not just the band')
      .toMatch(/LABEL_CLEARANCE_PX/)
  })

  it('offsets the label by its row and hides it on a band too narrow to hold it', () => {
    expect(SRC).toMatch(/top: b\.row \* 12/)
    expect(SRC, 'a 60px label bleeding out of a 4px band is worse than none')
      .toMatch(/\{w >= 34 && \(/)
  })
})
