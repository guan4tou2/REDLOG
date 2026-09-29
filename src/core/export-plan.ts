import { parseQuery } from './query/contract'
import type { EventFilter, HttpFlowQueryOptions } from './db/events'
import { BODY_REF_FOR } from './redact-export'
import { getReadonlyDB } from './db/index'
import { createHash, randomUUID } from 'crypto'
import type { RedLogEvent } from './db/event-types'
import { capabilitiesFor, isExportFormat, type ExportCapabilities, type ExportFormat } from './export-capabilities'
import { isAttachmentId, storedArtifactOf, type ExportAttachment } from './export-attachments'

/**
 * A point-in-time snapshot of both DB tiers' max rowid.
 * Preview and execute must share the same snapshot so the
 * dataset the operator reviewed is exactly the dataset exported.
 */
export interface ExportSnapshot {
  chainedMaxRowId: number
  loggedMaxRowId: number
  takenAt: number
}

export type ExportSubset =
  | { kind: 'selection'; projection: 'events' | 'http'; filter: Omit<EventFilter, 'scope' | 'personalDomains'>; query?: string; excludeHousekeeping?: boolean; http?: HttpFlowQueryOptions['http'] }
  | { kind: 'all' }
  | { kind: 'time-range'; since: number; before: number; targetId?: string }

export interface ExportRequest {
  format: ExportFormat
  subset?: ExportSubset
  sharing?: boolean
  maskOutOfScope?: boolean
  scopeOnly?: boolean
  scrubPii?: boolean
  /** Attachments the operator left out, by bundle-relative path (#222). */
  excludeAttachments?: string[]
}

export interface NormalizedExportRequest {
  format: ExportFormat
  subset: ExportSubset
  sharing: boolean
  maskOutOfScope: boolean
  scopeOnly: boolean
  scrubPii: boolean
  excludeAttachments: readonly string[]
}

export interface ExportCounts {
  exchanges?: number
  examined: number
  included: number
  excludedDoNotExport: number
  excludedPersonal: number
  excludedBlacklist: number
  maskedOutOfScope: number
  sanitized: number
  attachmentsIncluded: number
  attachmentsMissing: number
  attachmentsUnattributed: number
  /** attachments the operator chose to leave out (#222) */
  attachmentsExcludedByOperator: number
  unsupported: number
}

export function countReferencedAttachments(events: readonly RedLogEvent[]): number {
  const references = new Set<string>()
  for (const event of events) {
    const artifact = storedArtifactOf(event)
    if (artifact) references.add(artifact)
    if (event.agentType === 'screenshot' && typeof event.data.filename === 'string') references.add(`screenshot:${event.data.filename}`)
    for (const key of Object.values(BODY_REF_FOR)) {
      const ref = event.data[key]
      if (ref && typeof ref === 'object' && typeof (ref as { sha256?: unknown }).sha256 === 'string') {
        references.add(`body:${(ref as { sha256: string }).sha256}`)
      }
    }
  }
  return references.size
}

export interface ExportScopeSnapshot {
  targets: string[]
  excludeTargets: string[]
  personalDomains: string[]
  blacklist?: string[]
  sourceHash?: string
}

export interface ExportPlan {
  id: string
  projectId: string
  createdAt: number
  expiresAt: number
  request: NormalizedExportRequest
  snapshot: ExportSnapshot
  scopeSnapshot: ExportScopeSnapshot
  capabilities: ExportCapabilities
  counts: ExportCounts
  /** One row per file the bundle would carry, for the preview (#222). */
  attachments: readonly ExportAttachment[]
  selectedEventIds: readonly string[]
  selectedEvidenceDigest: string
  policyFingerprint: string
  fingerprint: string
}

export function normalizeExportRequest(request: ExportRequest): NormalizedExportRequest {
  if (!isExportFormat(request.format)) throw new Error('Invalid export format')
  const subset = structuredClone(request.subset ?? { kind: 'all' as const })
  if (!['all', 'time-range', 'selection'].includes(subset.kind)) throw new Error('Invalid export subset')
  if (subset.kind === 'selection') {
    if (!['events', 'http'].includes(subset.projection) || !subset.filter || typeof subset.filter !== 'object') throw new Error('Invalid export selection')
    const allowed = new Set(['targetId', 'agentType', 'since', 'before', 'inScopeOnly', 'hidePersonal', 'tier'])
    for (const [key, value] of Object.entries(subset.filter)) {
      if (!allowed.has(key)) throw new Error('Invalid export filter')
      if (['targetId','agentType'].includes(key) && typeof value !== 'string') throw new Error('Invalid export filter')
      if (['since','before'].includes(key) && !Number.isFinite(value)) throw new Error('Invalid export time range')
      if (['inScopeOnly','hidePersonal'].includes(key) && typeof value !== 'boolean') throw new Error('Invalid export filter')
      if (key === 'tier' && value !== 'chained') throw new Error('Invalid export tier')
    }
    if (subset.filter.since != null && subset.filter.before != null && subset.filter.since > subset.filter.before) throw new Error('Invalid export time range')
    if (subset.query !== undefined && (typeof subset.query !== 'string' || !parseQuery(subset.query).ok)) throw new Error('Invalid export query')
    if (subset.excludeHousekeeping !== undefined && typeof subset.excludeHousekeeping !== 'boolean') throw new Error('Invalid housekeeping predicate')
    if (subset.projection === 'http' && subset.query) throw new Error('Unsupported HTTP typed query')
    if (subset.projection !== 'http' && subset.http) throw new Error('Invalid HTTP predicates')
    if (subset.http) {
      for (const [key,value] of Object.entries(subset.http)) {
        if (!['method','statusPrefix','host','text'].includes(key) || typeof value !== 'string') throw new Error('Invalid HTTP predicate')
      }
      if (subset.http.statusPrefix && !/^[1-5][0-9]{0,2}$/.test(subset.http.statusPrefix)) throw new Error('Invalid HTTP status prefix')
      Object.freeze(subset.http)
    }
    Object.freeze(subset.filter)
  }
  if (subset.kind === 'time-range' && (!Number.isFinite(subset.since) || !Number.isFinite(subset.before) || subset.since >= subset.before)) {
    throw new Error('Invalid export time range')
  }
  return Object.freeze({
    format: request.format,
    subset: Object.freeze({ ...subset }),
    sharing: request.sharing === true,
    maskOutOfScope: request.maskOutOfScope !== false,
    scopeOnly: request.scopeOnly === true,
    scrubPii: request.scrubPii === true || request.sharing === true,
    excludeAttachments: Object.freeze([...new Set((request.excludeAttachments ?? []).filter(isAttachmentId))].sort())
  })
}

