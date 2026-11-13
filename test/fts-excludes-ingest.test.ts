// Spec 071 T033 (FR-025): full-text search does not find a row by its
// receiver stamp. Every new row carries `data._ingest` (FR-005) — `door`,
// `auth`, `in-process`, `legacy-api`, a UUIDv7 — and the index used to read
// every key and value of `data`, so searching `door` found every row written
// since the stamp. The insert triggers now skip the `$._ingest` subtree.
//
// The search path is one: buildTierWhere in src/core/db/event-queries.ts
// matches `events_fts` / `events_logged_fts`, which only the two `_ai`
// triggers (and a rebuild, with the same text) fill. `events_logged_fts_ad`
// deletes by rowid and reads no `data`. The saved-body index and the cast
// index read files, never `data` (src/core/http-body-index.ts,
// src/core/cast-index.ts), so they cannot see the stamp.
//
// The trigger swap must not rebuild the index (plan: "替換 trigger、不重建").
// Old rows have no `_ingest`, so what the old trigger indexed for them is
// exactly what the new one would. T033 asks for that to be measured on a
// 100 000-row project; this machine takes no large seeded databases, so it is
// shown structurally here — no rebuild statement runs, and the index's row
// count and per-row token sizes are unchanged across the swap — and the
// 100k measurement is left to T091 / CI.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')

let dbMod: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ingestMod: typeof import('../src/core/ingest')
let parseQuery: typeof import('../src/core/query/contract').parseQuery
let stamp: typeof import('../src/core/ingest/stamp')
if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ingestMod = await import('../src/core/ingest')
  parseQuery = (await import('../src/core/query/contract')).parseQuery
  stamp = await import('../src/core/ingest/stamp')
}

const ENG = 'eng-fts'
const who = { engagementId: ENG, operatorId: 'op-fts' }

function search(text: string): string[] {
  const outcome = parseQuery(text)
  if (!outcome.ok) throw new Error(`query did not parse: ${outcome.reason}`)
  return events.executeEventQuery({ parsed: outcome.parsed, filter: {}, limit: 100 }).items.map((e) => e.id)
}

/** Both triggers as every project before T033 stored them. */
const PRE_T033_INSERT_TRIGGER = (table: string): string => `CREATE TRIGGER ${table}_fts_ai AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${table}_fts(rowid, data, target_id, agent_type)
          VALUES (new.rowid, (SELECT group_concat(
      CASE WHEN typeof(key) = 'text' THEN key || ' ' ELSE '' END ||
      CASE type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
        WHEN 'null' THEN 'null' ELSE COALESCE(CAST(atom AS TEXT), '') END, ' ')
      FROM json_tree(new.data)), new.target_id, new.agent_type);
        END`

sqlite.describe('the full-text index does not read the stamp (FR-025)', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fts-ingest-'))
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
  })
  afterEach(async () => {
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a chained and a logged row are found by their content, never by their stamp', () => {
    const shell = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't1', pid: 1 }, ...who }).event!
    const dns = ingestMod.ingest({ agentType: 'dns', data: { subtype: 'dns_query', qname: 'zebrafish.test' }, ...who }).event!
    expect(dns.tier).toBe('logged')
    expect(search('nmap')).toEqual([shell.id])
    expect(search('zebrafish')).toEqual([dns.id])
    const eventId = String((shell.data._ingest as Record<string, unknown>).event_id)
    for (const term of ['door', 'auth', 'producer', 'credential', 'stripped', 'process', '"in-process"', '"legacy-api"', `"${eventId}"`, eventId.split('-')[0]]) {
      expect(search(term), term).toEqual([])
    }
  })

  it('the API door\'s words are not found either', () => {
    ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't2', pid: 2, _ingest: { door: 'forged' } }, ...who, entrance: stamp.LEGACY_API })
    for (const term of ['legacy', 'bearer', '"legacy-api"', 'forged', '_ingest', 'ingest']) expect(search(term), term).toEqual([])
    expect(search('id')).toHaveLength(1)
  })

  it('a key named like the stamp below the top level is still indexed', () => {
    const ev = events.insertEvent('shell', { subtype: 'command_start', command: 'echo', nested: { _ingest: 'quokka' } }, who)!
    expect(search('quokka')).toEqual([ev.id])
  })
})

sqlite.describe('swapping the trigger does not rebuild the index (plan: replace the trigger, no rebuild)', () => {
  let dir = ''
  const Database = createRequire(import.meta.url)('better-sqlite3') as { prototype: { exec: (sql: string) => unknown; prepare: (sql: string) => unknown } }
  const realExec = Database.prototype.exec
  const realPrepare = Database.prototype.prepare
  let seen: string[] = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fts-swap-'))
  })
  afterEach(async () => {
    Database.prototype.exec = realExec
    Database.prototype.prepare = realPrepare
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a project indexed by the pre-T033 trigger opens with the new trigger, no rebuild, every index row as it was', () => {
    // A project as it stood before T033: the old insert triggers, rows indexed
    // by them, seeded in one transaction.
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    const db = dbMod.getDB()
    for (const table of ['events', 'events_logged']) {
      db.exec(`DROP TRIGGER ${table}_fts_ai`)
      db.exec(PRE_T033_INSERT_TRIGGER(table))
    }
    db.transaction(() => {
      for (let i = 0; i < 40; i++) {
        events.insertEvent('shell', { subtype: 'command_start', command: `whoami ${i}` }, who)
        events.insertEvent('dns', { subtype: 'dns_query', qname: `h${i}.test` }, who)
      }
    })()
    const snapshot = (): Record<string, unknown> => Object.fromEntries(['events', 'events_logged'].map((t) => [t, {
      rows: (dbMod.getDB().prepare(`SELECT COUNT(*) AS n FROM ${t}_fts_docsize`).get() as { n: number }).n,
      docsize: dbMod.getDB().prepare(`SELECT id, sz FROM ${t}_fts_docsize ORDER BY id`).all()
    }]))
    const before = snapshot()
    expect((before.events as { rows: number }).rows).toBe(40)
    dbMod.closeDB()

    // Reopen with every statement recorded.
    seen = []
    Database.prototype.exec = function (this: unknown, sql: string) { seen.push(sql); return realExec.call(this, sql) }
    Database.prototype.prepare = function (this: unknown, sql: string) { seen.push(sql); return realPrepare.call(this, sql) }
    dbMod.initDB(dir)
    Database.prototype.exec = realExec
    Database.prototype.prepare = realPrepare

    const rebuilds = seen.filter((s) => /INSERT\s+INTO\s+events(_logged)?_fts\s*\([^)]*\)\s*(SELECT|VALUES\s*\(\s*'(rebuild|delete-all)')/i.test(s)
      || /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?events(_logged)?_fts\b/i.test(s))
    expect(rebuilds).toEqual([])
    expect(snapshot()).toEqual(before)
    // The swap happened: the stored triggers are the new ones.
    for (const table of ['events', 'events_logged']) {
      const sql = (dbMod.getDB().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(`${table}_fts_ai`) as { sql: string }).sql
      expect(sql, table).not.toBe(PRE_T033_INSERT_TRIGGER(table))
      expect(sql, table).toContain("'$._ingest'")
    }
    // A second open of the now-current project writes no trigger at all.
    dbMod.closeDB()
    seen = []
    Database.prototype.exec = function (this: unknown, sql: string) { seen.push(sql); return realExec.call(this, sql) }
    dbMod.initDB(dir)
    Database.prototype.exec = realExec
    expect(seen.filter((s) => /\b(CREATE|DROP)\s+TRIGGER\b[^;]*_fts_/i.test(s))).toEqual([])
  })
})
