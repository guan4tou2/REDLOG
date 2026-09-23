import { getReadonlyDB } from './db/index'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RedLogEvent } from './db/event-types'
import { isOutOfScope, type ScopeForSanitize } from './scope-sanitize'
import { capabilitiesFor, isExportFormat, type ExportCapabilities, type ExportFormat } from './export-capabilities'

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
  | { kind: 'all' }
  | { kind: 'time-range'; since: number; before: number; targetId?: string }

export interface ExportRequest {
  format: ExportFormat
  subset?: ExportSubset
  sharing?: boolean
  maskOutOfScope?: boolean
  scopeOnly?: boolean
  scrubPii?: boolean
}

export interface NormalizedExportRequest {
  format: ExportFormat
  subset: ExportSubset
  sharing: boolean
  maskOutOfScope: boolean
  scopeOnly: boolean
  scrubPii: boolean
}

export interface ExportCounts {
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
  unsupported: number
}

export interface ExportAttachmentCounts {
  included: number
  missing: number
  unattributed: number
}

export function countReferencedAttachments(events: readonly RedLogEvent[]): number {
  const references = new Set<string>()
  for (const event of events) {
    if (event.agentType === 'screenshot' && typeof event.data.filename === 'string') references.add(`screenshot:${event.data.filename}`)
    for (const key of ['request_body_ref', 'response_body_ref']) {
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
export function countExportAttachments(
  projectDir: string,
  events: readonly RedLogEvent[],
  options: { scope?: ScopeForSanitize; maskOutOfScope?: boolean } = {}
): ExportAttachmentCounts {
  const referencedScreenshots = new Set<string>()
  const bodyHashes = new Set<string>()
  let missing = 0

  for (const event of events) {
    if (event.agentType === 'screenshot') {
      const filename = typeof event.data.filename === 'string' ? event.data.filename : null
      if (filename && !(options.maskOutOfScope !== false && options.scope && isOutOfScope(event.targetId, options.scope))) {
        referencedScreenshots.add(filename)
      }
    }
    for (const key of ['request_body_ref', 'response_body_ref']) {
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
    if (fs.existsSync(path.join(screenshotsDir, filename))) included++
    else missing++
  }
  if (fs.existsSync(screenshotsDir)) {
    for (const filename of fs.readdirSync(screenshotsDir)) {
      if (!referencedScreenshots.has(filename) && fs.statSync(path.join(screenshotsDir, filename)).isFile()) {
        included++
        unattributed++
      }
    }
  }

  const bodiesDir = path.join(projectDir, 'http-bodies')
  for (const hash of bodyHashes) {
    if (fs.existsSync(path.join(bodiesDir, `${hash}.body`))) included++
    else missing++
  }

  const castsDir = path.join(projectDir, 'casts')
  if (fs.existsSync(castsDir)) {
    for (const filename of fs.readdirSync(castsDir)) {
      if (fs.statSync(path.join(castsDir, filename)).isFile()) {
        included++
        unattributed++
      }
    }
  }
  return { included, missing, unattributed }
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
  selectedEventIds: readonly string[]
  selectedEvidenceDigest: string
  policyFingerprint: string
  fingerprint: string
}

export function normalizeExportRequest(request: ExportRequest): NormalizedExportRequest {
  if (!isExportFormat(request.format)) throw new Error('Invalid export format')
  const subset = request.subset ?? { kind: 'all' as const }
  if (subset.kind === 'time-range' && (!Number.isFinite(subset.since) || !Number.isFinite(subset.before) || subset.since >= subset.before)) {
    throw new Error('Invalid export time range')
  }
  return Object.freeze({
    format: request.format,
    subset: Object.freeze({ ...subset }),
    sharing: request.sharing === true,
    maskOutOfScope: request.maskOutOfScope !== false,
    scopeOnly: request.scopeOnly === true,
    scrubPii: request.scrubPii === true || request.sharing === true
  })
}

interface CreateExportPlanInput {
  projectId: string
  request: NormalizedExportRequest
  snapshot: ExportSnapshot
  scopeSnapshot: ExportScopeSnapshot
  counts: ExportCounts
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
