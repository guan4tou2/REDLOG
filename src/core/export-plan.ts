import { capturedContentIsPartial } from './content-contract'
import { classifyScope } from './scope-evaluator'
import type { ActivitySnapshot } from './activity-contract'
import { parseQuery } from './query/contract'
import type { EventFilter, HttpFlowQueryOptions } from './db/events'
import { getReadonlyDB } from './db/index'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RedLogEvent } from './db/event-types'
import { isOutOfScope, type ScopeForSanitize } from './scope-sanitize'
import { capabilitiesFor, isExportFormat, type ExportCapabilities, type ExportFormat } from './export-capabilities'
import { isAttachmentId, storedArtifactOf, type ExportAttachment } from './export-attachments'
import { BODY_REF_FIELDS } from './http-body-store'

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
  | { kind: 'activity'; projectId: string; anchorEventId: string; snapshot: ActivitySnapshot }
  | { kind: 'session'; projectId: string; anchorEventId: string; snapshot: ActivitySnapshot }
  | { kind: 'all' }
  | { kind: 'time-range'; since: number; before: number; targetId?: string }

export interface ExportRequest {
  format: ExportFormat
  subset?: ExportSubset
  maskOutOfScope?: boolean
  scopeOnly?: boolean
  scrubPii?: boolean
  /** Attachments the operator left out, by bundle-relative path (#222). */
  excludeAttachments?: string[]
  includeAttachments?: string[]
}

export interface NormalizedExportRequest {
  format: ExportFormat
  subset: ExportSubset
  maskOutOfScope: boolean
  scopeOnly: boolean
  scrubPii: boolean
  excludeAttachments: readonly string[]
  includeAttachments: readonly string[]
}

export interface ExportCounts {
  exchanges?: number
  examined: number
  included: number
  excludedDoNotExport: number
  excludedPersonal: number
  outOfScopeHttpFlows?: number
  maskedOutOfScope: number
  sanitized: number
  attachmentsIncluded: number
  attachmentsMissing: number
  attachmentsUnattributed: number
  /** attachments the operator chose to leave out (#222) */
  attachmentsExcludedByOperator: number
  unsupported: number
  /** exported Events whose recorded output or body was cut short at capture */
  truncatedOutputs?: number
  /** recording pauses among the exported Events: stretches nothing was recorded */
  pauseWindows?: number
  /** HAR only: flows with stream segments and no saved request or response,
   *  carried beside the HAR entries rather than as one (#461) */
  partialHttpFlows?: number
  /** HAR of the HTTP view only: stream-only flows the view, and so the HAR,
   *  leaves out (#461) */
  partialHttpFlowsOutside?: number
}

export interface ExportAttachmentCounts {
  included: number
  missing: number
  unattributed: number
  excludedByOperator: number
}

/** Events whose captured output or body was cut short. The Event is still
 *  exported; the reader needs to know the text they see is not all of it. */
export function countTruncatedOutputs(events: readonly RedLogEvent[]): number {
  return events.filter(event => capturedContentIsPartial(event.data)).length
}

/** Recording pauses among these Events. Counts what the export carries: a
 *  selection that filters system Events out will not show its pauses. */
export function countPauseWindows(events: readonly RedLogEvent[]): number {
  return events.filter(e => e.agentType === 'system' && e.data.subtype === 'recording_paused').length
}

/** Flows among these Events that have SSE chunks or WebSocket messages and
 *  neither a request nor a response — what a HAR holds in `partialFlows`. */
export function countPartialHttpFlows(events: readonly RedLogEvent[]): number {
  return partialHttpFlowSegments(events).size
}

function partialHttpFlowSegments(events: readonly RedLogEvent[]): Map<string, RedLogEvent[]> {
  const segmented = new Map<string, RedLogEvent[]>()
  const exchanged = new Set<string>()
  for (const event of events) {
    const flowId = event.data.flow_id
    if (typeof flowId !== 'string' || !flowId) continue
    if (event.data.subtype === 'http_response_chunk' || event.data.subtype === 'ws_message') {
      segmented.set(flowId, [...(segmented.get(flowId) ?? []), event])
    } else if (event.data.subtype === 'http_request_start' || event.data.subtype === 'http_response') exchanged.add(flowId)
  }
  for (const flowId of exchanged) segmented.delete(flowId)
  return segmented
}

/** Stream-only flows a HAR of the HTTP view leaves out. That view is built
 *  from requests and responses, so these flows are in neither it nor its HAR;
 *  the preview says how many rather than dropping them silently (#461). Only
 *  the predicates a segment can answer are applied: a method or status filter
 *  cannot match a flow that has neither, and neither can a host or text filter
 *  a flow whose segments name no URL. */
