import crypto from 'crypto'
import os from 'os'
import { getDB } from './index'
import { monotonicNs, getNtpOffsetMs } from '../clock'
import { signEvent } from '../signing'

export interface RedLogEvent {
  id: string
  timestamp: number
  engagementId: string
  sessionId: string
  operatorId: string
  agentType: string
  hostname: string
  sourceIP: string | null
  targetId: string | null
  data: Record<string, unknown>
  hash?: string
  prevHash?: string | null
  createdAt: number
  monotonicNs?: string | null
  ntpOffsetMs?: number | null
  // v0.6.89: base64 raw 64-byte Ed25519 signature over the canonical JSON
  // used for `hash`. Nullable — operators created pre-v0.6.89 (or when
  // keygen fails) write unsigned rows, which the chain hash still protects.
  signature?: string | null
}

let sessionId = crypto.randomUUID()

// v0.6.88 P3-A: prefix monotonic_ns with a session-boot epoch so events
// sort correctly across app restarts. process.hrtime.bigint() resets to
// ~0 each time the process starts — a fresh session's `0000…12345` used
// to sort BEFORE an old session's `0000…99999` under lexicographic
// TEXT sort. Now every monotonic_ns lands as `${bootMs.padStart(14)}-${paddedNs}`
// so string sort is boot-epoch-first, then in-process ns.
const BOOT_EPOCH_MS = Date.now()

// Regenerate the session id — called by initDB on every project open so
// events written after a project switch belong to a fresh session rather
// than sharing the module-load session id across projects (v0.6.87 audit
// finding: prior code kept sessionId across project:open, which is
// currently harmless — no consumer filters on session_id — but silently
// wrong and would leak evidence between projects the moment anything
// starts partitioning by session.
export function resetSession(): void {
  sessionId = crypto.randomUUID()
}

// v0.6.88 P1-B: append-only enforcement contract.
// The events table is APPEND-ONLY by design. Deleting a row would:
//   1. Break the hash chain (prev_hash points at the deleted row).
//   2. Silently succeed against the SQLite file since there's no trigger.
// Screenshot / cast retention deletes the FILE only and appends a
// `system.screenshot_deleted` / `system.cast_pruned` audit event; the row
// stays. This helper is a runtime assertion for callers that inherit a
// db handle and could inadvertently issue a DELETE — throws instead of
// silently corrupting the chain. Tests call it before writing to verify
// no code path issues DELETE FROM events between init and the check.
export function assertEventsAppendOnly(): void {
  const db = getDB()
  // v0.6.93 P0-F: DROP + CREATE every time so DBs installed before v0.6.93
  // (which had a shorter column list — hash/prev_hash/data/id/timestamp/
  // operator_id only) get upgraded to cover every hash-contributing field.
  // Missing columns from the old trigger allowed silent tampering with
  // agent_type / hostname / session_id / engagement_id / source_ip / target_id
  // / monotonic_ns / ntp_offset_ms / signature; chain hash still catches
  // them, but the append-only contract now matches the doc. Idempotent.
  db.exec(`
    DROP TRIGGER IF EXISTS no_delete_events;
    DROP TRIGGER IF EXISTS no_update_events_hash;
    CREATE TRIGGER no_delete_events
      BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'events table is append-only (chain integrity)');
    END;
    CREATE TRIGGER no_update_events_hash
      BEFORE UPDATE OF hash, prev_hash, data, id, timestamp, operator_id,
                       agent_type, hostname, session_id, engagement_id,
                       source_ip, target_id, monotonic_ns, ntp_offset_ms,
                       created_at, signature
                       ON events
    BEGIN
      SELECT RAISE(ABORT, 'events row fields are immutable (chain integrity)');
    END;
  `)
}

// v0.6.88 P0-A: canonical JSON serialiser for hash input. `JSON.stringify`
// on an object doesn't sort keys — the order comes from insertion order
// and can shift across Node versions, spread patterns, or export/import
// round-trips. That means an event exported as JSON and reserialised
// might hash differently even though not a byte of user data changed.
// This walker sorts every object's keys recursively; array order is
// preserved (that IS semantic content). Strings are JSON-escaped normally.
// New events land with canonical-hashed rows; verifyChainFull tries the
// canonical shape first and falls back to legacy shapes for old rows.
export function canonicalStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']'
  const keys = Object.keys(v as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const k of keys) {
    const val = (v as Record<string, unknown>)[k]
    if (val === undefined) continue
    parts.push(JSON.stringify(k) + ':' + canonicalStringify(val))
  }
  return '{' + parts.join(',') + '}'
}

const ALLOWED_NO_TARGET_TYPES = new Set(['marker', 'screenshot'])
const EXCLUDED_NO_TARGET_TYPES = new Set(['clipboard', 'system'])

