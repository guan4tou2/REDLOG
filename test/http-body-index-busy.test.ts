// When another connection holds the shared index's write lock past the busy
// timeout, a search answers from what is there. What it answers must still be
// true: no event outside the caller's snapshot, and no coverage claim made by
// a row of this connection's TEMP tables that no longer stands for anything.
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parsed, savedBody, savedResponse } from './helpers/body-index-work'
import type { ExportSnapshot } from '../src/core/export-plan'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
let insertEvent: typeof import('../src/core/db/events').insertEvent
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
  insertEvent = (await import('../src/core/db/events')).insertEvent
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
}
let dir = ''
const search = (text: string) => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 100 })
/** Hold the shared index's write lock, as another writer mid-sync would. */
function whileLocked<T>(run: () => T): T {
  const holder = new Database(path.join(dir, 'http-body-index.db'))
  holder.prepare('BEGIN IMMEDIATE').run()
  try { return run() } finally { holder.prepare('ROLLBACK').run(); holder.close() }
}

sqlite.describe('a search while another connection holds the index', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-busy-')); db.initDB(dir) })
  afterEach(() => { idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns no event outside the snapshot it was given', () => {
    for (let i = 0; i < 3; i++) savedResponse(`old-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha old${i}"}`) })
    search('alpha')
    const snapshot: ExportSnapshot = readActivitySnapshot(db.getReadonlyDB())
    // Linked at ingest, after the snapshot, before any sync reached it.
    const ref = savedBody(dir, '{"n":"alpha later"}')
    savedResponse('later', { response_body_ref: ref })
    idx.linkHttpBodyEvent({ id: 'later', data: { subtype: 'http_response', response_body_ref: ref }, agentType: 'scanner' }, dir)
    const ids = whileLocked(() => idx.searchHttpBodyTermIds('alpha', dir, false, snapshot).flatMap(t => t.eventIds).sort())
    expect(ids).toEqual(['old-0', 'old-1', 'old-2'])
  }, 30_000)

  it('a transcript prefix kept in TEMP during one lock does not answer coverage after its file is pruned', () => {
    const folder = path.join(dir, 'agent-transcripts'); fs.mkdirSync(folder)
    const file = path.join(folder, 'conversation.jsonl')
    const snapshotOf = (text: string) => {
      fs.writeFileSync(file, text)
      return insertEvent('agent', { subtype: 'transcript_snapshot', snapshot_path: file, cumulative_bytes: Buffer.byteLength(text),
        cumulative_sha256: createHash('sha256').update(text).digest('hex') }, { engagementId: 'eng', operatorId: 'op' })!.id
    }
    snapshotOf('{"m":"TRANSCRIPTWORD one"}\n')
    search('TRANSCRIPTWORD')
    const newer = snapshotOf('{"m":"TRANSCRIPTWORD one"}\n{"m":"two"}\n')
    // A search during the lock answers the newer prefix all the same.
    expect(whileLocked(() => search('TRANSCRIPTWORD').items.map(e => e.id))).toEqual([newer])
    expect(search('TRANSCRIPTWORD').items.map(e => e.id)).toEqual([newer])
    fs.rmSync(file)
    idx.pruneSavedFileIndex(file, dir)
    // Coverage asked alone first, as a cursor's revision check asks it.
    const during = whileLocked(() => ({
      coverage: idx.bodySearchCoverage().sources!.find(s => s.kind === 'ai-raw')!.status,
      items: search('TRANSCRIPTWORD').items.map(e => e.id),
    }))
    expect(during.items).toEqual([])
    expect(during.coverage).not.toBe('covered')
    // And once the lock is gone, the answer a fresh index gives.
    expect(idx.bodySearchCoverage().sources!.find(s => s.kind === 'ai-raw')).toMatchObject({ status: 'unavailable', missing: 1 })
  }, 60_000)
})
