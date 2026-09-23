import crypto from 'crypto'
import { eventBus } from '../event-bus'
import os from 'os'
import { getDB } from './index'
import { monotonicNs, getNtpOffsetMs } from '../clock'
import { signEvent } from '../signing'
import { storeRaw, type RawRef } from '../raw-store'
import type { RedLogEvent, EnvelopeInput, StoredEnvelope } from './event-types'
import { ENVELOPE_SCHEMA_VERSION } from './event-types'

/** Store the raw bytes (if any) and fold their digest into `data` so the hash
 *  covers them. Returns the column values for the envelope. Pure except for
 *  the raw-store write. */
function prepareEnvelope(data: Record<string, unknown>, env: EnvelopeInput | undefined): StoredEnvelope {
  if (!env) return { rawRef: null, mapper: null, source: null, tsSource: null, schemaVersion: ENVELOPE_SCHEMA_VERSION }
  let rawRef: RawRef | null = null
  if (env.raw !== undefined) {
    rawRef = storeRaw(env.raw, { encoding: env.rawEncoding })
    // Fold into data BEFORE hashing so the chain closes over the raw digest.
    data._raw = rawRef
  }
  return {
    rawRef,
    mapper: env.mapper ?? null,
    source: env.source ?? null,
    tsSource: env.tsSource ?? null,
    schemaVersion: env.schemaVersion ?? ENVELOPE_SCHEMA_VERSION
  }
}

// ─── v0.13.0 two-tier classifier ────────────────────────────────────────────
//
// Tier assignment is data-driven from (agent_type, subtype). The rubric:
//   Q1. Would a court/blue team ask for THIS row alone?  → chained.
//   Q2. Does it earn keep via `_causes` to a chained row? → logged.
// See docs/DESIGN-two-tier-chain.md §2 for the full table and reasoning.
// Anything not listed here defaults to `chained` — unknown-source rows
// are treated as high-value evidence until an operator (or a plugin
// manifest) opts them into `logged`.

/** (agent_type, subtype) tuples that write to `events_logged` instead of
 *  `events`. Keyed as `"agent_type:subtype"` to mirror the shape of
 *  `PAUSE_EXEMPT_AGENT_TYPES` (constant-time membership check). */
const LOGGED_TIER: ReadonlySet<string> = new Set([
  // mitmproxy DNS producer (agent_type=dns)
  'dns:dns_query',
  'dns:dns_response',
  // mitmproxy HTTP producer (agent_type=scanner)
  'scanner:http_request_start',
  'scanner:http_response',
  'scanner:http_error',
  'scanner:http_request_dropped',
  'scanner:ws_message',
  'scanner:tcp_message',
  'scanner:cookie_change',
  // CDP browser console. `browser_launched` + top-level navigation stay
  // CHAINED — they're session-genesis rows.
  'browser:console',
  // Agent chain-of-thought — the `tool_call` that follows IS chained.
  'agent:thinking',
  // Process-monitor self-instrumentation. `process_spawn`/`process_exit`
  // are provisionally logged; §2.3 of the design doc flags a reconsider
  // ticket if a real IR investigation ever cites one.
  'process:process_spawn',
  'process:process_exit',
  'system:process_monitor_saturated',
  'system:process_monitor_ps_unavailable',
  // v0.15: pcap producer (hooks/pcap-agent.py) — high-volume network metadata.
  // Logged, not chained: a port scan is thousands of probes, and these are
  // supporting context that earns its keep via `_causes` to the shell command
  // that ran the scan, not court-alone evidence. Default-chained would bloat
  // the tamper-evident spine with packet noise.
  'pcap:connection_attempt',
  'pcap:port_scan',
  'pcap:connection_established',
  'pcap:connection_refused',
  'pcap:udp_flow'
])