// SQL predicate that matches the renderer-side `isHousekeeping()` filter in
// Timeline.tsx. Kept in sync manually — both hide RedLog plumbing rows that
// still land in the chain (for audit integrity) but must not show up in the
// operator's view. Pushing this filter into SQL fixes the Load-More pager,
// which was fetching 200 rows and filtering to ~30 client-side, then setting
// `allLoaded=true` because <200 came back — operators saw an empty timeline
// with more history they couldn't reach.
const HOUSEKEEPING_SQL = `
  NOT (
    (agent_type = 'system' AND json_extract(data,'$.subtype') IN ('api_started','session_start','deconfliction_test'))
    OR (agent_type = 'shell' AND json_extract(data,'$.subtype') = 'session_start')
    OR (agent_type = 'terminal' AND json_extract(data,'$.subtype') = 'session_start')
    OR (agent_type = 'shell' AND json_extract(data,'$.subtype') IN ('command_start','command') AND json_extract(data,'$.command') LIKE '%shell-preexec-hook.sh%')
  )
`

// Pad monotonic_ns to a fixed 20 chars so text-column ORDER BY sorts numerically
// (SQLite TEXT sort is lexicographic — unpadded '999' comes before '1000').
// Renderer sort compares as BigInt so padded + unpadded rows still order right
// on the client; this only matters for SQL sort. 20 chars covers ~317 years.
//
// v0.6.88 P3-A: prefix boot-epoch-ms (14 chars — good through 5138 AD)
// so events across process restarts sort in boot order first, then
// in-process ns. Renderer sort tolerates both padded-only and prefixed
// shapes because it falls back to event id for the final tiebreak.
function padMonoNs(ns: string | null): string | null {
  if (!ns) return ns
  const padded = ns.length >= 20 ? ns : ns.padStart(20, '0')
  const bootPad = String(BOOT_EPOCH_MS).padStart(14, '0')
  return `${bootPad}-${padded}`
}

// v0.6.88 P2-A: insert-time clock-anomaly detector. Fires when the wall
// clock has drifted too far from NTP or when the monotonic counter
// disagrees with wall clock delta since the previous event on the same
// (host, session) pair. The anomaly is stashed on the event's data
// under `_clock_anomaly` so verifyChainFull can surface it and Timeline
// can visually tag the row.
const CLOCK_NTP_THRESHOLD_MS = 30_000
let lastEventForClockCheck: { timestamp: number; monotonic: string; hostname: string; sessionId: string } | null = null
function detectClockAnomaly(
  now: number,
  currentMono: string | null,
  hostname: string
): { reason: string } | null {
  const ntpOffset = getNtpOffsetMs()
  if (ntpOffset != null && Math.abs(ntpOffset) > CLOCK_NTP_THRESHOLD_MS) {
    return { reason: `ntp_offset ${ntpOffset}ms exceeds ${CLOCK_NTP_THRESHOLD_MS}ms threshold` }
  }
  const prev = lastEventForClockCheck
  if (prev && prev.hostname === hostname && prev.sessionId === sessionId && currentMono && prev.monotonic) {
    try {
      // Compare against unprefixed pad — strip the `${bootPad}-` if present.
      const stripPrefix = (s: string): string => (s.includes('-') ? s.slice(s.indexOf('-') + 1) : s)
      const curNs = BigInt(stripPrefix(currentMono))
      const prevNs = BigInt(stripPrefix(prev.monotonic))
      if (curNs < prevNs) {
        return { reason: `monotonic_ns regressed within same session (prev ${prev.monotonic} > cur ${currentMono})` }
      }
    } catch { /* malformed prefix — skip */ }
  }
  if (prev && prev.timestamp > now + 60_000) {
    return { reason: `wall_clock regressed by ${prev.timestamp - now}ms since previous event` }
  }
  return null
}

