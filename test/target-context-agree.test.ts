// Spec 071: the Targets page and the in-app actions read one selection, the
// target of the config applied to the open project (IpcContext.getSelectedTarget),
// and "Work on this" repairs a file that disagrees with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({}))

import { initDB, closeDB } from '../src/core/db/index'
import { _resetIngest } from '../src/core/ingest'
import { registerTargetContextIpc } from '../src/main/ipc/target-context'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

describe('targetContext get/set against the applied selection', () => {
  let dir: string
  let handlers: Map<string, Handler>
  let applied: string | null
  let committed: Array<string | null>
  let sent: unknown[]
  const writeFile = (target: string | null): void => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), `engagement:\n  id: eng-1\n${target ? `  activeTarget: ${target}\n` : ''}operator:\n  id: op-1\n`)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-target-agree-'))
    writeFile(null)
    initDB(dir)
    _resetIngest()
    applied = null; committed = []; sent = []
    handlers = new Map()
    const ctx = {
      getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }),
      getCurrentEngagementId: () => 'eng-1', getCurrentOperatorId: () => 'op-1',
      getSelectedTarget: () => applied,
      getMainWindow: () => ({}), getOverlayWindow: () => null,
      send: (_w: unknown, channel: string, t: unknown) => { sent.push([channel, t]) }
    } as unknown as IpcContext
    registerTargetContextIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ctx, {
      commit: (next) => { committed.push(next.engagement.activeTarget ?? null); applied = next.engagement.activeTarget ?? null; writeFile(applied); return true }
    })
  })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('get answers what actions use (the applied selection), not what the file says', () => {
    writeFile('from-file.example'); applied = 'applied.example'
    expect(handlers.get('targetContext:get')!({})).toBe('applied.example')
    applied = null
    expect(handlers.get('targetContext:get')!({})).toBeNull()
  })

  it('set to the target the file already holds, while the applied selection differs, re-commits it', () => {
    writeFile('t.example'); applied = null
    const r = handlers.get('targetContext:set')!({}, 't.example')
    expect(r).toEqual({ ok: true, target: 't.example' })
    expect(committed).toEqual(['t.example'])
    expect(applied).toBe('t.example')
    expect(sent).toContainEqual(['targetContext:changed', 't.example'])
  })

  it('set to what both already hold changes nothing', () => {
    writeFile('t.example'); applied = 't.example'
    expect(handlers.get('targetContext:set')!({}, 't.example')).toEqual({ ok: true, target: 't.example' })
    expect(committed).toEqual([])
    expect(sent).toEqual([])
  })
})