interface CreateExportPlanInput {
  projectId: string
  request: NormalizedExportRequest
  snapshot: ExportSnapshot
  scopeSnapshot: ExportScopeSnapshot
  counts: ExportCounts
  attachments?: readonly ExportAttachment[]
  selectedEventIds: string[] | readonly string[]
  selectedEvidenceDigest?: string
  policyFingerprint?: string
}

export function createExportPlan(
  input: CreateExportPlanInput,
  options: { id?: string; now?: number; ttlMs?: number } = {}
): ExportPlan {
  const createdAt = options.now ?? Date.now()
  const selectedEventIds = [...input.selectedEventIds].sort()
  const scopeSnapshot = {
    targets: [...input.scopeSnapshot.targets],
    excludeTargets: [...input.scopeSnapshot.excludeTargets],
    personalDomains: [...input.scopeSnapshot.personalDomains],
    blacklist: [...(input.scopeSnapshot.blacklist ?? [])],
    ...(input.scopeSnapshot.sourceHash ? { sourceHash: input.scopeSnapshot.sourceHash } : {})
  }
  const evidence = JSON.stringify({
    projectId: input.projectId,
    request: input.request,
    snapshot: input.snapshot,
    scopeSnapshot,
    counts: input.counts,
    selectedEventIds,
    attachments: input.attachments ?? [],
    selectedEvidenceDigest: input.selectedEvidenceDigest ?? '',
    policyFingerprint: input.policyFingerprint ?? ''
  })
  const plan: ExportPlan = {
    id: options.id ?? randomUUID(),
    projectId: input.projectId,
    createdAt,
    expiresAt: createdAt + (options.ttlMs ?? 15 * 60_000),
    request: input.request,
    snapshot: Object.freeze({ ...input.snapshot }),
    scopeSnapshot: Object.freeze({
      ...scopeSnapshot,
      targets: Object.freeze(scopeSnapshot.targets) as unknown as string[],
      excludeTargets: Object.freeze(scopeSnapshot.excludeTargets) as unknown as string[],
      personalDomains: Object.freeze(scopeSnapshot.personalDomains) as unknown as string[],
      blacklist: Object.freeze(scopeSnapshot.blacklist) as unknown as string[]
    }),
    capabilities: Object.freeze(capabilitiesFor(input.request.format)),
    counts: Object.freeze({ ...input.counts }),
    attachments: Object.freeze((input.attachments ?? []).map(file => Object.freeze({ ...file, targets: Object.freeze([...file.targets]) as unknown as string[] }))),
    selectedEventIds: Object.freeze(selectedEventIds),
    selectedEvidenceDigest: input.selectedEvidenceDigest ?? '',
    policyFingerprint: input.policyFingerprint ?? '',
    fingerprint: createHash('sha256').update(evidence).digest('hex')
  }
  return Object.freeze(plan)
}

export function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type ExportPlanClaim =
  | { ok: true; plan: ExportPlan }
  | { ok: false; error: 'plan-not-found' | 'plan-expired' | 'project-changed' | 'plan-already-used' }

export class ExportPlanRegistry {
  private readonly plans = new Map<string, { plan: ExportPlan; used: boolean }>()
  private readonly now: () => number
  private readonly maxPlans: number

  constructor(options: { now?: () => number; maxPlans?: number } = {}) {
    this.now = options.now ?? Date.now
    this.maxPlans = Math.max(1, options.maxPlans ?? 32)
  }

  put(plan: ExportPlan): void {
    this.plans.set(plan.id, { plan, used: false })
    while (this.plans.size > this.maxPlans) {
      const oldest = this.plans.keys().next().value as string | undefined
      if (!oldest) break
      this.plans.delete(oldest)
    }
  }

  claim(planId: string, projectId: string): ExportPlanClaim {
    const entry = this.plans.get(planId)
    if (!entry) return { ok: false, error: 'plan-not-found' }
    if (this.now() > entry.plan.expiresAt) return { ok: false, error: 'plan-expired' }
    if (entry.plan.projectId !== projectId) return { ok: false, error: 'project-changed' }
    if (entry.used) return { ok: false, error: 'plan-already-used' }
    entry.used = true
    return { ok: true, plan: entry.plan }
  }

  clear(): void {
    this.plans.clear()
  }
}

export function takeExportSnapshot(): ExportSnapshot {
  const db = getReadonlyDB()
  const chained = db.prepare('SELECT MAX(rowid) AS m FROM events').get() as { m: number | null } | undefined
  const logged = db.prepare('SELECT MAX(rowid) AS m FROM events_logged').get() as { m: number | null } | undefined
  return {
    chainedMaxRowId: chained?.m ?? 0,
    loggedMaxRowId: logged?.m ?? 0,
    takenAt: Date.now()
  }
}
