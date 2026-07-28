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

const OTS_MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61,
  0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf,
  0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94
])
const OTS_VERSION = 0x01
const OTS_OP_SHA256 = 0x08

export function buildOtsBundle(headHashHex: string, receiptB64: string): Buffer {
  const digest = Buffer.from(headHashHex, 'hex')
  if (digest.length !== 32) throw new Error(`headHash must be 32 bytes (SHA-256), got ${digest.length}`)
  const timestamp = Buffer.from(receiptB64, 'base64')
  return Buffer.concat([
    OTS_MAGIC,
    Buffer.from([OTS_VERSION, OTS_OP_SHA256]),
    digest,
    timestamp
  ])
}

export function getAnchorById(id: string): ChainAnchor | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors WHERE id = ?`
  ).get(id) as AnchorRow | undefined
  return row ? rowToAnchor(row) : null
}

export interface ClockAnomaly {
  eventId: string
  prevEventId: string
  hostname: string
  sessionId: string
  wallDeltaMs: number
  monoDeltaMs: number
  diffMs: number
}

export interface FullVerifyResult {
  ok: boolean
  walked: number
  brokenAtEventId: string | null
  brokenReason: string | null
  currentHead: string | null
  anchor: ChainAnchor | null
  anchorMatchesWalkedHead: boolean
  clockAnomalies: ClockAnomaly[]
}

const CLOCK_TOLERANCE_MS = 5000

interface WalkRow {
  id: string
  timestamp: number
  engagement_id: string
  session_id: string
  operator_id: string
  agent_type: string
  hostname: string
  source_ip: string | null
  target_id: string | null
  data: string
  hash: string | null
  prev_hash: string | null
  created_at: number
  monotonic_ns: string | null
  ntp_offset_ms: number | null
}

export function verifyChainFull(): FullVerifyResult {
  const db = getDB()
  const anchor = getLastAnchor()
  const currentHead = computeChainHead()

  const rowIter = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms
     FROM events ORDER BY created_at ASC, rowid ASC`
  ).iterate() as IterableIterator<WalkRow>

  let walked = 0
  let expectedPrev: string | null = null
  let lastHash: string | null = null
  const clockAnomalies: ClockAnomaly[] = []
  const prevByHostSession = new Map<string, WalkRow>()

  for (const row of rowIter) {
    walked++
    if ((row.prev_hash ?? null) !== expectedPrev) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `prev_hash mismatch (expected ${expectedPrev ?? 'null'}, got ${row.prev_hash ?? 'null'})`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies
      }
    }

    const reconstructed: Record<string, unknown> = {
      id: row.id,
      timestamp: row.timestamp,
      engagementId: row.engagement_id,
      sessionId: row.session_id,
      operatorId: row.operator_id,
      agentType: row.agent_type,
      hostname: row.hostname,
      sourceIP: row.source_ip,
      targetId: row.target_id,
      data: JSON.parse(row.data),
      hash: undefined,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
      monotonicNs: row.monotonic_ns ?? null,
      ntpOffsetMs: row.ntp_offset_ms ?? null
    }
    const expectedHash = crypto.createHash('sha256').update(JSON.stringify(reconstructed)).digest('hex')
    if (expectedHash !== row.hash) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `hash mismatch (recomputed ${expectedHash.slice(0, 16)}..., stored ${(row.hash ?? '').slice(0, 16)}...)`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies
      }
    }

    const key = `${row.hostname}|${row.session_id}`
    const prev = prevByHostSession.get(key)
    if (prev && prev.monotonic_ns && row.monotonic_ns) {
      const wallDelta = row.timestamp - prev.timestamp
      const monoDelta = Number((BigInt(row.monotonic_ns) - BigInt(prev.monotonic_ns)) / 1000000n)
      const diff = Math.abs(wallDelta - monoDelta)
      if (diff > CLOCK_TOLERANCE_MS) {
        clockAnomalies.push({
          eventId: row.id,
          prevEventId: prev.id,
          hostname: row.hostname,
          sessionId: row.session_id,
          wallDeltaMs: wallDelta,
          monoDeltaMs: monoDelta,
          diffMs: diff
        })
      }
    }
    prevByHostSession.set(key, row)

    expectedPrev = row.hash
    lastHash = row.hash
  }

  let anchorMatchesWalkedHead = false
  if (anchor && lastHash) {
    const walkedHead = crypto.createHash('sha256').update(lastHash).update(String(walked)).digest('hex')
    anchorMatchesWalkedHead = walkedHead === anchor.headHash || anchor.eventCount <= walked
  }

  return {
    ok: true,
    walked,
    brokenAtEventId: null,
    brokenReason: null,
    currentHead: currentHead?.hash ?? null,
    anchor,
    anchorMatchesWalkedHead,
    clockAnomalies
  }
}
