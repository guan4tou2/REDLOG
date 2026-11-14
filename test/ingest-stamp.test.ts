// Spec 071 T020 (US1): the receiver's stamp, `data._ingest` (FR-005, FR-006),
// and the engagement a new row is written under (FR-007, T021).
//
// Two halves. The first holds src/core/ingest/stamp.ts to the stamp's shape:
// which keys, which value types, how big, how the Processor rule list is
// bounded. The second holds the write path to it: whatever a caller put under
// `_ingest` or the other receiver-owned keys, the stored row carries the
// receiver's values, names what it removed, and the chain hash covers it.
//
// Which door stamps what (api, spool, derived) is T030's test,
// test/ingest-stamp-doors.test.ts.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { IN_PROCESS, RESERVED_DATA_KEYS, engagementForWrite, ingestStamp, stripReserved } from '../src/core/ingest/stamp'

const sqlite = requires('better-sqlite3')

/** FR-005's keys, in the table's order. */
const FR005_KEYS = ['v', 'door', 'producer', 'credential', 'auth', 'event_id', 'instance', 'seq', 'terminal', 'target_via',
  'claimed', 'stripped', 'collapsed', 'rules', 'rules_partial']
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

/** FR-006: strings, integers, booleans, null and arrays of strings. `claimed`
 *  is the one nested object FR-005 names, and holds only strings. */
function typeViolations(stamp: Record<string, unknown>): string[] {
  const bad: string[] = []
  const scalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'boolean'
    || (typeof v === 'number' && Number.isInteger(v))
  for (const [k, v] of Object.entries(stamp)) {
    if (k === 'claimed') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { bad.push(k); continue }
      for (const [ck, cv] of Object.entries(v)) if (typeof cv !== 'string') bad.push(`claimed.${ck}`)
      continue
    }
    if (Array.isArray(v)) { if (!v.every((x) => typeof x === 'string')) bad.push(k); continue }
    if (!scalar(v)) bad.push(k)
  }
  return bad
}

/** A contract-1 item as plan.md's example has it: what a typical new row carries. */
const TYPICAL = {
  eventId: 'k7f3q9x2m4p8r1t6.000042', instance: 'k7f3q9x2m4p8r1t6', seq: 42,
  claimed: { producer: 'zsh-hook@0.18.0+c1', operator: 'op-1' }
}
const TYPICAL_ENTRANCE = { door: 'api', producer: 'shell', auth: 'bearer', credential: 'c4kq2x9a:1' } as const

