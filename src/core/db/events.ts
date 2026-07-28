import crypto from 'crypto'
import os from 'os'
import { getDB } from './index'
import { monotonicNs, getNtpOffsetMs } from '../clock'

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
}

let sessionId = crypto.randomUUID()

const ALLOWED_NO_TARGET_TYPES = new Set(['marker', 'screenshot'])
const EXCLUDED_NO_TARGET_TYPES = new Set(['clipboard', 'system'])

export function insertEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string }
): RedLogEvent | null {
  const db = getDB()
  const now = Date.now()

  if (agentType === 'shell' && data.command) {
    const twoSecondsAgo = now - 2000
    const dup = db.prepare(
      `SELECT id FROM events WHERE agent_type = 'shell' AND timestamp >= ? AND data LIKE ? ORDER BY timestamp DESC LIMIT 1`
    ).get(twoSecondsAgo, `%"command":"${String(data.command).replace(/"/g, '\\"')}"%`) as { id: string } | undefined
    if (dup) return null
  }

  const prevRow = db.prepare(
    'SELECT hash FROM events ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get() as { hash: string } | undefined
  const prevHash = prevRow?.hash ?? null

  if (!opts?.operatorId) {
    throw new Error(`insertEvent: operatorId is required (agent_type=${agentType}). ` +
      `Every event must resolve to a known operator — see docs/operators.md.`)
  }
  const event: RedLogEvent = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts?.engagementId ?? 'default',
    sessionId,
    operatorId: opts.operatorId,
    agentType,
    hostname: os.hostname(),
    sourceIP: null,
    targetId: opts?.targetId ?? null,
    data,
    prevHash,
    createdAt: now,
    monotonicNs: monotonicNs(),
    ntpOffsetMs: getNtpOffsetMs()
  }

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...event, hash: undefined, prevHash }))
    .digest('hex')
  event.hash = hash

  db.prepare(`
    INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id, agent_type, hostname, source_ip, target_id, data, hash, prev_hash, created_at, monotonic_ns, ntp_offset_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.timestamp, event.engagementId, event.sessionId,
    event.operatorId, event.agentType, event.hostname, event.sourceIP,
    event.targetId, JSON.stringify(event.data), event.hash, event.prevHash, event.createdAt,
    event.monotonicNs, event.ntpOffsetMs
  )

  return event
}

export function queryEvents(opts: {
  agentType?: string
  limit?: number
  since?: number
  targetId?: string
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
  if (opts.targetId) {
    conditions.push('target_id = ?')
    params.push(opts.targetId)
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
  const all = db.prepare(
    'SELECT * FROM events ORDER BY timestamp DESC LIMIT 100000'
  ).all() as Array<Record<string, unknown>>

  const events = all.map(rowToEvent)
  if (scopeTargets.length === 0) return events

  return events.filter((e) => {
    if (e.targetId) {
      return scopeTargets.some((t) => matchTarget(e.targetId!, t))
    }
    if (ALLOWED_NO_TARGET_TYPES.has(e.agentType)) return true
    if (EXCLUDED_NO_TARGET_TYPES.has(e.agentType)) return false
    return false
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
    ntpOffsetMs: (row.ntp_offset_ms as number | null) ?? null
  }
}