export function insertEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string }
): RedLogEvent | null {
  const db = getDB()
  const now = Date.now()

  if ((agentType === 'shell' || agentType === 'agent') && data.command) {
    // Dedup real duplicates (same subtype + same command within 2s) — but *never*
    // collapse a command_start/command_end pair into one. The previous
    // implementation `LIKE '%"command":"..."%'` matched on the raw JSON blob
    // and did not care about subtype, so a fast command's command_end (fired
    // ~10ms after command_start with an identical `data.command`) was silently
    // dropped — breaking timeline pair-collapse, /api/terminal/replay, and
    // pivot-close detection. Key structurally on (subtype, command, terminalId).
    //
    // v0.6.86 also dedups across shell↔agent: a Claude Code hook (`agent`)
    // shelling out to `ls` also gets caught by shell-preexec-hook (`shell`),
    // producing two rows for the same intent. When (command, terminal_id) or
    // (command, pid) match across types within 2s, whichever fires second is
    // dropped. Kept subtype-sensitive so a `command_end` from either source can
    // still land after a `command_start`.
    const cmd = String(data.command)
    const subtype = data.subtype != null ? String(data.subtype) : ''
    const terminalId = data.terminal_id != null ? String(data.terminal_id) : ''
    const pid = data.pid != null ? String(data.pid) : ''
    const twoSecondsAgo = now - 2000
    const candidates = db.prepare(
      `SELECT id, agent_type, data FROM events WHERE agent_type IN ('shell','agent') AND timestamp >= ? ORDER BY timestamp DESC LIMIT 20`
    ).all(twoSecondsAgo) as Array<{ id: string; agent_type: string; data: string }>
    for (const row of candidates) {
      let d: Record<string, unknown> = {}
      try { d = JSON.parse(row.data) } catch { continue }
      const rowSubtype = d.subtype != null ? String(d.subtype) : ''
      const rowCmd = d.command != null ? String(d.command) : ''
      const rowTerminalId = d.terminal_id != null ? String(d.terminal_id) : ''
      const rowPid = d.pid != null ? String(d.pid) : ''
      if (rowSubtype !== subtype) continue
      if (rowCmd !== cmd) continue
      if (row.agent_type === agentType) {
        // Same-type dedup: terminal_id must match exactly.
        if (rowTerminalId !== terminalId) continue
      } else {
        // Cross-type dedup (shell↔agent): terminal_id or pid must match, so we
        // don't accidentally drop two unrelated agents running `ls` at the same
        // time. If neither carries a matching linker, skip cross-type dedup.
        const tidMatch = terminalId !== '' && rowTerminalId === terminalId
        const pidMatch = pid !== '' && rowPid === pid
        if (!tidMatch && !pidMatch) continue
      }
      return null
    }
  }

  const prevRow = db.prepare(
    'SELECT hash FROM events ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get() as { hash: string } | undefined
  const prevHash = prevRow?.hash ?? null

  if (!opts?.operatorId) {
    throw new Error(`insertEvent: operatorId is required (agent_type=${agentType}). ` +
      `Every event must resolve to a known operator — see docs/operators.md.`)
  }
  const hostname = os.hostname()
  const paddedMono = padMonoNs(monotonicNs())

  // v0.6.88 P2-A: tag the event before hashing so the anomaly is part of
  // the chain (a later attacker can't strip it without a hash mismatch).
  const anomaly = detectClockAnomaly(now, paddedMono, hostname)
  const dataForChain: Record<string, unknown> = anomaly ? { ...data, _clock_anomaly: anomaly } : data

  const event: RedLogEvent = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts?.engagementId ?? 'default',
    sessionId,
    operatorId: opts.operatorId,
    agentType,
    hostname,
    sourceIP: null,
    targetId: opts?.targetId ?? null,
    data: dataForChain,
    prevHash,
    createdAt: now,
    monotonicNs: paddedMono,
    ntpOffsetMs: getNtpOffsetMs()
  }

  // v0.6.88 P0-A: canonical serialisation for hash. New rows land as
  // hash-shape "v0.6.88". verifyChainFull tries this shape first, then
  // falls back to legacy JSON.stringify shapes for pre-existing rows.
  const canonicalForHash = canonicalStringify({ ...event, hash: undefined, prevHash })
  const hash = crypto
    .createHash('sha256')
    .update(canonicalForHash)
    .digest('hex')
  event.hash = hash

  // v0.6.89: sign the same canonical JSON with the operator's Ed25519 key.
  // Returns null when the key file is missing (pre-v0.6.89 operator, wiped
  // key, or filesystem error); the row still lands — chain hash keeps it
  // integrity-protected, verifyChainFull flags it "unsigned" not "broken".
  const signature = signEvent(canonicalForHash, event.operatorId)
  event.signature = signature

  db.prepare(`
    INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id, agent_type, hostname, source_ip, target_id, data, hash, prev_hash, created_at, monotonic_ns, ntp_offset_ms, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.timestamp, event.engagementId, event.sessionId,
    event.operatorId, event.agentType, event.hostname, event.sourceIP,
    event.targetId, JSON.stringify(event.data), event.hash, event.prevHash, event.createdAt,
    event.monotonicNs, event.ntpOffsetMs, event.signature
  )

  lastEventForClockCheck = {
    timestamp: event.timestamp,
    monotonic: event.monotonicNs || '',
    hostname: event.hostname,
    sessionId: event.sessionId
  }

  return event
}

export function queryEvents(opts: {
  agentType?: string
  limit?: number
  since?: number
  // Pagination anchor: return events strictly older than this WALL-CLOCK
  // timestamp. Kept for compatibility but the Timeline pager now prefers
  // `beforeCreatedAt` because wall-clock can regress on NTP correction and
  // silently skip a newly-arrived event that landed with an older ts.
  before?: number
  // Preferred pager anchor — created_at is monotonic within a run (Date.now
  // at write instant, but callers can't rewind DB insertion order) so walking
  // strictly older rows works even under wall-clock backwards jump. v0.6.87
  // audit A1.
  beforeCreatedAt?: number
  targetId?: string
  // When true, drop RedLog's own housekeeping rows (api_started, shell
  // session_start, hook-source command_start, deconfliction_test) at the SQL
  // layer. Previously Timeline fetched 200 rows and filtered them to ~30
  // visible client-side, which meant the pager marked itself "all loaded"
  // when fewer than 200 came back — but the visible count was tiny.
  excludeHousekeeping?: boolean
}): RedLogEvent[] {
  const db = getDB()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agentType) {
    conditions.push('agent_type = ?')
    params.push(opts.agentType)
  }
  if (opts.since) {
    conditions.push('timestamp >= ?')
    params.push(opts.since)
  }
  if (opts.before) {
    conditions.push('timestamp < ?')
    params.push(opts.before)
  }
  if (opts.beforeCreatedAt) {
    conditions.push('created_at < ?')
    params.push(opts.beforeCreatedAt)
  }
  if (opts.targetId) {
    conditions.push('target_id = ?')
    params.push(opts.targetId)
  }
  if (opts.excludeHousekeeping) {
    conditions.push(HOUSEKEEPING_SQL)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 200

  const rows = db.prepare(
    `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...params, limit) as Array<Record<string, unknown>>

  return rows.map(rowToEvent)
}

