import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// An engagement recorded before v0.16 could not be opened by any build after
// it. `76548d2` added `subtype` to the events tables and an index that names
// it, and `CREATE TABLE IF NOT EXISTS` does nothing to a database that already
// exists — so the column never appeared, and the CREATE INDEX right after it
// threw `no such column: subtype` on project:open. Six weeks of releases in
// which an operator's recorded work was unreachable.
//
// Adding the column back is only half of it. Queries read the denormalized
// column now, so every row written before the migration would answer NULL —
// a timeline that silently drops its own history is worse than one that
// refuses to open (constitution I, II).

let dbmod: typeof import('../src/core/db/index') | null = null
let Database: typeof import('better-sqlite3') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  Database = D as unknown as typeof import('better-sqlite3')
  dbmod = await import('../src/core/db/index')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = dbmod !== null

/** The events table as it stood before v0.16: no `subtype` column. */
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

describe.skipIf(!available)('opening an engagement recorded by an older build', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-migration-'))
    const db = new Database!(path.join(dir, 'timeline.db'))
    db.exec(PRE_V016)
    db.prepare(
      `INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
                           agent_type, data, created_at)
       VALUES (?, ?, 'eng', 's', 'op', ?, ?, ?)`
    ).run('old-1', 1000, 'shell', JSON.stringify({ subtype: 'command_end', command: 'id' }), 1000)
    db.prepare(
      `INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
                           agent_type, data, created_at)
       VALUES (?, ?, 'eng', 's', 'op', ?, ?, ?)`
    ).run('old-2', 2000, 'scanner', JSON.stringify({ url: 'http://x/' }), 2000)
    db.close()
  })

  afterEach(() => {
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens at all', () => {
    expect(() => dbmod!.initDB(dir)).not.toThrow()
  })

  it('backfills the denormalized column from the row it was denormalized from', () => {
    const db = dbmod!.initDB(dir)
    const rows = db.prepare('SELECT id, subtype FROM events ORDER BY id').all() as Array<{ id: string; subtype: string | null }>
    expect(rows).toEqual([
      { id: 'old-1', subtype: 'command_end' },
      // No subtype in the JSON: NULL is the truth, not an empty string.
      { id: 'old-2', subtype: null }
    ])
  })

  it('is idempotent — a second open neither throws nor rewrites', () => {
    dbmod!.initDB(dir)
    dbmod!.closeDB()
    const db = dbmod!.initDB(dir)
    expect((db.prepare("SELECT subtype FROM events WHERE id = 'old-1'").get() as { subtype: string }).subtype)
      .toBe('command_end')
  })

  it('leaves a database that already has the column alone', () => {
    // Built with the column present and a value that does NOT match the JSON,
    // because the events rows are immutable once RedLog's triggers are on and
    // a hand-edit afterwards is not a thing an operator can do.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-migration-'))
    const db = new Database!(path.join(other, 'timeline.db'))
    db.exec(PRE_V016.replace('agent_type TEXT NOT NULL,', 'agent_type TEXT NOT NULL, subtype TEXT,'))
    db.prepare(
      `INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
                           agent_type, subtype, data, created_at)
       VALUES ('kept', 1, 'eng', 's', 'op', 'shell', 'already-set', ?, 1)`
    ).run(JSON.stringify({ subtype: 'command_end' }))
    db.close()

    const opened = dbmod!.initDB(other)
    expect((opened.prepare("SELECT subtype FROM events WHERE id = 'kept'").get() as { subtype: string }).subtype)
      .toBe('already-set')
    dbmod!.closeDB()
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('leaves the append-only trigger installed after migrating', () => {
    const db = dbmod!.initDB(dir)
    const trigger = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'no_update_events_hash'`
    ).get()
    expect(trigger, 'the migration drops it to backfill and must not leave it off').toBeTruthy()
  })
})
