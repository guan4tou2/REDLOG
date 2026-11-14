// A saved body that vanishes or changes while it is read ends missing or
// failed, and those are retried on every search. The documents the read wrote
// before it failed must go with it: kept, each retry added another copy, the
// event was found while coverage said missing, and the copies outlived the
// file coming back.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parsed, savedBody, savedResponse, bodySource } from './helpers/body-index-work'
import { documentRowids } from './helpers/body-index-layout'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
}
let dir = ''
const search = (text: string) => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 50 })

sqlite.describe('a read that fails after it wrote documents', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-midread-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const docs = (id: string): number => {
    const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try { return documentRowids(index, id).length } finally { index.close() }
  }
  /** From the first byte read on, the body file looks `gone` (removed) or
   *  `replaced` (another file) to the check after the read. */
  function midRead(file: string, how: 'gone' | 'replaced'): () => void {
    let reading = false
    const readSync = fs.readSync, lstatSync = fs.lstatSync
    const reads = vi.spyOn(fs, 'readSync').mockImplementation(((...a: unknown[]) => { reading = true; return (readSync as (...b: unknown[]) => number)(...a) }) as typeof fs.readSync)
    const stats = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (reading && String(p) === file) {
        if (how === 'gone') throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
        return (lstatSync as (...b: unknown[]) => fs.Stats)(path.dirname(file), ...rest)
      }
      return (lstatSync as (...b: unknown[]) => fs.Stats)(p, ...rest)
    }) as typeof fs.lstatSync)
    return () => { reads.mockRestore(); stats.mockRestore(); reading = false }
  }

  // `documents`: what the body makes once read whole. Three is a body of three
  // overlapping chunks, each written before the read fails.
  it.each([['gone', 1], ['replaced', 1], ['gone', 3]] as const)('a body %s mid-read keeps none of its %i documents, however often it is retried', (how, documents) => {
    const text = documents === 1 ? '{"n":"MIDREADWORD"}' : `{"n":"MIDREADWORD ${'filler words '.repeat(170_000)}"}`
    const ref = savedBody(dir, text), file = path.join(dir, 'http-bodies', ref.file)
    fs.rmSync(file)
    savedResponse('E', { response_body_ref: ref })
    expect(search('MIDREADWORD').items).toEqual([])
    fs.writeFileSync(file, text)
    for (let i = 0; i < 3; i++) {
      const stop = midRead(file, how)
      let page
      try { page = search('MIDREADWORD') } finally { stop() }
      expect({ items: page.items.map(e => e.id), docs: docs('E'), status: bodySource(page)?.status })
        .toEqual({ items: [], docs: 0, status: how === 'gone' ? 'unavailable' : 'failed' })
    }
    // Once it reads whole, it has its documents once each, however many
    // searches follow.
    for (let i = 0; i < 3; i++) {
      const back = search('MIDREADWORD')
      expect({ items: back.items.map(e => e.id), docs: docs('E'), status: bodySource(back)?.status }).toEqual({ items: ['E'], docs: documents, status: 'covered' })
    }
  })
})