// Design doc §4.1 hedged a `system.ip_verdict` special case that would route
// heartbeat "unchanged" ticks to the logged tier. That branch is DEAD in
// practice: `IPPolicy.evaluate` at src/core/alert/policies.ts:143 dedups
// unchanged verdicts and returns `[]`, so no `ip_verdict` event with
// `ip_verdict_kind === 'unchanged'` is ever emitted — the surface only
// writes real state changes. Every emitted ip_verdict is chain-worthy;
// the default fallback below routes it correctly. If a future policy
// starts emitting explicit heartbeat ticks, re-add the special case
// alongside the emitter change and cover it with an end-to-end test.

/** Which table an insertEvent call should target. Every real (agentType,
 *  subtype) pair emitted by RedLog must resolve here to exactly one
 *  tier — the `tier-classifier-total` test enforces that. Unknown pairs
 *  default to `chained` as the fail-safe direction (see §2.1 of the design
 *  doc: downgrading chained→logged later would need a version bump;
 *  upgrading logged→chained is additive). */
export function classifyTier(
  agentType: string,
  data: Record<string, unknown>
): 'chained' | 'logged' {
  const subtype = typeof data.subtype === 'string' ? data.subtype : ''
  if (LOGGED_TIER.has(`${agentType}:${subtype}`)) return 'logged'
  return 'chained'
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
  // v0.6.95 P0-4b: reset the in-memory prev-hash cache. The next insertEvent
  // will hit the DB once (via `ensureLastHash`) then take over as source of
  // truth. Cache lives per-process; a project switch closes the DB and reopens
  // it, so the cached hash from the OLD project must not seed the NEW one.
  cachedLastHash = SENTINEL_UNSEEDED
  // v0.6.97 C: same invariant for the row-count cache.
  cachedEventCount = null
}

// v0.6.95 P0-4b: prev-hash cache. Every event's hash chains onto the last
// event's hash — previously that meant an `ORDER BY created_at DESC LIMIT 1`
// query per insert. At 100k rows without an index the read cost dominated
// the write. Now: we seed once from the DB on first use (or after a rebuild
// event), and thereafter each successful insertEvent updates the cache in
// place. Any DB write error resets the cache back to unseeded so the next
// insert re-reads from disk rather than chaining onto a hash the DB may
// not actually have committed.
const SENTINEL_UNSEEDED = Symbol('unseeded')
let cachedLastHash: string | null | typeof SENTINEL_UNSEEDED = SENTINEL_UNSEEDED

