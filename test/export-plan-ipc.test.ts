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
import { addExportEvent as addEvent, addExportAttachment } from './helpers/export-fixtures'

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

  it('keeps selected IDs and integrity digests in the main process', () => {
    addEvent('events', 'private-plan-id', 1000)
    const resolved = handlers.get('data:resolveExportPlan')?.({}, { format: 'json' } as never) as {
      ok: true; plan: Record<string, unknown>
    }
    expect(resolved.ok).toBe(true)
    expect(resolved.plan).not.toHaveProperty('selectedEventIds')
    expect(resolved.plan).not.toHaveProperty('selectedEvidenceDigest')
    expect(resolved.plan).not.toHaveProperty('policyFingerprint')
    expect(JSON.stringify(resolved.plan)).not.toContain('private-plan-id')
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

  // #222: a session that moved between two targets. Exporting only target A
  // does not make its recording A-only, so the preview says the cast spans
  // both, and the operator can leave it out of this delivery.
  it('lists a cross-target cast, and leaves it out of the bundle when the operator does', () => {
    addExportAttachment(dir, 'casts/term-1.cast', 'A and B typed here')
    addExportAttachment(dir, 'casts/term-2.cast', 'A only')
    addEvent('events', 'on-a', 1000, { targetId: 'a.test', data: { terminalId: 't1', io: { stream: 'cast', ref: path.join(dir, 'casts', 'term-1.cast'), off: 0, len: 3 } } })
    addEvent('events', 'on-b', 1001, { targetId: 'b.test', data: { terminalId: 't1', io: { stream: 'cast', ref: path.join(dir, 'casts', 'term-1.cast'), off: 3, len: 3 } } })
    addEvent('events', 'only-a', 1002, { targetId: 'a.test', data: { terminalId: 't2', io: { stream: 'cast', ref: path.join(dir, 'casts', 'term-2.cast'), off: 0, len: 3 } } })

    type Plan = { id: string; fingerprint: string; request: { excludeAttachments: string[] }; counts: { attachmentsIncluded: number; attachmentsExcludedByOperator: number }; attachments: Array<{ id: string; targets: string[]; attribution: string; status: string }> }
    const first = handlers.get('data:resolveExportPlan')?.({}, { format: 'bundle' } as never) as { ok: true; plan: Plan }
    const cast = first.plan.attachments.find((a) => a.id === 'casts/term-1.cast')
    expect(cast).toMatchObject({ targets: ['a.test', 'b.test'], attribution: 'cross-target', status: 'included' })

    const second = handlers.get('data:resolveExportPlan')?.({}, { format: 'bundle', excludeAttachments: ['casts/term-1.cast'] } as never) as { ok: true; plan: Plan }
    expect(second.plan.fingerprint).not.toBe(first.plan.fingerprint)
    expect(second.plan.counts.attachmentsExcludedByOperator).toBe(1)
    expect(second.plan.counts.attachmentsIncluded).toBe(first.plan.counts.attachmentsIncluded - 1)
    expect(second.plan.attachments.find((a) => a.id === 'casts/term-1.cast')?.status).toBe('excluded-by-operator')

    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: second.plan.id } as never) as { ok: true; artifactPath: string }
    expect(executed.ok).toBe(true)
    expect(fs.existsSync(path.join(executed.artifactPath, 'casts', 'term-1.cast'))).toBe(false)
    expect(fs.existsSync(path.join(executed.artifactPath, 'casts', 'term-2.cast'))).toBe(true)
    // The original recording is never trimmed or deleted.
    expect(fs.readFileSync(path.join(dir, 'casts', 'term-1.cast'), 'utf8')).toBe('A and B typed here')
    const manifest = JSON.parse(fs.readFileSync(path.join(executed.artifactPath, 'manifest.json'), 'utf8')) as {
      attachments: { excludedByOperator: string[]; casts: Array<{ path: string; targets: string[]; attribution: string }> }
      files: Array<{ path: string }>
    }
    expect(manifest.attachments.excludedByOperator).toEqual(['casts/term-1.cast'])
    expect(manifest.attachments.casts).toEqual([{ path: 'casts/term-2.cast', targets: ['a.test'], attribution: 'target' }])
    expect(manifest.files.map((f) => f.path)).not.toContain('casts/term-1.cast')
  })

  it('uses the approved raw out-of-scope policy in both bundle preview and execution', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
      'engagement:',
      '  id: eng-1',
      'scope:',
      '  targets:',
      '    - allowed.test',
      '  excludeTargets: []',
      '  personalDomains: []'
    ].join('\n'))
    addEvent('events', 'outside', 1000, {
      targetId: 'outside.test',
      data: { command: 'curl https://outside.test/private' }
    })

    const resolved = handlers.get('data:resolveExportPlan')?.({}, {
      format: 'bundle', maskOutOfScope: false
    } as never) as { ok: true; plan: { id: string; counts: { maskedOutOfScope: number } } }
    expect(resolved.plan.counts.maskedOutOfScope).toBe(0)

    const executed = handlers.get('data:executeExportPlan')?.({}, {
      planId: resolved.plan.id
    } as never) as { ok: true; artifactPath: string }
    const row = JSON.parse(fs.readFileSync(path.join(executed.artifactPath, 'events.jsonl'), 'utf8').trim()) as { data: string }
    expect(JSON.parse(row.data).command).toBe('curl https://outside.test/private')
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
