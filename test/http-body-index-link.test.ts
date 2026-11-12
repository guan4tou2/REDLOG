import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db/index'
import { linkHttpBodyEvent, closeHttpBodyIndex } from '../src/core/http-body-index'

// `body_fts.event_id` is an UNINDEXED FTS5 column, so `DELETE FROM body_fts
// WHERE event_id=? AND sha256=?` reads every indexed chunk. Linking ran it for
// every new HTTP body — a body the index had never seen and so could hold no
// rows for — which made each scanner insert O(indexed bodies): 0.53 ms at 2k
// rows, 3.36 ms at 60k, and the whole ingest rate fell with it.
//
// The rows for a (event, body) pair are only ever written beside its
// body_event_refs row, in one transaction, and every delete removes both. No
// ref row means no FTS rows, so there is nothing to delete.

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-link-')); initDB(dir) })
afterEach(() => { vi.restoreAllMocks(); closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

const body = (text: string) => { const b = Buffer.from(text); return { data: b.toString('base64'), encoding: 'base64', size: b.length, sha256: createHash('sha256').update(b).digest('hex') } }
function ftsDeletes(run: () => void): number {
  const seen: string[] = []
  const prepare = Database.prototype.prepare
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const stmt = prepare.call(this, sql)
    if (/DELETE FROM body_fts WHERE event_id=\?/.test(sql)) {
      const exec = stmt.run.bind(stmt)
      ;(stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...a: unknown[]) => { seen.push(sql); return exec(...a) }
    }
    return stmt
  })
  try { run() } finally { spy.mockRestore() }
  return seen.length
}
const indexed = (): Array<{ event_id: string; content: string }> => {
  const db = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
  try { return db.prepare('SELECT event_id,content FROM body_fts ORDER BY event_id,rowid').all() as Array<{ event_id: string; content: string }> }
  finally { db.close() }
}

describe('linking a saved body into the search index', () => {
  it('does not delete from the FTS table for a body it has never seen', () => {
    linkHttpBodyEvent({ id: 'warm', data: { subtype: 'http_response', response_body: body('warm up') } })
    const deletes = ftsDeletes(() => {
      linkHttpBodyEvent({ id: 'e1', data: { subtype: 'http_response', response_body: body('alpha token') } })
      linkHttpBodyEvent({ id: 'e2', data: { subtype: 'http_request_start', request_body: body('beta token') } })
    })
    expect(deletes).toBe(0)
    expect(indexed().map(r => r.event_id)).toEqual(['e1', 'e2', 'warm'])
  })

  it('keeps what it indexed when the same pair is linked again', () => {
    const event = { id: 'again', data: { subtype: 'http_response', response_body: body('gamma token') } }
    linkHttpBodyEvent(event)
    // Indexed already: kept as is, nothing deleted or duplicated.
    expect(ftsDeletes(() => linkHttpBodyEvent(event))).toBe(0)
    expect(indexed()).toEqual([{ event_id: 'again', content: 'gamma token' }])
  })
})
