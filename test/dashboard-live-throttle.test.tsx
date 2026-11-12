// @vitest-environment jsdom
//
// The dashboard re-read capture health and the chain anchors on every live
// batch, on top of the shared counts. During a capture burst that is several
// reads a second of the main process for a card nobody reads that fast. They
// follow batches at most once a second now, one round at a time, and the last
// batch of a burst is still read.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { DashboardView } from '../src/renderer/src/components/DashboardView'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

const noop = (): void => {}
const batch = new Set<() => void>()
let anchors = 0, health = 0, anchorsInFlight = 0, maxAnchorsInFlight = 0
function install(): void {
  batch.clear(); anchors = 0; health = 0; anchorsInFlight = 0; maxAnchorsInFlight = 0
  const later = <T,>(v: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(v), 50))
  const named: Record<string, Record<string, unknown>> = {
    config: { get: async () => ({ engagement: { id: 'E' }, operator: { name: 'op' }, scope: { targets: ['a.test'], excludeTargets: [] } }) },
    events: { getCount: async () => 1, onNewBatch: (cb: () => void) => { batch.add(cb); return () => { batch.delete(cb) } } },
    chain: {
      length: async () => 1,
      anchors: () => { anchors++; anchorsInFlight++; maxAnchorsInFlight = Math.max(maxAnchorsInFlight, anchorsInFlight); return later([]).finally(() => { anchorsInFlight-- }) }
    },
    capture: { health: () => { health++; return later({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) } },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    loot: { getCount: async () => 0 },
    pivots: { getActive: async () => [], onChange: () => noop }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}
const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  window.localStorage.setItem('redlog-locale', 'en'); _resetCaptureHealth(); _resetIssues(); install()
})
afterEach(() => { cleanup(); vi.useRealTimers(); window.localStorage.clear() })

it('follows a 5 s burst of batches with at most one anchor and health read a second', async () => {
  render(<I18nProvider><DashboardView onNavigate={noop} projectName="p" /></I18nProvider>)
  await advance(500)
  const a0 = anchors, h0 = health
  for (let i = 0; i < 50; i++) { for (const cb of batch) cb(); await advance(100) }
  await advance(1500)
  expect(maxAnchorsInFlight).toBe(1)
  expect(anchors - a0).toBeGreaterThan(0)
  expect(anchors - a0).toBeLessThanOrEqual(6)
  expect(health - h0).toBeLessThanOrEqual(6)
  // The trailing read after the last batch happened.
  const settled = anchors
  for (const cb of batch) cb()
  await advance(1100)
  expect(anchors).toBe(settled + 1)
})