describe('the stamp (FR-005, FR-006)', () => {
  it('an in-process row: v, door, producer, credential, auth and a receiver event_id; nothing else', () => {
    const now = Date.UTC(2026, 10, 13, 9, 30)
    const s = ingestStamp(IN_PROCESS, { tier: 'chained', now }) as Record<string, unknown>
    expect(Object.keys(s)).toEqual(['v', 'door', 'producer', 'credential', 'auth', 'event_id'])
    expect(s).toMatchObject({ v: 1, door: 'in-process', producer: 'in-process', credential: null, auth: 'in-process' })
    // D4: an item that brings no event_id gets a UUIDv7 from the receiver,
    // whose first 48 bits are the receipt time.
    expect(s.event_id).toMatch(UUID_V7)
    expect(parseInt(String(s.event_id).replace(/-/g, '').slice(0, 12), 16)).toBe(now)
  })

  it('two rows never share a receiver event_id', () => {
    const now = Date.now()
    const ids = new Set(Array.from({ length: 200 }, () => ingestStamp(IN_PROCESS, { tier: 'chained', now }).event_id))
    expect(ids.size).toBe(200)
  })

  it('every key it can carry is one FR-005 names, in the table\'s order, of the types FR-006 allows', () => {
    const s = ingestStamp(TYPICAL_ENTRANCE, {
      tier: 'chained', now: Date.now(), stripped: ['_raw', '_ingest'], collapsed: 2, terminal: 't-ab12',
      item: { ...TYPICAL, rules: [{ pluginId: 'b', contentHash: 'f'.repeat(64) }, { pluginId: 'a', contentHash: '0'.repeat(64) }], rulesPartial: true }
    }) as Record<string, unknown>
    const keys = Object.keys(s)
    expect(keys.filter((k) => !FR005_KEYS.includes(k))).toEqual([])
    expect(keys).toEqual(FR005_KEYS.filter((k) => keys.includes(k)))
    expect(typeViolations(s)).toEqual([])
    expect(s).toMatchObject({
      door: 'api', producer: 'shell', credential: 'c4kq2x9a:1', auth: 'bearer',
      event_id: TYPICAL.eventId, instance: TYPICAL.instance, seq: 42, terminal: 't-ab12',
      claimed: { producer: 'zsh-hook@0.18.0+c1', operator: 'op-1' },
      // In RESERVED_DATA_KEYS order, whatever order they were found in.
      stripped: ['_ingest', '_raw'],
      // FR-097: how many over-deep containers are stored as JSON text.
      collapsed: 2,
      rules: ['a#000000000000', 'b#ffffffffffff'],
      rules_partial: true
    })
  })

  it('a logged row carries no `claimed` (plan, data shapes)', () => {
    const s = ingestStamp(TYPICAL_ENTRANCE, { tier: 'logged', now: Date.now(), item: TYPICAL }) as Record<string, unknown>
    expect(s.claimed).toBeUndefined()
    expect(s.event_id).toBe(TYPICAL.eventId)
  })

  it('optional keys are omitted, not null, when there is nothing to say', () => {
    const s = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), stripped: [], collapsed: 0, item: { rules: [], rulesPartial: false } }) as Record<string, unknown>
    for (const k of ['instance', 'seq', 'terminal', 'claimed', 'stripped', 'collapsed', 'rules', 'rules_partial']) expect(k in s, k).toBe(false)
  })

  it('a claimed value is a claim: bounded, and only identifier characters survive', () => {
    const s = ingestStamp(TYPICAL_ENTRANCE, {
      tier: 'chained', now: Date.now(),
      item: { claimed: { producer: `evil"\n\u0000${'x'.repeat(500)}`, operator: '运营者' } }
    }) as { claimed: { producer: string; operator: string } }
    expect(s.claimed.producer).toMatch(/^[A-Za-z0-9._:@+/-]{1,32}$/)
    expect(s.claimed.producer.startsWith('evil')).toBe(true)
    expect(s.claimed.operator).toMatch(/^[A-Za-z0-9._:@+/-]{1,32}$/)
  })

  describe('rules (Spec 075 FR-059 as FR-006 bounds it)', () => {
    const rule = (pluginId: string, seed: string) => ({ pluginId, contentHash: crypto.createHash('sha256').update(seed).digest('hex') })

    it('each item is `<pluginId>#<first 12 of the content hash>`, in lexicographic order', () => {
      const s = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), item: { rules: [rule('zeta', 'z'), rule('alpha', 'a')] } })
      expect(s.rules).toEqual([`alpha#${rule('alpha', 'a').contentHash.slice(0, 12)}`, `zeta#${rule('zeta', 'z').contentHash.slice(0, 12)}`])
    })

    it('a plugin id is cut at 32 characters, so no item exceeds 45 bytes', () => {
      const s = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), item: { rules: [rule('p'.repeat(200), 'x')] } })
      expect(s.rules).toHaveLength(1)
      expect(s.rules![0]).toBe(`${'p'.repeat(32)}#${rule('', 'x').contentHash.slice(0, 12)}`)
      expect(Buffer.byteLength(s.rules![0])).toBe(45)
    })

    it('three plugins are listed whole; a fourth turns the third item into `+<the rest>`', () => {
      const three = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), item: { rules: [rule('c', '3'), rule('a', '1'), rule('b', '2')] } })
      expect(three.rules!.map((r) => r.split('#')[0])).toEqual(['a', 'b', 'c'])
      const five = ingestStamp(IN_PROCESS, { tier: 'chained', now: Date.now(), item: { rules: ['e', 'c', 'a', 'd', 'b'].map((p) => rule(p, p)) } })
      expect(five.rules).toHaveLength(3)
      expect(five.rules!.slice(0, 2).map((r) => r.split('#')[0])).toEqual(['a', 'b'])
      expect(five.rules![2]).toBe('+3')
    })
  })

  describe('size (FR-006, SC-009)', () => {
    it('a typical stamp is at most 320 bytes', () => {
      // plan.md's example row, which names its terminal (FR-011).
      const s = ingestStamp(TYPICAL_ENTRANCE, { tier: 'chained', now: Date.now(), item: TYPICAL, terminal: 't-ab12' })
      expect(bytes(s)).toBeLessThanOrEqual(320)
    })

    it('the worst the rules can do, with every reserved key stripped and claims at their bound, stays within 512 bytes', () => {
      const many = Array.from({ length: 40 }, (_, i) => ({ pluginId: `${String.fromCharCode(97 + (i % 26))}${'q'.repeat(60)}${i}`, contentHash: 'e'.repeat(64) }))
      const s = ingestStamp(TYPICAL_ENTRANCE, {
        tier: 'chained', now: Date.now(), stripped: [...RESERVED_DATA_KEYS],
        // A 20 MB body holds at most ~7 million collapsible containers (`[],` each).
        collapsed: 9_999_999,
        item: { ...TYPICAL, claimed: { producer: 'p'.repeat(400), operator: 'o'.repeat(400) }, rules: many, rulesPartial: true }
      })
      expect(s.rules).toHaveLength(3)
      expect(bytes(s), JSON.stringify(s)).toBeLessThanOrEqual(512)
    })
  })

  it('the receiver-owned keys of `data` are exactly the four FR-005 names; `_causes` is not one of them', () => {
    expect([...RESERVED_DATA_KEYS]).toEqual(['_ingest', '_raw', '_clock_anomaly', '_source_time_rejected'])
    const data: Record<string, unknown> = { subtype: 'x', _causes: ['a'], _other: 1, _source_time_rejected: {}, _ingest: { v: 9 }, _clock_anomaly: {}, _raw: 'r' }
    expect(stripReserved(data)).toEqual(['_ingest', '_raw', '_clock_anomaly', '_source_time_rejected'])
    expect(data).toEqual({ subtype: 'x', _causes: ['a'], _other: 1 })
    expect(stripReserved(data)).toEqual([])
  })
})

