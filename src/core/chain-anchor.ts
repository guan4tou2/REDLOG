import crypto from 'crypto'
import https from 'https'
import { URL } from 'url'
import { getDB } from './db/index'

export interface ChainAnchor {
  id: string
  headEventId: string | null
  headHash: string
  eventCount: number
  calendarReceipts: CalendarReceipt[]
  status: 'pending' | 'partial' | 'complete' | 'failed'
  createdAt: number
  completedAt: number | null
}

export interface CalendarReceipt {
  calendar: string
  ok: boolean
  receiptB64?: string
  error?: string
  submittedAt: number
}

const DEFAULT_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://finney.calendar.eternitywall.com'
]

const HTTP_TIMEOUT_MS = 15000

interface AnchorRow {
  id: string
  head_event_id: string | null
  head_hash: string
  event_count: number
  calendar_receipts: string
  status: string
  created_at: number
  completed_at: number | null
}

function rowToAnchor(row: AnchorRow): ChainAnchor {
  let receipts: CalendarReceipt[] = []
  try { receipts = JSON.parse(row.calendar_receipts) } catch { /* */ }
  return {
    id: row.id,
    headEventId: row.head_event_id,
    headHash: row.head_hash,
    eventCount: row.event_count,
    calendarReceipts: receipts,
    status: row.status as ChainAnchor['status'],
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

export function computeChainHead(): { hash: string; headEventId: string | null; eventCount: number } | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT id, hash FROM events WHERE hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get() as { id: string; hash: string } | undefined
  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM events WHERE hash IS NOT NULL`
  ).get() as { count: number }
  if (!row) return null
  const hash = crypto.createHash('sha256')
    .update(row.hash)
    .update(String(countRow.count))
    .digest('hex')
  return { hash, headEventId: row.id, eventCount: countRow.count }
}

export function listAnchors(limit = 50): ChainAnchor[] {
  const db = getDB()
  const rows = db.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as AnchorRow[]
  return rows.map(rowToAnchor)
}

export function getLastAnchor(): ChainAnchor | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors ORDER BY created_at DESC LIMIT 1`
  ).get() as AnchorRow | undefined
  return row ? rowToAnchor(row) : null
}

function postDigest(calendarUrl: string, hashBytes: Buffer): Promise<CalendarReceipt> {
  return new Promise((resolve) => {
    const submittedAt = Date.now()
    const parsed = new URL(calendarUrl + '/digest')
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.opentimestamps.v1',
        'Content-Length': hashBytes.length,
        'User-Agent': 'RedLog-anchor/0.1'
      },
      timeout: HTTP_TIMEOUT_MS
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && body.length > 0) {
          resolve({
            calendar: calendarUrl,
            ok: true,
            receiptB64: body.toString('base64'),
            submittedAt
          })
        } else {
          resolve({
            calendar: calendarUrl,
            ok: false,
            error: `HTTP ${res.statusCode}`,
            submittedAt
          })
        }
      })
    })
    req.on('error', (err) => {
      resolve({ calendar: calendarUrl, ok: false, error: err.message, submittedAt })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ calendar: calendarUrl, ok: false, error: 'timeout', submittedAt })
    })
    req.write(hashBytes)
    req.end()
  })
}

function insertAnchor(a: Omit<ChainAnchor, 'id'>): ChainAnchor {
  const db = getDB()
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO chain_anchors (id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, a.headEventId, a.headHash, a.eventCount,
    JSON.stringify(a.calendarReceipts), a.status, a.createdAt, a.completedAt
  )
  return { ...a, id }
}

export async function anchorNow(calendars: string[] = DEFAULT_CALENDARS): Promise<ChainAnchor | null> {
  const head = computeChainHead()
  if (!head) return null

  const hashBytes = Buffer.from(head.hash, 'hex')
  const receipts = await Promise.all(calendars.map((cal) => postDigest(cal, hashBytes)))

  const okCount = receipts.filter((r) => r.ok).length
  let status: ChainAnchor['status'] = 'failed'
  if (okCount > 0 && okCount === calendars.length) status = 'complete'
  else if (okCount > 0) status = 'partial'

  const now = Date.now()
  return insertAnchor({
    headEventId: head.headEventId,
    headHash: head.hash,
    eventCount: head.eventCount,
    calendarReceipts: receipts,
    status,
    createdAt: now,
    completedAt: okCount > 0 ? now : null
  })
}

let loopTimer: ReturnType<typeof setInterval> | null = null

export function startAnchorLoop(intervalMs = 60 * 60 * 1000): void {
  stopAnchorLoop()
  const tick = async (): Promise<void> => {
    try {
      const head = computeChainHead()
      if (!head) return
      const last = getLastAnchor()
      if (last && last.headHash === head.hash && last.status !== 'failed') return
      await anchorNow()
    } catch { /* best effort */ }
  }
  loopTimer = setInterval(tick, intervalMs)
  setTimeout(tick, 30_000)
}

export function stopAnchorLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}

export function verifyLatestAnchor(): { ok: boolean; anchor: ChainAnchor | null; currentHead: string | null } {
  const last = getLastAnchor()
  const head = computeChainHead()
  if (!last || !head) return { ok: false, anchor: last, currentHead: head?.hash ?? null }
  const ok = last.eventCount <= head.eventCount
  return { ok, anchor: last, currentHead: head.hash }
}
