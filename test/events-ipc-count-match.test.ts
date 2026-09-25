import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db/index'
import { loadConfig, saveConfig } from '../src/core/config'
import { registerEventsIpc } from '../src/main/ipc/events'
import type { IpcContext } from '../src/main/ipc/types'
import type { ProjectMeta } from '../src/core/project-manager'
import { seedTimelineFixture, type TimelineFixture } from './helpers/timeline-query-fixture'

type Handler = (_event: unknown, input?: unknown) => unknown

// contracts/ipc.md: the two channels the Timeline reads its total and its
// matches through. They take the active project's scope from main, the way
// every other event channel does, so a renderer can narrow a result but
// never widen it past the project's scope.
describe('events:count and events:matchIds', () => {
  let dir: string
  let active: ProjectMeta | null
  let handlers: Map<string, Handler>
  let fx: TimelineFixture

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-038-ipc-'))
    initDB(dir)
    const config = loadConfig(dir)
    saveConfig(dir, { ...config, scope: { ...config.scope, targets: ['10.0.0.5'], excludeTargets: [] } })
    active = { id: 'eng-1', name: 'Test', path: dir, createdAt: 1, lastOpened: 1 }
    handlers = new Map()
    const ipcMain = { handle: (name: string, fn: Handler) => { handlers.set(name, fn) } }
    const ctx = { getActiveProject: () => active } as unknown as IpcContext
    registerEventsIpc(ipcMain as never, ctx)
    fx = seedTimelineFixture({ total: 60, newestShell: 10 })
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns its empty shape without an active project', () => {
    active = null
    expect(handlers.get('events:count')?.({}, { filter: {} })).toBe(0)
    expect(handlers.get('events:matchIds')?.({}, { ids: ['fx-1'] })).toEqual([])
  })

  it('counts with the project scope attached, not one the renderer sent', () => {
    const inScope = fx.rows.filter((r) => r.targetId === null || r.targetId === '10.0.0.5').length
    // A renderer-supplied scope that would admit everything is replaced.
    const sent = { filter: { inScopeOnly: true, scope: { targets: ['*'], excludeTargets: [] } } }
    expect(handlers.get('events:count')?.({}, sent)).toBe(inScope)
  })

  it('matches ids with the project scope attached', () => {
    const ids = fx.rows.map((r) => r.id)
    const admitted = handlers.get('events:matchIds')?.({}, { ids, filter: { inScopeOnly: true } }) as string[]
    expect(admitted.length).toBeGreaterThan(0)
    for (const id of admitted) {
      const target = fx.rows.find((r) => r.id === id)?.targetId
      expect(target === null || target === '10.0.0.5').toBe(true)
    }
  })

  it('rejects more than 1000 ids instead of truncating', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `x-${i}`)
    expect(() => handlers.get('events:matchIds')?.({}, { ids })).toThrow('at most 1000 ids')
  })
})
