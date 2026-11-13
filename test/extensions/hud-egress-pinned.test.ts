// Spec 076 T004 (US1, FR-023): the HUD's egress path as it is today, pinned
// before anything around it moves.
//
// The path is IPSignalProducer (reads the address, keeps the state the HUD and
// the status bar show) -> AlertBus -> IPPolicy (classifies, and decides whether
// a verdict is new: policies.ts `evaluate`, the dedup at lines 85-94) ->
// ChainEmitter (writes `system.ip_verdict`). Spec 076 does not change any of
// it, but it moves the sources that feed the base layer, and an operator whose
// HUD turned stale or stopped writing verdicts would find out in the field.
//
// Driven the way test/ip-signal-producer.test.ts does (HTTP provider stubbed,
// fake time, start() and the clock only) but with the whole chain attached, and
// with ChainEmitter's write recorded instead of stored. That file pins how a
// read becomes an address; this one pins what the state says at each tick and
// when a verdict row is written.
//
// The three state words, as the code sets them (ip-signal-producer.ts read()):
//   externalReadAt  when a read last returned the stable address; moves only on
//                   a successful read of that address, not on a failed read or
//                   a candidate read
//   stale           the last read failed; the verdict reads `unknown`
//   settling        a different address has been seen but not yet confirmed 3
//                   times; the verdict stays on the old address
// And the timing of the write, which is the part that surprises: a verdict is
// written when its value changes, AND on every tick while it is stale or
// settling, because evaluate() does not dedup those. A HUD left unplugged for an
// hour therefore writes one `ip_verdict` row per interval. Pinned as it is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ writes: [] as Array<{ agentType: string; data: Record<string, unknown> }> }))
vi.mock('../../src/core/db/events', () => ({
  insertEvent: (agentType: string, data: Record<string, unknown>) => { h.writes.push({ agentType, data }); return { id: `ev-${h.writes.length}` } }
}))
vi.mock('../../src/core/event-bus', () => ({ eventBus: { publish: () => undefined } }))

import { IPSignalProducer } from '../../src/main/services/producers/ip-signal-producer'
import { AlertBus } from '../../src/core/alert/bus'
import { IPPolicy } from '../../src/core/alert/policies'
import { ChainEmitter } from '../../src/core/alert/surface'

const PROVIDER = 'https://egress.test/ip'
const SAFE = '198.51.100.7'
const EXPOSED = '203.0.113.5'
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0)

type Answer = { ip: string } | 'fail'
let answers: Answer[] = []
let producer: IPSignalProducer | null = null

function build(opts: { confirmations?: number } = {}): IPSignalProducer {
  const bus = new AlertBus()
  const policy = new IPPolicy()
  policy.configure({ safeIps: ['198.51.100.0/24'], exposedIps: ['203.0.113.0/24'] })
  bus.registerPolicy(policy)
  bus.registerSurface(new ChainEmitter({ engagementId: 'eng-hud', operatorId: 'op-hud' }))
  const p = new IPSignalProducer(bus)
  p.configure({ ipMode: 'http', providers: [PROVIDER], confirmations: opts.confirmations ?? 3 })
  return p
}

/** The state words at this moment, with the read time as seconds since T0 so
 *  the table reads as a timeline. */
function snapshot(p: IPSignalProducer): Record<string, unknown> {
  const s = p.getState()
  return {
    external: s.external,
    readAtS: s.externalReadAt === 0 ? 0 : (s.externalReadAt - T0) / 1000,
    stale: s.stale,
    settling: s.settling,
    error: s.error
  }
}

/** The ip_verdict rows written since the last call, as the fields a reader sees. */
function written(): Array<Record<string, unknown>> {
  const rows = h.writes.splice(0).map((w) => {
    expect(w.agentType).toBe('system')
    const { subtype, ip_verdict_kind, authority, severity, settling, stale } = w.data
    return { subtype, kind: ip_verdict_kind, authority, severity, ...(settling ? { settling } : {}), ...(stale ? { stale } : {}) }
  })
  return rows
}

