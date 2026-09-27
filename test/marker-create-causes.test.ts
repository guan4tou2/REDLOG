// #225: a step picked in the transcript is a marker that cites the step's
// events and carries its target. The cited events are not touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({}))

import { initDB, closeDB } from '../src/core/db/index'
import { insertEvent, queryEventById } from '../src/core/db/events'
import { _resetIngest } from '../src/core/ingest'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

describe('marker:create with causes', () => {
  let dir: string
  let handlers: Map<string, Handler>
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-marker-causes-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n')
    initDB(dir)
    _resetIngest()
    handlers = new Map()
    const ctx = { getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }) } as unknown as IpcContext
    registerMarkersIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ctx, {} as never)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stores the cited events and the step target, leaving the step as it was', () => {
    const step = insertEvent('shell', { subtype: 'command_end', command: 'whoami', stdout: 'root' }, { engagementId: 'eng-1', operatorId: 'op-1', targetId: '10.0.0.5' })!
    const before = JSON.stringify(queryEventById(step.id))
    const marker = handlers.get('marker:create')!({}, {
      title: 'Key step: whoami', category: 'key_step', atTimestamp: step.timestamp,
      causes: [step.id, 42, step.id], targetId: '10.0.0.5'
    }) as { id: string; targetId: string | null; data: Record<string, unknown> }
    expect(marker.data._causes).toEqual([step.id])
    expect(marker.data.category).toBe('key_step')
    expect(marker.targetId).toBe('10.0.0.5')
    expect(JSON.stringify(queryEventById(step.id))).toBe(before)
  })

  it('creates a plain marker unchanged when no causes are given', () => {
    const marker = handlers.get('marker:create')!({}, { title: 'note' }) as { data: Record<string, unknown> }
    expect(marker.data._causes).toBeUndefined()
  })
})
