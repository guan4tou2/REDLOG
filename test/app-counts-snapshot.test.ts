// @vitest-environment jsdom
//
// Spec 074 T014 (US5): the shared counts are read as five or six separate IPC
// calls, and each answer is written to the store as it lands, so a render can
// show a mixture of two moments. And a read that fails is drawn as 0.
//
// Both are RED against today and stated as the correct behaviour in `it.fails`.
// The pins beside them say what works today, so that the RED cases cannot pass
// for the wrong reason (a read that never ran, a store that never rendered).
//
//  1. Atomicity. `eventCount` (chained rows) and `chainLen` (rows carrying a
//     hash) are equal on a sound chain, and the fixture serves equal values.
//     After a batch, `getCount('chained')` answers before `chain.length()`,
//     and for one render the strip reads "11 events, chain of 10". Phase 6
//     reads one `counts:snapshot` and the render never sees half of it.
//  2. A failed read is not a zero (`useAppCounts.ts`: "A read that fails is
//     not a zero"). The scope pair already says so with `scopeUnknown`; the
//     four numbers below keep their INITIAL 0 and `loading` goes false, so
//     the status bar prints 0 as a fact.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppCounts, type AppCounts } from '../src/renderer/src/lib/useAppCounts'

let batch = new Set<() => void>()
let truth = { chained: 0, logged: 0, chain: 0, loot: 0 }
let failing: keyof typeof truth | null = null
let delay = { chained: 10, logged: 10, chain: 10, loot: 10 }

function install(): void {
  batch = new Set()
  const answer = <K extends keyof typeof truth>(key: K): Promise<number> => new Promise((resolve, reject) => {
    setTimeout(() => (failing === key ? reject(new Error(`${key} unavailable`)) : resolve(truth[key])), delay[key])
  })
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      getCount: vi.fn((tier: string) => answer(tier === 'chained' ? 'chained' : 'logged')),
      onNewBatch: vi.fn((cb: () => void) => { batch.add(cb); return () => { batch.delete(cb) } })
    },
    chain: { length: vi.fn(() => answer('chain')) },
    loot: { getCount: vi.fn(() => answer('loot')), countIsPartial: vi.fn(async () => false) },
    scope: { getObservationCount: vi.fn(async () => 0), isConfigured: vi.fn(async () => true) }
  }
}
const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  truth = { chained: 0, logged: 0, chain: 0, loot: 0 }; failing = null; delay = { chained: 10, logged: 10, chain: 10, loot: 10 }
  install()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Every value the hook returned, in render order. */
function mount(): { seen: AppCounts[] } {
  const seen: AppCounts[] = []
  renderHook(() => { const counts = useAppCounts(); seen.push(counts); return counts })
  return { seen }
}

describe('the shared counts, as one snapshot', () => {
  it('(pin) lands every count of a round: 11 and 11 after a batch', async () => {
    const { seen } = mount()
    await advance(100)
    truth = { ...truth, chained: 11, chain: 11 }
    delay = { ...delay, chain: 60 } // the chain length answers later than the event count
    act(() => { for (const cb of batch) cb() })
    await advance(1100)
    await advance(200)
    expect(seen.at(-1)).toMatchObject({ eventCount: 11, chainLen: 11, loading: false })
  })

  it.fails('never renders eventCount and chainLen from two different moments', async () => {
    const { seen } = mount()
    await advance(100)
    truth = { ...truth, chained: 11, chain: 11 }
    delay = { ...delay, chain: 60 }
    act(() => { for (const cb of batch) cb() })
    await advance(1100)
    await advance(200)
    expect(seen.at(-1)).toMatchObject({ eventCount: 11, chainLen: 11 })
    const mixed = seen.filter((c) => c.eventCount !== c.chainLen).map((c) => `${c.eventCount}/${c.chainLen}`)
    expect(mixed, 'renders in which the two equal numbers differ (eventCount/chainLen)').toEqual([])
  })
})

describe('a count whose read failed', () => {
  const fields: Array<[keyof typeof truth, keyof AppCounts]> = [
    ['chained', 'eventCount'], ['logged', 'loggedCount'], ['chain', 'chainLen'], ['loot', 'lootCount']
  ]
  for (const [key, field] of fields) {
    it(`(pin) ${field}: the other counts still land when it fails`, async () => {
      truth = { chained: 7, logged: 7, chain: 7, loot: 7 }
      failing = key
      const { seen } = mount()
      await advance(100)
      const last = seen.at(-1)!
      expect(last.loading).toBe(false)
      for (const [k, f] of fields) if (k !== key) expect(last[f], String(f)).toBe(7)
    })
    it.fails(`${field}: is not reported as 0`, async () => {
      truth = { chained: 7, logged: 7, chain: 7, loot: 7 }
      failing = key
      const { seen } = mount()
      await advance(100)
      expect(seen.at(-1)!.loading, 'the round finished').toBe(false)
      expect(seen.at(-1)![field], `${String(field)} after its read failed`).not.toBe(0)
    })
  }
})
