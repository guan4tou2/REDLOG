// Spec 017 T001b — guard tests for FR-008.
//
// Written after T009 rather than before it, because the implementation
// deliberately reuses the store's existing `toMatchQuery` instead of matching
// text a new way. There was no behaviour change to drive test-first; what
// there is, is a behaviour that a later refactor would drop in silence, which
// the Spec 018 corpus flagged before it could happen:
//
//   Each whitespace term becomes a quoted FTS5 phrase, so a URL, an IP address
//   and a `-sV` flag match as typed rather than being read as FTS operators.
//   The final term also gets a `*`, which is the only reason type-ahead works
//   on a box that queries every keystroke — drop it and every partially typed
//   word reports "no results" until it is finished.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery } from '../src/core/query/contract'
import type { ParsedQuery } from '../src/core/query/contract'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let insertEvent: typeof import('../src/core/db/event-write').insertEvent
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let available = false

try {
  const db = await import('../src/core/db')
  const write = await import('../src/core/db/event-write')
  const queries = await import('../src/core/db/event-queries')
  const bodyIndex = await import('../src/core/http-body-index')
  initDB = db.initDB
  closeDB = db.closeDB
  insertEvent = write.insertEvent
  closeHttpBodyIndex = bodyIndex.closeHttpBodyIndex
  executeEventQuery = queries.executeEventQuery
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

function parsed(input: string): ParsedQuery {
  const outcome = parseQuery(input)
  if (!outcome.ok) throw new Error(`expected ${input} to parse, got ${outcome.reason}`)
  return outcome.parsed
}

function seed(full: string): string {
  const e = insertEvent('agent', { subtype: 'assistant_message', session_id: 'S1', full }, { operatorId: 'op' })
  if (!e) throw new Error('insertEvent returned null')
  return e.id
}

function found(input: string): string[] {
  return executeEventQuery({ parsed: parsed(input) }).items.map((e) => e.id)
}

describeDB('free text keeps the matching the store already provides (T001b)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-query-text-'))
    initDB(dir)
  })
  afterEach(() => {
    // A text query opens the http-body index; Windows refuses to unlink
    // an open file, so leaving it open fails the cleanup, not the assertion.
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('prefix-matches the final term, so a half-typed word still matches', () => {
    const id = seed('ran nmapscan against the host')
    expect(found('nmap')).toContain(id)
  })

  it('does not prefix-match an earlier term, which would widen the query', () => {
    seed('nmapscan finished')
    const id = seed('nmap finished')
    expect(found('nmap finished')).toEqual([id])
  })

  it('matches a pasted URL as typed', () => {
    const id = seed('fetched https://example.com/a and moved on')
    expect(found('https://example.com/a')).toContain(id)
  })

  it('matches an IP address as typed', () => {
    const id = seed('connected to 10.10.10.11 on 443')
    expect(found('10.10.10.11')).toContain(id)
  })

  it('matches a flag beginning with a hyphen, which FTS would read as an operator', () => {
    const id = seed('nmap -sV target')
    expect(found('-sV')).toContain(id)
  })

  it('folds case, so capitals are not a different question', () => {
    const id = seed('Connection Refused by peer')
    expect(found('connection refused')).toContain(id)
  })

  it('requires every term, rather than any of them', () => {
    const both = seed('connection refused by peer')
    seed('connection established')
    expect(found('connection refused')).toEqual([both])
  })
})