export function countPartialHttpFlowsOutside(
  snapshotEvents: readonly RedLogEvent[],
  selectedIds: ReadonlySet<string>,
  bounds: { since?: number; before?: number; targetId?: string; http?: { method?: string; statusPrefix?: string; host?: string; text?: string } },
  excluded: (event: RedLogEvent) => boolean
): number {
  if (bounds.http?.method || bounds.http?.statusPrefix) return 0
  let outside = 0
  for (const segments of partialHttpFlowSegments(snapshotEvents).values()) {
    if (segments.some(event => selectedIds.has(event.id)) || segments.every(excluded)) continue
    const first = segments.reduce((a, b) => (b.timestamp < a.timestamp ? b : a))
    if (bounds.since != null && first.timestamp < bounds.since) continue
    if (bounds.before != null && first.timestamp > bounds.before) continue
    if (bounds.targetId && first.targetId?.toLowerCase() !== bounds.targetId.toLowerCase()) continue
    const url = segments.map(event => event.data.url).find((value): value is string => typeof value === 'string')
    const host = bounds.http?.host?.toLowerCase()
    const text = bounds.http?.text?.toLowerCase()
    if ((host || text) && !url) continue
    if (host) { try { if (new URL(url!).hostname.toLowerCase() !== host) continue } catch { continue } }
    if (text && !url!.toLowerCase().includes(text)) continue
    outside++
  }
  return outside
}

export function countReferencedAttachments(events: readonly RedLogEvent[]): number {
  const references = new Set<string>()
  for (const event of events) {
    if (event.agentType === 'screenshot' && typeof event.data.filename === 'string') references.add(`screenshot:${event.data.filename}`)
    for (const key of BODY_REF_FIELDS) {
      const ref = event.data[key]
      if (ref && typeof ref === 'object' && typeof (ref as { sha256?: unknown }).sha256 === 'string') {
        references.add(`body:${(ref as { sha256: string }).sha256}`)
      }
    }
  }
  return references.size
}

/** Resolve the bundle's filesystem attachments from the already-approved,
 * already-redacted Events. Counts files, not Events carrying references. */
/** Bundle paths of the operator-added artifacts these events carry, minus
 *  those whose event scope masking drops. */
export function referencedArtifacts(
  events: readonly RedLogEvent[],
  options: { scope?: ScopeForSanitize; maskOutOfScope?: boolean } = {}
): Set<string> {
  const out = new Set<string>()
  for (const event of events) {
    const stored = storedArtifactOf(event)
    if (!stored) continue
    if (options.maskOutOfScope !== false && options.scope && isOutOfScope(event.targetId, options.scope)) continue
    out.add(stored)
  }
  return out
}

export function countExportAttachments(
  projectDir: string,
  events: readonly RedLogEvent[],
  options: { scope?: ScopeForSanitize; maskOutOfScope?: boolean; exclude?: ReadonlySet<string> } = {}
): ExportAttachmentCounts {
  const referencedScreenshots = new Set<string>()
  const bodyHashes = new Set<string>()
  const exclude = options.exclude ?? new Set<string>()
  let missing = 0
  let excludedByOperator = 0
  /** True — and counted — when the operator left this file out. */
  const dropped = (id: string): boolean => {
    if (!exclude.has(id)) return false
    excludedByOperator++
    return true
  }

  for (const event of events) {
    if (event.agentType === 'screenshot') {
      const filename = typeof event.data.filename === 'string' ? event.data.filename : null
      if (filename && !(options.maskOutOfScope !== false && options.scope && isOutOfScope(event.targetId, options.scope))) {
        referencedScreenshots.add(filename)
      }
    }
    for (const key of BODY_REF_FIELDS) {
      const ref = event.data[key]
      if (ref && typeof ref === 'object' && typeof (ref as { sha256?: unknown }).sha256 === 'string') {
        bodyHashes.add((ref as { sha256: string }).sha256)
      }
    }
  }

  let included = 0
  let unattributed = 0
  const screenshotsDir = path.join(projectDir, 'screenshots')
  for (const filename of referencedScreenshots) {
    if (!fs.existsSync(path.join(screenshotsDir, filename))) missing++
    else if (!dropped(`screenshots/${filename}`)) included++
  }
  if (fs.existsSync(screenshotsDir)) {
    for (const filename of fs.readdirSync(screenshotsDir)) {
      if (!referencedScreenshots.has(filename) && fs.statSync(path.join(screenshotsDir, filename)).isFile()) {
        if (dropped(`screenshots/${filename}`)) continue
        included++
        unattributed++
      }
    }
  }

  const bodiesDir = path.join(projectDir, 'http-bodies')
  for (const hash of bodyHashes) {
    if (!fs.existsSync(path.join(bodiesDir, `${hash}.body`))) missing++
    else if (!dropped(`http-bodies/${hash}.body`)) included++
  }

  const castsDir = path.join(projectDir, 'casts')
  if (fs.existsSync(castsDir)) {
    for (const filename of fs.readdirSync(castsDir)) {
      if (fs.statSync(path.join(castsDir, filename)).isFile()) {
        if (dropped(`casts/${filename}`)) continue
        included++
        unattributed++
      }
    }
  }

  // Operator-added artifacts (#221) travel only with their own event.
  for (const stored of referencedArtifacts(events, options)) {
    if (!fs.existsSync(path.join(projectDir, stored))) missing++
    else if (!dropped(stored)) included++
  }
  return { included, missing, unattributed, excludedByOperator }
}

