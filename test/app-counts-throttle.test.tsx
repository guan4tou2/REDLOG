// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppCounts } from '../src/renderer/src/lib/useAppCounts'

// Three mounted consumers (status bar, sidebar, dashboard) each re-read five
// counts on every live batch: during a 50 events/s burst the main process
// served ~21 count reads a second for numbers nobody can read that fast. The
// counts are one store now: one round of reads in flight at most, live batches
// start a round at most once a second however many components subscribe, and
// the last batch of a burst still lands.

function Probe({ id }: { id: string }): JSX.Element {
  const { eventCount } = useAppCounts()
  return <div data-testid={id}>{eventCount}</div>
}

let batch = new Set<() => void>()
let rounds = 0, inFlight = 0, maxInFlight = 0, value = 0
let hold: Array<() => void> = []
let holding = false
function install(): void {
  batch = new Set(); rounds = 0; inFlight = 0; maxInFlight = 0; value = 0; hold = []; holding = false
  const read = <T,>(v: () => T) => vi.fn(() => new Promise<T>((resolve) => {
    const done = (): void => resolve(v())
    if (holding) hold.push(done)
    else setTimeout(done, 50)
  }))
  const chained = read(() => value)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      getCount: vi.fn((tier: string) => {
        if (tier !== 'chained') return Promise.resolve(0)
        rounds++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        return chained().finally(() => { inFlight-- })
      }),
      onNewBatch: vi.fn((cb: () => void) => { batch.add(cb); return () => { batch.delete(cb) } })
    },
    chain: { length: vi.fn(async () => 0) },
    loot: { getCount: vi.fn(async () => 0) },
    scope: { getObservationCount: vi.fn(async () => 0), isConfigured: vi.fn(async () => true) }
  }
}
const emit = (): void => { for (const cb of batch) cb() }
const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); install() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('shared app counts under a live burst', () => {
  it('serves three subscribers with one round on mount and one per batch', async () => {
    render(<><Probe id="a" /><Probe id="b" /><Probe id="c" /></>)
    await advance(100)
    expect(rounds).toBe(1)
    await advance(2000)
    value = 7
    emit()
    await advance(100)
    expect(rounds).toBe(2)
    for (const id of ['a', 'b', 'c']) expect(screen.getByTestId(id).textContent).toBe('7')
  })

  it('reads at most once a second during a burst, one round at a time, and lands the last batch', async () => {
    render(<><Probe id="a" /><Probe id="b" /><Probe id="c" /></>)
    await advance(100)
    const before = rounds
    // 50 batches over 5 s, as a 50 events/s capture delivers them.
    for (let i = 1; i <= 50; i++) { value = i; emit(); await advance(100) }
    await advance(1500)
    expect(maxInFlight).toBe(1)
    expect(rounds - before).toBeGreaterThan(0)
    expect(rounds - before).toBeLessThanOrEqual(Math.ceil(5) + 1)
    expect(screen.getByTestId('a').textContent).toBe('50')
  })

  it('does not start a round while one is still in flight', async () => {
    render(<Probe id="a" />)
    await advance(100)
    holding = true
    await advance(1100)
    emit()
    await advance(10)
    const started = rounds
    for (let i = 0; i < 30; i++) { emit(); await advance(200) }
    expect(rounds).toBe(started)
    holding = false
    value = 9
    for (const done of hold.splice(0)) done()
    await advance(1100)
    expect(rounds).toBe(started + 1)
    expect(screen.getByTestId('a').textContent).toBe('9')
  })
})
