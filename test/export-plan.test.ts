import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  ExportPlanRegistry,
  countExportAttachments,
  countReferencedAttachments,
  createExportPlan,
  normalizeExportRequest,
  type ExportCounts,
  type ExportSnapshot
} from '../src/core/export-plan'
import { capabilitiesFor } from '../src/core/export-capabilities'

const snapshot: ExportSnapshot = { chainedMaxRowId: 12, loggedMaxRowId: 7, takenAt: 1000 }
const counts: ExportCounts = {
  examined: 19,
  included: 15,
  excludedDoNotExport: 1,
  excludedPersonal: 1,
  excludedBlacklist: 0,
  maskedOutOfScope: 2,
  sanitized: 3,
  attachmentsIncluded: 2,
  attachmentsMissing: 1,
  attachmentsUnattributed: 0,
  unsupported: 0
}

describe('ExportPlan domain contract', () => {
  it('normalizes sharing protections and rejects invalid time bounds', () => {
    expect(normalizeExportRequest({ format: 'json', sharing: true })).toMatchObject({
      format: 'json',
      sharing: true,
      scrubPii: true,
      subset: { kind: 'all' }
    })
    expect(() => normalizeExportRequest({
      format: 'timeline',
      subset: { kind: 'time-range', since: 20, before: 10 }
    })).toThrow(/time range/i)
  })

  it('declares format capability gaps instead of implying protections', () => {
    expect(capabilitiesFor('bundle')).toMatchObject({ attachments: true, snapshot: true, scopeMasking: true })
    expect(capabilitiesFor('har')).toMatchObject({ attachments: false, snapshot: true, scopeMasking: false })
  })

  it('creates a frozen plan with a deterministic evidence fingerprint', () => {
    const input = {
      projectId: 'eng-1',
      request: normalizeExportRequest({ format: 'json', sharing: true }),
      snapshot,
      scopeSnapshot: { targets: ['example.test'], excludeTargets: [], personalDomains: [] },
      counts,
      selectedEventIds: ['b', 'a']
    }
    const first = createExportPlan(input, { id: 'plan-a', now: 2000, ttlMs: 5000 })
    const second = createExportPlan({ ...input, selectedEventIds: ['a', 'b'] }, { id: 'plan-b', now: 2000, ttlMs: 5000 })

    expect(first.id).toBe('plan-a')
    expect(first.expiresAt).toBe(7000)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.request)).toBe(true)
  })

  it('expires plans, binds them to a project and permits one successful claim', () => {
    let now = 2000
    const registry = new ExportPlanRegistry({ now: () => now, maxPlans: 2 })
    const plan = createExportPlan({
      projectId: 'eng-1',
      request: normalizeExportRequest({ format: 'ndjson' }),
      snapshot,
      scopeSnapshot: { targets: [], excludeTargets: [], personalDomains: [] },
      counts,
      selectedEventIds: ['a']
    }, { id: 'plan-a', now, ttlMs: 100 })

    registry.put(plan)
    expect(registry.claim('plan-a', 'other')).toMatchObject({ ok: false, error: 'project-changed' })
    expect(registry.claim('plan-a', 'eng-1')).toMatchObject({ ok: true, plan: { id: 'plan-a' } })
    expect(registry.claim('plan-a', 'eng-1')).toMatchObject({ ok: false, error: 'plan-already-used' })

    const expiring = createExportPlan({ ...plan, selectedEventIds: ['b'] }, { id: 'plan-b', now, ttlMs: 100 })
    registry.put(expiring)
    now = 2200
    expect(registry.claim('plan-b', 'eng-1')).toMatchObject({ ok: false, error: 'plan-expired' })
  })

  it('counts attachment files, missing refs and unattributed sidecars separately', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plan-files-'))
    fs.mkdirSync(path.join(dir, 'screenshots'))
    fs.mkdirSync(path.join(dir, 'http-bodies'))
    fs.mkdirSync(path.join(dir, 'casts'))
    fs.writeFileSync(path.join(dir, 'screenshots', 'seen.png'), 'image')
    fs.writeFileSync(path.join(dir, 'screenshots', 'orphan.png'), 'image')
    fs.writeFileSync(path.join(dir, 'http-bodies', 'body-ok.body'), 'body')
    fs.writeFileSync(path.join(dir, 'casts', 'session.cast'), 'cast')
    const base = { timestamp: 1, engagementId: 'e', sessionId: 's', operatorId: 'o', hostname: '', sourceIP: null, targetId: 'example.test', hash: null, prevHash: null, signature: null, createdAt: 1 }
    const events = [
      { ...base, id: 'shot-ok', agentType: 'screenshot', data: { filename: 'seen.png' } },
      { ...base, id: 'shot-missing', agentType: 'screenshot', data: { filename: 'missing.png' } },
      { ...base, id: 'http', agentType: 'scanner', data: { request_body_ref: { sha256: 'body-ok' }, response_body_ref: { sha256: 'body-missing' } } }
    ]
    expect(countExportAttachments(dir, events)).toEqual({ included: 4, missing: 2, unattributed: 2 })
    expect(countReferencedAttachments(events)).toBe(4)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
