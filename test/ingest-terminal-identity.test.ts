// Spec 071 T025 (US1, FR-011): a new row has one terminal identity,
// `_ingest.terminal`, and the core reads that one value wherever it needs it.
//
// FR-011: take `observed.terminal`; a legacy door (every door until the
// contract-1 receiver, Phase 5) falls back to `data.terminalId`, then
// `data.terminal_id`. Before this, the causal link and the 2 s duplicate window
// each read the two fields in their own order — causes-resolver
// `terminal_id ?? terminalId`, event-write `terminalId ?? terminal_id` — so a
// row carrying both was one terminal to the dedup window and another to the
// causal link.
//
// Three halves: the function itself; what the write path stores (`_ingest.
// terminal` on every door, both tiers); and that its readers in core go
// through it (behaviour, and a source check so the next reader does too).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { IN_PROCESS, ingestStamp } from '../src/core/ingest/stamp'
import { rowTerminal, terminalIdentity } from '../src/core/ingest/terminal'

const sqlite = requires('better-sqlite3')

describe('terminalIdentity (FR-011)', () => {
  it('a legacy door reads data.terminalId, then data.terminal_id', () => {
    expect(terminalIdentity({ terminalId: 't-new' })).toBe('t-new')
    expect(terminalIdentity({ terminal_id: 't-old' })).toBe('t-old')
    expect(terminalIdentity({ terminalId: 't-new', terminal_id: 't-old' })).toBe('t-new')
  })

  it('observed.terminal is the identity when the item has `observed`; data is then not read', () => {
    expect(terminalIdentity({ terminalId: 't-data' }, { terminal: 't-obs' })).toBe('t-obs')
    // A contract-1 item says where it was observed; its data is the producer's payload.
    expect(terminalIdentity({ terminalId: 't-data' }, {})).toBeNull()
  })

  it('a value that names no terminal is no terminal: empty, or neither a string nor a number', () => {
    expect(terminalIdentity({})).toBeNull()
    expect(terminalIdentity({ terminalId: '' })).toBeNull()
    expect(terminalIdentity({ terminalId: null, terminal_id: 't-old' })).toBe('t-old')
    // An unusable first field does not hide a usable second one.
    expect(terminalIdentity({ terminalId: '', terminal_id: 't-old' })).toBe('t-old')
    expect(terminalIdentity({ terminalId: { x: 1 } })).toBeNull()
    expect(terminalIdentity({ terminalId: 42 })).toBe('42')
  })

  it('is bounded at 128 characters (FR-002\'s bound for a source-supplied id); the characters are kept', () => {
    expect(terminalIdentity({ terminalId: 'x'.repeat(500) })).toBe('x'.repeat(128))
    expect(terminalIdentity({ terminalId: 'ps-12 a/b' })).toBe('ps-12 a/b')
  })

  it('a stored row: its stamp\'s value; a row stamped without one, or written before the stamp, its data\'s', () => {
    expect(rowTerminal({ terminalId: 't-data', _ingest: { v: 1, door: 'legacy-api', terminal: 't-stamp' } })).toBe('t-stamp')
    expect(rowTerminal({ terminalId: 't-data', _ingest: { v: 1, door: 'legacy-api' } })).toBe('t-data')
    expect(rowTerminal({ terminal_id: 't-pre071' })).toBe('t-pre071')
    // A contract-1 row with no `terminal` in its stamp observed none.
    expect(rowTerminal({ terminalId: 't-data', _ingest: { v: 1, door: 'api' } })).toBeNull()
  })
})

describe('the stamp carries it (FR-005)', () => {
  it('`terminal` sits after `seq`, as FR-005\'s table orders it; omitted when there is none', () => {
    const s = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), terminal: 't-ab12', item: { seq: 3 } }) as Record<string, unknown>
    expect(Object.keys(s)).toEqual(['v', 'door', 'producer', 'credential', 'auth', 'event_id', 'seq', 'terminal'])
    expect(s.terminal).toBe('t-ab12')
    expect('terminal' in ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), terminal: null })).toBe(false)
  })
})

