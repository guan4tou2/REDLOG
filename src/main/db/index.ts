import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'

let db: Database.Database | null = null

function getDbPath(engagementId: string): string {
  const dir = path.join(os.homedir(), '.redlog', 'data', engagementId)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'terminal'), { recursive: true })
  return path.join(dir, 'timeline.db')
}

export function initDB(engagementId: string): Database.Database {
  if (db) return db

  const dbPath = getDbPath(engagementId)
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

    CREATE TABLE IF NOT EXISTS chain (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES events(id),
      event_hash TEXT NOT NULL DEFAULT '',
      prev_hash TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL
    );
  `)

  return db
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDB(): void {
  db?.close()
  db = null
}

export function getDataDir(engagementId: string): string {
  return path.join(os.homedir(), '.redlog', 'data', engagementId)
}
