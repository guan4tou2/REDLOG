import crypto from 'crypto'
import { getDB } from './db/index'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { planScopeSanitize, type SanitizeCandidate, type ScopeSanitizePlan } from './scope-sanitize-plan'
import type { ScopeVerdict } from './artifact-pin'

// Scope-aware sanitize EXECUTION (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B, G3). The
// planner (scope-sanitize-plan.ts) decides WHAT; this applies it, reusing the
// layer-4 sanitize storage model (docs/redaction-design.md): never mutate the
// source event, write replacement bytes to a side table (sanitized_events for
// inline fields, sanitized_io for sidecar bodies), and APPEND one chained
// system.sanitized recording every swap. The bundle export serves the
// replacements; redlog-verify reads the swap and confirms bytes hash to the
// replacement digest → *sanitized*, never *tampered*.

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

/** The redacted body a client-deliverable export shows in place of out-of-scope
 *  content. Pure. Keeps the touched host visible (A1: the fact a host was hit
 *  survives) while removing the captured bytes. */
export function scopeRedactionPlaceholder(verdict: ScopeVerdict, target: string | null): string {
  const where = target ? ` — ${target}` : ''
  switch (verdict) {
    case 'excluded': return `[redacted: excluded target${where}]`
    case 'out_of_scope': return `[redacted: out-of-scope${where}]`
    case 'unknown': return `[redacted: unclassified target${where}]`
    case 'in_scope': return ''   // never sanitized
  }
}

export interface RunScopeSanitizeInput {
  events: SanitizeCandidate[]
  classify: (target: string | null) => ScopeVerdict
  operatorId: string
  engagementId: string
  /** Preview only — compute the plan, write nothing. */
  dryRun?: boolean
  /** Operator opted to also sanitize `unknown`-target events (default: don't —
   *  A2, unknown is never auto-stripped). */
  includeUnknown?: boolean
}

export interface RunScopeSanitizeResult {
  plan: ScopeSanitizePlan
  dryRun: boolean
  sanitizedFields: number
  sanitizedIoBodies: number
  sanitizedEventId: string | null
}

interface FieldRow { source_event_id: string; field: string; sanitized_value: string; replacement_sha256: string }
interface IoRow { orig_sha256: string; sanitized_value: string; replacement_sha256: string }

export function runScopeSanitize(input: RunScopeSanitizeInput): RunScopeSanitizeResult {
  const plan = planScopeSanitize(input.events, input.classify)
  const items = [...plan.toSanitize, ...(input.includeUnknown ? plan.unknown : [])]

  // A deduped io body may be cited by an out-of-scope AND an in-scope event.
  // Sanitizing removes the single file, so a body referenced by ANY kept event
  // must not be sanitized (the refcount rule, mirrored from prune). Collect the
  // refs the kept items still need and exclude them.
  const keptRefs = new Set<string>()
  const keptItems = plan.items.filter((i) => !items.includes(i))
  for (const i of keptItems) for (const r of i.ioRefs) keptRefs.add(r)

  const fieldRows: FieldRow[] = []
  const ioRows: IoRow[] = []
  const seenIo = new Set<string>()
  for (const item of items) {
    const placeholder = scopeRedactionPlaceholder(item.scope, item.target)
    for (const field of item.fields) {
      fieldRows.push({ source_event_id: item.eventId, field, sanitized_value: placeholder, replacement_sha256: sha256(placeholder) })
    }
    for (const ref of item.ioRefs) {
      if (seenIo.has(ref) || keptRefs.has(ref)) continue   // sanitize a body once, never if still needed in-scope
      seenIo.add(ref)
      ioRows.push({ orig_sha256: ref, sanitized_value: placeholder, replacement_sha256: sha256(placeholder) })
    }
  }

  if (input.dryRun || (fieldRows.length === 0 && ioRows.length === 0)) {
    return { plan, dryRun: true, sanitizedFields: 0, sanitizedIoBodies: 0, sanitizedEventId: null }
  }

  // One chained system.sanitized covers the whole scope pass. `io_replacements`
  // is what verify keys on to treat swapped io bodies as sanitized-not-tampered.
  const now = Date.now()
  const chained = insertEvent('system', {
    subtype: 'sanitized',
    reason: 'scope',
    source_events: [...new Set(items.map((i) => i.eventId))],
    fields: [...new Set(fieldRows.map((r) => r.field))],
    replacements: fieldRows.map((r) => ({ event: r.source_event_id, field: r.field, sha256: r.replacement_sha256 })),
    io_replacements: ioRows.map((r) => ({ ref: r.orig_sha256, sha256: r.replacement_sha256 }))
  }, { engagementId: input.engagementId, operatorId: input.operatorId })
  if (!chained) throw new Error('Failed to append system.sanitized event')
  eventBus.publish(chained)

  const db = getDB()
  const fieldStmt = db.prepare(
    `INSERT OR REPLACE INTO sanitized_events
     (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const ioStmt = db.prepare(
    `INSERT OR REPLACE INTO sanitized_io
     (orig_sha256, sanitized_value, replacement_sha256, created_at, sanitized_event_id)
     VALUES (?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const r of fieldRows) fieldStmt.run(r.source_event_id, r.field, r.sanitized_value, r.replacement_sha256, now, chained.id)
    for (const r of ioRows) ioStmt.run(r.orig_sha256, r.sanitized_value, r.replacement_sha256, now, chained.id)
  })()

  return {
    plan,
    dryRun: false,
    sanitizedFields: fieldRows.length,
    sanitizedIoBodies: ioRows.length,
    sanitizedEventId: chained.id
  }
}

/** All sanitized io replacements, keyed by original digest — for the bundle
 *  export to serve the redacted body under `io/<orig_sha256>.bin`. */
export function getSanitizedIo(): Map<string, { value: string; replacementSha: string }> {
  const db = getDB()
  const rows = db.prepare('SELECT orig_sha256, sanitized_value, replacement_sha256 FROM sanitized_io').all() as Array<{ orig_sha256: string; sanitized_value: string; replacement_sha256: string }>
  const out = new Map<string, { value: string; replacementSha: string }>()
  for (const r of rows) out.set(r.orig_sha256, { value: r.sanitized_value, replacementSha: r.replacement_sha256 })
  return out
}
