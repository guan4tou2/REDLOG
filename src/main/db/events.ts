import crypto from 'crypto'
import os from 'os'
import { getDB } from './index'

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
  createdAt: number
}

let sessionId = crypto.randomUUID()

export function insertEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string }
): RedLogEvent {
  const db = getDB()
  const now = Date.now()
  const event: RedLogEvent = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts?.engagementId ?? 'default',
    sessionId,
    operatorId: opts?.operatorId ?? 'operator-1',
    agentType,
    hostname: os.hostname(),
    sourceIP: null,
    targetId: opts?.targetId ?? null,
    data,
    createdAt: now
  }

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...event, hash: undefined }))
    .digest('hex')
  event.hash = hash

  db.prepare(`
    INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id, agent_type, hostname, source_ip, target_id, data, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.timestamp, event.engagementId, event.sessionId,
    event.operatorId, event.agentType, event.hostname, event.sourceIP,
    event.targetId, JSON.stringify(event.data), event.hash, event.createdAt
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
    createdAt: row.created_at as number
  }
}
