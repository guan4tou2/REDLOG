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
const SESSION_BANDS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'timelineSessionBands.ts'), 'utf-8'
)
const FILTERS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'timelineFilters.ts'), 'utf-8'
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
  it('the filter box asks nothing while it is empty', () => {
    // Spec 033 replaced the in-renderer search index, whose build was the most
    // expensive thing on the panel at 131,833 events, with an id check in the
    // persistence layer. The property that index guarded still holds: with
    // no query there is no work, not a round trip per flush.
    const bail = SRC.indexOf('if (!parsedQuery || !queryKey) {')
    const ask = SRC.indexOf('ids, parsed: parsedQuery, filter: eventFilterRef.current, excludeHousekeeping: true')
    expect(bail, 'the match effect bails before asking').toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(bail)
  })

  it('the match check follows the query and the rows, once per row', () => {
    // Checked ids are cached per query and filter, so a flush asks only about
    // rows it has not asked about; a new query or filter starts the cache over.
    expect(SRC).toContain('}, [queryKey, rawEvents, boxRetry])')
    expect(SRC).toContain('rawEvents.filter((e) => !cache.checked.has(e.id))')
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
    // The logic was extracted to timelineSessionBands.ts — verify delegation
    // and that the extracted module has the actual algorithm.
    expect(SRC, 'Timeline delegates to buildSessionBands')
      .toMatch(/buildSessionBands\(/)
    expect(SESSION_BANDS_SRC, 'greedy interval colouring over x0-sorted bands')
      .toMatch(/rowEnds\.findIndex\(\(end\) => end <= b\.x0\)/)
    expect(SESSION_BANDS_SRC, 'clearance must account for the label, not just the band')
      .toMatch(/labelClearancePx/)
  })

  it('offsets the label by its row and hides it on a band too narrow to hold it', () => {
    expect(SRC).toMatch(/top: b\.row \* 12/)
    expect(SRC, 'a 60px label bleeding out of a 4px band is worse than none')
      .toMatch(/\{w >= 34 && \(/)
  })
})
