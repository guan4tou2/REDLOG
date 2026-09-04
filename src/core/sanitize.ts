import crypto from 'crypto'
import { getDB } from './db/index'
import { insertEvent, RedLogEvent } from './db/events'
import { eventBus } from './event-bus'
import { maskText } from './redaction'

// Layer 4 of the four-layer redaction model (docs/redaction-design.md):
// producing sanitized bytes for pre-delivery scrub.
//
// This module NEVER mutates the source `events` row. Instead it:
//   1. Reads the source event and its detected spans (event.data.redactions).
//   2. Composes a masked copy of each requested field.
//   3. Writes replacement bytes to the sanitized_events table.
//   4. Appends a chained system.sanitized event that names the source event,
//      the fields sanitized, and the SHA-256 of the replacement bytes.
// The bundle export layer looks up sanitized_events on write and serves the
// masked copy in the exported events.jsonl, keeping the source DB unchanged.
//
// Because sanitization only APPENDS to the chain, a bundle without matching
// system.sanitized events is detectable as tampering (someone stripped bytes
// without going through the audited path).

interface RedactionSpan {
  field: string
  start: number
  end: number
  pattern?: string
  hint?: string
}

export interface SanitizedRow {
  source_event_id: string
  field: string
  sanitized_value: string
  replacement_sha256: string
  created_at: number
  sanitized_event_id: string
}

export interface SanitizeInput {
  eventIds: string[]
  /** Which fields to mask on each event; only string fields with spans are
   *  touched. Common values: 'output', 'output_preview', 'command'. */
  fields: string[]
  operatorId: string
  engagementId: string
  reason?: string
  /** When true, return what WOULD be sanitized without writing anything. */
  dryRun?: boolean
}

export interface SanitizeResult {
  dryRun: boolean
  planned: Array<{ eventId: string; field: string; spanCount: number; replacementSha256: string }>
  applied: number  // rows written (0 when dryRun)
  sanitizedEventId: string | null  // id of the chained system.sanitized event (null when dryRun)
}

function eventById(id: string): RedLogEvent | null {
  const db = getDB()
  const row = db.prepare('SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type, hostname, source_ip, target_id, data, hash, prev_hash, created_at, monotonic_ns, ntp_offset_ms FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as string,
    timestamp: row.timestamp as number,
    engagementId: row.engagement_id as string,
    sessionId: row.session_id as string,
    operatorId: row.operator_id as string,
    agentType: row.agent_type as string,
    hostname: row.hostname as string,
    sourceIP: (row.source_ip as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    hash: row.hash as string,
    prevHash: (row.prev_hash as string | null) ?? null,
    createdAt: row.created_at as number,
    monotonicNs: (row.monotonic_ns as string | null) ?? null,
    ntpOffsetMs: (row.ntp_offset_ms as number | null) ?? null
  }
}

export function sanitize(input: SanitizeInput): SanitizeResult {
  const planned: SanitizeResult['planned'] = []
  const toWrite: SanitizedRow[] = []
  const now = Date.now()

  for (const eventId of input.eventIds) {
    const ev = eventById(eventId)
    if (!ev) continue
    const spans = (ev.data?.redactions as RedactionSpan[] | undefined) ?? []
    if (spans.length === 0) continue
    for (const field of input.fields) {
      const val = ev.data?.[field]
      if (typeof val !== 'string' || !val) continue
      const fieldSpans = spans.filter((s) => s.field === field)
      if (fieldSpans.length === 0) continue
      const masked = maskText(val, fieldSpans.map((s) => ({
        start: s.start, end: s.end,
        pattern: (s.pattern === 'entropy' ? 'entropy' : 'denylist') as 'entropy' | 'denylist',
        hint: s.hint ?? ''
      })))
      const sha = crypto.createHash('sha256').update(masked).digest('hex')
      planned.push({ eventId, field, spanCount: fieldSpans.length, replacementSha256: sha })
      toWrite.push({
        source_event_id: eventId,
        field,
        sanitized_value: masked,
        replacement_sha256: sha,
        created_at: now,
        sanitized_event_id: '' // filled in below with the chained event id
      })
    }
  }

  if (input.dryRun || toWrite.length === 0) {
    return { dryRun: true, planned, applied: 0, sanitizedEventId: null }
  }

  // Append the audit event FIRST so we can stamp its id onto the sanitized
  // rows — that way every row points back to the chained record proving the
  // sanitization happened.
  const chained = insertEvent('system', {
    subtype: 'sanitized',
    source_events: [...new Set(toWrite.map((r) => r.source_event_id))],
    fields: [...new Set(toWrite.map((r) => r.field))],
    reason: input.reason ?? null,
    replacements: toWrite.map((r) => ({ event: r.source_event_id, field: r.field, sha256: r.replacement_sha256 }))
  }, { engagementId: input.engagementId, operatorId: input.operatorId })
  if (!chained) throw new Error('Failed to append system.sanitized event')
  eventBus.publish(chained)

  const db = getDB()
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sanitized_events
     (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((rows: SanitizedRow[]) => {
    for (const r of rows) stmt.run(r.source_event_id, r.field, r.sanitized_value, r.replacement_sha256, r.created_at, chained.id)
  })
  tx(toWrite)

  return { dryRun: false, planned, applied: toWrite.length, sanitizedEventId: chained.id }
}

/** Lookup all sanitized replacements for an event, keyed by field. Used by the
 *  bundle export to swap raw bytes for the sanitized copy. */
export function getSanitizedFields(eventId: string): Record<string, string> {
  const db = getDB()
  const rows = db.prepare('SELECT field, sanitized_value FROM sanitized_events WHERE source_event_id = ?').all(eventId) as Array<{ field: string; sanitized_value: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.field] = r.sanitized_value
  return out
}

export function countSanitizedEvents(): number {
  const db = getDB()
  return (db.prepare('SELECT COUNT(DISTINCT source_event_id) AS n FROM sanitized_events').get() as { n: number }).n
}