sqlite.describe('the write path stores `_ingest.terminal`, and its readers agree with it', () => {
  let dir = ''
  let pending = ''
  let dbMod: typeof import('../src/core/db/index')
  let events: typeof import('../src/core/db/events')
  let ingestMod: typeof import('../src/core/ingest')
  let spool: typeof import('./helpers/spool-drain-as-main')
  const ENG = 'eng-term'
  const who = { engagementId: ENG, operatorId: 'op-term' }

  beforeEach(async () => {
    dbMod = await import('../src/core/db/index')
    events = await import('../src/core/db/events')
    ingestMod = await import('../src/core/ingest')
    spool = await import('./helpers/spool-drain-as-main')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-term-'))
    pending = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-term-spool-'))
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
  })
  afterEach(async () => {
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    for (const d of [dir, pending]) fs.rmSync(d, { recursive: true, force: true })
  })

  const stampOf = (id: string): Record<string, unknown> => {
    const row = dbMod.getDB().prepare(`SELECT data FROM events WHERE id = ? UNION ALL SELECT data FROM events_logged WHERE id = ?`).get(id, id) as { data: string }
    return (JSON.parse(row.data) as { _ingest: Record<string, unknown> })._ingest
  }

  it('in-process, through ingest() and straight through insertEvent, chained and logged', () => {
    const a = ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'id', terminalId: 't-ip', pid: 1 }, who)!
    const b = events.insertEvent('shell', { subtype: 'command_start', command: 'pwd', terminal_id: 't-ins', pid: 2 }, who)!
    const c = ingestMod.ingestEvent('dns', { subtype: 'dns_query', qname: 'term.test', terminalId: 't-log' }, who)!
    expect(c.tier).toBe('logged')
    expect([a, b, c].map((e) => stampOf(e.id).terminal)).toEqual(['t-ip', 't-ins', 't-log'])
  })

  it('a row with no terminal has no `terminal` in its stamp', () => {
    const e = events.insertEvent('system', { subtype: 'session_start' }, who)!
    expect('terminal' in stampOf(e.id)).toBe(false)
  })

  it('a spooled file (legacy-handoff) is stamped from its data the same way', () => {
    fs.writeFileSync(path.join(pending, '0001.json'), JSON.stringify({ agent_type: 'shell', _identity: who,
      data: { subtype: 'command_start', command: 'ls', pid: 9, terminal_id: 't-sp', source_timestamp: Date.now() - 1000 } }))
    expect(spool.drainSpoolAsMain(pending, who)?.replayed).toBe(1)
    const row = dbMod.getDB().prepare(`SELECT data FROM events WHERE agent_type = 'shell'`).get() as { data: string }
    expect((JSON.parse(row.data) as { _ingest: Record<string, unknown> })._ingest).toMatchObject({ door: 'legacy-handoff', terminal: 't-sp' })
  })

  it('a caller\'s own `_ingest.terminal` does not survive: the receiver\'s value replaces it', () => {
    const e = ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'w', terminalId: 't-real', pid: 3,
      _ingest: { v: 1, terminal: 't-forged' } }, who)!
    expect(stampOf(e.id)).toMatchObject({ terminal: 't-real', stripped: ['_ingest'] })
  })

  // The defect FR-011 removes. Both fields present, as a producer migrating
  // from one name to the other sends them: the stamp, the duplicate window
  // and the causal link must all see one terminal.
  it('a command_end is linked to its command_start by the stamp\'s terminal, whichever field carried it', () => {
    const start = ingestMod.ingest({ agentType: 'shell', ...who,
      data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', pid: 77, terminalId: 't-B', terminal_id: 't-A' } }).event!
    const end = ingestMod.ingest({ agentType: 'shell', ...who,
      data: { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', pid: 77, terminalId: 't-B', exit_code: 0 } }).event!
    expect(end.data._causes).toContain(start.id)
    expect(stampOf(start.id).terminal).toBe('t-B')
    expect(stampOf(end.id).terminal).toBe('t-B')
  })

  it('the duplicate window sees the same terminal the stamp names', () => {
    const first = events.insertEvent('shell', { subtype: 'command_start', command: 'ls', terminalId: 't-B', terminal_id: 't-A' }, who)
    expect(first).not.toBeNull()
    // Same terminal by the stamp's reading (terminalId first): a duplicate.
    expect(events.insertEvent('shell', { subtype: 'command_start', command: 'ls', terminalId: 't-B' }, who)).toBeNull()
    // The other field's value is another terminal: not a duplicate.
    expect(events.insertEvent('shell', { subtype: 'command_start', command: 'ls', terminal_id: 't-A' }, who)).not.toBeNull()
  })
})

// The next reader in core that wants a new row's terminal must not read the
// two fields itself. These are the files FR-011 names and the write path's
// own readers; each derives the identity through stamp.ts or not at all.
describe('core readers of a new row\'s terminal go through stamp.ts (source check)', () => {
  const SRC = path.join(__dirname, '..', 'src', 'core')
  const READERS = [path.join('causes-resolver.ts'), path.join('db', 'event-write.ts'), path.join('ingest.ts')]
  for (const rel of READERS) {
    it(rel, () => {
      const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n')
      const bad = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter(({ line }) => /\.(terminalId|terminal_id)\b|\[['"](terminalId|terminal_id)['"]\]/.test(line))
        .map(({ line, n }) => `${n}: ${line.trim()}`)
      expect(bad).toEqual([])
    })
  }
})