beforeEach(() => {
  h.writes.length = 0
  answers = []
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.stubGlobal('fetch', async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (a === 'fail') throw new TypeError('fetch failed')
    return { ok: true, status: 200, json: async () => a }
  })
})
afterEach(() => {
  producer?.stop()
  producer = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Start, let the first read finish, return the producer. */
async function begin(p: IPSignalProducer): Promise<void> {
  producer = p
  p.start()
  await vi.advanceTimersByTimeAsync(0)
}
const tick = (): Promise<void> => vi.advanceTimersByTimeAsync(10_000)

describe('IPSignalProducer state words and ip_verdict writes (Spec 076 T004)', () => {
  it('first read: the address is stable at once, read time is now, one verdict is written', async () => {
    answers = [{ ip: SAFE }]
    const p = build()
    await begin(p)
    expect(snapshot(p)).toEqual({ external: SAFE, readAtS: 0, stale: false, settling: false, error: null })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'safe', authority: 'fact', severity: 'clean' }])
  })

  it('same address again: externalReadAt moves, nothing is written (the dedup)', async () => {
    answers = [{ ip: SAFE }]
    const p = build()
    await begin(p)
    written()
    await tick()
    await tick()
    expect(snapshot(p)).toMatchObject({ external: SAFE, readAtS: 20, stale: false, settling: false })
    expect(written()).toEqual([])
  })

  it('a failed read: stale, the address and its read time stay, and a verdict is written on EVERY stale tick', async () => {
    answers = [{ ip: SAFE }, 'fail']
    const p = build()
    await begin(p)
    written()
    await tick()
    expect(snapshot(p)).toEqual({ external: SAFE, readAtS: 0, stale: true, settling: false, error: 'All IP providers failed' })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'unknown', authority: 'unknown', severity: 'notice', stale: true }])
    await tick()
    await tick()
    // Not deduped: stale verdicts are written each tick. externalReadAt did not move.
    expect(snapshot(p)).toMatchObject({ readAtS: 0, stale: true })
    expect(written()).toEqual([
      { subtype: 'ip_verdict', kind: 'unknown', authority: 'unknown', severity: 'notice', stale: true },
      { subtype: 'ip_verdict', kind: 'unknown', authority: 'unknown', severity: 'notice', stale: true }
    ])
  })

  it('recovery on the same address: stale clears, read time moves, the verdict comes back once', async () => {
    answers = [{ ip: SAFE }, 'fail', { ip: SAFE }]
    const p = build()
    await begin(p)
    await tick()
    written()
    await tick()
    expect(snapshot(p)).toEqual({ external: SAFE, readAtS: 20, stale: false, settling: false, error: null })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'safe', authority: 'fact', severity: 'clean' }])
    await tick()
    expect(written()).toEqual([])
  })

  it('a new address: settling for two reads (old address kept, read time frozen, a verdict each tick), promoted on the third', async () => {
    answers = [{ ip: SAFE }, { ip: EXPOSED }]
    const p = build()
    await begin(p)
    written()
    await tick()
    expect(snapshot(p)).toEqual({ external: SAFE, readAtS: 0, stale: false, settling: true, error: null })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'safe', authority: 'fact', severity: 'clean', settling: true }])
    await tick()
    expect(snapshot(p)).toMatchObject({ external: SAFE, readAtS: 0, settling: true })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'safe', authority: 'fact', severity: 'clean', settling: true }])
    await tick()
    // Promoted: the new address is stable, read now (30 s), and it is exposed.
    expect(snapshot(p)).toEqual({ external: EXPOSED, readAtS: 30, stale: false, settling: false, error: null })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'exposed', authority: 'fact', severity: 'critical' }])
  })

  it('the old address returning mid-settle drops the candidate: settling clears, no verdict beyond the settling ones', async () => {
    answers = [{ ip: SAFE }, { ip: EXPOSED }, { ip: SAFE }]
    const p = build()
    await begin(p)
    written()
    await tick()
    written()
    await tick()
    expect(snapshot(p)).toEqual({ external: SAFE, readAtS: 20, stale: false, settling: false, error: null })
    expect(written()).toEqual([])
  })

  it('a failed read during settling ends it: stale, not settling', async () => {
    answers = [{ ip: SAFE }, { ip: EXPOSED }, 'fail']
    const p = build()
    await begin(p)
    await tick()
    written()
    await tick()
    expect(snapshot(p)).toMatchObject({ external: SAFE, stale: true, settling: false })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'unknown', authority: 'unknown', severity: 'notice', stale: true }])
  })

  it('offline (air-gap): never reads, stale from the first tick, externalReadAt stays 0, a verdict each tick', async () => {
    const p = build()
    p.configure({ offline: true })
    await begin(p)
    expect(snapshot(p)).toEqual({ external: null, readAtS: 0, stale: true, settling: false, error: 'offline (air-gap)' })
    expect(written()).toEqual([{ subtype: 'ip_verdict', kind: 'unknown', authority: 'unknown', severity: 'notice', stale: true }])
    await tick()
    expect(written()).toHaveLength(1)
  })

  it('the write happens inside the tick that read it: no verdict is pending after a tick completes', async () => {
    answers = [{ ip: SAFE }]
    const p = build()
    await begin(p)
    // Written by the time start()'s first read resolved, not deferred to the next interval.
    expect(h.writes).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
  })
})
