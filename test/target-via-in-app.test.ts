// Spec 071: an in-app action is the operator's act on the target they have
// selected, so main reads the selection at that moment and hands it to the
// writer as `operator-selected`. With nothing selected the row has no target.
// A row a tool or a timer writes takes no part in it: the selection reaches
// ingest through no other door.
//
// The HUD marker is a direct insertEvent in main/index.ts (not importable
// here): it is checked at the call and by its source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showOpenDialog: vi.fn() }
}))

import { initDB, closeDB, getDB } from '../src/core/db/index'
import { insertEvent } from '../src/core/db/events'
import { _resetIngest, ingest } from '../src/core/ingest'
import { LEGACY_API } from '../src/core/ingest/stamp'
import { loadConfig } from '../src/core/config'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import { registerArtifactsIpc } from '../src/main/ipc/artifacts'
import { operatorSelectedTarget } from '../src/main/ipc/target-context'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

const stored = (agent: string): Array<{ target: string | null; via: string }> =>
  (getDB().prepare('SELECT target_id, data FROM events WHERE agent_type = ? ORDER BY rowid').all(agent) as Array<{ target_id: string | null; data: string }>)
    .map((r) => ({ target: r.target_id, via: (JSON.parse(r.data) as { _ingest: { target_via: string } })._ingest.target_via }))

describe('in-app actions pass the selected target', () => {
  let dir: string
  let loot: string
  let handlers: Map<string, Handler>
  const captures: Array<{ trigger: string; opts: Record<string, unknown> }> = []
  const select = (target: string | null): void => {
    fs.writeFileSync(path.join(dir, 'config.yaml'),
      `engagement:\n  id: eng-1\n${target ? `  activeTarget: ${target}\n` : ''}operator:\n  id: op-1\n`)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-via-app-'))
    loot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-via-loot-'))
    fs.writeFileSync(path.join(loot, 'hashes.txt'), 'admin:aad3b435')
    select(null)
    initDB(dir)
    _resetIngest()
    captures.length = 0
    handlers = new Map()
    const ctx = {
      getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }),
      getMainWindow: () => ({})
    } as unknown as IpcContext
    const ipc = { handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never
    const agent = { captureNow: (trigger: string, _cause: unknown, opts: Record<string, unknown>) => { captures.push({ trigger, opts }); return Promise.resolve('/x.jpg') } }
    registerMarkersIpc(ipc, ctx, agent as never)
    registerArtifactsIpc(ipc, ctx)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(loot, { recursive: true, force: true })
  })

  it('marker:create with no target of its own takes the selected one; a transcript step keeps its own (explicit)', () => {
    select('10.10.11.24')
    const create = handlers.get('marker:create')!
    create({}, { title: 'from the toolbar' })
    create({}, { title: 'from a step', targetId: '10.0.0.5' })
    expect(stored('marker')).toEqual([
      { target: '10.10.11.24', via: 'operator-selected' },
      { target: '10.0.0.5', via: 'explicit' }
    ])
  })

  it('marker:create with nothing selected has no target', () => {
    handlers.get('marker:create')!({}, { title: 'unselected' })
    expect(stored('marker')).toEqual([{ target: null, via: 'none' }])
  })

  it('a selection read from the config at the moment of the action: change it and the next marker follows', () => {
    const create = handlers.get('marker:create')!
    select('a.example'); create({}, { title: '1' })
    select('b.example'); create({}, { title: '2' })
    select(null); create({}, { title: '3' })
    expect(stored('marker').map((r) => r.target)).toEqual(['a.example', 'b.example', null])
  })

  it('screenshot:capture hands the selected target to the agent, and nothing when none is selected', async () => {
    select('10.10.11.24')
    await handlers.get('screenshot:capture')!({}, undefined, {})
    select(null)
    await handlers.get('screenshot:capture')!({}, undefined, {})
    expect(captures.map((c) => [c.trigger, c.opts.targetId])).toEqual([['manual', '10.10.11.24'], ['manual', undefined]])
  })

  it('an added file takes the selected target', async () => {
    select('10.10.11.24')
    const r = await handlers.get('artifacts:addDropped')!({}, [path.join(loot, 'hashes.txt')], { title: 't', message: 'm', confirm: 'y', cancel: 'n' }) as { results: Array<{ ok: boolean }> }
    expect(r.results[0].ok).toBe(true)
    expect(stored('file_transfer')).toEqual([{ target: '10.10.11.24', via: 'operator-selected' }])
  })

  it('an added file with nothing selected has no target', async () => {
    await handlers.get('artifacts:addDropped')!({}, [path.join(loot, 'hashes.txt')], { title: 't', message: 'm', confirm: 'y', cancel: 'n' })
    expect(stored('file_transfer')).toEqual([{ target: null, via: 'none' }])
  })

  it('the HUD marker\'s insert, as main writes it, takes the selected target', () => {
    select('10.10.11.24')
    const open = { engagementId: 'eng-1', operatorId: 'op-1' }
    insertEvent('marker', { title: 'HUD mark', severity: 'info', category: 'custom' }, { ...open, ...operatorSelectedTarget(loadConfig(dir)) })
    select(null)
    insertEvent('marker', { title: 'HUD mark 2', severity: 'info', category: 'custom' }, { ...open, ...operatorSelectedTarget(loadConfig(dir)) })
    expect(stored('marker')).toEqual([{ target: '10.10.11.24', via: 'operator-selected' }, { target: null, via: 'none' }])
  })

  it('main\'s HUD marker and screenshot shortcut read the selection (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const hud = src.slice(src.indexOf('function addHudMarker'), src.indexOf('const WINDOW_STATE_PATH'))
    expect(hud).toContain('operatorSelectedTarget(')
    const shortcut = src.slice(src.indexOf('globalShortcut.register(QUICK_SHOT_ACCELERATOR'), src.indexOf('// --- Updates ---'))
    expect(shortcut).toContain('operatorSelectedTarget(')
    expect(shortcut).toContain("captureNow('manual'")
  })

  describe('rows no in-app action writes take no target from the selection', () => {
    it('a marker sent to /api/marker without a target (redlog-cli mark, the shell agent) has none', () => {
      select('10.10.11.24')
      ingest({ agentType: 'marker', data: { title: 'mark', severity: 'info', category: 'external' }, engagementId: 'eng-1', operatorId: 'op-1', entrance: LEGACY_API })
      expect(stored('marker')).toEqual([{ target: null, via: 'none' }])
    })

    it('a host-less shell command and a built-in terminal session row have none', () => {
      select('10.10.11.24')
      const who = { engagementId: 'eng-1', operatorId: 'op-1' }
      ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1' }, ...who })
      ingest({ agentType: 'shell', data: { subtype: 'session_start', terminalId: 't1', source: 'builtin-terminal' }, ...who })
      ingest({ agentType: 'shell', data: { subtype: 'session_output', terminalId: 't1', stdout: 'hello\n', source: 'builtin-terminal' }, ...who })
      expect(stored('shell').map((r) => r.target)).toEqual([null, null, null])
    })
  })
})
