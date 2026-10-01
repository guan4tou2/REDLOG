// The Dashboard event tile says nothing about a sound chain. It used to read
// "證據鏈同步 · 1154 筆 · ⚓ 22m · 2m 前抽樣驗證" under 1154 — the number again,
// and two ages with nothing to do about them.

import { describe, it, expect } from 'vitest'
import { eventTileStatus } from '../src/renderer/src/lib/eventTileStatus'

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key

const now = 1_000_000_000_000
const H = 3_600_000
const base = { eventCount: 1154, chainLen: 1154, lastAnchor: null, sampleBroken: undefined, now }

describe('the event tile sub-line', () => {
  it('is empty on a sound chain with a fresh anchor', () => {
    expect(eventTileStatus({ ...base, lastAnchor: { createdAt: now - 22 * 60_000, status: 'confirmed' } }, t))
      .toEqual({ sub: undefined, tone: 'cyan' })
  })

  it('names a drift, in red', () => {
    expect(eventTileStatus({ ...base, chainLen: 1150 }, t))
      .toEqual({ sub: 'dashboard.chainDrift(1150,1154)', tone: 'red' })
  })

  it('names a stale anchor: amber from 2h, red from a day', () => {
    expect(eventTileStatus({ ...base, lastAnchor: { createdAt: now - 1.9 * H, status: 'confirmed' } }, t).sub).toBeUndefined()
    expect(eventTileStatus({ ...base, lastAnchor: { createdAt: now - 3 * H, status: 'confirmed' } }, t))
      .toEqual({ sub: 'dashboard.anchorStale(3h)', tone: 'amber' })
    expect(eventTileStatus({ ...base, lastAnchor: { createdAt: now - 50 * H, status: 'confirmed' } }, t))
      .toEqual({ sub: 'dashboard.anchorStale(2d)', tone: 'red' })
  })

  it('names a failed anchor however recent', () => {
    expect(eventTileStatus({ ...base, lastAnchor: { createdAt: now - 60_000, status: 'failed' } }, t))
      .toEqual({ sub: 'dashboard.anchorFailed', tone: 'red' })
  })

  it('a stale anchor does not soften a drift back to amber', () => {
    const r = eventTileStatus({ ...base, chainLen: 1, lastAnchor: { createdAt: now - 3 * H, status: 'confirmed' } }, t)
    expect(r.tone).toBe('red')
    expect(r.sub).toBe('dashboard.chainDrift(1,1154) · dashboard.anchorStale(3h)')
  })

  it('names a broken sample with the broken row’s age', () => {
    expect(eventTileStatus({ ...base, sampleBroken: { eventTimestamp: now - 3 * 86_400_000 } }, t))
      .toEqual({ sub: 'dashboard.sampleBroken dashboard.sampleAgeDays(3)', tone: 'red' })
    expect(eventTileStatus({ ...base, sampleBroken: {} }, t).sub).toBe('dashboard.sampleBroken')
  })
})
