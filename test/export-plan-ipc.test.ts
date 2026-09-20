import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))

import { initDB, closeDB, getDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import type { IpcContext } from '../src/main/ipc/types'
import type { ProjectMeta } from '../src/core/project-manager'
import { ExportPlanRegistry } from '../src/core/export-plan'
import { addExportEvent as addEvent } from './helpers/export-fixtures'

type Handler = (_event: unknown, input?: never) => unknown

describe('export plan IPC contract', () => {
  let dir: string
  let active: ProjectMeta | null
  let handlers: Map<string, Handler>
  let now: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plan-ipc-'))
    initDB(dir)
    active = { id: 'eng-1', name: 'Test', path: dir, createdAt: 1, lastOpened: 1 }
    handlers = new Map()
    now = Date.now()
    const ipcMain = { handle: (name: string, fn: Handler) => { handlers.set(name, fn) } }
    const ctx = {
      getActiveProject: () => active,
      getMainWindow: () => null,
      getOverlayWindow: () => null,
      getCurrentEngagementId: () => active?.id ?? null,
      getCurrentOperatorId: () => null,
      send: () => undefined,
      triggerBookmark: () => undefined,
      triggerInstantMark: () => ({ ok: false })
    } as unknown as IpcContext
    registerDataExportIpc(ipcMain as never, ctx, { planRegistry: new ExportPlanRegistry({ now: () => now }) })
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns an explicit failure when no project is active', () => {
    active = null
    expect(handlers.get('data:resolveExportPlan')?.({}, { format: 'json' } as never)).toEqual({
      ok: false,
      error: 'no-active-project'
    })
  })

  it('executes JSON from the approved snapshot and reports matching identity/counts', () => {
    addEvent('events', 'before-a', 1000)
    addEvent('events_logged', 'before-b', 1001)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'json' } as never) as {
      ok: true
      plan: { id: string; fingerprint: string; counts: { included: number } }
    }
    expect(resolved.ok).toBe(true)
    expect(resolved.plan.counts.included).toBe(2)

    addEvent('events', 'after-preview', 2000)
    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as {
      ok: true
      artifactPath: string
      planId: string
      fingerprint: string
      counts: { included: number }
    }
    expect(executed).toMatchObject({
      ok: true,
      planId: resolved.plan.id,
      fingerprint: resolved.plan.fingerprint,
      counts: { included: 2 }
    })
    const artifact = JSON.parse(fs.readFileSync(executed.artifactPath, 'utf8')) as { events: Array<{ id: string }> }
    expect(artifact.events.map((event) => event.id).sort()).toEqual(['before-a', 'before-b'])
    const manifest = JSON.parse(fs.readFileSync(`${executed.artifactPath}.manifest.json`, 'utf8')) as {
      exportPlan: { id: string; fingerprint: string; snapshot: unknown }
      actualCounts: { included: number }
    }
    expect(manifest).toMatchObject({
      exportPlan: { id: resolved.plan.id, fingerprint: resolved.plan.fingerprint },
      actualCounts: { included: 2 }
    })
    expect(handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never)).toMatchObject({
      ok: false,
      error: 'plan-already-used'
    })
  })

  it('executes NDJSON from the approved snapshot', () => {
    addEvent('events', 'ndjson-before', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'ndjson' } as never) as { ok: true; plan: { id: string } }
    addEvent('events_logged', 'ndjson-after', 2000)
    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as { ok: true; artifactPath: string }
    const content = fs.readFileSync(executed.artifactPath, 'utf8')
    expect(content).toContain('ndjson-before')
    expect(content).not.toContain('ndjson-after')
  })

  it('does not execute an approved plan after the active project changes', () => {
    addEvent('events', 'before-a', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'ndjson' } as never) as { ok: true; plan: { id: string } }
    active = { ...active!, id: 'eng-2' }
    expect(handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never)).toMatchObject({
      ok: false,
      error: 'project-changed'
    })
  })

  it('returns plan-expired and writes no artifact after the approval lifetime', () => {
    addEvent('events', 'expiring', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'json' } as never) as {
      ok: true; plan: { id: string; expiresAt: number }
    }
    now = resolved.plan.expiresAt + 1
    expect(handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never)).toMatchObject({
      ok: false,
      error: 'plan-expired'
    })
    expect(fs.existsSync(path.join(dir, 'exports'))).toBe(false)
  })

  it('rejects execution when approved evidence disappears', () => {
    addEvent('events', 'will-disappear', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'json' } as never) as { ok: true; plan: { id: string } }
    // Simulate retention/corruption below the normal append-only guard; the
    // exporter must still refuse to claim the previewed artifact was written.
    getDB().exec('DROP TRIGGER no_delete_events')
    getDB().prepare('DELETE FROM events WHERE id = ?').run('will-disappear')
    expect(handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never)).toMatchObject({
      ok: false,
      error: 'source-unavailable'
    })
    expect(fs.existsSync(path.join(dir, 'exports'))).toBe(false)
  })

  it('rejects a requested protection that the selected format cannot apply', () => {
    const resolved = handlers.get('data:resolveExportPlan')?.({}, {
      format: 'bundle',
      sharing: true
    } as never)
    expect(resolved).toMatchObject({ ok: false, error: expect.stringContaining('unsupported-policy') })
  })

  it('writes bundle rows and manifest from the approved plan selection', () => {
    addEvent('events', 'bundle-before', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'bundle' } as never) as {
      ok: true; plan: { id: string; fingerprint: string }
    }
    addEvent('events_logged', 'bundle-after', 2000)
    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as {
      ok: true; artifactPath: string
    }
    expect(executed.ok).toBe(true)
    const chained = fs.readFileSync(path.join(executed.artifactPath, 'events.jsonl'), 'utf8')
    const logged = fs.readFileSync(path.join(executed.artifactPath, 'events_logged.jsonl'), 'utf8')
    expect(chained).toContain('bundle-before')
    expect(logged).not.toContain('bundle-after')
    const manifest = JSON.parse(fs.readFileSync(path.join(executed.artifactPath, 'manifest.json'), 'utf8')) as {
      exportPlan: { id: string; fingerprint: string }
    }
    expect(manifest.exportPlan).toMatchObject({ id: resolved.plan.id, fingerprint: resolved.plan.fingerprint })
  })

  it('keeps HAR inside the approved target, time and snapshot bounds', () => {
    addEvent('events_logged', 'req-before', 1000, { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: 'f1', method: 'GET', url: 'https://example.test/a' } })
    addEvent('events_logged', 'res-before', 1100, { agentType: 'scanner', subtype: 'http_response', data: { flow_id: 'f1', status: 200 } })
    const resolved = handlers.get('data:resolveExportPlan')?.({}, {
      format: 'har', subset: { kind: 'time-range', since: 900, before: 1500, targetId: 'example.test' }
    } as never) as { ok: true; plan: { id: string } }
    addEvent('events_logged', 'req-after', 1200, { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: 'f2', method: 'GET', url: 'https://example.test/b' } })
    addEvent('events_logged', 'res-after', 1300, { agentType: 'scanner', subtype: 'http_response', data: { flow_id: 'f2', status: 201 } })

    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as { ok: true; artifactPath: string }
    const har = JSON.parse(fs.readFileSync(executed.artifactPath, 'utf8')) as { log: { entries: Array<{ request: { url: string } }> } }
    expect(har.log.entries.map((entry) => entry.request.url)).toEqual(['https://example.test/a'])
  })

  it('keeps Timeline slice inside the approved time and snapshot bounds', () => {
    addEvent('events', 'timeline-before', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, {
      format: 'timeline', subset: { kind: 'time-range', since: 900, before: 1500 }
    } as never) as { ok: true; plan: { id: string } }
    addEvent('events', 'timeline-after', 1200)

    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as { ok: true; artifactPath: string }
    const content = fs.readFileSync(executed.artifactPath, 'utf8')
    expect(content).toContain('timeline-before')
    expect(content).not.toContain('timeline-after')
  })
})
