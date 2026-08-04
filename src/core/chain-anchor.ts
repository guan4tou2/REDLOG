import crypto from 'crypto'
import https from 'https'
import { URL } from 'url'
import { getDB } from './db/index'
import { canonicalStringify } from './db/events'
import { verifyEventSignature } from './signing'

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
  upgraded?: boolean
  upgradedAt?: number | null
  upgradedBytes?: number
}

const UPGRADED_MIN_BYTES = 200

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

export function computeChainHead(maxEvents?: number): { hash: string; headEventId: string | null; eventCount: number } | null {
  const db = getDB()
  if (maxEvents !== undefined) {
    const rows = db.prepare(
      `SELECT id, hash FROM events WHERE hash IS NOT NULL ORDER BY created_at ASC, rowid ASC LIMIT ?`
    ).all(maxEvents) as { id: string; hash: string }[]
    if (!rows.length) return null
    const last = rows[rows.length - 1]
    const hash = crypto.createHash('sha256')
      .update(last.hash)
      .update(String(rows.length))
      .digest('hex')
    return { hash, headEventId: last.id, eventCount: rows.length }
  }
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
  const anchor = insertAnchor({
    headEventId: head.headEventId,
    headHash: head.hash,
    eventCount: head.eventCount,
    calendarReceipts: receipts,
    status,
    createdAt: now,
    completedAt: okCount > 0 ? now : null
  })

  // v0.6.88 P2-B: an anchor failure is currently silent — dashboard shows
  // "last anchor: N hours ago" and the operator has no idea why it stopped
  // renewing. Emit a `system.anchor_failed` audit event so the chain records
  // that OTS submission failed and delivery bundles carry the reason.
  if (status === 'failed') {
    try {
      const { insertEvent } = require('./db/events') as typeof import('./db/events')
      const ops = require('./db/operators') as { getPrimaryOperator?: () => { id: string } | null }
      const opId = ops.getPrimaryOperator?.()?.id
      if (opId) {
        insertEvent('system', {
          subtype: 'anchor_failed',
          headHash: head.hash,
          eventCount: head.eventCount,
          calendarsAttempted: calendars.length,
          receipts: receipts.map((r) => ({ calendar: r.calendar, ok: r.ok, error: r.error })),
          description: `OTS anchor failed across ${calendars.length} calendars`
        }, { operatorId: opId })
      }
    } catch { /* audit event best-effort; anchor row itself is the real record */ }
  }

  return anchor
}

let loopTimer: ReturnType<typeof setInterval> | null = null
let upgradeTimer: ReturnType<typeof setInterval> | null = null

export function startAnchorLoop(intervalMs = 60 * 60 * 1000, upgradeIntervalMs = 6 * 60 * 60 * 1000): void {
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

  const upgradeTick = async (): Promise<void> => {
    try { await upgradeAllPending() } catch { /* best effort */ }
  }
  upgradeTimer = setInterval(upgradeTick, upgradeIntervalMs)
  setTimeout(upgradeTick, 2 * 60_000)
}

export function stopAnchorLoop(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null }
  if (upgradeTimer) { clearInterval(upgradeTimer); upgradeTimer = null }
}

export function verifyLatestAnchor(): { ok: boolean; anchor: ChainAnchor | null; currentHead: string | null } {
  const last = getLastAnchor()
  const head = computeChainHead()
  if (!last || !head) return { ok: false, anchor: last, currentHead: head?.hash ?? null }
  const countOk = last.eventCount <= head.eventCount
  const recomputedAtAnchor = computeChainHead(last.eventCount)
  const hashOk = recomputedAtAnchor ? recomputedAtAnchor.hash === last.headHash : false
  return { ok: countOk && hashOk, anchor: last, currentHead: head.hash }
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

function getTimestamp(calendarUrl: string, headHashHex: string): Promise<{ ok: boolean; status: number; body?: Buffer; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL
    try { parsed = new URL(calendarUrl + '/timestamp/' + headHashHex) } catch (e) { return resolve({ ok: false, status: 0, error: (e as Error).message }) }
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.opentimestamps.v1',
        'User-Agent': 'RedLog-anchor/0.1'
      },
      timeout: HTTP_TIMEOUT_MS
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const s = res.statusCode ?? 0
        if (s >= 200 && s < 300 && body.length > 0) resolve({ ok: true, status: s, body })
        else resolve({ ok: false, status: s, error: `HTTP ${s}` })
      })
    })
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }) })
    req.end()
  })
}

