import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB, bindDBEngagement } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { parseQuery } from '../src/core/query/contract'
import { queryActivityPage, queryActivityMembers } from '../src/core/db/activity-queries'
import { queryEvents, queryEventsPage, queryEventCausalChain } from '../src/core/db/event-queries'
import { compareEventOrder, eventOrderAfter, eventOrderBy, type EventOrderFields } from '../src/core/event-order'
import type { ActivityRequest } from '../src/core/activity-contract'
import { insertEvent } from '../src/core/db/event-write'
import { withoutRowId } from '../src/core/db/event-types'
import { redactEventForExport } from '../src/core/redact-export'

// Events recorded in the same millisecond must come back in the order they
// were ingested. They used to tie on a random UUID: e2e/evidence-views showed a
// tool_result before its tool_call. Every fixture here picks ids that sort the
// WRONG way ('z…' ingested first, 'a…' second), so a query that still breaks
// the tie on id fails every time rather than half the time.

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-order-')); initDB(dir); bindDBEngagement('eng-test') })
afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

type Tier = 'chained' | 'logged'
interface Row { id: string; ts: number; type: string; data: Record<string, unknown>; tier?: Tier; createdAt?: number; causes?: string[] }
function add(r: Row): void {
  const table = r.tier === 'logged' ? 'events_logged' : 'events'
  const data = r.causes ? { ...r.data, _causes: r.causes } : r.data
  getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${table === 'events' ? ',hash,prev_hash' : ''})
    VALUES (?,?,'eng','binding','operator',?,?,'host',NULL,NULL,?,?${table === 'events' ? ", 'fixture-hash', NULL" : ''})`).run(
    r.id, r.ts, r.type, String(r.data.subtype ?? ''), JSON.stringify(data), r.createdAt ?? r.ts)
}
const tool = (subtype: string, id: string, more: Record<string, unknown> = {}) => ({ subtype, agent: 'claude-code', session_id: 'conversation', tool_use_id: id, ...more })
const cmd = (subtype: string, id: string, more: Record<string, unknown> = {}) => ({ subtype, shell: 'zsh', terminalId: 'term', command: 'id', command_id: id, ...more })
function request(query = '', extra: Partial<ActivityRequest> = {}): ActivityRequest {
  const parsed = parseQuery(query); if (!parsed.ok) throw new Error('bad fixture query')
  return { projectId: 'eng', parsed: parsed.parsed, ...extra }
}
function reopen(): void { closeHttpBodyIndex(); closeDB(); initDB(dir); bindDBEngagement('eng-test') }

/** Same-millisecond sequences, each listed in ingestion order. */
const T = 1_700_000_000_000
const SEQUENCES: Array<{ name: string; rows: Row[] }> = [
  { name: 'tool call then result', rows: [
    { id: 'z-call', ts: T, type: 'agent', data: tool('tool_call', 'tu1', { tool_name: 'Bash', tool_input: { command: 'id' } }) },
    { id: 'a-result', ts: T, type: 'agent', data: tool('tool_result', 'tu1', { output: 'uid=0' }) }] },
  { name: 'command start then end', rows: [
    { id: 'z-start', ts: T, type: 'shell', data: cmd('command_start', 'c1') },
    { id: 'a-end', ts: T, type: 'shell', data: cmd('command_end', 'c1', { exit_code: 0 }) }] },
  { name: 'request then response (logged tier)', rows: [
    { id: 'z-req', ts: T, type: 'scanner', tier: 'logged', data: { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url: 'https://t/' } },
    { id: 'a-resp', ts: T, type: 'scanner', tier: 'logged', data: { subtype: 'http_response', flow_id: 'f1', method: 'GET', url: 'https://t/', status: 200 } }] },
  { name: 'three in a row', rows: [
    { id: 'z-1', ts: T, type: 'marker', data: { title: 'one' } },
    { id: 'm-2', ts: T, type: 'marker', data: { title: 'two' } },
    { id: 'a-3', ts: T, type: 'marker', data: { title: 'three' } }] }
]

describe('same-millisecond events read in ingestion order', () => {
  for (const { name, rows } of SEQUENCES) {
    const expected = rows.map(r => r.id)
    for (const limit of [1, 2, 200]) {
      it(`${name}: event pages, page size ${limit}`, () => {
        for (const r of rows) add(r)
        const seen: string[] = []
        let page = queryEventsPage({ limit })
        for (;;) {
          seen.push(...page.items.map(e => e.id))
          if (!page.nextCursor) break
          page = queryEventsPage({ limit, cursor: page.nextCursor })
        }
        expect(seen).toEqual([...expected].reverse())
        expect(queryEvents({ order: 'oldest', limit: 200 }).map(e => e.id)).toEqual(expected)
        expect(queryEvents({ limit: 200 }).map(e => e.id)).toEqual([...expected].reverse())
      })
    }
  }

  for (const { name, rows } of SEQUENCES.slice(0, 3)) {
    const expected = rows.map(r => r.id)
    for (const limit of [1, 2, 200]) {
      it(`${name}: Activity members and previews, page size ${limit}`, () => {
        for (const r of rows) add(r)
        const page = queryActivityPage(request())
        expect(page.items).toHaveLength(1)
        const item = page.items[0]
        expect(item.sourcePreview.ids).toEqual(expected)
        expect(item.matchedPreview.ids).toEqual(expected)
        // The begin row anchors the Activity, not whichever id is lower.
        expect(item.anchor.id).toBe(expected[0])
        const seen: string[] = []
        const detail = { ...request(), ref: item, snapshot: page.snapshot, limit }
        let members = queryActivityMembers(detail)
        for (;;) {
          seen.push(...members.items.map(m => m.event.id))
          if (!members.nextCursor) break
          members = queryActivityMembers({ ...detail, cursor: members.nextCursor })
        }
        expect(seen).toEqual(expected)
      })
    }
  }

  it('a tool result ingested later than another result in the same millisecond is the Activity result', () => {
    add({ id: 'z-call', ts: T, type: 'shell', data: cmd('command_start', 'c9') })
    add({ id: 'z-end-first', ts: T, type: 'shell', data: cmd('command_end', 'c9', { exit_code: 1 }) })
    add({ id: 'a-end-second', ts: T, type: 'shell', data: cmd('command_end', 'c9', { exit_code: 0 }) })
    expect(queryActivityPage(request()).items[0].result).toEqual({ exitCode: 0 })
  })

  it('matching rows first, then context, each in ingestion order across a page boundary', () => {
    add({ id: 'z-call', ts: T, type: 'agent', data: tool('tool_call', 'tu2', { tool_name: 'Bash', tool_input: { command: 'id' } }) })
    add({ id: 'y-result', ts: T, type: 'agent', data: tool('tool_result', 'tu2', { output: 'needle one' }) })
    add({ id: 'a-result', ts: T, type: 'agent', data: tool('tool_result', 'tu2', { output: 'needle two' }) })
    const req = request('needle'), page = queryActivityPage(req)
    const detail = { ...req, ref: page.items[0], snapshot: page.snapshot, matchesFirst: true, limit: 1 }
    const seen: string[] = []
    let members = queryActivityMembers(detail)
    for (;;) {
      seen.push(...members.items.map(m => m.event.id))
      if (!members.nextCursor) break
      members = queryActivityMembers({ ...detail, cursor: members.nextCursor })
    }
    expect(seen).toEqual(['y-result', 'a-result', 'z-call'])
  })

  it('rejects an Activity member cursor from the previous build instead of restarting or skipping', () => {
    for (const r of SEQUENCES[0].rows) add(r)
    const page = queryActivityPage(request())
    const detail = { ...request(), ref: page.items[0], snapshot: page.snapshot, limit: 1 }
    const next = queryActivityMembers(detail).nextCursor!
    const decoded = JSON.parse(Buffer.from(next, 'base64url').toString('utf8')) as Record<string, unknown>
    // The previous build's member cursor: version 1, positioned by (ts, id).
    const { row: _row, tier: _tier, ...rest } = decoded
    const old = Buffer.from(JSON.stringify({ ...rest, v: 1 })).toString('base64url')
    expect(() => queryActivityMembers({ ...detail, cursor: old })).toThrow(/Invalid Activity cursor/)
  })

  it('keeps the order across a restart and after rows written by the next run', () => {
    add({ id: 'z-call', ts: T, type: 'agent', data: tool('tool_call', 'tu3', { tool_name: 'Bash', tool_input: { command: 'id' } }) })
    reopen()
    add({ id: 'a-result', ts: T, type: 'agent', data: tool('tool_result', 'tu3', { output: 'x' }) })
    expect(queryEvents({ order: 'oldest', limit: 10 }).map(e => e.id)).toEqual(['z-call', 'a-result'])
    const page = queryActivityPage(request())
    expect(page.items[0].sourcePreview.ids).toEqual(['z-call', 'a-result'])
  })

  it('interleaved across the two tiers: each tier in ingestion order, the whole in the one defined order', () => {
    // Ingested c1, l1, c2, l2. Rowids are per table, so across tiers the order
    // is the defined one (rowid, then chained above logged), not ingestion.
    add({ id: 'z-c1', ts: T, type: 'marker', data: { title: 'c1' } })
    add({ id: 'y-l1', ts: T, type: 'agent', tier: 'logged', data: { subtype: 'thinking' } })
    add({ id: 'x-c2', ts: T, type: 'marker', data: { title: 'c2' } })
    add({ id: 'w-l2', ts: T, type: 'agent', tier: 'logged', data: { subtype: 'thinking' } })
    const oldest = queryEvents({ order: 'oldest', limit: 10 }).map(e => e.id)
    expect(oldest).toEqual(['y-l1', 'z-c1', 'w-l2', 'x-c2'])
    expect(oldest.filter(id => id === 'z-c1' || id === 'x-c2')).toEqual(['z-c1', 'x-c2'])
    expect(oldest.filter(id => id === 'y-l1' || id === 'w-l2')).toEqual(['y-l1', 'w-l2'])
    for (const limit of [1, 2]) {
      const seen: string[] = []
      let page = queryEventsPage({ limit })
      for (;;) {
        seen.push(...page.items.map(e => e.id))
        if (!page.nextCursor) break
        page = queryEventsPage({ limit, cursor: page.nextCursor })
      }
      expect(seen).toEqual([...oldest].reverse())
    }
  })

  it('a live row carries the rowId its page read will have, outside the hash', () => {
    // Producer time pins both rows to one millisecond, as a transcript backfill does.
    const at = Date.now() - 1000
    const call = insertEvent('agent', tool('tool_call', 'tu4', { tool_name: 'Bash', tool_input: { command: 'id' } }), { operatorId: 'op', occurredAt: at })!
    const result = insertEvent('agent', tool('tool_result', 'tu4', { output: 'x' }), { operatorId: 'op', occurredAt: at })!
    const thinking = insertEvent('agent', { subtype: 'thinking', agent: 'claude-code', session_id: 'conversation', text: 't' }, { operatorId: 'op', occurredAt: at })!
    expect(thinking.tier).toBe('logged')
    const read = queryEvents({ order: 'oldest', limit: 10 })
    for (const live of [call, result, thinking]) expect(read.find(e => e.id === live.id)!.rowId).toBe(live.rowId)
    expect([thinking, result, call].sort(compareEventOrder).map(e => e.id)).toEqual(read.map(e => e.id))
    expect(read.map(e => e.id).filter(id => id !== thinking.id)).toEqual([call.id, result.id])
    const stored = getDB().prepare('SELECT hash FROM events WHERE id = ?').get(call.id) as { hash: string }
    expect(stored.hash).toBe(call.hash)
  })

  it('rowId stays inside the app: an exported row is byte-for-byte the record without it', () => {
    add({ id: 'z-call', ts: T, type: 'marker', data: { title: 'x' } })
    const [read] = queryEvents({ limit: 1 })
    expect(read.rowId).toBe(1)
    const exported = redactEventForExport(read)!
    expect('rowId' in exported).toBe(false)
    const { rowId: _rowId, ...record } = read
    expect(JSON.stringify(exported)).toBe(JSON.stringify(record))
    expect(withoutRowId(read)).toEqual(record)
  })

  it('cause chain effects come back in ingestion order within a millisecond', () => {
    add({ id: 'm-cause', ts: T - 1, type: 'shell', data: { subtype: 'command_start', command: 'curl', command_id: 'c5' } })
    add({ id: 'z-effect', ts: T, type: 'scanner', tier: 'logged', data: { subtype: 'http_request_start', flow_id: 'f9' }, causes: ['m-cause'] })
    add({ id: 'a-effect', ts: T, type: 'scanner', tier: 'logged', data: { subtype: 'http_response', flow_id: 'f9' }, causes: ['m-cause'] })
    const chain = queryEventCausalChain('m-cause')
    expect(chain.events.map(e => e.id)).toEqual(['m-cause', 'z-effect', 'a-effect'])
  })
})

describe('SQL order and the TypeScript comparator agree', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  }

  it('on random rows from both tiers, every event read carries its rowId and sorts the same both ways', () => {
    const r = rng(7)
    for (let i = 0; i < 300; i++) {
      add({ id: `e${Math.floor(r() * 1e9).toString(36)}-${i}`, ts: T + Math.floor(r() * 4), type: 'marker', tier: r() < 0.5 ? 'logged' : 'chained', data: { title: String(i) } })
    }
    const sql = queryEvents({ order: 'oldest', limit: 1000 })
    expect(sql).toHaveLength(300)
    expect(sql.every(e => typeof e.rowId === 'number')).toBe(true)
    expect(sql.map(e => e.id)).toEqual([...sql].sort(compareEventOrder).map(e => e.id))
    // The fragment builder is the same order as the comparator, in raw SQL.
    const order = (dir: 'ASC' | 'DESC') => getDB().prepare(`SELECT id FROM (
        SELECT id, timestamp, rowid AS _row, 1 AS tier_rank FROM events
        UNION ALL SELECT id, timestamp, rowid AS _row, 0 AS tier_rank FROM events_logged
      ) ORDER BY ${eventOrderBy(dir)}`).all().map(x => (x as { id: string }).id)
    expect(order('ASC')).toEqual(sql.map(e => e.id))
    expect(order('DESC')).toEqual(sql.map(e => e.id).reverse())
    // And the keyset predicate admits exactly the rows the comparator puts after the cursor row.
    const pivot = sql[137]
    const after = getDB().prepare(`SELECT id FROM (
        SELECT id, timestamp, rowid AS _row, 1 AS tier_rank FROM events
        UNION ALL SELECT id, timestamp, rowid AS _row, 0 AS tier_rank FROM events_logged
      ) WHERE ${eventOrderAfter('ASC', { timestamp: 'timestamp', row: '_row', tierRank: 'tier_rank' }, { timestamp: '@ts', row: '@row', tierRank: '@rank' })}
      ORDER BY ${eventOrderBy('ASC')}`).all({ ts: pivot.timestamp, row: pivot.rowId, rank: pivot.tier === 'chained' ? 1 : 0 }).map(x => (x as { id: string }).id)
    expect(after).toEqual(sql.slice(138).map(e => e.id))
  })
})

describe('compareEventOrder is a strict weak order', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  }
  const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]
  it('is irreflexive, antisymmetric and transitive on rows with missing fields', () => {
    const r = rng(42)
    const rows: EventOrderFields[] = []
    for (let i = 0; i < 60; i++) {
      rows.push({
        id: `id${pick(r, [0, 1, 2, 3, 4])}${i % 3 === 0 ? '' : i}`,
        timestamp: pick(r, [1, 1, 2]),
        tier: pick(r, ['chained', 'logged'] as const),
        ...(r() < 0.5 ? { rowId: pick(r, [1, 2, 3]) } : r() < 0.5 ? { rowId: null } : {})
      })
    }
    const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
    const flip = (x: number) => (x > 0 ? -1 : x < 0 ? 1 : 0)
    for (const a of rows) {
      expect(compareEventOrder(a, a)).toBe(0)
      for (const b of rows) {
        expect(sign(compareEventOrder(a, b))).toBe(flip(compareEventOrder(b, a)))
        for (const c of rows) {
          if (compareEventOrder(a, b) < 0 && compareEventOrder(b, c) < 0) expect(compareEventOrder(a, c)).toBeLessThan(0)
          // Incomparability (== 0) is transitive too, which is what makes it weak.
          if (compareEventOrder(a, b) === 0 && compareEventOrder(b, c) === 0) expect(compareEventOrder(a, c)).toBe(0)
        }
      }
    }
  })

})
