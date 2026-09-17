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
  // v0.13.0: tier this event was written to. `chained` = the primary
  // hash-chained + signed + anchored path (unchanged from earlier
  // versions). `logged` = supporting-evidence table (`events_logged`);
  // no hash / signature / anchor. Rows constructed by legacy callers
  // without setting this default to `chained`. See
  // docs/DESIGN-two-tier-chain.md.
  tier?: EventTier
}

/** v0.13.0 tier identifiers. `chained` and `logged` name the two DB tables;
 *  `all` is the IPC / UI query filter that means "both". Exported so
 *  main / preload / renderer share one source of truth for the string
 *  union — otherwise the shape gets redeclared inline at every boundary
 *  and drifts when a third tier lands. */
export type EventTier = 'chained' | 'logged'
export type EventTierFilter = EventTier | 'all'

/** The envelope schema version new rows are written under (docs/
 *  DESIGN-plugin-kernel.md §3). Bumped when the envelope's shape changes;
 *  a row records the version it was written under and is never backfilled. */
export const ENVELOPE_SCHEMA_VERSION = 1

/** Envelope metadata a producer (through `ingest`) may attach to an event:
 *  the verbatim bytes it sent, which mapper normalised them, the producer id,
 *  and the producer's own timestamp. `raw` is stored to the raw sidecar and
 *  its sha256 is folded into the hashed `data`, so the chain attests the bytes
 *  without carrying them. All fields optional — a producer that already speaks
 *  the envelope shape (the identity mapper) can omit `raw`. */
export interface EnvelopeInput {
  raw?: Buffer | string
  rawEncoding?: 'json' | 'bytes'
  mapper?: { id: string; version: string }
  source?: string
  tsSource?: number | null
  schemaVersion?: number
}

export interface StoredEnvelope {
  rawRef: import('../raw-store').RawRef | null
  mapper: { id: string; version: string } | null
  source: string | null
  tsSource: number | null
  schemaVersion: number
}

export function rowToEvent(row: Record<string, unknown>): RedLogEvent {
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
    signature: (row.signature as string | null) ?? null,
    // v0.13.0: honour tier hint from the SELECT (queryEvents adds
    // `'chained' AS tier`/`'logged' AS tier`; queryEventById spreads
    // it in). Rows without a hint default to `chained` — every legacy
    // row lives in `events`, so this default is correct for any query
    // path that pre-dates the two-tier split.
    tier: ((row.tier as 'chained' | 'logged' | undefined) ?? 'chained')
  }
}