export async function upgradeAnchor(id: string): Promise<ChainAnchor | null> {
  const db = getDB()
  const existing = getAnchorById(id)
  if (!existing) return null

  const receipts = await Promise.all(existing.calendarReceipts.map(async (r) => {
    if (!r.ok || r.upgraded) return r
    const res = await getTimestamp(r.calendar, existing.headHash)
    if (res.ok && res.body) {
      const b64 = res.body.toString('base64')
      const wasPending = r.receiptB64 ?? ''
      const isBigger = res.body.length >= UPGRADED_MIN_BYTES && b64 !== wasPending
      return {
        ...r,
        receiptB64: b64,
        upgraded: isBigger,
        upgradedAt: isBigger ? Date.now() : (r.upgradedAt ?? null),
        upgradedBytes: res.body.length
      }
    }
    return { ...r, upgraded: false, upgradedAt: r.upgradedAt ?? null, error: res.error ?? r.error }
  }))

  const anyUpgraded = receipts.some((r) => r.upgraded)
  const allUpgraded = receipts.filter((r) => r.ok).every((r) => r.upgraded)
  const status = allUpgraded ? 'complete' : (anyUpgraded ? 'partial' : existing.status)

  db.prepare(
    `UPDATE chain_anchors SET calendar_receipts = ?, status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?`
  ).run(JSON.stringify(receipts), status, anyUpgraded ? Date.now() : existing.completedAt, id)

  return getAnchorById(id)
}

export async function upgradeAllPending(): Promise<{ upgraded: number; scanned: number }> {
  const anchors = listAnchors(1000).filter((a) => a.calendarReceipts.some((r) => r.ok && !r.upgraded))
  let upgraded = 0
  for (const a of anchors) {
    const result = await upgradeAnchor(a.id)
    if (result && result.calendarReceipts.some((r) => r.upgraded)) upgraded++
  }
  return { upgraded, scanned: anchors.length }
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
  // v0.6.89: per-event Ed25519 signature roll-up.
  //   signedCount   — rows with a signature that verifies against the
  //                   operator's DB-stored public key.
  //   unsignedCount — rows without a signature (legacy pre-v0.6.89, or an
  //                   operator without a signing key). Not a failure signal
  //                   on its own — chain hash still protects them.
  //   badSignatureAtEventId — first row whose signature is present but does
  //                   NOT verify. That IS a tamper signal; also causes ok=false.
  signedCount: number
  unsignedCount: number
  badSignatureAtEventId: string | null
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
  signature: string | null
}

