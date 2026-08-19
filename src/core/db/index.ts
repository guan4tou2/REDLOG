import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { resetSession, assertEventsAppendOnly } from './events'

let db: Database.Database | null = null
let currentDbPath: string | null = null
let currentProjectDir: string | null = null

export function initDB(projectDir: string): Database.Database {
  if (db) closeDB()
  // Every project open is a fresh session — regenerate sessionId so events
  // written after a project switch don't share the previous session's id
  // (v0.6.87 audit A4).
  resetSession()

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'screenshots'), { recursive: true })

  const dbPath = path.join(projectDir, 'timeline.db')
  currentDbPath = dbPath
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      engagement_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      hostname TEXT NOT NULL DEFAULT '',
      source_ip TEXT,
      target_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      hash TEXT,
      prev_hash TEXT,
      created_at INTEGER NOT NULL,
      monotonic_ns TEXT,
      ntp_offset_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(agent_type);
    -- v0.9.8: (agent_type, timestamp DESC). Both hot paths filter by
    -- agent_type and then want the NEWEST rows, and neither single-column
    -- index serves both halves:
    --   * insertEvent's dedup window (agent_type IN (shell,agent) AND
    --     timestamp >= ? ORDER BY timestamp DESC LIMIT 20) planned as
    --     "SEARCH USING idx_events_type + USE TEMP B-TREE FOR ORDER BY" --
    --     it pulled every shell row into a sort to find 20. Measured at
    --     50k rows: 2.8 ms, on every single insert.
    --   * capture-health's eleven MAX(timestamp) WHERE agent_type = ?
    --     probes scanned the whole agent_type bucket each. 23 ms per call,
    --     and it runs on every agent status request.
    -- With the composite index the order comes from the index, so both
    -- become bounded walks from the newest row.
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(agent_type, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_engagement ON events(engagement_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id);
    -- v0.6.95 P0-4b: every insertEvent looks up the previous row hash via
    -- ORDER BY created_at DESC, rowid DESC LIMIT 1. Without this index the
    -- query degrades to a table scan at 100k+ events, adding O(N) latency
    -- per write. The lastHash in-memory cache in db/events.ts avoids the
    -- query on the hot path; this index protects the cold path (first
    -- insert after boot, cache invalidation, and the SAMPLE walker
    -- prev-hash lookup). SQLite rejects rowid in indexes because rowid is
    -- an implicit alias, so we index on created_at only and let SQLite use
    -- the implicit rowid as the tiebreak for ORDER BY.
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    -- v0.9.8: partial index so chain-head COUNT walks index pages instead of
    -- the table. computeChainHead() ends with
    -- "SELECT COUNT(*) FROM events WHERE hash IS NOT NULL", which planned as
    -- a bare SCAN — and scanning the table means paging in the whole data
    -- column. On a 131k-event project with 151 MB of data that was 43 ms per
    -- call, and verifyLatestAnchor pays it twice.
    CREATE INDEX IF NOT EXISTS idx_events_hashed ON events(created_at) WHERE hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS quickmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      note TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quickmarks_ts ON quickmarks(created_at);

    CREATE TABLE IF NOT EXISTS event_annotations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotation_event ON event_annotations(event_id);

    CREATE TABLE IF NOT EXISTS operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_operator_token ON operators(token_hash);

    CREATE TABLE IF NOT EXISTS chain_anchors (
      id TEXT PRIMARY KEY,
      head_event_id TEXT,
      head_hash TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      calendar_receipts TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_ts ON chain_anchors(created_at);

    -- Four-layer redaction, layer 4 (docs/redaction-design.md): the source
    -- 'events' row is never mutated; instead a sanitized replacement copy is
    -- written here and the bundle export serves it in place of the raw bytes.
    -- Every sanitize pass also appends a chained system.sanitized event, so a
    -- bundle without matching events is detectable as tampering.
    CREATE TABLE IF NOT EXISTS sanitized_events (
      source_event_id TEXT NOT NULL,
      field TEXT NOT NULL,
      sanitized_value TEXT NOT NULL,
      replacement_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sanitized_event_id TEXT NOT NULL,   -- the system.sanitized chain event
      PRIMARY KEY (source_event_id, field)
    );
    CREATE INDEX IF NOT EXISTS idx_sanitized_source ON sanitized_events(source_event_id);

    -- v0.13.0 two-tier chain (docs/DESIGN-two-tier-chain.md sec.3): the
    -- logged tier for supporting evidence -- DNS lookups, HTTP flow
    -- bookkeeping, CDP console lines, agent thinking, ip_verdict
    -- unchanged-tick heartbeats. Rows here are NOT hash-chained, NOT
    -- Ed25519-signed, and NOT covered by the OTS anchor. The absence of
    -- prev_hash + hash + signature + monotonic_ns + ntp_offset_ms is
    -- the tier -- every reader that unions the two tables discovers
    -- that at compile time (no hash field to reference on the row).
    --
    -- Retention (docs/DESIGN-logged-tier-retention.md): unlike events,
    -- this table has NO append-only trigger. Sweep code path deletes
    -- rows past retention.loggedTier.keepDays (default 30d), emitting
    -- one chained system.retention_pruned_logged summary per sweep.
    CREATE TABLE IF NOT EXISTS events_logged (
      id            TEXT PRIMARY KEY,
      timestamp     INTEGER NOT NULL,
      engagement_id TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      operator_id   TEXT NOT NULL,
      agent_type    TEXT NOT NULL,
      hostname      TEXT NOT NULL DEFAULT '',
      source_ip     TEXT,
      target_id     TEXT,
      data          TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_logged_ts         ON events_logged(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_logged_type_ts    ON events_logged(agent_type, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_logged_engagement ON events_logged(engagement_id);
    CREATE INDEX IF NOT EXISTS idx_events_logged_target     ON events_logged(target_id);
    -- Retention sweep uses created_at (not timestamp) -- see
    -- DESIGN-logged-tier-retention.md sec.5.2. created_at is monotonic
    -- in wall-clock terms since it is set inside the insert transaction
    -- from Date.now(); timestamp can lag or lead per producer clock.
    CREATE INDEX IF NOT EXISTS idx_events_logged_created_at ON events_logged(created_at);
  `)

  // Migrate: add columns if missing (older DB versions)
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))
  if (!colNames.has('prev_hash')) db.exec('ALTER TABLE events ADD COLUMN prev_hash TEXT')
  if (!colNames.has('monotonic_ns')) db.exec('ALTER TABLE events ADD COLUMN monotonic_ns TEXT')
  if (!colNames.has('ntp_offset_ms')) db.exec('ALTER TABLE events ADD COLUMN ntp_offset_ms INTEGER')
  // v0.6.89: per-event Ed25519 signature. Nullable so pre-existing rows keep
  // working (verifyChainFull marks them "unsigned" rather than "broken");
  // signed rows carry base64 raw 64-byte Ed25519 sig over the same canonical
  // JSON string used for the hash.
  if (!colNames.has('signature')) db.exec('ALTER TABLE events ADD COLUMN signature TEXT')
  const opCols = db.prepare("PRAGMA table_info(operators)").all() as Array<{ name: string }>
  const opColNames = new Set(opCols.map(c => c.name))
  // Public key mirrored into the DB so verify never touches disk to walk the
  // chain. Nullable: existing operators keep NULL and their events verify as
  // "unsigned"; keygen only fires on new / re-set operators. Rewriting old
  // keys would invalidate the chain of signed rows behind them, so migration
  // stays hands-off.
  if (!opColNames.has('signer_pub_key')) db.exec('ALTER TABLE operators ADD COLUMN signer_pub_key TEXT')

  // v0.6.88 P1-B: install append-only triggers on events table so
  // DELETE / UPDATE-of-immutable-fields raise instead of silently corrupting
  // the chain. Idempotent — safe to call every project open.
  assertEventsAppendOnly()

  currentProjectDir = projectDir
  return db
}

/** v0.11.1: a second, read-only handle on the same file.
 *
 *  better-sqlite3 is synchronous, and its iterator holds the connection open
 *  for as long as it is being consumed. `verifyChainFullAsync` walks the whole
 *  chain and yields with setImmediate between chunks so the UI keeps painting
 *  — but the iterator stays open across those yields, and better-sqlite3
 *  rejects any `.run()` on a connection with a live iterator:
 *
 *    Error: This database connection is busy executing a query
 *
 *  So every capture write during a full verify failed: REST returned 500,
 *  the shell hook spooled, capture-health went dark. Reproduced with 40
 *  inserts against a 6000-row walk — the first one threw.
 *
 *  The old comment argued this was safe "as long as no interleaving statement
 *  is issued against the same DB". Background capture is precisely an
 *  interleaving statement; the premise was wrong, not the reasoning.
 *
 *  WAL mode lets a reader run concurrently with a writer, so the walk gets its
 *  own connection and the write path keeps the primary one to itself. Opened
 *  on demand and closed by closeDB. */
export function openReadOnlyDB(): Database.Database {
  if (!currentDbPath) throw new Error('Database not initialized')
  return new Database(currentDbPath, { readonly: true })
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDB(): void {
  db?.close()
  db = null
  currentProjectDir = null
}

export function getProjectDir(): string {
  if (!currentProjectDir) throw new Error('No project loaded')
  return currentProjectDir
}