function ensureLastHash(): string | null {
  if (cachedLastHash !== SENTINEL_UNSEEDED) return cachedLastHash
  const db = getDB()
  const row = db.prepare(
    'SELECT hash FROM events ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get() as { hash: string } | undefined
  cachedLastHash = row?.hash ?? null
  return cachedLastHash
}

/**
 * Forget the cached chain head so the next insert re-reads it from the table.
 *
 * Required by anything that changes what is in `events` outside insertEvent —
 * rebuild flows, tests mutating via raw SQL, and crucially any ROLLBACK of a
 * transaction that contained inserts. insertEvent advances the cache after each
 * successful INSERT and only resets it when that INSERT itself throws, so a
 * rollback triggered by anything else leaves the cache pointing at a hash that
 * is no longer in the table — and the next insert anywhere in the app chains
 * onto a row that does not exist.
 */
export function invalidateChainHeadCache(): void {
  cachedLastHash = SENTINEL_UNSEEDED
}

// Row-count cache. getEventCount is called on every StatusBar tick and every
// dashboard render. With 200k+ rows a full scan takes 40-80ms and
// blocks the main thread. Now: seed once via COUNT, then increment on every
// successful insert. Any write path that mutates the events table outside
// insertEvent (rebuild, DELETE via a bypassed trigger, migration) must call
// `resetEventCountCache` — mirror of the prev-hash cache invariant. Reset
// on project switch via resetSession too.
let cachedEventCount: number | null = null

export function resetEventCountCache(): void {
  cachedEventCount = null
}

/** @internal — read the cached event count (used by getEventCount in event-queries). */
export function _getCachedEventCount(): number | null { return cachedEventCount }
/** @internal — seed the cached event count (used by getEventCount in event-queries). */
export function _setCachedEventCount(v: number | null): void { cachedEventCount = v }

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
                       agent_type, subtype, hostname, session_id, engagement_id,
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
// Every event is hashed with this canonical representation.
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

// v0.15 logged-tier integrity (docs/DESIGN-two-tier-chain.md §7.5 / §8): the
// logged tier is deliberately un-chained and un-signed — see the events_logged
// schema comment in db/index.ts. That is the tier, not an oversight, so it has
// no per-row tamper-evidence by design. Rather than pay a per-row hash on the
// hot write path (which would defeat the tier's whole reason to exist), we fold
// ONE cheap digest over the tier on demand — at export/audit time — and let the
// caller record it into the chained tier, where the OTS anchor already reaches.
// §8 always said the honest way to prove "these logged rows existed at time T"
// is to hash the logged tier and anchor the hash; this is that hash, in a single
// index-ordered streaming scan (O(1) memory, canonical-key hashing like the
// chain), so an export carries a verifiable snapshot with zero write-path cost.
export function loggedTierDigest(maxRowId?: number): {
  count: number
  sha256: string
  oldest: number | null
  newest: number | null
} {
  const db = getDB()
  // Same column projection and ordering the bundle dump uses (bundle-export.ts),
  // so the digest is a faithful fingerprint of what an export serialises.
  // iterate() keeps a single row resident regardless of tier size.
  const rows = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, created_at
     FROM events_logged${maxRowId === undefined ? '' : ' WHERE rowid <= ?'}
     ORDER BY created_at ASC, rowid ASC`
  ).iterate(...(maxRowId === undefined ? [] : [maxRowId])) as IterableIterator<Record<string, unknown>>
  const h = crypto.createHash('sha256')
  let count = 0
  let oldest: number | null = null
  let newest: number | null = null
  for (const row of rows) {
    // Newline-delimited canonical rows: the delimiter stops two adjacent rows
    // from being ambiguous with one row whose fields happen to concatenate to
    // the same bytes. canonicalStringify sorts keys so the fingerprint is stable
    // across Node versions and export/import round-trips (same rationale the
    // chain hash relies on).
    h.update(canonicalStringify(row))
    h.update('\n')
    const ts = row.timestamp as number
    if (oldest === null || ts < oldest) oldest = ts
    if (newest === null || ts > newest) newest = ts
    count++
  }
  return { count, sha256: h.digest('hex'), oldest, newest }
}

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
// under `_clock_anomaly` so verifyChainFullAsync can surface it and Timeline
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

/** Lanes that keep recording while paused. `system` is RedLog's audit trail
 *  about itself and the environment — dropping it would leave the pause
 *  itself unrecorded. `marker` is an explicit "write this down" action.
 *  Everything else is passive capture and stops. */
export const PAUSE_EXEMPT_AGENT_TYPES: ReadonlySet<string> = new Set(['system', 'marker'])

export function insertEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string; bypassPause?: boolean; envelope?: EnvelopeInput }
): RedLogEvent | null {
  // Pause enforcement stays at the front door for BOTH tiers. See the
  // block comment below (previously the head of this function) for why
  // `system`/`marker` are exempt and why the gate lives here instead of
  // at the 46 call sites.
  if (!PAUSE_EXEMPT_AGENT_TYPES.has(agentType) && !opts?.bypassPause && eventBus.paused) return null

  // v0.13.0: two-tier dispatch. The chained arm is the ENTIRE historical
  // body of insertEvent (hash + Ed25519 sign + INSERT into `events`). The
  // logged arm skips the chain machinery entirely and lands in
  // `events_logged`. See docs/DESIGN-two-tier-chain.md §4.
  const tier = classifyTier(agentType, data)
  if (tier === 'logged') return insertLoggedEvent(agentType, data, opts)
  return insertChainedEvent(agentType, data, opts)
}

/** The historical chained path — hash-linked + Ed25519-signed, lands in
 *  `events`. See the block comment before insertEvent for the pause
 *  reasoning; every existing invariant (dedup window, prev_hash cache,
 *  clock-anomaly stamp, canonical serialisation, signature) stays here. */
function insertChainedEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string; bypassPause?: boolean; envelope?: EnvelopeInput }
): RedLogEvent | null {
  // v0.9.5: pause means "do not record", not "do not display". Before this the
  // gate lived only on eventBus.publish(), so a paused RedLog still wrote every
  // event into the DB and the hash chain — it only stopped the UI feed. The
  // README promised daily/hobby work stayed off the
  // audit chain; it did not. Enforcing here rather than at the 46 call sites
  // means no capture source can forget.
  //
  // `system` is exempt: that lane is RedLog's audit trail about itself and the
  // environment — recording_paused/resumed, config_changed, sanitized,
  // secret_revealed, *_pruned, ip_transition, opsec_state_changed,
  // chain_sample_broken. Dropping those would make the pause itself
  // unrecorded, and a gap in the timeline has to stay explainable; that is the
  // premise the whole log rests on.
  //
  // `marker` is exempt for the same reason screenshot-agent already exempts a
  // manual capture: a marker is the operator (or agent) deliberately writing
  // something down, not something RedLog observed. Pause suppresses passive
  // capture; it was never meant to refuse an explicit "record this".
  //
  // `bypassPause` covers the remaining deliberate actions — today the manual
  // screenshot trigger.

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
    // shelling out to `ls` also gets caught by the active shell adapter,
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

  // v0.6.95 P0-4b: prev-hash from the in-memory cache instead of a fresh
  // SQL lookup per insert. `ensureLastHash` hits the DB only when the cache
  // is unseeded (post-initDB or after a manual reset); every subsequent
  // insert reads from memory. Cache is refreshed AFTER a successful INSERT
  // below so a mid-write crash doesn't leak the uncommitted hash to the
  // next insert. Composite index `idx_events_created_at (created_at, rowid)`
  // protects the cold-path query in `ensureLastHash`.
  const prevHash = ensureLastHash()

  if (!opts?.operatorId) {
    throw new Error(`insertEvent: operatorId is required (agent_type=${agentType}). ` +
      `Every event must resolve to a known operator — see docs/operators.md.`)
  }
  const hostname = os.hostname()
  const paddedMono = padMonoNs(monotonicNs())

  // Envelope: store raw bytes (if any) and fold their digest into `data`
  // before the anomaly stamp and the hash, so the chain covers the raw sha256.
  const env = prepareEnvelope(data, opts?.envelope)

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
    ntpOffsetMs: getNtpOffsetMs(),
    tier: 'chained'
  }

  // Canonical serialisation for the hash and signature payload.
  const canonicalForHash = canonicalStringify({ ...event, hash: undefined, prevHash })
  const hash = crypto
    .createHash('sha256')
    .update(canonicalForHash)
    .digest('hex')
  event.hash = hash

  // Sign the same canonical JSON with the operator's Ed25519 key.
  // Returns null when the key file is missing or inaccessible; the row still lands — chain hash keeps it
  // integrity-protected, verifyChainFullAsync flags it "unsigned" not "broken".
  const signature = signEvent(canonicalForHash, event.operatorId)
  event.signature = signature

  // Denormalized subtype column — a copy of data.subtype so WHERE clauses
  // hit the composite index instead of json_extract.
  const subtypeCol = typeof dataForChain.subtype === 'string' ? dataForChain.subtype : null
  // P2-2: denormalized transcript_uuid for buildSeedIndex.
  const transcriptUuid = typeof dataForChain.transcript_uuid === 'string' ? dataForChain.transcript_uuid : null

  try {
    db.prepare(`
      INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id, agent_type, subtype, hostname, source_ip, target_id, data, hash, prev_hash, created_at, monotonic_ns, ntp_offset_ms, signature, raw_ref, mapper, schema_version, ts_source, source, transcript_uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.timestamp, event.engagementId, event.sessionId,
      event.operatorId, event.agentType, subtypeCol, event.hostname, event.sourceIP,
      event.targetId, JSON.stringify(event.data), event.hash, event.prevHash, event.createdAt,
      event.monotonicNs, event.ntpOffsetMs, event.signature,
      env.rawRef ? JSON.stringify(env.rawRef) : null,
      env.mapper ? JSON.stringify(env.mapper) : null,
      env.schemaVersion, env.tsSource, env.source, transcriptUuid
    )
  } catch (e) {
    // v0.6.95 P0-4b: any INSERT failure invalidates the cached prev-hash —
    // we don't know whether the row actually landed, so the next insert must
    // re-derive from the DB. Without this reset a UNIQUE-constraint retry
    // (or any transient write error) could chain the next event onto a hash
    // that isn't in the table, silently breaking the chain.
    cachedLastHash = SENTINEL_UNSEEDED
    throw e
  }

  // Commit the just-inserted hash as the new chain head. Only reached on a
  // successful INSERT (the try/catch above resets on error).
  cachedLastHash = event.hash ?? null
  // v0.6.97 C: increment count cache when seeded; leave unseeded state alone
  // so the next getEventCount does the seeding scan against the true row set.
  if (cachedEventCount !== null) cachedEventCount++

  lastEventForClockCheck = {
    timestamp: event.timestamp,
    monotonic: event.monotonicNs || '',
    hostname: event.hostname,
    sessionId: event.sessionId
  }

  return event
}

