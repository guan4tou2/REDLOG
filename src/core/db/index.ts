import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { resetSession, assertEventsAppendOnly } from './events'

function hasRows(db: import('better-sqlite3').Database, table: string): boolean {
  try { return ((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c) > 0 } catch { return false }
}

let db: Database.Database | null = null
let currentDbPath: string | null = null
let currentProjectDir: string | null = null
// v0.15: cached read-only handle for heavy/long read queries — see
// getReadonlyDB. Tied to currentDbPath and reset by closeDB, so a project
// switch (which always goes through closeDB before reopening) never serves a
// stale handle from the previous project.
let roDb: Database.Database | null = null

export function initDB(projectDir: string): Database.Database {
  if (db) closeDB()
  // Every project open is a fresh session — regenerate sessionId so events
  // written after a project switch don't share the previous session's id
  // (v0.6.87 audit A4).
  resetSession()

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'screenshots'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'http-bodies'), { recursive: true })

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
      subtype TEXT,
      hostname TEXT NOT NULL DEFAULT '',
      source_ip TEXT,
      target_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      hash TEXT,
      prev_hash TEXT,
      created_at INTEGER NOT NULL,
      monotonic_ns TEXT,
      ntp_offset_ms INTEGER,
      signature TEXT,
      -- Envelope (docs/DESIGN-plugin-kernel.md §3-4). raw_ref points at the
      -- verbatim producer bytes in <project>/raw/; mapper names the
      -- (id,version) that derived data; source is the producer id.
      raw_ref TEXT,
      mapper TEXT,
      schema_version INTEGER,
      ts_source INTEGER,
      source TEXT,
      transcript_uuid TEXT
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
    -- (agent_type, target_id): answers "are there two distinct command-derived
    -- targets yet" in two index seeks. idx_events_target orders by target_id
    -- alone, so the same question there walks every row of the first target
    -- before it can emit a second.
    CREATE INDEX IF NOT EXISTS idx_events_type_target ON events(agent_type, target_id);
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
    -- v0.16: denormalized subtype column. The most-queried JSON property,
    -- previously accessed via json_extract(data,'$.subtype') on every
    -- Timeline page load, evidence filter, chain-turning-point scan, tier
    -- classifier, and capture-health probe. Composite with agent_type +
    -- timestamp DESC so the hot (agent_type, subtype, newest-first) pattern
    -- is a single bounded index walk.
    CREATE INDEX IF NOT EXISTS idx_events_agent_subtype_ts ON events(agent_type, subtype, timestamp DESC);

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      note TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_ts ON bookmarks(created_at);

    -- (event_annotations removed v0.15: created in an early version but never
    --  given a read or write path — dead schema. Existing DBs keep the empty
    --  table harmlessly; new DBs no longer create it.)

    CREATE TABLE IF NOT EXISTS operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      signer_pub_key TEXT
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

    -- Operator assertion: "this event must not leave the local DB".
    -- A side table (not a column) because events rows are immutable.
    -- INSERT = mark; DELETE = unmark. Both tiers share the same table.
    CREATE TABLE IF NOT EXISTS do_not_export (
      event_id   TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

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
      subtype       TEXT,
      hostname      TEXT NOT NULL DEFAULT '',
      source_ip     TEXT,
      target_id     TEXT,
      data          TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      raw_ref       TEXT,
      mapper        TEXT,
      schema_version INTEGER,
      ts_source     INTEGER,
      source        TEXT
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
    CREATE INDEX IF NOT EXISTS idx_events_logged_agent_subtype_ts ON events_logged(agent_type, subtype, timestamp DESC);
  `)

  db.exec('CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, timestamp DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_logged_source_ts ON events_logged(source, timestamp DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_transcript_uuid ON events(agent_type, transcript_uuid) WHERE transcript_uuid IS NOT NULL')
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_logged_http_flow
    ON events_logged(json_extract(data, '$.flow_id'), timestamp DESC)
    WHERE agent_type = 'scanner' AND subtype IN ('http_request_start', 'http_response')`)

  // Spec 017: the query language's identifier conditions. The agent session
  // and tool-use id live in `data`, not in columns — `session_id` the COLUMN
  // is RedLog's own capture session, which nothing filters on. `events` has a
  // `transcript_uuid` column already indexed above; `events_logged` does not,
  // so its transcript condition reads the same value out of `data`.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_agent_session
    ON events(json_extract(data, '$.session_id'), timestamp DESC)
    WHERE json_extract(data, '$.session_id') IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_logged_agent_session
    ON events_logged(json_extract(data, '$.session_id'), timestamp DESC)
    WHERE json_extract(data, '$.session_id') IS NOT NULL`)
  // Composite, because a tool-use id is unique only within its session.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tool_use
    ON events(json_extract(data, '$.tool_use_id'), json_extract(data, '$.session_id'))
    WHERE json_extract(data, '$.tool_use_id') IS NOT NULL`)
  // Deliberately no tool-use or transcript index on the logged tier. A partial
  // index still evaluates its expression on every insert to decide whether the
  // row belongs, and the logged tier is the HTTP/DNS capture hot path — but
  // `tool_call`/`tool_result` and agent transcripts are chained-tier (see
  // LOGGED_TIER in event-write), so those two indexes would have cost every
  // proxied request and indexed nothing. The conditions still resolve there;
  // they scan a set that is empty in practice. The agent session index stays
  // because `agent:thinking` IS logged and carries one.

  // FTS5 full-text search indexes for events + events_logged.
  // External-content tables: the index references the source rows directly
  // (no data duplication). AFTER INSERT / AFTER DELETE triggers keep the
  // index in sync. events is append-only so only INSERT is needed there;
  // events_logged also has retention DELETE sweeps.
  {
    const tbls = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    )
    const hadEventsFts = tbls.has('events_fts')

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        data, target_id, agent_type,
        content=events, content_rowid=rowid,
        tokenize='unicode61 remove_diacritics 2',
        prefix='2 3'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS events_logged_fts USING fts5(
        data, target_id, agent_type,
        content=events_logged, content_rowid=rowid,
        tokenize='unicode61 remove_diacritics 2',
        prefix='2 3'
      );
    `)

    // Triggers: keep FTS in sync on write. DROP+CREATE so column lists
    // stay current across upgrades (same pattern as assertEventsAppendOnly).
    db.exec(`
      DROP TRIGGER IF EXISTS events_fts_ai;
      CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, data, target_id, agent_type)
        VALUES (new.rowid, new.data, new.target_id, new.agent_type);
      END;

      DROP TRIGGER IF EXISTS events_logged_fts_ai;
      CREATE TRIGGER events_logged_fts_ai AFTER INSERT ON events_logged BEGIN
        INSERT INTO events_logged_fts(rowid, data, target_id, agent_type)
        VALUES (new.rowid, new.data, new.target_id, new.agent_type);
      END;

      DROP TRIGGER IF EXISTS events_logged_fts_ad;
      CREATE TRIGGER events_logged_fts_ad AFTER DELETE ON events_logged BEGIN
        INSERT INTO events_logged_fts(events_logged_fts, rowid, data, target_id, agent_type)
        VALUES ('delete', old.rowid, old.data, old.target_id, old.agent_type);
      END;
    `)

    // Build the external-content index when it is first created.
    if (!hadEventsFts) {
      if (hasRows(db, 'events'))
        db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')")
      if (hasRows(db, 'events_logged'))
        db.exec("INSERT INTO events_logged_fts(events_logged_fts) VALUES('rebuild')")
    }
  }

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

/** v0.15: a cached read-only handle for heavy/long-running READ queries
 *  (queryEvents, the export/scope LIMIT-100000 scan, target/host aggregates,
 *  full-text search). getDB() is the single read-WRITE connection, and
 *  better-sqlite3 runs one statement per connection at a time — so a heavy
 *  scan on getDB() serialises every capture write behind it. WAL lets a
 *  separate reader run concurrently with the writer, so the heavy readers get
 *  their own connection and the write path keeps getDB() to itself.
 *
 *  Distinct from openReadOnlyDB(), which hands out a FRESH connection per call:
 *  the hash-walk holds an iterator open across setImmediate yields and must not
 *  pin a shared handle. The heavy readers here are short, non-overlapping
 *  statements that don't need isolation from each other, so they share one
 *  cached handle. Cached and invalidated exactly like `db` — closeDB() drops
 *  it, and initDB() reopens through closeDB(). */
export function getReadonlyDB(): Database.Database {
  if (!currentDbPath) throw new Error('Database not initialized')
  if (roDb) return roDb
  roDb = new Database(currentDbPath, { readonly: true })
  return roDb
}

export function closeDB(): void {
  db?.close()
  db = null
  // v0.15: the cached read-only handle is bound to currentDbPath — close it
  // here so a project switch (initDB → closeDB → reopen) re-creates it against
  // the new file instead of serving reads from the previous project's db.
  roDb?.close()
  roDb = null
  currentProjectDir = null
}

export function getProjectDir(): string {
  if (!currentProjectDir) throw new Error('No project loaded')
  return currentProjectDir
}
