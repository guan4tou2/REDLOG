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

export function verifyLatestAnchor(): { ok: boolean; anchor: ChainAnchor | null; currentHead: string | null; noAnchor?: boolean } {
  const last = getLastAnchor()
  const head = computeChainHead()
  // v0.9.4: "never anchored" is not "the anchor disagrees with the chain".
  // `ok` stays false — nothing has been verified — but `noAnchor` lets callers
  // say which one it is. The Settings panel already branched on `anchor ===
  // null`; the CLI printed "MISMATCH — investigate" and exited 2, and the MCP
  // tool handed agents a bare {ok:false}, so an agent following the ship skill
  // would report a broken evidence chain on a brand-new project.
  if (!last || !head) return { ok: false, noAnchor: !last, anchor: last, currentHead: head?.hash ?? null }
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

// v0.6.95 P0-4a: shared walker state so both the sync `verifyChainFull` and
// the async `verifyChainFullAsync` (chunked, yields to the main loop) can
// call the same per-row logic. Extracting this lets us short-circuit shape
// attempts lazily — most rows on a modern chain match the v0.6.88 canonical
// shape, and older shapes only need to be computed as fallbacks. Previously
// the walker eagerly computed all 6 SHA-256 hashes per row — 30-second block
// at 100k events.
interface WalkerState {
  walked: number
  expectedPrev: string | null
  lastHash: string | null
  clockAnomalies: ClockAnomaly[]
  prevByHostSession: Map<string, WalkRow>
  signedCount: number
  unsignedCount: number
  badSignatureAtEventId: string | null
  seenNonNullPrevHash: boolean
  lookupPubKey: (opId: string) => string | null
}

// v0.7.1 P3: subset of the row shape needed to rebuild a hash. Both
// WalkRow (verifyChainFull) and SampleRow (verifyRandomSample) satisfy
// this structurally — the previous TODO warned that sharing the shape
// list would need a helper with 15+ parameters, but bundling them into
// this interface keeps the call sites one-argument.
export interface HashableRow {
  id: string
  timestamp: number
  engagement_id: string
  session_id: string
  operator_id: string
  agent_type: string
  hostname: string
  source_ip: string | null
  target_id: string | null
  created_at: number
  prev_hash: string | null
  monotonic_ns: string | null
  ntp_offset_ms: number | null
}

export interface HashShapes {
  v01: Record<string, unknown>
  v02: Record<string, unknown>
  v06: () => Record<string, unknown>
  v06Null: Record<string, unknown>
}

// v0.7.1 P3: single source of truth for the hash shape list. Called by
// both verifyRowHash (full walk) and the random-sample loop; if a new
// shape is ever added, this is the only place to touch. The `v06` variant
// stays a thunk — its content depends on whether monotonic_ns / ntp_offset_ms
// are present, and lazy evaluation avoids the mutation-during-spread hazard.
export function buildHashShapes(row: HashableRow, parsedData: unknown): HashShapes {
  const v01: Record<string, unknown> = {
    id: row.id, timestamp: row.timestamp,
    engagementId: row.engagement_id, sessionId: row.session_id,
    operatorId: row.operator_id, agentType: row.agent_type,
    hostname: row.hostname, sourceIP: row.source_ip, targetId: row.target_id,
    data: parsedData, hash: undefined, createdAt: row.created_at
  }
  const v02: Record<string, unknown> = { ...v01, prevHash: row.prev_hash }
  const v06 = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...v02 }
    if (row.monotonic_ns != null) o.monotonicNs = row.monotonic_ns
    if (row.ntp_offset_ms != null) o.ntpOffsetMs = row.ntp_offset_ms
    return o
  }
  const v06Null: Record<string, unknown> = {
    ...v02, monotonicNs: row.monotonic_ns ?? null, ntpOffsetMs: row.ntp_offset_ms ?? null
  }
  return { v01, v02, v06, v06Null }
}