sqlite.describe('the write path stamps every new row (FR-005, FR-020)', () => {
  let dir = ''
  let dbMod: typeof import('../src/core/db/index')
  let events: typeof import('../src/core/db/events')
  let ingestMod: typeof import('../src/core/ingest')
  let rules: typeof import('../src/core/evidence-rules')

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-'))
    dbMod = await import('../src/core/db/index')
    events = await import('../src/core/db/events')
    ingestMod = await import('../src/core/ingest')
    rules = await import('../src/core/evidence-rules')
    dbMod.initDB(dir)
    dbMod.bindDBEngagement('eng-stamp')
    ingestMod._resetIngest()
  })
  afterEach(() => {
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const who = { engagementId: 'eng-stamp', operatorId: 'op-stamp' }
  const stored = (table: 'events' | 'events_logged', id: string): Record<string, unknown> & { data: string } =>
    dbMod.getDB().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> & { data: string }

  it('a caller\'s `_ingest`, `_raw`, `_clock_anomaly` and `_source_time_rejected` do not reach the row; the receiver\'s stamp does, naming them', () => {
    const forged = {
      subtype: 'command_start', command: 'id', terminalId: 't-forge', pid: 1,
      _ingest: { v: 1, door: 'api', producer: 'builtin-terminal', auth: 'bearer', credential: 'stolen:1' },
      _raw: { sha256: '0'.repeat(64), size: 1 },
      _clock_anomaly: { reason: 'forged' },
      _source_time_rejected: { value: 1, reason: 'forged' },
      _causes: ['cause-1']
    }
    const r = ingestMod.ingest({ agentType: 'shell', data: forged, ...who })
    expect(r.event).not.toBeNull()
    const data = JSON.parse(stored('events', r.event!.id).data) as Record<string, unknown>
    expect(data._ingest).toMatchObject({ v: 1, door: 'in-process', producer: 'in-process', auth: 'in-process', credential: null,
      stripped: ['_ingest', '_raw', '_clock_anomaly', '_source_time_rejected'] })
    expect((data._ingest as Record<string, unknown>).event_id).toMatch(UUID_V7)
    for (const k of ['_raw', '_clock_anomaly', '_source_time_rejected']) expect(k in data, k).toBe(false)
    expect(data._causes).toEqual(['cause-1'])
    // The returned row is the stored row.
    expect(r.event!.data).toEqual(data)
  })

  it('the caller\'s object is not changed: the same object ingested twice records the same `stripped` both times', () => {
    const forged = { subtype: 'note', text: 'same object', _ingest: { door: 'forged' }, _raw: 'forged' }
    const first = ingestMod.ingest({ agentType: 'external', data: forged, ...who }).event!
    expect(forged).toEqual({ subtype: 'note', text: 'same object', _ingest: { door: 'forged' }, _raw: 'forged' })
    const second = ingestMod.ingest({ agentType: 'external', data: forged, ...who }).event!
    expect(second.id).not.toBe(first.id)
    for (const ev of [first, second]) {
      expect((JSON.parse(stored('events', ev.id).data)._ingest as Record<string, unknown>).stripped).toEqual(['_ingest', '_raw'])
    }
  })

  it('the receiver\'s own `_raw` is kept: only the caller\'s is replaced', () => {
    const r = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'whoami', terminalId: 't-raw', pid: 2, _raw: 'forged' }, ...who,
      envelope: { raw: '{"agent_type":"shell"}', source: 'api' } })
    const data = JSON.parse(stored('events', r.event!.id).data) as Record<string, unknown>
    expect(data._raw).toMatchObject({ sha256: crypto.createHash('sha256').update('{"agent_type":"shell"}').digest('hex') })
    expect((data._ingest as Record<string, unknown>).stripped).toEqual(['_raw'])
  })

  it('a row written straight through insertEvent is stamped too (the 30 direct calls T037 has not moved yet)', () => {
    const ev = events.insertEvent('system', { subtype: 'session_start' }, who)!
    const data = JSON.parse(stored('events', ev.id).data) as Record<string, unknown>
    expect(Object.keys(data)).toEqual(['subtype', '_ingest'])
    expect(data._ingest).toMatchObject({ v: 1, door: 'in-process', producer: 'in-process', auth: 'in-process', credential: null })
    expect('stripped' in (data._ingest as object)).toBe(false)
  })

  it('a logged-tier row is stamped, without `claimed`', () => {
    const r = ingestMod.ingest({ agentType: 'dns', data: { subtype: 'dns_query', qname: 'stamp.test', _ingest: 'forged' }, ...who })
    expect(r.event!.tier).toBe('logged')
    const data = JSON.parse(stored('events_logged', r.event!.id).data) as Record<string, unknown>
    expect(data._ingest).toMatchObject({ v: 1, door: 'in-process', stripped: ['_ingest'] })
    expect('claimed' in (data._ingest as object)).toBe(false)
  })

  it('the stamp is inside the chained hash: the stored hash covers it, and a different stamp is a different hash', () => {
    const ev = events.insertEvent('system', { subtype: 'session_start' }, who)!
    const row = stored('events', ev.id) as Parameters<typeof rules.chainedRowCanonical>[0] & { data: string; hash: string }
    const data = JSON.parse(row.data) as { _ingest: Record<string, unknown> }
    expect(data._ingest).toBeDefined()
    const sha = (parsed: unknown): string => crypto.createHash('sha256').update(rules.chainedRowCanonical(row, parsed)).digest('hex')
    expect(sha(data)).toBe(row.hash)
    expect(sha({ ...data, _ingest: { ...data._ingest, door: 'api' } })).not.toBe(row.hash)
  })
})