export function getEventCount(): number {
  const db = getDB()
  const row = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
  return row.count
}

export function searchEvents(query: string, limit = 100): RedLogEvent[] {
  const db = getDB()
  const pattern = `%${query}%`
  const rows = db.prepare(
    `SELECT * FROM events WHERE data LIKE ? OR target_id LIKE ? OR agent_type LIKE ?
     ORDER BY timestamp DESC LIMIT ?`
  ).all(pattern, pattern, pattern, limit) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
}

export function queryScopeFilteredEvents(scopeTargets: string[]): RedLogEvent[] {
  const db = getDB()
  // Push obvious no-target exclusions into SQL so we don't drag half the
  // engagement's clipboard/system rows into memory just to drop them. Pattern
  // matching against user-supplied scope targets stays in JS because SQLite
  // has no cheap wildcard/glob for arbitrary patterns like `*.example.com`.
  const excluded = Array.from(EXCLUDED_NO_TARGET_TYPES)
  const allowedNoTarget = Array.from(ALLOWED_NO_TARGET_TYPES)
  const excludedPlaceholders = excluded.map(() => '?').join(',')
  const allowedPlaceholders = allowedNoTarget.map(() => '?').join(',')
  const sql = `
    SELECT * FROM events
    WHERE (
      target_id IS NOT NULL
      OR agent_type IN (${allowedPlaceholders})
    )
    AND agent_type NOT IN (${excludedPlaceholders})
    ORDER BY timestamp DESC
    LIMIT 100000
  `
  const rows = db.prepare(sql).all(...allowedNoTarget, ...excluded) as Array<Record<string, unknown>>
  const events = rows.map(rowToEvent)
  if (scopeTargets.length === 0) return events

  return events.filter((e) => {
    if (e.targetId) return scopeTargets.some((t) => matchTarget(e.targetId!, t))
    return ALLOWED_NO_TARGET_TYPES.has(e.agentType)
  })
}

function matchTarget(target: string, pattern: string): boolean {
  const t = target.toLowerCase()
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) {
    const domain = p.slice(2)
    return t === domain || t.endsWith('.' + domain)
  }
  if (p.includes('/')) {
    return t.startsWith(p.split('/')[0])
  }
  return t === p || t.includes(p)
}

function rowToEvent(row: Record<string, unknown>): RedLogEvent {
  return {
    id: row.id as string,
    timestamp: row.timestamp as number,
    engagementId: row.engagement_id as string,
    sessionId: row.session_id as string,
    operatorId: row.operator_id as string,
    agentType: row.agent_type as string,
    hostname: row.hostname as string,
    sourceIP: row.source_ip as string | null,
    targetId: row.target_id as string | null,
    data: JSON.parse(row.data as string),
    hash: row.hash as string,
    prevHash: (row.prev_hash as string | null) ?? null,
    createdAt: row.created_at as number,
    monotonicNs: (row.monotonic_ns as string | null) ?? null,
    ntpOffsetMs: (row.ntp_offset_ms as number | null) ?? null,
    signature: (row.signature as string | null) ?? null
  }
}
