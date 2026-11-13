// The receiver's stamp: `data._ingest` on every new row (Spec 071 FR-005,
// FR-006, plan D1).
//
// What a row says about where it came from used to be whatever the caller put
// in it — `data.source` is the producer's own word, and the `source` column is
// outside the hash. The stamp is the receiver's account instead: which door,
// which producer as the receiver authenticated it, which credential. It lives
// under one reserved key of `data`, so the hash formula is unchanged
// (FR-020): old rows have no `_ingest`, new rows do, and both verifiers check
// both the same way. Inside a chained row it is therefore inside the hash.
//
// The receiver owns four keys of `data`: this one, and the three insertEvent
// folds in itself (`_raw`, `_clock_anomaly`, `_source_time_rejected`). A
// caller's value for any of them is removed before the row is built, and the
// stamp names what was removed (`stripped`). `_causes` is the one underscore
// key a source may write (Domain Invariant 6).
//
// FR-006 limits the stamp to strings, integers, booleans, null and arrays of
// strings — the types both verifiers serialise byte for byte alike — with
// `claimed` as the one nested object FR-005 itself names, holding strings.

import crypto from 'crypto'
import { dbEngagement } from '../db/index'

/** FR-005's doors. Only `in-process` is written until the contract-1 receiver
 *  (Phase 5) and the doors of T030 are threaded through. */
export type IngestDoor = 'api' | 'handoff' | 'in-process' | 'legacy-api' | 'legacy-handoff'
export type IngestAuth = 'bearer' | 'mac' | 'in-process' | 'none'

/** Who wrote a row, as the receiver decided it when the row came in — never
 *  as the row says. */
export interface IngestEntrance {
  door: IngestDoor
  /** The receiver's producer: decided by the credential, or by the in-process
   *  caller (FR-012). A producer's own name for itself goes in `claimed`. */
  producer: string
  auth: IngestAuth
  /** `"<id>:<generation>"`; null in-process and until credentials exist (Phase 4). */
  credential: string | null
}

/** RedLog's own code writing a row. */
export const IN_PROCESS: IngestEntrance = { door: 'in-process', producer: 'in-process', auth: 'in-process', credential: null }

/** What an item said about itself that the stamp records. Nothing writes these
 *  before the contract-1 receiver (Phase 5) and Spec 075's rule list. */
export interface StampItem {
  eventId?: string
  instance?: string
  seq?: number
  /** A producer's own name (`name@version`) and operator: kept, not believed. */
  claimed?: { producer?: string; operator?: string }
  /** User Processor rules whose results this row carries (Spec 075 FR-059). */
  rules?: ReadonlyArray<{ pluginId: string; contentHash: string }>
  rulesPartial?: boolean
}

export interface IngestStamp {
  v: 1
  door: IngestDoor
  producer: string
  credential: string | null
  auth: IngestAuth
  event_id: string
  instance?: string
  seq?: number
  claimed?: { producer?: string; operator?: string }
  stripped?: string[]
  rules?: string[]
  rules_partial?: true
}

/** The keys of `data` only the receiver writes, in the order `stripped` lists them. */
export const RESERVED_DATA_KEYS = ['_ingest', '_raw', '_clock_anomaly', '_source_time_rejected'] as const

/** Remove the receiver-owned keys from `data`, in place, and say which were there. */
export function stripReserved(data: Record<string, unknown>): string[] {
  const removed: string[] = []
  for (const key of RESERVED_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      delete data[key]
      removed.push(key)
    }
  }
  return removed
}

// A claim is a source's word, bounded so it cannot crowd the stamp past
// FR-006's 512 bytes, and reduced to identifier characters so it serialises
// without escapes in either verifier.
const CLAIM_MAX = 32
const ID_MAX = 128
const ID_UNSAFE = /[^A-Za-z0-9._:@+/-]/g
const clip = (value: string, max: number): string => value.replace(ID_UNSAFE, '_').slice(0, max)

// FR-006: a rule item is `<pluginId>#<first 12 of the content hash>`, the id
// cut at 32 characters; at most three items, the third `+<the rest>` when more
// plugins took part.
const RULE_ID_MAX = 32
const RULE_HASH_CHARS = 12
const RULES_MAX = 3

function boundedRules(rules: ReadonlyArray<{ pluginId: string; contentHash: string }>): string[] {
  const items = [...new Set(rules.map((r) => `${clip(r.pluginId, RULE_ID_MAX)}#${clip(r.contentHash, RULE_HASH_CHARS)}`))].sort()
  if (items.length <= RULES_MAX) return items
  return [...items.slice(0, RULES_MAX - 1), `+${items.length - (RULES_MAX - 1)}`]
}

/** A UUIDv7 (RFC 9562): the first 48 bits are `now`, the rest random. The
 *  random bits come from crypto.randomUUID, so a test that fixes that fixes
 *  this too. */
function uuidV7(now: number): string {
  const random = crypto.randomUUID().replace(/-/g, '')
  const ms = Math.max(0, Math.floor(now)).toString(16).padStart(12, '0').slice(-12)
  // randomUUID is v4: hex 12 is its version digit, 16 its variant — which v7 keeps.
  const hex = `${ms}7${random.slice(13, 16)}${random.slice(16)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The stamp for one new row. `stripped` is what stripReserved removed from
 *  the caller's data; `now` is the receipt time. */
export function ingestStamp(
  entrance: IngestEntrance,
  opts: { tier: 'chained' | 'logged'; now: number; stripped?: readonly string[]; item?: StampItem }
): IngestStamp {
  const item = opts.item ?? {}
  const stamp: IngestStamp = {
    v: 1,
    door: entrance.door,
    producer: entrance.producer,
    credential: entrance.credential,
    auth: entrance.auth,
    // D4: an item without an event_id gets one from the receiver.
    event_id: item.eventId ? clip(item.eventId, ID_MAX) : uuidV7(opts.now)
  }
  if (item.instance) stamp.instance = clip(item.instance, ID_MAX)
  if (typeof item.seq === 'number' && Number.isSafeInteger(item.seq)) stamp.seq = item.seq
  // A logged row has no claims: the instance's own account is kept beside it
  // (plan, data shapes).
  if (opts.tier === 'chained' && item.claimed) {
    const claimed: { producer?: string; operator?: string } = {}
    if (item.claimed.producer) claimed.producer = clip(item.claimed.producer, CLAIM_MAX)
    if (item.claimed.operator) claimed.operator = clip(item.claimed.operator, CLAIM_MAX)
    if (claimed.producer || claimed.operator) stamp.claimed = claimed
  }
  if (opts.stripped && opts.stripped.length > 0) {
    stamp.stripped = RESERVED_DATA_KEYS.filter((k) => opts.stripped!.includes(k))
  }
  if (item.rules && item.rules.length > 0) stamp.rules = boundedRules(item.rules)
  if (item.rulesPartial === true) stamp.rules_partial = true
  return stamp
}

/** The engagement a new row is written under (FR-007): the one the open
 *  database is bound to, whatever the caller named. A database opened without
 *  a binding (tests and tools; db/index.ts bindDBEngagement) takes the
 *  caller's. With neither there is no project to write to, and nothing is
 *  written: the `default` engagement is gone. A caller that names another
 *  engagement than the bound one is refused before this, at the gate. */
export function engagementForWrite(requested: string | undefined): string {
  const bound = dbEngagement()
  if (bound !== null) return bound
  if (typeof requested === 'string' && requested.length > 0) return requested
  throw Object.assign(new Error('no project: the open database names no engagement and the row names none'), { code: 'no-project' })
}