export interface ExportScopeSnapshot {
  targets: string[]
  excludeTargets: string[]
  personalDomains: string[]
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
  attachmentDigest: string
  policyFingerprint: string
  fingerprint: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

export function normalizeExportRequest(request: ExportRequest): NormalizedExportRequest {
  if (!isExportFormat(request.format)) throw new Error('Invalid export format')
  const subset = structuredClone(request.subset ?? { kind: 'all' as const })
  if (!['all', 'time-range', 'selection', 'activity', 'session'].includes(subset.kind)) throw new Error('Invalid export subset')
  if (subset.kind === 'activity' || subset.kind === 'session') {
    if (typeof subset.projectId !== 'string' || !subset.projectId || typeof subset.anchorEventId !== 'string' || !subset.anchorEventId || !isPlainRecord(subset.snapshot)) throw new Error('Invalid operation export reference')
    for (const key of ['chainedMaxRowId','loggedMaxRowId','chainedCount','loggedCount','takenAt'] as const) {
      if (!Number.isSafeInteger(subset.snapshot[key]) || subset.snapshot[key] < 0) throw new Error('Invalid operation export boundary')
    }
    for (const key of ['chainedTailId','loggedTailId'] as const) {
      if (subset.snapshot[key] !== null && typeof subset.snapshot[key] !== 'string') throw new Error('Invalid operation export boundary')
    }
    if (!['json','ndjson','bundle'].includes(request.format)) throw new Error('Unsupported operation export format')
    Object.freeze(subset.snapshot)
  }
  if (subset.kind === 'selection') {
    if (!['events', 'http'].includes(subset.projection) || !isPlainRecord(subset.filter)) throw new Error('Invalid export selection')
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
    if (subset.projection !== 'http' && subset.http !== undefined) throw new Error('Invalid HTTP predicates')
    if (subset.http !== undefined) {
      if (!isPlainRecord(subset.http)) throw new Error('Invalid HTTP predicates')
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
    maskOutOfScope: request.maskOutOfScope !== false,
    scopeOnly: request.scopeOnly === true,
    scrubPii: request.scrubPii === true,
    excludeAttachments: Object.freeze([...new Set((request.excludeAttachments ?? []).filter(isAttachmentId))].sort()),
    includeAttachments: Object.freeze([...new Set((request.includeAttachments ?? []).filter(isAttachmentId))].sort())
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
  attachmentDigest?: string
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
    ...(input.scopeSnapshot.sourceHash ? { sourceHash: input.scopeSnapshot.sourceHash } : {})
  }
  const evidence = JSON.stringify({
    projectId: input.projectId,
    request: input.request,
    snapshot: input.snapshot,
    scopeSnapshot,
    counts: input.counts,
    selectedEventIds,
    selectedEvidenceDigest: input.selectedEvidenceDigest ?? '',
    attachmentDigest: input.attachmentDigest ?? '',
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
      personalDomains: Object.freeze(scopeSnapshot.personalDomains) as unknown as string[]
    }),
    capabilities: Object.freeze(capabilitiesFor(input.request.format)),
    counts: Object.freeze({ ...input.counts }),
    attachments: Object.freeze([...(input.attachments ?? [])]),
    selectedEventIds: Object.freeze(selectedEventIds),
    selectedEvidenceDigest: input.selectedEvidenceDigest ?? '',
    attachmentDigest: input.attachmentDigest ?? '',
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

/** Count exchanges, not request+response rows, against the frozen policy. */
export function countOutOfScopeHttpFlows(events: readonly RedLogEvent[], scope: { targets: string[]; excludeTargets: string[] }): number {
  const flows = new Set<string>()
  for (const event of events) {
    const d = event.data
    if (!['http_request_start', 'http_response', 'http_response_chunk'].includes(String(d.subtype)) || typeof d.flow_id !== 'string' || typeof d.url !== 'string') continue
    try {
      const url = new URL(d.url)
      if (!['http:', 'https:'].includes(url.protocol)) continue
      const state = classifyScope(url.hostname, scope).status
      if (state === 'out-of-scope' || state === 'excluded') flows.add(d.flow_id)
    } catch { /* malformed target is unknown, not outside scope */ }
  }
  return flows.size
}
