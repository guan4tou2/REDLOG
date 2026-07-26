import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

let db: Database.Database | null = null
let currentProjectDir: string | null = null

export function initDB(projectDir: string): Database.Database {
  if (db) closeDB()

  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'screenshots'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'terminal'), { recursive: true })

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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(agent_type);
    CREATE INDEX IF NOT EXISTS idx_events_engagement ON events(engagement_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      cvss_vector TEXT,
      cvss_score REAL,
      description TEXT NOT NULL DEFAULT '',
      remediation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      affected_hosts TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_links (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_finding ON evidence_links(finding_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_event ON evidence_links(event_id);

    CREATE TABLE IF NOT EXISTS event_annotations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotation_event ON event_annotations(event_id);
  `)

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
