import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CapturePrerequisite } from '../src/core/capture-health'

// #688: a source the OS will not let record is `error` through the same field
// the Dashboard issue list and StatusBar already read. `unknown` is "could not
// ask" and changes nothing; the operator's own `off` is never overridden.

vi.mock('../src/core/db/index', () => ({ getDB: () => ({ prepare: () => ({ get: () => undefined }) }) }))
vi.mock('../src/core/hooks-manager', () => ({ detectHooks: () => [], invalidateCommandCache: () => {} }))
vi.mock('../src/core/terminal-enrollment', () => ({ listTerminalEnrollments: () => [] }))
vi.mock('../src/core/spool-replay', () => ({ summarizeUnattributedSpool: () => null, clearUnattributedSpool: () => ({}) }))
vi.mock('../src/core/plugins/official-agents', () => ({ createOfficialAgentPluginManager: () => ({ list: () => [] }) }))
vi.mock('../src/core/plugins', () => ({
  listPlugins: () => [{ manifest: { id: 'pack-host-monitors' }, source: 'bundled', status: 'active' }]
}))

const ch = await import('../src/core/capture-health')

const missing = (id: string): CapturePrerequisite => ({ id, state: 'missing' })
let tick = 1_000_000
const read = (prereqs: Record<string, CapturePrerequisite[]>, hostMonitors: boolean) => {
  ch.configureCaptureHealth({ packs: { hostMonitors } })
  ch.configureCapturePrerequisites(() => prereqs)
  tick += 10_000 // past the health cache
  const h = ch.getCaptureHealth(tick)
  return { h, row: (id: string) => h.sources.find((s) => s.id === id) }
}

describe('capture health — prerequisites', () => {
  beforeEach(() => { ch.configureCapturePrerequisites(null) })

  it('marks an enabled source with a missing prerequisite as error, and the verdict partial', () => {
    const { h, row } = read({ screenshot: [{ ...missing('screen-recording'), fix: { kind: 'open', url: 'x' } }] }, false)
    expect(row('screenshot')?.state).toBe('error')
    expect(row('screenshot')?.prerequisites?.[0].id).toBe('screen-recording')
    expect(h.verdict).not.toBe('healthy')
  })

  it('leaves `unknown` alone', () => {
    const { row } = read({ screenshot: [{ id: 'screen-recording', state: 'unknown' }] }, false)
    expect(row('screenshot')?.state).toBe('ready')
    expect(row('screenshot')?.prerequisites).toEqual([{ id: 'screen-recording', state: 'unknown' }])
  })

  it('does not override a source the operator switched off', () => {
    expect(read({ 'connection-monitor': [missing('ss')] }, false).row('connection-monitor')?.state).toBe('off')
    expect(read({ 'connection-monitor': [missing('ss')] }, true).row('connection-monitor')?.state).toBe('error')
  })

  it('says nothing when the probe itself throws', () => {
    ch.configureCaptureHealth({})
    ch.configureCapturePrerequisites(() => { throw new Error('probe broke') })
    tick += 10_000
    const s = ch.getCaptureHealth(tick).sources.find((x) => x.id === 'screenshot')
    expect(s?.state).toBe('ready')
    expect(s?.prerequisites).toBeUndefined()
  })
})