sqlite.describe('the engagement of a new row is the open database\'s (FR-007, T021)', () => {
  let dir = ''
  let dbMod: typeof import('../src/core/db/index')
  let events: typeof import('../src/core/db/events')

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-eng-'))
    dbMod = await import('../src/core/db/index')
    events = await import('../src/core/db/events')
    dbMod.initDB(dir)
  })
  afterEach(() => {
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a row that names no engagement is written under the bound one, never `default`', () => {
    dbMod.bindDBEngagement('eng-bound')
    const ev = events.insertEvent('system', { subtype: 'session_start' }, { operatorId: 'op' })!
    expect(ev.engagementId).toBe('eng-bound')
    const logged = events.insertEvent('dns', { subtype: 'dns_query', qname: 'x.test' }, { operatorId: 'op' })!
    expect(logged.engagementId).toBe('eng-bound')
    expect(engagementForWrite(undefined)).toBe('eng-bound')
  })

  // KNOWN GAP, pinned on purpose. FR-007 says a new row's engagement is always
  // the bound database's, and T021's task text says "沒有綁定 DB 時拋錯" — throw
  // whenever no database is bound. This slice is lenient instead: a database
  // opened WITHOUT a binding (tests and tools; production binds right after
  // initDB, src/main/index.ts startProject) takes the engagement the caller
  // names. Making it strict means changing this test — and binding in the ~120
  // test files that open a database without one. Decided 2026-11-13: lenient
  // for now.
  it('KNOWN GAP (FR-007 / T021): a database opened without a binding takes the caller\'s engagement', () => {
    expect(dbMod.dbEngagement()).toBeNull()
    const ev = events.insertEvent('system', { subtype: 'session_start' }, { engagementId: 'eng-named', operatorId: 'op' })!
    expect(ev.engagementId).toBe('eng-named')
    expect(engagementForWrite('eng-named')).toBe('eng-named')
  })

  it('with nothing bound and no engagement named, nothing is written: it throws `no-project`', () => {
    expect(() => engagementForWrite(undefined)).toThrow(expect.objectContaining({ code: 'no-project' }))
    expect(() => events.insertEvent('system', { subtype: 'session_start' }, { operatorId: 'op' })).toThrow(expect.objectContaining({ code: 'no-project' }))
    expect(() => events.insertEvent('dns', { subtype: 'dns_query', qname: 'x.test' }, { operatorId: 'op' })).toThrow(expect.objectContaining({ code: 'no-project' }))
    const n = (dbMod.getDB().prepare('SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM events_logged) AS n').get() as { n: number }).n
    expect(n).toBe(0)
  })
})
