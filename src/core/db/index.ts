import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

let db: Database.Database | null = null
let currentProjectDir: string | null = null

export function initDB(projectDir: string): Database.Database {
  if (db) closeDB()

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'screenshots'), { recursive: true })

  const dbPath = path.join(projectDir, 'timeline.db')
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
    CREATE INDEX IF NOT EXISTS idx_events_engagement ON events(engagement_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id);

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
  `)

  // Migrate: add columns if missing (older DB versions)
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))
  if (!colNames.has('prev_hash')) db.exec('ALTER TABLE events ADD COLUMN prev_hash TEXT')
  if (!colNames.has('monotonic_ns')) db.exec('ALTER TABLE events ADD COLUMN monotonic_ns TEXT')
  if (!colNames.has('ntp_offset_ms')) db.exec('ALTER TABLE events ADD COLUMN ntp_offset_ms INTEGER')

  currentProjectDir = projectDir
  return db
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
