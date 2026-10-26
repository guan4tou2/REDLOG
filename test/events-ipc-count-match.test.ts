import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery } from '../src/core/query/contract'
import type { ActivityPage } from '../src/core/activity-contract'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
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
    const ctx = { getActiveProject: () => active, getCurrentEngagementId: () => active?.id ?? null } as unknown as IpcContext
    registerEventsIpc(ipcMain as never, ctx)
    fx = seedTimelineFixture({ total: 60, newestShell: 10 })
  })

  afterEach(() => {
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not read saved content after the active project changes', () => {
    const eventId = fx.rows.find(r => r.agentType === 'shell')!.id
    const reply = handlers.get('content:list')?.({}, {projectId:'eng-1',eventId}) as {ok:boolean;value:Array<{ref:unknown}>}
    expect(reply.ok).toBe(true)
    active = {...active!,id:'other-project'}
    expect(handlers.get('content:list')?.({}, {projectId:'eng-1',eventId})).toMatchObject({ok:false,status:'denied'})
    expect(handlers.get('content:read')?.({}, {ref:reply.value[0]?.ref})).toMatchObject({ok:false,status:'denied'})
    active = null
    expect(handlers.get('content:find')?.({}, {ref:reply.value[0]?.ref,needle:'test'})).toMatchObject({ok:false,status:'denied'})
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
  it('binds Activity pages and source references to the active project', () => {
    const parsed = parseQuery(''); if (!parsed.ok) throw new Error('fixture')
    const req = { projectId: 'eng-1', parsed: parsed.parsed, limit: 1 }
    const page = handlers.get('events:activityPage')?.({}, req) as ActivityPage
    expect(page.items).toHaveLength(1)
    const detail = { ...req, ref: page.items[0], snapshot: page.snapshot }
    expect(handlers.get('events:activityMembers')?.({}, detail)).toMatchObject({ sourceCount: 1 })
    active = { ...active!, id: 'other-project' }
    expect(() => handlers.get('events:activityPage')?.({}, req)).toThrow(/project/i)
    expect(() => handlers.get('events:activityMembers')?.({}, detail)).toThrow(/project/i)
    active = null
    expect(() => handlers.get('events:activityPage')?.({}, req)).toThrow(/project/i)
  })

  it('uses the active scope for Activity matches and totals', () => {
    const parsed = parseQuery(''); if (!parsed.ok) throw new Error('fixture')
    const req = { projectId: 'eng-1', parsed: parsed.parsed, filter: { inScopeOnly: true, scope: { targets: ['*'], excludeTargets: [] } } }
    const page = handlers.get('events:activityPage')?.({}, req) as ActivityPage
    expect(page.totalMatches).toBe(fx.rows.filter(r => r.targetId === null || r.targetId === '10.0.0.5').length)
  })

})
