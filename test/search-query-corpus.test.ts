import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  loadCorpus, seedCorpus, replayEntry, REQUIRED_COVERAGE, type Corpus
} from './search-query-corpus.harness'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let getDB: typeof import('../src/core/db/index').getDB
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const queryMod = await import('../src/core/db/event-queries')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  closeHttpBodyIndex = (await import('../src/core/http-body-index')).closeHttpBodyIndex
  getDB = dbMod.getDB
  executeEventQuery = queryMod.executeEventQuery
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

const corpus: Corpus = loadCorpus()

let tmpDir: string

/**
 * Spec 018 T002 — the non-regression corpus.
 *
 * Every entry here is a query a Search operator can type today, replayed
 * through the same call SearchPanel makes, against a dataset frozen alongside
 * it in `search-query-corpus.json`. The expectations were CAPTURED from this
 * implementation (T001), not written by hand, so the file records what Search
 * does rather than what anyone believed it did.
 *
 * Spec 018 FR-002: every query valid before the Spec 017 migration must select
 * the same event set after it, or its changed meaning must be recorded and
 * accepted. This file is the "same event set" half. The recorded-and-accepted
 * half is the changed-meaning table in
 * `specs/018-search-query-migration/research.md` — when an entry there is
 * migrated, its expectation is updated here in the same commit, with the
 * research entry as the reason. An expectation that changes without one is the
 * silent meaning change the corpus exists to prevent.
 *
 * The assertions compare the ORDERED id list, not a set: Search presents its
 * results in canonical order and an operator reads the top of the list first,
 * so a reordering is a behaviour change too.
 */
describeDB('Search query migration corpus', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-search-corpus-'))
    initDB(tmpDir)
    seedCorpus(getDB(), corpus.dataset)
  })
  afterEach(() => {
    // `closeDB()` leaves `http-body-index.db` open — the search path opens it
    // lazily via `searchHttpBodyEventIds`. Windows answers EBUSY on rmSync
    // while it is open, so close it first (same reason as search-pagination).
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  for (const entry of corpus.entries) {
    it(`${entry.id}: ${JSON.stringify(entry.query)} selects the same events`, () => {
      expect(replayEntry(executeEventQuery, entry)).toEqual(entry.expected)
    })
  }

  it('the seeded dataset is exactly what the corpus was captured against', () => {
    // A row added, dropped or reordered here silently rewrites every
    // expectation above, so the dataset is pinned as tightly as the results.
    const rows = getDB().prepare(`
      SELECT id, 'chained' AS tier FROM events
      UNION ALL
      SELECT id, 'logged' AS tier FROM events_logged
    `).all() as Array<{ id: string; tier: string }>
    expect(rows).toEqual(corpus.dataset.map((row) => ({ id: row.id, tier: row.tier })))
  })

  it('covers every bullet the corpus is required to witness', () => {
    const covered = new Set(corpus.entries.flatMap((entry) => entry.covers))
    expect([...REQUIRED_COVERAGE].filter((bullet) => !covered.has(bullet))).toEqual([])
  })

  it('names no coverage bullet that is not required', () => {
    // Stops a typo'd `covers` value from looking like coverage it is not.
    const known = new Set<string>(REQUIRED_COVERAGE)
    const unknown = corpus.entries.flatMap((entry) =>
      entry.covers.filter((bullet) => !known.has(bullet)).map((bullet) => `${entry.id}: ${bullet}`))
    expect(unknown).toEqual([])
  })
})
