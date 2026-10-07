// An annotation on an event, stored beside the chain rather than in it.
//
// The record says what happened. It does not say "this 404 is the interesting
// one" or "ran this twice by mistake", and three weeks later that is the part
// nobody can reconstruct. But the events rows are hashed and immutable: a
// note written an hour after the fact must not touch the row it is about, or
// the chain stops verifying.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let dbmod: typeof import('../src/core/db/index') | null = null
let notes: typeof import('../src/core/db/event-notes') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  dbmod = await import('../src/core/db/index')
  notes = await import('../src/core/db/event-notes')
} catch { /* better-sqlite3 not built for this Node ABI */ }

describe.skipIf(!notes)('an event note', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-note-'))
    dbmod!.initDB(dir)
  })
  afterEach(() => {
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is absent until written', () => {
    expect(notes!.getEventNote('e1')).toBeNull()
  })

  it('round-trips, with its own timestamps', () => {
    const before = Date.now()
    const saved = notes!.setEventNote('e1', 'this 404 is the interesting one')
    expect(saved?.note).toBe('this 404 is the interesting one')
    // The timestamps are the whole honesty of an annotation: a reader has to
    // be able to see it was written after the event, and when.
    expect(saved!.createdAt).toBeGreaterThanOrEqual(before)
    expect(notes!.getEventNote('e1')?.note).toBe('this 404 is the interesting one')
  })

  it('keeps createdAt across an edit — how long it has been annotated is its own fact', () => {
    const first = notes!.setEventNote('e1', 'draft')!
    const edited = notes!.setEventNote('e1', 'final')!
    expect(edited.note).toBe('final')
    expect(edited.createdAt).toBe(first.createdAt)
  })

  it('clearing deletes the row rather than storing an empty note', () => {
    // A blank note reads as "they looked and had nothing to say", which is a
    // different claim from never having annotated it.
    notes!.setEventNote('e1', 'something')
    expect(notes!.setEventNote('e1', '   ')).toBeNull()
    expect(notes!.getEventNote('e1')).toBeNull()
  })

  it('trims, so a stray newline is not a note', () => {
    notes!.setEventNote('e1', '  kept  ')
    expect(notes!.getEventNote('e1')?.note).toBe('kept')
  })

  it('keeps notes to their own events', () => {
    notes!.setEventNote('e1', 'one')
    notes!.setEventNote('e2', 'two')
    expect(notes!.getEventNote('e1')?.note).toBe('one')
    expect(notes!.getAnnotatedIds()).toEqual(new Set(['e1', 'e2']))
  })

  it('does not touch the event it annotates', () => {
    // The point of the side table. If a note could reach the events row, the
    // hash over that row would change and every later link would break.
    const cols = dbmod!.getDB().prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'note')).toBe(false)
  })
})