/** The logged-tier insert path (v0.13.0). Deliberately does NOT:
 *  - Update `cachedLastHash` (no chain contribution).
 *  - Update `cachedEventCount` (that count is chain-scoped — the anchor
 *    uses it).
 *  - Run `detectClockAnomaly` (only meaningful on rows the chain will
 *    one day rehash).
 *  - Compute canonical JSON or sign anything.
 *  - Enter the shell-command dedup window (dedup is chained-tier
 *    concern; logged rows are high-volume and dedup would cost more
 *    than it saves).
 *
 *  The returned event has `hash: undefined`, `signature: null`,
 *  `prevHash: null`, `monotonicNs: null`, `ntpOffsetMs: null`, and
 *  `tier: 'logged'`. Callers reading `event.hash` on a logged row and
 *  expecting a value have a bug the tier classifier just exposed — that
 *  is the design intent, not a regression. */
function insertLoggedEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string; bypassPause?: boolean; envelope?: EnvelopeInput }
): RedLogEvent | null {
  if (!opts?.operatorId) {
    throw new Error(`insertEvent (logged): operatorId is required (agent_type=${agentType}). ` +
      `Every event must resolve to a known operator — see docs/operators.md.`)
  }
  const db = getDB()
  const now = Date.now()
  const env = prepareEnvelope(data, opts.envelope)
  const event: RedLogEvent = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts.engagementId ?? 'default',
    sessionId,
    operatorId: opts.operatorId,
    agentType,
    hostname: os.hostname(),
    sourceIP: null,
    targetId: opts.targetId ?? null,
    data,
    createdAt: now,
    // Deliberately absent — see the block above.
    hash: undefined,
    prevHash: null,
    monotonicNs: null,
    ntpOffsetMs: null,
    signature: null,
    tier: 'logged'
  }
  const subtypeCol = typeof data.subtype === 'string' ? data.subtype : null

  try {
    db.prepare(`
      INSERT INTO events_logged
        (id, timestamp, engagement_id, session_id, operator_id, agent_type, subtype,
         hostname, source_ip, target_id, data, created_at, raw_ref, mapper, schema_version, ts_source, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.timestamp, event.engagementId, event.sessionId,
      event.operatorId, event.agentType, subtypeCol, event.hostname, event.sourceIP,
      event.targetId, JSON.stringify(event.data), event.createdAt,
      env.rawRef ? JSON.stringify(env.rawRef) : null,
      env.mapper ? JSON.stringify(env.mapper) : null,
      env.schemaVersion, env.tsSource, env.source
    )
  } catch (e) {
    // Logged-tier writes should fail loud — there's no chain cache to
    // invalidate, so callers just get null and can decide what to do.
    console.error('[insertLoggedEvent] insert failed:', e)
    return null
  }
  return event
}
