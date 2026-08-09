import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getCaptureHealth: typeof import('../src/core/capture-health').getCaptureHealth
let configureCaptureHealth: typeof import('../src/core/capture-health').configureCaptureHealth
let invalidateHooksCache: typeof import('../src/core/capture-health').invalidateHooksCache
let hooksMod: typeof import('../src/core/hooks-manager')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  const chMod = await import('../src/core/capture-health')
  hooksMod = await import('../src/core/hooks-manager')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  getCaptureHealth = chMod.getCaptureHealth
  configureCaptureHealth = chMod.configureCaptureHealth
  invalidateHooksCache = chMod.invalidateHooksCache
  dbAvailable = true
} catch { /* better-sqlite3 not built */ }

const describeDB = dbAvailable ? describe : describe.skip

const ins = (agentType: string, data: Record<string, unknown>) =>
  insertEventRaw(agentType, data, { operatorId: 'op' })

function mockHooks(installed: Record<string, boolean>): void {
  invalidateHooksCache()
  vi.spyOn(hooksMod, 'detectHooks').mockReturnValue(
    Object.entries(installed).map(([id, inst]) => ({
      id, name: id, description: '', agentType: 'shell',
      installed: inst, available: true, installMethod: 'shell-source' as const, hookFile: ''
    }))
  )
}

describeDB('capture-health', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cap-')); initDB(tmp) })
  afterEach(() => { closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('dark when no hooks installed and only system events exist', () => {
    mockHooks({ 'shell-zsh': false, 'shell-bash': false, 'claude-code': false })
    ins('system', { subtype: 'session_start' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('dark')
    expect(h.recording).toBe(false)
  })

  it('partial when a hook is installed but nothing has fed recently', () => {
    mockHooks({ 'shell-zsh': true, 'claude-code': false })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('partial') // wired but idle
    expect(h.sources.find((s) => s.id === 'shell-hook')?.state).toBe('idle')
  })

  it('healthy when a source produced an event within the active window', () => {
    mockHooks({ 'shell-zsh': true, 'claude-code': false })
    ins('shell', { subtype: 'command_start', command: 'nmap', source: 'zsh' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.recording).toBe(true)
    expect(h.sources.find((s) => s.id === 'shell-hook')?.state).toBe('active')
  })

  it('does not count builtin-terminal shell events as the shell hook', () => {
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('shell', { subtype: 'session_start', source: 'builtin-terminal' })
    const h = getCaptureHealth()
    const shell = h.sources.find((s) => s.id === 'shell-hook')
    expect(shell?.lastEventAt).toBeNull() // builtin terminal is a separate source
    const builtin = h.sources.find((s) => s.id === 'builtin-terminal')
    expect(builtin?.state).toBe('active')
  })

  // v0.9.7: the `claude-code` row is gone. That hook was retired in v0.7.3 —
  // the script is a no-op stub, its detectHooks() entry is commented out —
  // so the row could never report `installed` and rendered as a permanent
  // idle with an Install button that did nothing. Agent coverage now comes
  // from the transcript tailer, which sees every tool, not just Bash.
  it('reports agent activity through the tailer row, not a claude-code row', () => {
    mockHooks({ 'shell-zsh': false })
    ins('agent', { subtype: 'tool_call', tool_name: 'Bash' })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'claude-code')).toBeUndefined()
    expect(h.sources.find((s) => s.id === 'agent-tailer')?.state).toBe('active')
  })

  // v0.9.7: DNS and HTTP are the same addon (hooks/mitmproxy-addon.py),
  // switched by how mitmdump is run. One row, fed by either stream.
  it('folds DNS events into the mitmproxy row', () => {
    mockHooks({ 'shell-zsh': false })
    ins('dns', { subtype: 'dns_query', query: 'example.test' })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'dns')).toBeUndefined()
    expect(h.sources.find((s) => s.id === 'mitmproxy')?.state).toBe('active')
  })

  // v0.9.7: installation and activation are separate axes.
  it('reports a switched-off source as off, not idle', () => {
    mockHooks({ 'shell-zsh': false })
    configureCaptureHealth({ clipboard: { enabled: false }, fileWatcher: { enabled: true } })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'clipboard')?.state).toBe('off')
    expect(h.sources.find((s) => s.id === 'clipboard')?.enabled).toBe(false)
    // enabled-but-silent stays idle — that one is a real signal
    expect(h.sources.find((s) => s.id === 'file-watcher')?.state).toBe('idle')
  })

  it('a switched-off source does not drag the verdict to partial', () => {
    mockHooks({ 'shell-zsh': false })
    // Feed the monitor, then switch it off: previously "expected but silent"
    // pinned the verdict to partial forever after.
    ins('process', { subtype: 'process_spawn', command: 'bash' })
    ins('scanner', { subtype: 'http_request', url: 'https://x' })
    configureCaptureHealth({ processMonitor: { enabled: false } })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'process-monitor')?.state).toBe('off')
    expect(h.verdict).toBe('healthy')
  })

  it('recognises mitmproxy scanner events even though it has no install flag', () => {
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('scanner', { subtype: 'http_request', url: 'https://x' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.sources.find((s) => s.id === 'mitmproxy')?.state).toBe('active')
  })

  // v0.9.8: getCaptureHealth is cached for 750 ms — it runs eleven indexed
  // probes plus a hooks check, and is hit by the Dashboard poll, the
  // StatusBar, every REST /api/status and every agent calling redlog_status.
  // Anything that changes what it reports has to drop the cache, or the
  // readout lags behind the thing it is reporting on.
  it('a config change is visible immediately, not after the cache TTL', () => {
    mockHooks({ 'shell-zsh': false })
    configureCaptureHealth({ clipboard: { enabled: true } })
    expect(getCaptureHealth().sources.find((s) => s.id === 'clipboard')?.enabled).toBe(true)
    configureCaptureHealth({ clipboard: { enabled: false } })
    expect(getCaptureHealth().sources.find((s) => s.id === 'clipboard')?.enabled).toBe(false)
  })
})
