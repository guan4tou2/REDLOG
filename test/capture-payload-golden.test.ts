// Spec 075 T004: the payload `getCaptureHealth` returns TODAY, for eight fixed
// combinations of machine facts, pinned before Phase 2 replaces how it is
// derived. A golden records what the code does, including where that is wrong:
// the "new project, no hook" case reads `dark`, which Spec 075 FR-015 calls a
// defect (T010 holds the correct reading as an `it.fails`). Phase 2 must leave
// every value below unchanged — the old fields keep their meaning until
// Phase 3 — and T026 lists any difference, with the FR that justifies it.
//
// Each case pins `verdict`, `hasRecorded`, and the `state` of EVERY row
// (id -> state), so a row appearing, vanishing or changing colour fails here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { requires } from './helpers/requires'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let ch: typeof import('../src/core/capture-health')
let hooksMod: typeof import('../src/core/hooks-manager')
let pluginsIndex: typeof import('../src/core/plugins/index')

let dbAvailable = false
if (requires('better-sqlite3').ok) {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  ch = await import('../src/core/capture-health')
  hooksMod = await import('../src/core/hooks-manager')
  pluginsIndex = await import('../src/core/plugins/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  dbAvailable = true
}
const describeDB = dbAvailable ? describe : describe.skip

const ins = (agentType: string, data: Record<string, unknown>) =>
  insertEventRaw(agentType, data, { operatorId: 'op' })

type Hook = ReturnType<typeof hooksMod.detectHooks>[number]
const hook = (id: string, installed: boolean, extra: Partial<Hook> = {}): Hook => ({
  id, name: id, description: '', agentType: 'shell',
  installed, available: true, installMethod: 'shell-source' as const, hookFile: '', ...extra
}) as Hook
function mockHooks(list: Hook[]): void {
  ch.invalidateHooksCache()
  vi.spyOn(hooksMod, 'detectHooks').mockReturnValue(list)
}

/** What a reader of the payload sees: the two whole-capture fields and one
 *  state per row. */
function read() {
  const h = ch.getCaptureHealth()
  return {
    verdict: h.verdict,
    hasRecorded: h.hasRecorded,
    states: Object.fromEntries(h.sources.map((s) => [s.id, s.state])),
    health: h
  }
}

// A machine with nothing configured and no events. Rows that exist regardless
// of the combination; only the ones a case changes are written out below.
const BASE_STATES = {
  terminal: 'ready',
  'agent-claude-code': 'off',
  'agent-codex': 'off',
  mitmproxy: 'ready',
  'browser-console': 'ready',
  'connection-monitor': 'off',
  screenshot: 'ready',
  'process-monitor': 'off',
  'file-watcher': 'off'
}

describeDB('capture payload golden (Spec 075 T004)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-golden-')); initDB(tmp)
    vi.spyOn(os, 'homedir').mockReturnValue(tmp)
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      [active('pack-host-monitors'), active('pack-windows-output')]
    )
    ch.configureCaptureHealth({})
    ch.configureCapturePrerequisites(null)
    ch.configureManagedProxyHealth(() => undefined)
    ch.clearSampleBroken()
  })
  afterEach(() => {
    ch.configureManagedProxyHealth(() => undefined)
    ch.configureCapturePrerequisites(null)
    ch.clearSampleBroken()
    closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks()
  })

  const typed = (zshOk = true) => {
    mockHooks([hook('shell-zsh', true, { available: zshOk }), hook('shell-bash', false)])
    ins('shell', { subtype: 'command_start', command: 'nmap 10.0.0.1', shell: 'zsh', source: 'auto-relay' })
  }

  it('1. new project, no hook installed, no events: dark (FR-015 calls this wrong; T010)', () => {
    mockHooks([hook('shell-zsh', false), hook('shell-bash', false)])
    const r = read()
    expect(r.verdict).toBe('dark')
    expect(r.hasRecorded).toBe(false)
    expect(r.states).toEqual(BASE_STATES)
  })

  it('2. hook installed, nothing typed yet: healthy, same rows', () => {
    mockHooks([hook('shell-zsh', true), hook('shell-bash', false)])
    const r = read()
    expect(r.verdict).toBe('healthy')
    expect(r.hasRecorded).toBe(false)
    expect(r.states).toEqual(BASE_STATES)
  })

  it('3. hook installed but python3 missing (shell-zsh unavailable): still healthy, terminal ready (04-U6a; T011)', () => {
    mockHooks([hook('shell-zsh', true, { available: false }), hook('shell-bash', false)])
    const r = read()
    expect(r.verdict).toBe('healthy')
    expect(r.states).toEqual(BASE_STATES)
  })

  it('4. managed proxy failed to start: partial, and no row says so', () => {
    typed()
    ch.configureManagedProxyHealth(() => ({
      state: 'failed', url: null, error: 'port in use',
      errorReason: { code: 'port-in-use', address: '127.0.0.1:8080', holder: null }
    }))
    const r = read()
    expect(r.verdict).toBe('partial')
    expect(r.hasRecorded).toBe(true)
    // The failure is a field beside the rows, not a state on any row.
    expect(r.states).toEqual(BASE_STATES)
    expect(r.health.managedHttpProxy?.state).toBe('failed')
  })

  it('5. plugin disabled but its events and heartbeat still arrive: row ready, flagged disabled, verdict healthy (T011)', () => {
    mockHooks([
      hook('shell-zsh', true),
      hook('pcap-capture.pcap-tcpdump', false, { agentType: 'scanner', emits: ['packet_flow'], installMethod: 'manual', disabled: true } as Partial<Hook>)
    ])
    ins('shell', { subtype: 'command_start', command: 'x', shell: 'zsh', source: 'auto-relay' })
    ins('scanner', { subtype: 'packet_flow', src: '10.0.0.5', dst: '10.0.0.9' })
    ins('system', { subtype: 'producer_heartbeat', producer: 'pcap-capture' })
    const r = read()
    expect(r.verdict).toBe('healthy')
    expect(r.states).toEqual({ ...BASE_STATES, 'pcap-capture.pcap-tcpdump': 'ready' })
    const row = r.health.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(row).toMatchObject({ disabled: true, running: true, informational: true })
  })

  it('6. AI tool configured with a relative transcript path: installed, silently off, verdict healthy (04-U4)', async () => {
    mockHooks([hook('shell-zsh', true)])
    const { createOfficialAgentPluginManager } = await import('../src/core/plugins/official-agents')
    const manager = createOfficialAgentPluginManager(path.join(tmp, '.redlog', 'plugins'))
    manager.install('claude-code')
    const receipt = manager.list().find((p) => p.agentKind === 'claude-code')!.installationId
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      [active('official-ai-claude-code'), active('pack-host-monitors'), active('pack-windows-output')]
    )
    ch.invalidateHooksCache()
    ch.configureCaptureHealth({
      agentTailer: { sources: { 'claude-code': { enabled: true, installationId: receipt, workPaths: [tmp], startedAt: 1000, sourceRoot: 'relative/dir' } } }
    })
    const r = read()
    expect(r.verdict).toBe('healthy')
    expect(r.states).toEqual(BASE_STATES)
    expect(r.health.sources.find((s) => s.id === 'agent-claude-code')).toMatchObject({ installed: true, enabled: false, state: 'off' })
  })

  it('7. HTTPS rejected by the client (unverified): the proxy is running and nothing in the payload degrades', () => {
    typed()
    ch.configureManagedProxyHealth(() => ({
      state: 'running', url: 'http://127.0.0.1:8080', certReady: true,
      httpsVerification: { scheme: 'https', rejected: true, receivedAt: Date.now() }
    }))
    const r = read()
    expect(r.verdict).toBe('healthy')
    expect(r.hasRecorded).toBe(true)
    expect(r.states).toEqual(BASE_STATES)
  })

  it('8. chain sample broken: dark even though every row is fine', () => {
    typed()
    ch.noteSampleBroken({ eventId: 'e1', reason: 'hash mismatch' })
    const r = read()
    expect(r.verdict).toBe('dark')
    expect(r.hasRecorded).toBe(true)
    expect(r.states).toEqual(BASE_STATES)
    expect(r.health.lastSampleBroken?.eventId).toBe('e1')
  })
})