export function verifyChainFull(): FullVerifyResult {
  const db = getDB()
  const anchor = getLastAnchor()
  const currentHead = computeChainHead()

  const rowIter = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms, signature
     FROM events ORDER BY created_at ASC, rowid ASC`
  ).iterate() as IterableIterator<WalkRow>

  // v0.6.89: cache operator → public key lookups. verifyChainFull walks the
  // full events table; a typical operator set is <20, so a Map keyed by
  // operator_id is cheaper than a JOIN and lets us surface "no pubkey" as
  // "unsigned" cleanly.
  const pubKeyCache = new Map<string, string | null>()
  const pubKeyStmt = db.prepare(`SELECT signer_pub_key FROM operators WHERE id = ?`)
  const lookupPubKey = (opId: string): string | null => {
    if (pubKeyCache.has(opId)) return pubKeyCache.get(opId) ?? null
    const row = pubKeyStmt.get(opId) as { signer_pub_key: string | null } | undefined
    const key = row?.signer_pub_key ?? null
    pubKeyCache.set(opId, key)
    return key
  }

  let walked = 0
  let expectedPrev: string | null = null
  let lastHash: string | null = null
  const clockAnomalies: ClockAnomaly[] = []
  const prevByHostSession = new Map<string, WalkRow>()
  let signedCount = 0
  let unsignedCount = 0
  let badSignatureAtEventId: string | null = null

  for (const row of rowIter) {
    walked++
    // A pre-v0.2 event has no prev_hash column at all — the migration added
    // the column but populated existing rows with NULL rather than backfilling
    // the actual prior-event hash. Treat NULL prev_hash on any row (not just
    // row 0) as a legacy-migration state, not tampering. New (v0.2+) events
    // still get strict chain-linkage checking.
    if (row.prev_hash != null && row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `prev_hash mismatch (expected ${expectedPrev ?? 'null'}, got ${row.prev_hash ?? 'null'})`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies,
        signedCount,
        unsignedCount,
        badSignatureAtEventId
      }
    }

    // Schema evolved over the v0.x line — an event's stored hash may have
    // been computed over one of THREE object shapes:
    //   (v0.1) no prevHash, no monotonicNs/ntpOffsetMs
    //   (v0.2) prevHash present, no monotonicNs/ntpOffsetMs
    //   (v0.6) prevHash + monotonicNs + ntpOffsetMs (null-inclusive)
    // Rebuild each explicitly (don't rely on Object.spread ordering) and
    // try in order; only reject when all three differ. Rewriting old hashes
    // would defeat the point of the chain (an operator couldn't distinguish
    // schema evolution from tampering), so this stays a read-side shim.
    const parsedData = JSON.parse(row.data)
    const shapeV01: Record<string, unknown> = {
      id: row.id, timestamp: row.timestamp,
      engagementId: row.engagement_id, sessionId: row.session_id,
      operatorId: row.operator_id, agentType: row.agent_type,
      hostname: row.hostname, sourceIP: row.source_ip, targetId: row.target_id,
      data: parsedData,
      hash: undefined,
      createdAt: row.created_at
    }
    const shapeV02: Record<string, unknown> = {
      id: row.id, timestamp: row.timestamp,
      engagementId: row.engagement_id, sessionId: row.session_id,
      operatorId: row.operator_id, agentType: row.agent_type,
      hostname: row.hostname, sourceIP: row.source_ip, targetId: row.target_id,
      data: parsedData,
      hash: undefined,
      prevHash: row.prev_hash,
      createdAt: row.created_at
    }
    const shapeV06: Record<string, unknown> = { ...shapeV02 }
    if (row.monotonic_ns != null) shapeV06.monotonicNs = row.monotonic_ns
    if (row.ntp_offset_ms != null) shapeV06.ntpOffsetMs = row.ntp_offset_ms
    // Additional variant: v0.6 with explicit null values (some code paths
    // spread the event object even when monotonicNs was null).
    const shapeV06Null: Record<string, unknown> = { ...shapeV02, monotonicNs: row.monotonic_ns ?? null, ntpOffsetMs: row.ntp_offset_ms ?? null }
    // v0.6.88 P0-A: canonical shape uses `canonicalStringify` (sorted keys).
    // New rows land here; verify tries this first because it's the most-recent
    // computation. Falls back to the older per-shape JSON.stringify variants
    // for rows written before v0.6.88.
    const reconstructed = shapeV06
    const jsonSha = (obj: Record<string, unknown>): string =>
      crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')
    const canonicalSha = (obj: Record<string, unknown>): string =>
      crypto.createHash('sha256').update(canonicalStringify(obj)).digest('hex')
    const target = row.hash
    // Try shapes in newest-first order — most events on a modern chain are
    // v0.6.88 canonical. Older rows fall through to legacy JSON.stringify.
    const attempts: Array<{ label: string; hash: string }> = [
      { label: 'v0.6.88', hash: canonicalSha(shapeV06Null) },
      { label: 'v0.6.88+strip', hash: canonicalSha(shapeV06) },
      { label: 'v0.6', hash: jsonSha(shapeV06) },
      { label: 'v0.6+null', hash: jsonSha(shapeV06Null) },
      { label: 'v0.2', hash: jsonSha(shapeV02) },
      { label: 'v0.1', hash: jsonSha(shapeV01) }
    ]
    const matched = attempts.find((a) => a.hash === target)
    if (!matched) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `hash mismatch (tried ${attempts.map((a) => `${a.label}=${a.hash.slice(0, 8)}`).join(', ')}, stored ${(target ?? '').slice(0, 16)}...)`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies,
        signedCount,
        unsignedCount,
        badSignatureAtEventId
      }
    }
    void reconstructed  // shape-dependent, kept in scope for potential downstream use

    // v0.6.89: per-event Ed25519 signature check. Only rows whose stored hash
    // matched the v0.6.88 canonical shape (label starts with "v0.6.88") have
    // a canonical string we can verify against — older shapes never carried
    // signatures anyway, so we skip them cleanly. Signatures are additive:
    //   present + verifies  → signedCount++
    //   present + FAILS     → hard error (tamper); mark ok=false
    //   absent              → unsignedCount++ (pre-v0.6.89 or unsigned operator)
    if (row.signature) {
      if (matched.label.startsWith('v0.6.88')) {
        const pubKey = lookupPubKey(row.operator_id)
        if (!pubKey) {
          // Signature is on the row but we can't find the pubkey to check —
          // treat as unsigned rather than tamper (operator row could have
          // been wiped; that's a data-integrity problem worth surfacing but
          // not proof of chain tampering).
          unsignedCount++
        } else {
          const canonicalJson = matched.label === 'v0.6.88+strip'
            ? canonicalStringify(shapeV06)
            : canonicalStringify(shapeV06Null)
          const sigOk = verifyEventSignature(canonicalJson, row.signature, pubKey)
          if (sigOk) {
            signedCount++
          } else {
            if (badSignatureAtEventId == null) badSignatureAtEventId = row.id
            return {
              ok: false,
              walked,
              brokenAtEventId: row.id,
              brokenReason: 'signature invalid',
              currentHead: currentHead?.hash ?? null,
              anchor,
              anchorMatchesWalkedHead: false,
              clockAnomalies,
              signedCount,
              unsignedCount,
              badSignatureAtEventId
            }
          }
        }
      } else {
        // Row carries a signature but the hash matched a legacy shape — no
        // canonical string exists that would round-trip both. Count as
        // unsigned rather than fail; the chain hash still protected the row.
        unsignedCount++
      }
    } else {
      unsignedCount++
    }

    const key = `${row.hostname}|${row.session_id}`
    const prev = prevByHostSession.get(key)
    if (prev && prev.monotonic_ns && row.monotonic_ns) {
      // v0.6.88 P3-A: monotonic_ns may carry a `${bootPad}-${nsPad}` prefix.
      // Strip it for the numeric compare. If the two rows have different
      // boot epochs, the compare is meaningless (they're from different
      // process runs) — skip anomaly detection in that case.
      const parse = (s: string): { boot: string; ns: bigint } | null => {
        try {
          if (s.includes('-')) {
            const [boot, ns] = s.split('-', 2)
            return { boot, ns: BigInt(ns) }
          }
          return { boot: '', ns: BigInt(s) }
        } catch { return null }
      }
      const pr = parse(prev.monotonic_ns)
      const cur = parse(row.monotonic_ns)
      if (pr && cur && pr.boot === cur.boot) {
        const wallDelta = row.timestamp - prev.timestamp
        const monoDelta = Number((cur.ns - pr.ns) / 1000000n)
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
    clockAnomalies,
    signedCount,
    unsignedCount,
    badSignatureAtEventId
  }
}

// v0.6.89 P1-A: read-path sampling verify. verifyChainFull walks the whole
// chain and is Settings-button-only; a chain-aware attacker that edits N rows,
// recomputes hashes forward, and rebuilds the OTS-anchored region has time
// before the operator manually verifies. Sampling turns detection into a
// probability: run K random rows on every project open + every 5 minutes,
// and the odds of tampering escaping N runs shrinks exponentially.
//
// Each sampled row re-hashes across the same shape variants verifyChainFull
// tries (canonical/v0.6.88/v0.6/v0.6+null/v0.2/v0.1) and — for rows that
// carry a prev_hash (v0.2+) — verifies the link against the ACTUAL previous
// row's stored hash. Pre-v0.2 rows have a null prev_hash from the migration;
// treat null as a legacy migration state, not tampering, exactly like
// verifyChainFull does.
//
// TODO: share the per-row hash-shape validation with verifyChainFull. The two
// duplicate ~30 lines of shape-attempt logic. Refactoring would introduce a
// helper with 15+ parameters (or a Row type) and hurt readability more than
// it helps; keep duplicated for now, but any change to the shape list MUST
// be made in both places.
export interface RandomSampleResult {
  ok: boolean
  sampled: number
  brokenAtEventId: string | null
  brokenReason: string | null
}

interface SampleRow {
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

export function verifyRandomSample(count = 50): RandomSampleResult {
  const db = getDB()
  // ORDER BY RANDOM() is O(n) — fine at 10k events (< 20ms), acceptable at
  // 100k, painful at 1M. A future scaling switch would sample by rowid range
  // (SELECT id FROM events WHERE rowid = ?) with a rowid histogram; not
  // needed at current scale but noted here so a slowdown at 1M+ rows has a
  // clear next step.
  const rows = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms
     FROM events WHERE hash IS NOT NULL ORDER BY RANDOM() LIMIT ?`
  ).all(count) as SampleRow[]

  if (rows.length === 0) {
    return { ok: true, sampled: 0, brokenAtEventId: null, brokenReason: null }
  }

  const prevLookup = db.prepare(
    `SELECT hash FROM events WHERE created_at < ? OR (created_at = ? AND rowid < ?) ORDER BY created_at DESC, rowid DESC LIMIT 1`
  )
  const rowIdOf = db.prepare(`SELECT rowid AS rid FROM events WHERE id = ?`)

  const jsonSha = (obj: Record<string, unknown>): string =>
    crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')
  const canonicalSha = (obj: Record<string, unknown>): string =>
    crypto.createHash('sha256').update(canonicalStringify(obj)).digest('hex')

  for (const row of rows) {
    // Re-hash the row under every legal shape (same list as verifyChainFull).
    let parsedData: unknown
    try { parsedData = JSON.parse(row.data) } catch {
      return { ok: false, sampled: rows.length, brokenAtEventId: row.id, brokenReason: 'data column is not valid JSON' }
    }
    const shapeV01: Record<string, unknown> = {
      id: row.id, timestamp: row.timestamp,
      engagementId: row.engagement_id, sessionId: row.session_id,
      operatorId: row.operator_id, agentType: row.agent_type,
      hostname: row.hostname, sourceIP: row.source_ip, targetId: row.target_id,
      data: parsedData, hash: undefined, createdAt: row.created_at
    }
    const shapeV02: Record<string, unknown> = {
      id: row.id, timestamp: row.timestamp,
      engagementId: row.engagement_id, sessionId: row.session_id,
      operatorId: row.operator_id, agentType: row.agent_type,
      hostname: row.hostname, sourceIP: row.source_ip, targetId: row.target_id,
      data: parsedData, hash: undefined, prevHash: row.prev_hash, createdAt: row.created_at
    }
    const shapeV06: Record<string, unknown> = { ...shapeV02 }
    if (row.monotonic_ns != null) shapeV06.monotonicNs = row.monotonic_ns
    if (row.ntp_offset_ms != null) shapeV06.ntpOffsetMs = row.ntp_offset_ms
    const shapeV06Null: Record<string, unknown> = { ...shapeV02, monotonicNs: row.monotonic_ns ?? null, ntpOffsetMs: row.ntp_offset_ms ?? null }

    const target = row.hash
    const attempts: Array<{ label: string; hash: string }> = [
      { label: 'v0.6.88', hash: canonicalSha(shapeV06Null) },
      { label: 'v0.6.88+strip', hash: canonicalSha(shapeV06) },
      { label: 'v0.6', hash: jsonSha(shapeV06) },
      { label: 'v0.6+null', hash: jsonSha(shapeV06Null) },
      { label: 'v0.2', hash: jsonSha(shapeV02) },
      { label: 'v0.1', hash: jsonSha(shapeV01) }
    ]
    if (!attempts.some((a) => a.hash === target)) {
      return {
        ok: false,
        sampled: rows.length,
        brokenAtEventId: row.id,
        brokenReason: `hash mismatch (tried ${attempts.map((a) => a.label).join(', ')}, stored ${(target ?? '').slice(0, 16)}...)`
      }
    }

    // Link verify: skip when the row itself has NULL prev_hash (legacy
    // migration state — verifyChainFull ignores it on purpose). For rows
    // that DO carry a prev_hash, the immediately preceding row (by
    // created_at + rowid) must exist and match.
    if (row.prev_hash != null) {
      const rid = rowIdOf.get(row.id) as { rid: number } | undefined
      if (!rid) continue
      const prev = prevLookup.get(row.created_at, row.created_at, rid.rid) as { hash: string } | undefined
      if (!prev) {
        return {
          ok: false,
          sampled: rows.length,
          brokenAtEventId: row.id,
          brokenReason: `prev_hash points at ${row.prev_hash.slice(0, 16)}... but no preceding row exists`
        }
      }
      if (prev.hash !== row.prev_hash) {
        return {
          ok: false,
          sampled: rows.length,
          brokenAtEventId: row.id,
          brokenReason: `prev_hash mismatch (expected ${prev.hash.slice(0, 16)}..., got ${row.prev_hash.slice(0, 16)}...)`
        }
      }
    }
  }

  return { ok: true, sampled: rows.length, brokenAtEventId: null, brokenReason: null }
}