// Rebuild each hash shape lazily. `label` names the shape so we can log which
// one matched; `build` computes SHA-256 on demand. We try canonical first
// (~99% of rows on a modern chain), then progressively older shapes. The
// first match wins and no later shapes get hashed.
function verifyRowHash(row: WalkRow, parsedData: unknown):
  { matched: { label: string; canonicalJsonForSig: string | null } | null; attemptLabels: string[] } {
  // v0.7.1 P3: shape objects now come from the shared buildHashShapes
  // helper; the sample-verify path uses the same source. The `build:`
  // callbacks below expect thunks, so v01/v06Null land in a lambda for
  // parity with v06 (which is already a thunk because its content depends
  // on optional column presence).
  const shapes = buildHashShapes(row, parsedData)
  const shapeV02 = shapes.v02
  const shapeV06 = shapes.v06
  const shapeV06Null = (): Record<string, unknown> => shapes.v06Null
  const shapeV01 = (): Record<string, unknown> => shapes.v01

  const target = row.hash
  const attempts: Array<{
    label: string
    build: () => Record<string, unknown>
    hash: (o: Record<string, unknown>) => string
    canonical: (o: Record<string, unknown>) => string | null
  }> = [
    // Newest-first — v0.6.88 canonical dominates on any modern chain.
    { label: 'v0.6.88',       build: shapeV06Null, hash: (o) => canonicalSha(o), canonical: (o) => canonicalStringify(o) },
    { label: 'v0.6.88+strip', build: shapeV06,     hash: (o) => canonicalSha(o), canonical: (o) => canonicalStringify(o) },
    { label: 'v0.6',          build: shapeV06,     hash: (o) => jsonSha(o),      canonical: () => null },
    { label: 'v0.6+null',     build: shapeV06Null, hash: (o) => jsonSha(o),      canonical: () => null },
    { label: 'v0.2',          build: () => shapeV02, hash: (o) => jsonSha(o),    canonical: () => null },
    { label: 'v0.1',          build: shapeV01,     hash: (o) => jsonSha(o),      canonical: () => null }
  ]
  const attemptLabels: string[] = []
  for (const a of attempts) {
    const obj = a.build()
    const h = a.hash(obj)
    attemptLabels.push(`${a.label}=${h.slice(0, 8)}`)
    if (h === target) {
      return { matched: { label: a.label, canonicalJsonForSig: a.canonical(obj) }, attemptLabels }
    }
  }
  return { matched: null, attemptLabels }
}

const jsonSha = (obj: Record<string, unknown>): string =>
  crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')
const canonicalSha = (obj: Record<string, unknown>): string =>
  crypto.createHash('sha256').update(canonicalStringify(obj)).digest('hex')

