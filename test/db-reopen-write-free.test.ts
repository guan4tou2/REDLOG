import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Opening a project whose schema is already current must not write. Before,
// every open dropped and recreated the two append-only triggers and the FTS
// triggers, each statement its own WAL commit and its own sync: pure cost on a
// runner that scans the file, and a window in which a crash left the events
// table without its triggers (#669).
//
// The observer is a second connection held open across the reopen.
// `PRAGMA data_version` on it moves whenever ANOTHER connection commits to the
// file, and `schema_version` moves on every DDL, so together they catch a
// commit and a no-op rewrite of the schema alike, without depending on how
// the writer happened to issue it.

let dbmod: typeof import('../src/core/db/index') | null = null
let Database: typeof import('better-sqlite3') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  Database = D as unknown as typeof import('better-sqlite3')
  dbmod = await import('../src/core/db/index')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = dbmod !== null

interface Probe { dataVersion: number; schemaVersion: number; master: string }

function probe(observer: import('better-sqlite3').Database): Probe {
  const num = (name: string): number =>
    Object.values(observer.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]
  return {
    dataVersion: num('data_version'),
    schemaVersion: num('schema_version'),
    master: JSON.stringify(observer.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all())
  }
}

const PRE_V016 = `
  CREATE TABLE events (
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
    created_at INTEGER NOT NULL
  );
`

const INSERT_ROW = `INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
                                         agent_type, data, created_at)
                    VALUES (?, 1, 'eng', 's', 'op', 'shell', '{}', 1)`

describe.skipIf(!available)('reopening a project whose schema is current', () => {
  let dir: string
  let observer: import('better-sqlite3').Database | null = null

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-reopen-')) })

  afterEach(() => {
    observer?.close()
    observer = null
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function observe(): import('better-sqlite3').Database {
    observer = new Database!(path.join(dir, 'timeline.db'))
    return observer
  }

  it('commits nothing and changes no schema object', () => {
    dbmod!.initDB(dir)
    dbmod!.closeDB()
    const before = probe(observe())

    dbmod!.initDB(dir)

    expect(probe(observer!)).toEqual(before)
  })

  it('commits nothing when the project was first migrated from an older schema', () => {
    const old = new Database!(path.join(dir, 'timeline.db'))
    old.exec(PRE_V016)
    old.prepare(INSERT_ROW).run('old-1')
    old.close()
    dbmod!.initDB(dir)
    dbmod!.closeDB()
    const before = probe(observe())

    dbmod!.initDB(dir)

    expect(probe(observer!)).toEqual(before)
  })

  it('does catch a reopen that writes (the probe can fail)', () => {
    dbmod!.initDB(dir)
    dbmod!.closeDB()
    const before = probe(observe())

    // What the old open did: drop and recreate a trigger it did not need to.
    const db = dbmod!.initDB(dir)
    db.exec(`DROP TRIGGER no_delete_events;
      CREATE TRIGGER no_delete_events BEFORE DELETE ON events BEGIN
        SELECT RAISE(ABORT, 'events table is append-only (chain integrity)');
      END`)

    const after = probe(observer!)
    expect(after.dataVersion).not.toBe(before.dataVersion)
    expect(after.schemaVersion).not.toBe(before.schemaVersion)
  })

  it('still refuses DELETE and UPDATE of a chained field after a reopen', () => {
    dbmod!.initDB(dir).prepare(INSERT_ROW).run('kept')
    dbmod!.closeDB()
    const db = dbmod!.initDB(dir)

    expect(() => db.prepare("DELETE FROM events WHERE id = 'kept'").run()).toThrow(/append-only/)
    expect(() => db.prepare("UPDATE events SET agent_type = 'x' WHERE id = 'kept'").run()).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE events SET signature = 'x' WHERE id = 'kept'").run()).toThrow(/immutable/)
    expect((db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(1)
  })

  it('reinstalls a missing or older append-only trigger and the index triggers on reopen', () => {
    const fresh = dbmod!.initDB(dir)
    const triggers = (d: import('better-sqlite3').Database): string =>
      JSON.stringify(d.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all())
    const expected = triggers(fresh)
    expect(JSON.parse(expected).map((t: { name: string }) => t.name)).toEqual([
      'events_fts_ai', 'events_logged_fts_ad', 'events_logged_fts_ai',
      'no_delete_events', 'no_update_events_hash'
    ])

    // A v0.6.88-era trigger: fewer columns, so `agent_type` is not protected.
    fresh.exec(`
      DROP TRIGGER no_delete_events;
      DROP TRIGGER no_update_events_hash;
      CREATE TRIGGER no_update_events_hash BEFORE UPDATE OF hash, prev_hash, data ON events
      BEGIN SELECT RAISE(ABORT, 'events row fields are immutable (chain integrity)'); END;
      DROP TRIGGER events_fts_ai;
      DROP TRIGGER events_logged_fts_ad;
      CREATE TRIGGER events_fts_ad AFTER DELETE ON events BEGIN SELECT 1; END;
    `)
    fresh.prepare(INSERT_ROW).run('kept')
    expect(() => fresh.prepare("UPDATE events SET agent_type = 'x' WHERE id = 'kept'").run()).not.toThrow()
    dbmod!.closeDB()

    const db = dbmod!.initDB(dir)

    expect(triggers(db)).toBe(expected)
    expect(() => db.prepare("DELETE FROM events WHERE id = 'kept'").run()).toThrow(/append-only/)
    expect(() => db.prepare("UPDATE events SET agent_type = 'y' WHERE id = 'kept'").run()).toThrow(/immutable/)
  })

  it('applies the schema step all or nothing', () => {
    // No `created_at`: the column migration succeeds and the index on it fails
    // after it, in the same open.
    const old = new Database!(path.join(dir, 'timeline.db'))
    old.exec(PRE_V016.replace(/,\s*created_at INTEGER NOT NULL/, ''))
    old.close()

    expect(() => dbmod!.initDB(dir)).toThrow()

    const check = new Database!(path.join(dir, 'timeline.db'), { readonly: true })
    try {
      const columns = (check.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).not.toContain('subtype')
      expect(check.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index'`).get())
        .toEqual({ c: 1 }) // only the autoindex for the primary key
    } finally { check.close() }
  })
})
