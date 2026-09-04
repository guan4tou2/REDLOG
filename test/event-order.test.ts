import { describe, it, expect } from 'vitest'
import { compareMonotonicNs } from '../src/renderer/src/lib/eventOrder'

// `monotonic_ns` is `bootEpochMs-nanoseconds`, both zero-padded. The obvious
// BigInt(stamp) sat in the timeline for months and never once ran — the hyphen
// makes it throw, so every same-millisecond pair silently ordered by UUID.
// Ordered, just not in the order things happened, which is the kind of wrong
// nothing notices.

const mono = (bootMs: number, ns: number): string =>
  `${String(bootMs).padStart(14, '0')}-${String(ns).padStart(20, '0')}`

describe('monotonic order', () => {
  it('orders two stamps from the same run by nanoseconds', () => {
    expect(compareMonotonicNs(mono(1_700_000_000_000, 10), mono(1_700_000_000_000, 11))).toBeLessThan(0)
    expect(compareMonotonicNs(mono(1_700_000_000_000, 11), mono(1_700_000_000_000, 10))).toBeGreaterThan(0)
    expect(compareMonotonicNs(mono(1_700_000_000_000, 10), mono(1_700_000_000_000, 10))).toBe(0)
  })

  it('breaks a tie across a restart by boot epoch first', () => {
    // Nanosecond counters from different runs are unrelated, so without this a
    // row from an earlier run with a high counter sorts after a later run.
    const earlierRunHighCounter = mono(1_700_000_000_000, 999_999_999)
    const laterRunLowCounter = mono(1_700_000_900_000, 1)
    expect(compareMonotonicNs(earlierRunHighCounter, laterRunLowCounter)).toBeLessThan(0)
  })

  it('would have thrown under the old BigInt path', () => {
    // The regression itself, stated as a fact about the format.
    expect(() => BigInt(mono(1_700_000_000_000, 1))).toThrow()
    expect(compareMonotonicNs(mono(1_700_000_000_000, 1), mono(1_700_000_000_000, 2))).toBeLessThan(0)
  })

  it('sorts a pre-prefix row ahead of a prefixed one', () => {
    expect(compareMonotonicNs('00000000000000000042', mono(1_700_000_000_000, 1))).toBeLessThan(0)
  })

  it('says nothing when either stamp is missing or malformed', () => {
    // 0 rather than an invented order, so the caller falls through to its own
    // next key instead of ordering on noise.
    expect(compareMonotonicNs(null, mono(1, 1))).toBe(0)
    expect(compareMonotonicNs(undefined, undefined)).toBe(0)
    expect(compareMonotonicNs('not-a-number', mono(1, 1))).toBe(0)
    expect(compareMonotonicNs('', '')).toBe(0)
  })
})
