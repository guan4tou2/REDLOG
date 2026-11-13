// Spec 075 T010 + T011: three readings the spec says are WRONG today, written
// as the reading it says is right and marked `it.fails`. They document the
// gap and keep it honest: when Phase 2/3/5 changes the derivation, the
// `it.fails` flips to "unexpectedly passed", and whoever flipped it removes
// the marker in the same change. Today's (wrong) values are pinned by
// test/capture-payload-golden.test.ts; this file must never be "fixed" by
// editing production code in Phase 1.
//
// "Correct" is stated in today's vocabulary (`verdict`, per-row `state`),
// because that is all the payload has until Phase 2. Waiting-for-first-event
// does not exist yet, so FR-015 is asserted as "not dark, and the same as a
// machine that has a hook".
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
// T011's first case is about POSIX shells; Windows has no python3 requirement.
const itPosixFails = process.platform === 'win32' ? it.skip : it.fails

type Hook = ReturnType<typeof hooksMod.detectHooks>[number]
const hook = (id: string, installed: boolean, extra: Partial<Hook> = {}): Hook => ({
  id, name: id, description: '', agentType: 'shell',
  installed, available: true, installMethod: 'shell-source' as const, hookFile: '', ...extra
}) as Hook
function mockHooks(list: Hook[]): void {
  ch.invalidateHooksCache()
  vi.spyOn(hooksMod, 'detectHooks').mockReturnValue(list)
}

describeDB('source status: readings the spec calls wrong today (Spec 075 T010, T011)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-red-')); initDB(tmp)
    vi.spyOn(os, 'homedir').mockReturnValue(tmp)
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([active('pack-host-monitors'), active('pack-windows-output')])
    ch.configureCaptureHealth({})
  })
  afterEach(() => { closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks() })

  // T010 / FR-015, FR-017: a new project has simply not recorded yet.
  it.fails('T010: a new project with no hook is not dark (today: dark; capture-health.test.ts:65 pins that)', () => {
    mockHooks([hook('shell-zsh', false), hook('shell-bash', false)])
    expect(ch.getCaptureHealth().verdict).not.toBe('dark')
  })

  it.fails('T010: a new project reads the same whether or not this machine has a hook (today: dark vs healthy)', () => {
    mockHooks([hook('shell-zsh', false), hook('shell-bash', false)])
    const without = ch.getCaptureHealth().verdict
    mockHooks([hook('shell-zsh', true), hook('shell-bash', false)])
    const withHook = ch.getCaptureHealth().verdict
    expect(without).toBe(withHook)
  })

  // T011 / 04-U6a: python3 is what every POSIX hook and the pane adapter run.
  itPosixFails('T011: with python3 missing the built-in terminal is not ready (today: ready; alwaysPresent hides it)', () => {
    mockHooks([hook('shell-zsh', false, { available: false }), hook('shell-bash', false, { available: false })])
    const terminal = ch.getCaptureHealth().sources.find((s) => s.id === 'terminal')
    expect(terminal?.state).not.toBe('ready')
  })

  // T011 / decision-table F1 writing-while-off: a disabled plugin whose events keep
  // arriving is a failure, not a green row with a `disabled` flag.
  it.fails('T011: a disabled plugin that keeps delivering events is a failed source (today: ready)', () => {
    mockHooks([
      hook('shell-zsh', true),
      hook('pcap-capture.pcap-tcpdump', false, { agentType: 'scanner', emits: ['packet_flow'], installMethod: 'manual', disabled: true } as Partial<Hook>)
    ])
    insertEventRaw('scanner', { subtype: 'packet_flow', src: '10.0.0.5', dst: '10.0.0.9' }, { operatorId: 'op' })
    const row = ch.getCaptureHealth().sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(row?.disabled).toBe(true) // the fixture is what it claims to be
    expect(row?.state).toBe('error')
  })
})
