import { describe, it, expect, vi, beforeEach } from 'vitest'

// Trust decides whether a plugin's code runs, so grant and revoke are written
// into the record the way enable/disable are.

const m = vi.hoisted(() => ({
  insertEvent: vi.fn(() => ({ id: 'ev' })),
  publish: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn()
}))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('../src/core/db/events', () => ({ insertEvent: m.insertEvent }))
vi.mock('../src/core/event-bus', () => ({ eventBus: { publish: m.publish } }))
vi.mock('../src/core/plugins', () => ({
  listPlugins: m.list, listEventTypes: vi.fn(), setPluginEnabled: vi.fn(),
  grantPluginTrust: m.grant, revokePluginTrust: m.revoke, reloadPlugins: vi.fn()
}))
vi.mock('../src/core/config', () => ({ loadConfig: () => ({ operator: { id: 'op' } }) }))
vi.mock('../src/core/project-manager', () => ({ getProjectDir: () => '/p' }))
vi.mock('../src/core/capture-health', () => ({ invalidateHooksCache: vi.fn() }))
vi.mock('../src/core/hooks-manager', () => ({ invalidateHooksCache: vi.fn() }))
vi.mock('../src/core/plugins/test-sample', () => ({ testSample: vi.fn() }))
vi.mock('../src/core/plugins/contributions', () => ({ getContributionReport: () => undefined }))

import { registerPluginsIpc } from '../src/main/ipc/plugins'

const plug = { manifest: { id: 'x', name: 'X', capabilities: ['events:write'] }, source: 'bundled', tier: 'privileged', status: 'needs-consent', contentHash: 'abc' }
type H = (e: unknown, ...a: unknown[]) => unknown
const setup = (engagement: string | null = 'eng') => {
  const handlers = new Map<string, H>()
  const ctx = {
    getActiveProject: () => 'proj', getCurrentEngagementId: () => engagement, getCurrentOperatorId: () => 'op',
    onPluginsChanged: vi.fn()
  }
  registerPluginsIpc({ handle: (c: string, h: H) => handlers.set(c, h) } as never, ctx as never)
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a), ctx }
}

describe('plugins:grant / plugins:revoke audit', () => {
  beforeEach(() => { Object.values(m).forEach((f) => f.mockClear()); m.list.mockReturnValue([plug]) })

  it('grant writes a trust event with the capabilities and hash, and refreshes capture', () => {
    m.grant.mockReturnValue({ ok: true })
    const { call, ctx } = setup()
    call('plugins:grant', 'x')
    const [type, payload, meta] = m.insertEvent.mock.calls[0] as unknown as [string, { changed: Record<string, unknown>; description: string }, unknown]
    expect(type).toBe('system')
    expect(payload.changed['plugin.x.trusted']).toEqual({ from: false, to: true })
    expect(payload.changed['plugin.x.content_sha256']).toEqual({ from: null, to: 'abc' })
    expect(payload.description).toBe('Plugin trusted: X')
    expect(meta).toEqual({ engagementId: 'eng', operatorId: 'op' })
    expect(m.publish).toHaveBeenCalledTimes(1)
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
  })

  it('a refused grant writes nothing, since nothing changed', () => {
    m.grant.mockReturnValue({ ok: false, error: 'plugin failed to load' })
    const { call, ctx } = setup()
    call('plugins:grant', 'x')
    expect(m.insertEvent).not.toHaveBeenCalled()
    expect(ctx.onPluginsChanged).not.toHaveBeenCalled()
  })

  it('revoke writes a trust event and refreshes capture', () => {
    const { call, ctx } = setup()
    call('plugins:revoke', 'x')
    const payload = (m.insertEvent.mock.calls[0] as unknown as [string, { changed: Record<string, unknown> }])[1]
    expect(payload.changed['plugin.x.trusted']).toEqual({ from: true, to: false })
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
  })

  it('with no open engagement the change still happens and nothing is written', () => {
    const { call, ctx } = setup(null)
    call('plugins:revoke', 'x')
    expect(m.revoke).toHaveBeenCalledWith('x')
    expect(m.insertEvent).not.toHaveBeenCalled()
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
  })

  it('a failing insert does not undo or throw out of the revoke', () => {
    m.insertEvent.mockImplementationOnce(() => { throw new Error('db locked') })
    const { call } = setup()
    expect(() => call('plugins:revoke', 'x')).not.toThrow()
    expect(m.revoke).toHaveBeenCalled()
  })
})
