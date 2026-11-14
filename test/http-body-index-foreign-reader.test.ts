// The export worker is a module instance of its own, with its own database
// and body-index connections, and it reads under the snapshot the export was
// taken at — usually older than what main has indexed since. Nothing it does
// may take from the shared index what main's later searches need, and what it
// answers is exactly the snapshot's answer: no event outside it through a
// body, and the transcript prefix that was the latest inside it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { cost, parsed, savedBody, savedResponse, bodySource } from './helpers/body-index-work'
import type { ExportSnapshot } from '../src/core/export-plan'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
let insertEvent: typeof import('../src/core/db/events').insertEvent
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
  insertEvent = (await import('../src/core/db/events')).insertEvent
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
}
let dir = ''
const search = (text: string) => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 50 })

sqlite.describe('another connection bounded by an older snapshot', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-foreign-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  /** A second module instance with its own database and index connections,
   *  as the export worker has; closed after `run`. */
  async function elsewhere<T>(run: (m: { queries: typeof queries; idx: typeof idx }) => T): Promise<T> {
    vi.resetModules()
    const other = { db: await import('../src/core/db'), queries: await import('../src/core/db/event-queries'), idx: await import('../src/core/http-body-index') }
    expect(other.idx).not.toBe(idx)
    other.db.initDB(dir)
    try { return run(other) } finally { other.idx.closeHttpBodyIndex(); other.db.closeDB() }
  }

  it('does not take from the index what main indexed after the snapshot, and cannot return it through a body', async () => {
    for (let i = 0; i < 5; i++) savedResponse(`old-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha ${i}"}`) })
    search('alpha')
    const snapshot: ExportSnapshot = readActivitySnapshot(db.getReadonlyDB())
    savedResponse('NEW', { response_body_ref: savedBody(dir, '{"n":"newword"}') })
    const first = search('newword')
    expect(first.items.map(e => e.id)).toEqual(['NEW'])
    expect(bodySource(first)).toMatchObject({ status: 'covered', indexed: 6 })

    const bounded = await elsewhere(other => ({
      page: other.queries.executeEventQuery({ parsed: parsed('newword'), filter: {}, snapshot, limit: 50 }).items.map(e => e.id),
      body: other.idx.searchHttpBodyTermIds('newword', dir, false, snapshot).flatMap(t => t.eventIds),
      coverage: other.idx.bodySearchCoverage(snapshot).indexed,
    }))
    expect(bounded).toEqual({ page: [], body: [], coverage: 5 })

    const again = search('newword')
    expect(again.items.map(e => e.id)).toEqual(['NEW'])
    expect(bodySource(again)).toMatchObject({ status: 'covered', indexed: 6 })
  })

  it('answers an older snapshot with the transcript prefix it held, and leaves the newest one to main', async () => {
    fs.mkdirSync(path.join(dir, 'agent-transcripts'))
    const file = path.join(dir, 'agent-transcripts', 'versions.jsonl')
    let text = '', snapshot: ExportSnapshot | undefined
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      text += `{"message":"VERSIONCANARY ${i}"}\n`; fs.writeFileSync(file, text)
      ids.push(insertEvent('agent', { subtype: 'transcript_snapshot', snapshot_path: file, cumulative_bytes: Buffer.byteLength(text),
        cumulative_sha256: createHash('sha256').update(text).digest('hex') }, { engagementId: 'eng', operatorId: 'op' })!.id)
      if (i === 1) snapshot = readActivitySnapshot(db.getReadonlyDB())
    }
    expect(search('VERSIONCANARY').items.map(e => e.id)).toEqual([ids[3]])
    const bounded = await elsewhere(other => other.queries.executeEventQuery({ parsed: parsed('VERSIONCANARY'), filter: {}, snapshot, limit: 50 }))
    expect(bounded.items.map(e => e.id)).toEqual([ids[1]])
    // The file has grown past the prefix that snapshot confirmed: partial.
    expect(bounded.bodyCoverage?.sources?.find(s => s.kind === 'ai-raw')).toMatchObject({ status: 'partial', indexed: 1, pending: 1 })
    const live = cost(() => search('VERSIONCANARY'))
    expect(live.result.items.map(e => e.id)).toEqual([ids[3]])
    expect(live.rows).toBe(0)
  })
})