// Returns a FullVerifyResult if this row breaks the chain (caller should
// return it immediately); null otherwise. State is mutated in place so the
// walker can resume with the same counters.
function processRow(row: WalkRow, state: WalkerState, currentHeadHash: string | null, anchor: ChainAnchor | null): FullVerifyResult | null {
  state.walked++
  // A pre-v0.2 event has no prev_hash column at all — the migration added
  // the column but populated existing rows with NULL rather than backfilling
  // the actual prior-event hash. NULL prev_hash is legitimate ONLY for the
  // leading (pre-migration) rows, before any row with prev_hash appears.
  if (row.prev_hash != null) {
    state.seenNonNullPrevHash = true
    if (row.prev_hash !== state.expectedPrev) {
      return {
        ok: false,
        walked: state.walked,
        brokenAtEventId: row.id,
        brokenReason: `prev_hash mismatch (expected ${state.expectedPrev ?? 'null'}, got ${row.prev_hash ?? 'null'})`,
        currentHead: currentHeadHash,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies: state.clockAnomalies,
        signedCount: state.signedCount,
        unsignedCount: state.unsignedCount,
        badSignatureAtEventId: state.badSignatureAtEventId
      }
    }
  } else if (state.seenNonNullPrevHash) {
    // v0.6.93 P0-A: NULL prev_hash after we've already crossed the
    // migration boundary = forgery. Silent-forgery vector documented in
    // the v0.6.92.1 security audit.
    return {
      ok: false,
      walked: state.walked,
      brokenAtEventId: row.id,
      brokenReason: 'NULL prev_hash after migration boundary (v0.6.93 forgery-check)',
      currentHead: currentHeadHash,
      anchor,
      anchorMatchesWalkedHead: false,
      clockAnomalies: state.clockAnomalies,
      signedCount: state.signedCount,
      unsignedCount: state.unsignedCount,
      badSignatureAtEventId: state.badSignatureAtEventId
    }
  }

  // Rebuild hash shapes lazily and short-circuit on the first match. Most
  // events on a modern chain match the first (v0.6.88 canonical) shape, so
  // legacy shapes never need to be computed.
  const parsedData = JSON.parse(row.data)
  const { matched, attemptLabels } = verifyRowHash(row, parsedData)
  if (!matched) {
    return {
      ok: false,
      walked: state.walked,
      brokenAtEventId: row.id,
      brokenReason: `hash mismatch (tried ${attemptLabels.join(', ')}, stored ${(row.hash ?? '').slice(0, 16)}...)`,
      currentHead: currentHeadHash,
      anchor,
      anchorMatchesWalkedHead: false,
      clockAnomalies: state.clockAnomalies,
      signedCount: state.signedCount,
      unsignedCount: state.unsignedCount,
      badSignatureAtEventId: state.badSignatureAtEventId
    }
  }

  // v0.6.89: per-event Ed25519 signature check. Only rows whose stored hash
  // matched the v0.6.88 canonical shape have a canonical string we can verify
  // against — older shapes never carried signatures anyway.
  if (row.signature) {
    if (matched.label.startsWith('v0.6.88') && matched.canonicalJsonForSig) {
      const pubKey = state.lookupPubKey(row.operator_id)
      if (!pubKey) {
        state.unsignedCount++
      } else {
        const sigOk = verifyEventSignature(matched.canonicalJsonForSig, row.signature, pubKey)
        if (sigOk) {
          state.signedCount++
        } else {
          if (state.badSignatureAtEventId == null) state.badSignatureAtEventId = row.id
          return {
            ok: false,
            walked: state.walked,
            brokenAtEventId: row.id,
            brokenReason: 'signature invalid',
            currentHead: currentHeadHash,
            anchor,
            anchorMatchesWalkedHead: false,
            clockAnomalies: state.clockAnomalies,
            signedCount: state.signedCount,
            unsignedCount: state.unsignedCount,
            badSignatureAtEventId: state.badSignatureAtEventId
          }
        }
      }
    } else {
      state.unsignedCount++
    }
  } else {
    state.unsignedCount++
  }

  const key = `${row.hostname}|${row.session_id}`
  const prev = state.prevByHostSession.get(key)
  if (prev && prev.monotonic_ns && row.monotonic_ns) {
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
        state.clockAnomalies.push({
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
  state.prevByHostSession.set(key, row)

  state.expectedPrev = row.hash
  state.lastHash = row.hash
  return null
}

function initWalkerState(): WalkerState {
  const db = getDB()
  const pubKeyCache = new Map<string, string | null>()
  const pubKeyStmt = db.prepare(`SELECT signer_pub_key FROM operators WHERE id = ?`)
  return {
    walked: 0,
    expectedPrev: null,
    lastHash: null,
    clockAnomalies: [],
    prevByHostSession: new Map<string, WalkRow>(),
    signedCount: 0,
    unsignedCount: 0,
    badSignatureAtEventId: null,
    seenNonNullPrevHash: false,
    // v0.6.89: cache operator → public key lookups. verifyChainFull walks the
    // full events table; a typical operator set is <20, so a Map keyed by
    // operator_id is cheaper than a JOIN and lets us surface "no pubkey" as
    // "unsigned" cleanly.
    lookupPubKey: (opId: string): string | null => {
      if (pubKeyCache.has(opId)) return pubKeyCache.get(opId) ?? null
      const row = pubKeyStmt.get(opId) as { signer_pub_key: string | null } | undefined
      const key = row?.signer_pub_key ?? null
      pubKeyCache.set(opId, key)
      return key
    }
  }
}

function finaliseWalk(state: WalkerState, anchor: ChainAnchor | null, currentHead: ReturnType<typeof computeChainHead>): FullVerifyResult {
  let anchorMatchesWalkedHead = false
  if (anchor && state.lastHash) {
    const walkedHead = crypto.createHash('sha256').update(state.lastHash).update(String(state.walked)).digest('hex')
    anchorMatchesWalkedHead = walkedHead === anchor.headHash || anchor.eventCount <= state.walked
  }
  return {
    ok: true,
    walked: state.walked,
    brokenAtEventId: null,
    brokenReason: null,
    currentHead: currentHead?.hash ?? null,
    anchor,
    anchorMatchesWalkedHead,
    clockAnomalies: state.clockAnomalies,
    signedCount: state.signedCount,
    unsignedCount: state.unsignedCount,
    badSignatureAtEventId: state.badSignatureAtEventId
  }
}

const WALK_STMT_SQL =
  `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
          hostname, source_ip, target_id, data, hash, prev_hash, created_at,
          monotonic_ns, ntp_offset_ms, signature
   FROM events ORDER BY created_at ASC, rowid ASC`

export function verifyChainFull(): FullVerifyResult {
  const db = getDB()
  const anchor = getLastAnchor()
  const currentHead = computeChainHead()
  const state = initWalkerState()
  const rowIter = db.prepare(WALK_STMT_SQL).iterate() as IterableIterator<WalkRow>
  for (const row of rowIter) {
    const broken = processRow(row, state, currentHead?.hash ?? null, anchor)
    if (broken) return broken
  }
  return finaliseWalk(state, anchor, currentHead)
}

// v0.6.95 P0-4a: async variant that yields to the event loop every CHUNK rows.
// verifyChainFull walks the entire events table (with SHA-256 per row for up
// to 6 shape variants + Ed25519 verify), which at 100k events blocks the main
// thread for 10-30s and freezes the renderer. The async path drains a chunk,
// hands the main loop back with `setImmediate`, then resumes. Same result
// shape as the sync version — Electron IPC handlers should prefer this.
const ASYNC_CHUNK_ROWS = 1000
export async function verifyChainFullAsync(): Promise<FullVerifyResult> {
  const db = getDB()
  const anchor = getLastAnchor()
  const currentHead = computeChainHead()
  const state = initWalkerState()
  const rowIter = db.prepare(WALK_STMT_SQL).iterate() as IterableIterator<WalkRow>
  let inChunk = 0
  for (const row of rowIter) {
    const broken = processRow(row, state, currentHead?.hash ?? null, anchor)
    if (broken) return broken
    if (++inChunk >= ASYNC_CHUNK_ROWS) {
      inChunk = 0
      // setImmediate lets any queued IPC / renderer message process before we
      // grab the next chunk. Node's better-sqlite3 iterator is synchronous
      // but holding it across a setImmediate boundary is safe as long as no
      // interleaving statement is issued against the same DB — the pubkey
      // lookup goes through a separate prepared statement handle, which is
      // fine.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return finaliseWalk(state, anchor, currentHead)
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
// v0.7.1 P3: the per-row shape building lives in the shared `buildHashShapes`
// helper (defined next to verifyRowHash). Both callers rebuild the same 4
// shape variants via one call; only the attempts loop differs between them
// (full walk also derives canonicalJsonForSig for signature verify, sample
// doesn't need it). Any future shape change is a single-file edit.
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

  // v0.6.93 P0-A: query the migration boundary — the earliest rowid whose
  // prev_hash is NOT NULL. Rows sampled AFTER this rowid must carry a
  // non-NULL prev_hash; a NULL there is post-migration forgery (see
  // verifyChainFull for the full-walk version of this check).
  const firstNonNullRow = db.prepare(
    `SELECT MIN(rowid) AS rid FROM events WHERE prev_hash IS NOT NULL`
  ).get() as { rid: number | null } | undefined
  const migrationBoundaryRid = firstNonNullRow?.rid ?? Number.MAX_SAFE_INTEGER

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
    // v0.7.1 P3: shared shape builder — one edit surface across the full
    // walk (verifyRowHash) and this sample-verify path.
    const shapes = buildHashShapes(row, parsedData)
    const shapeV06 = shapes.v06()

    const target = row.hash
    const attempts: Array<{ label: string; hash: string }> = [
      { label: 'v0.6.88', hash: canonicalSha(shapes.v06Null) },
      { label: 'v0.6.88+strip', hash: canonicalSha(shapeV06) },
      { label: 'v0.6', hash: jsonSha(shapeV06) },
      { label: 'v0.6+null', hash: jsonSha(shapes.v06Null) },
      { label: 'v0.2', hash: jsonSha(shapes.v02) },
      { label: 'v0.1', hash: jsonSha(shapes.v01) }
    ]
    if (!attempts.some((a) => a.hash === target)) {
      return {
        ok: false,
        sampled: rows.length,
        brokenAtEventId: row.id,
        brokenReason: `hash mismatch (tried ${attempts.map((a) => a.label).join(', ')}, stored ${(target ?? '').slice(0, 16)}...)`
      }
    }

    // v0.6.93 P0-A: NULL prev_hash after the migration boundary = forgery.
    // Pre-boundary NULLs are legitimate legacy rows (v0.1/v0.2); post-
    // boundary NULLs are the exact attack vector the v0.6.92.1 audit called
    // out (attacker hashes under shapeV01 to fool the shape-tolerant walk).
    if (row.prev_hash == null) {
      const rid = rowIdOf.get(row.id) as { rid: number } | undefined
      if (rid && rid.rid >= migrationBoundaryRid) {
        return {
          ok: false,
          sampled: rows.length,
          brokenAtEventId: row.id,
          brokenReason: 'NULL prev_hash after migration boundary (v0.6.93 forgery-check)'
        }
      }
    }
    // Link verify: skip when the row itself has NULL prev_hash (legitimate
    // pre-migration state — the boundary check above already gated it).
    // For rows that DO carry a prev_hash, the immediately preceding row
    // (by created_at + rowid) must exist and match.
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
