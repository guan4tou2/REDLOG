import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getCaptureHealth: typeof import('../src/core/capture-health').getCaptureHealth
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

  it('recognises the Claude Code hook by its claude_code_bash subtype', () => {
    mockHooks({ 'claude-code': true, 'shell-zsh': false })
    ins('agent', { subtype: 'claude_code_bash', command: 'ls' })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'claude-code')?.state).toBe('active')
  })

  it('recognises mitmproxy scanner events even though it has no install flag', () => {
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('scanner', { subtype: 'http_request', url: 'https://x' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.sources.find((s) => s.id === 'mitmproxy')?.state).toBe('active')
  })
})
