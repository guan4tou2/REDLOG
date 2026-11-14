// Spec 071 FR-097: the writer bounds how deep `data` nests, without losing
// anything. A container that would sit deeper than MAX_DATA_DEPTH (`data`
// itself is depth 1) is stored as a string holding its JSON text, exactly as
// JSON.stringify writes it, and `_ingest.collapsed` counts them.
//
// Here: the counting at the boundary, the text of a collapsed container, the
// round trip, a 100,000-level input, a property test, and the write path for
// both tiers — in-process, derived and straight through insertEvent — with
// dedup, the search index and the app's chain verifier. The API and handoff
// doors are in test/ingest-depth-doors.test.ts and the door-equivalence test;
// the AI tailer's redaction in test/ingest-depth-tailer.test.ts; both bundle
// verifiers in test/depth-vectors.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { MAX_DATA_DEPTH, boundDataDepth } from '../src/core/ingest/depth'
import { canonicalStringify } from '../src/core/db/event-write'

const sqlite = requires('better-sqlite3')

/** Container depth, the root container being 1. Iterative, so any input. */
function depthOf(v: unknown): number {
  let max = 0
  const stack: Array<[unknown, number]> = [[v, 1]]
  while (stack.length > 0) {
    const [x, d] = stack.pop()!
    if (x === null || typeof x !== 'object') continue
    if (d > max) max = d
    for (const c of Object.values(x as object)) stack.push([c, d + 1])
  }
  return max
}

/** A chain of `n` nested arrays (depth n), built by JSON.parse, which does not recurse. */
const chain = (n: number): unknown[] => JSON.parse('['.repeat(n) + ']'.repeat(n)) as unknown[]

/** Containers of `v` that sit at exactly `depth` (`v` being 1). */
function containersAt(v: unknown, depth: number): number {
  let n = 0
  const stack: Array<[unknown, number]> = [[v, 1]]
  while (stack.length > 0) {
    const [x, d] = stack.pop()!
    if (x === null || typeof x !== 'object') continue
    if (d === depth) { n++; continue }
    for (const c of Object.values(x as object)) stack.push([c, d + 1])
  }
  return n
}

/** Put back, at each place a container was collapsed, what JSON.parse makes of
 *  its string. `original` says where those places are. */
function restore(stored: unknown, original: unknown): unknown {
  if (original === null || typeof original !== 'object') return stored
  if (typeof stored === 'string') return JSON.parse(stored) as unknown
  if (Array.isArray(original)) return (stored as unknown[]).map((s, i) => restore(s, original[i]))
  return Object.fromEntries(Object.entries(stored as object).map(([k, s]) => [k, restore(s, (original as Record<string, unknown>)[k])]))
}

/** The value at `path` inside `v`. */
const at = (v: unknown, path: Array<string | number>): unknown => path.reduce<unknown>((x, k) => (x as Record<string | number, unknown>)[k], v)

describe('the depth bound (FR-097)', () => {
  it('is 64', () => {
    expect(MAX_DATA_DEPTH).toBe(64)
  })

  it('`data` exactly at the limit is the same object, untouched, and nothing is counted', () => {
    const data = { subtype: 'x', deep: chain(MAX_DATA_DEPTH - 1) }
    expect(depthOf(data)).toBe(64)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(0)
    expect(r.data).toBe(data)
    expect(r.data.deep).toBe(data.deep)
  })

  it('one level deeper collapses exactly one container, the one at depth 65, to its JSON text', () => {
    const data = { subtype: 'x', deep: chain(MAX_DATA_DEPTH) }
    const before = JSON.stringify(data)
    expect(depthOf(data)).toBe(65)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    // data (1) → deep (2) → … → the container at 64 holds the string.
    const holder = at(r.data, ['deep', ...Array<number>(MAX_DATA_DEPTH - 2).fill(0)]) as unknown[]
    expect(holder).toEqual(['[]'])
    expect(JSON.stringify(data), 'the caller\'s value is not changed').toBe(before)
  })

  it('arrays and objects count alike, mixed', () => {
    // depth 2..71 alternating object / array, a scalar at each level.
    let inner: unknown = 'leaf'
    for (let d = 71; d >= 2; d--) inner = d % 2 === 0 ? { k: inner, n: d } : [d, inner]
    const data = { subtype: 'x', mixed: inner }
    expect(depthOf(data)).toBe(71)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    // Path to the container at depth 64: objects take `k`, arrays index 1.
    const path: Array<string | number> = ['mixed']
    for (let d = 2; d < 64; d++) path.push(d % 2 === 0 ? 'k' : 1)
    const holder = at(r.data, path) as Record<string, unknown>
    expect(holder).toMatchObject({ n: 64 })
    expect(holder.k).toBe(JSON.stringify(at(data, [...path, 'k'])))
  })

  it('several over-deep siblings are each collapsed, and counted; their scalar siblings stay', () => {
    const atLimit = { a: [1], b: { c: 2 }, d: [[3]], e: 'kept', f: 7, g: null }
    let data: Record<string, unknown> = atLimit
    for (let d = 0; d < MAX_DATA_DEPTH - 1; d++) data = { down: data }
    expect(depthOf(data)).toBe(66)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(3)
    expect(depthOf(r.data)).toBe(64)
    const holder = at(r.data, Array<string>(MAX_DATA_DEPTH - 1).fill('down'))
    expect(holder).toEqual({ a: '[1]', b: '{"c":2}', d: '[[3]]', e: 'kept', f: 7, g: null })
    // Off the collapsed path nothing is copied.
    const sibling = { untouched: [1, 2] }
    const both = boundDataDepth({ deep: data, other: sibling })
    expect(both.data.other).toBe(sibling)
  })

  it('keys and strings outside the Basic Multilingual Plane, and a lone surrogate, are written as JSON.stringify writes them', () => {
    const lone = String.fromCharCode(0xd800)
    const subtree = { ['clef \u{1D11E}']: `emoji \u{1F600} ${lone} end`, [`k${lone}`]: ['\u{10FFFF}', '\u0000\u001f"\\'] }
    const data: Record<string, unknown> = { x: [] }
    let cur = data.x as unknown[]
    for (let d = 2; d < MAX_DATA_DEPTH; d++) { const next: unknown[] = []; cur.push(next); cur = next }
    cur.push(subtree)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    const text = at(r.data, ['x', ...Array<number>(MAX_DATA_DEPTH - 2).fill(0), 0]) as string
    expect(text).toBe(JSON.stringify(subtree))
    expect(text).toContain('\\ud800')
    expect(text).toContain('\u{1F600}')
    expect(JSON.parse(text)).toEqual(subtree)
  })

  it('numbers inside a collapsed container are JavaScript\'s text, inside a string', () => {
    const subtree = { tiny: 0.00001, huge: 1e21, neg: -0, frac: 0.1 + 0.2, big: 2 ** 53 + 2 }
    let data: Record<string, unknown> = { n: subtree }
    for (let d = 0; d < MAX_DATA_DEPTH - 1; d++) data = { down: data }
    const r = boundDataDepth(data)
    const text = (at(r.data, Array<string>(MAX_DATA_DEPTH - 1).fill('down')) as Record<string, unknown>).n
    expect(text).toBe('{"tiny":0.00001,"huge":1e+21,"neg":0,"frac":0.30000000000000004,"big":9007199254740994}')
    // The row's canonical form carries it as one JSON string.
    expect(canonicalStringify(r.data)).toContain(JSON.stringify(text))
  })

  it('what JSON.stringify leaves out or rewrites is left out or rewritten the same way', () => {
    const when = new Date(Date.UTC(2026, 10, 14))
    // eslint-disable-next-line no-sparse-arrays
    const holes = [1, , 3]
    const subtree = {
      u: undefined, f: () => 1, s: Symbol('x'), nan: NaN, inf: -Infinity, when,
      own: { toJSON: () => ({ replaced: true }) }, gone: { toJSON: () => undefined },
      arr: [undefined, () => 1, Symbol('y'), NaN, when, holes], boxed: Object(5) as unknown, nul: Object.create(null) as unknown
    }
    ;(subtree.nul as Record<string, unknown>).k = 'v'
    let data: Record<string, unknown> = { n: subtree }
    for (let d = 0; d < MAX_DATA_DEPTH - 1; d++) data = { down: data }
    const r = boundDataDepth(data)
    const text = (at(r.data, Array<string>(MAX_DATA_DEPTH - 1).fill('down')) as Record<string, unknown>).n
    expect(text).toBe(JSON.stringify(subtree))
  })

  it('a cycle throws, as JSON.stringify does', () => {
    const loop: Record<string, unknown> = { subtype: 'x' }
    loop.self = loop
    expect(() => boundDataDepth(loop)).toThrow(TypeError)
  })

  it('a 100,000-level input is stored: one container collapsed, its text exact, no stack overflow', () => {
    const N = 100_000
    const data = { subtype: 'x', deep: chain(N) }
    // What the writer used before: JSON.stringify of the whole value overflows
    // the stack in Node at a few thousand levels (canonicalStringify sooner).
    expect(() => canonicalStringify(data)).toThrow(RangeError)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    // deep's containers sit at 2..N+1; the one at 65 holds the rest, N+1-64 levels.
    const text = at(r.data, ['deep', ...Array<number>(MAX_DATA_DEPTH - 2).fill(0), 0]) as string
    expect(text.length).toBe(2 * (N + 1 - 64))
    expect(text).toBe('['.repeat(N + 1 - 64) + ']'.repeat(N + 1 - 64))
    expect(() => canonicalStringify(r.data)).not.toThrow()
  })

  describe('property: random values up to depth 200', () => {
    // A seeded generator (mulberry32), so a failure names a reproducible case.
    function rng(seed: number): () => number {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const SCALARS = ['', 'a', 'é\u{1F600}', String.fromCharCode(0xdc00), 0, -1, 0.00001, 1e21, 3.5, true, false, null]

    /** A value whose first branch (the spine) runs to `maxDepth`; the other
     *  branches end within a few levels, never past `maxDepth`. */
    function value(r: () => number, depth: number, maxDepth: number, spine: boolean): unknown {
      if (depth >= maxDepth || (!spine && r() < 0.3)) return SCALARS[Math.floor(r() * SCALARS.length)]
      const width = 1 + Math.floor(r() * 3)
      const child = (i: number): unknown => value(r, depth + 1, i === 0 ? maxDepth : Math.min(maxDepth, depth + 1 + Math.floor(r() * 4)), spine && i === 0)
      if (r() < 0.5) return Array.from({ length: width }, (_, i) => child(i))
      return Object.fromEntries(Array.from({ length: width }, (_, i) => [`k${i}${SCALARS[i % 3] as string}`, child(i)]))
    }

    it('stored depth never exceeds the limit, the round trip holds, the count is the containers at 65, and what is within the limit is untouched', () => {
      let deeper = 0
      for (let seed = 1; seed <= 400; seed++) {
        const r = rng(seed)
        const maxDepth = 1 + Math.floor(r() * 200)
        const data: Record<string, unknown> = { subtype: 's', a: value(r, 2, maxDepth, true), b: value(r, 2, 2 + Math.floor(r() * 80), r() < 0.5) }
        const text = JSON.stringify(data)
        const out = boundDataDepth(data)
        const label = `seed ${seed}`
        expect(depthOf(out.data), label).toBeLessThanOrEqual(MAX_DATA_DEPTH)
        expect(out.collapsed, label).toBe(containersAt(data, MAX_DATA_DEPTH + 1))
        expect(JSON.stringify(restore(out.data, data)), label).toBe(text)
        expect(restore(out.data, data), label).toEqual(data)
        expect(JSON.stringify(data), `${label}: the input is not changed`).toBe(text)
        if (depthOf(data) <= MAX_DATA_DEPTH) expect(out.data, label).toBe(data)
        else deeper++
        for (const k of ['a', 'b']) if (depthOf(data[k]) + 1 <= MAX_DATA_DEPTH) expect(out.data[k], `${label} ${k}`).toBe(data[k])
      }
      // The generator reaches both sides of the limit.
      expect(deeper).toBeGreaterThan(100)
      expect(deeper).toBeLessThan(400)
    })
  })
})

let dbMod: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ingestMod: typeof import('../src/core/ingest')
let parseQuery: typeof import('../src/core/query/contract').parseQuery
let chainAnchor: typeof import('../src/core/chain-anchor')
if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ingestMod = await import('../src/core/ingest')
  parseQuery = (await import('../src/core/query/contract')).parseQuery
  chainAnchor = await import('../src/core/chain-anchor')
}

const ENG = 'eng-depth'
const who = { engagementId: ENG, operatorId: 'op-depth' }

/** `data` whose `deep` key holds `levels` nested arrays, the innermost holding `leaf`. */
function overDeep(base: Record<string, unknown>, levels: number, leaf: unknown = 'leaf'): Record<string, unknown> {
  let inner: unknown = leaf
  for (let i = 0; i < levels; i++) inner = [inner]
  return { ...base, deep: inner }
}

sqlite.describe('the write path bounds every row, both tiers (FR-097)', () => {
  let dir = ''
  const KEYS_DIR = process.env.REDLOG_KEYS_DIR
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-depth-'))
    process.env.REDLOG_KEYS_DIR = path.join(dir, 'keys')
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
  })
  afterEach(async () => {
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    if (KEYS_DIR === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = KEYS_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const stored = (table: 'events' | 'events_logged', id: string): { text: string; data: Record<string, unknown> } => {
    const row = dbMod.getDB().prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }
    return { text: row.data, data: JSON.parse(row.data) as Record<string, unknown> }
  }
  function search(text: string): string[] {
    const outcome = parseQuery(text)
    if (!outcome.ok) throw new Error(`query did not parse: ${outcome.reason}`)
    return events.executeEventQuery({ parsed: outcome.parsed, filter: {}, limit: 100 }).items.map((e) => e.id)
  }

  it('in-process, derived and straight through insertEvent; chained and logged: each row is bounded and says how many it collapsed', () => {
    const rows: Array<{ table: 'events' | 'events_logged'; id: string; producer: string }> = []
    const a = ingestMod.ingest({ agentType: 'shell', data: overDeep({ subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1 }, 70), ...who }).event!
    rows.push({ table: 'events', id: a.id, producer: 'in-process' })
    const b = ingestMod.ingest({ agentType: 'dns', data: overDeep({ subtype: 'dns_query', qname: 'deep.test' }, 70), ...who }).event!
    expect(b.tier).toBe('logged')
    rows.push({ table: 'events_logged', id: b.id, producer: 'in-process' })
    const c = ingestMod.ingest({ agentType: 'pivot', data: overDeep({ subtype: 'route_add', tool: 'x' }, 70), ...who, derived: true }).event!
    rows.push({ table: 'events', id: c.id, producer: 'derived' })
    const d = events.insertEvent('system', overDeep({ subtype: 'session_start' }, 70), who)!
    rows.push({ table: 'events', id: d.id, producer: 'in-process' })
    const e = events.insertEvent('scanner', overDeep({ subtype: 'http_response', flow_id: 'f' }, 70), who)!
    expect(e.tier).toBe('logged')
    rows.push({ table: 'events_logged', id: e.id, producer: 'in-process' })
    for (const r of rows) {
      const { data } = stored(r.table, r.id)
      expect(depthOf(data), r.id).toBe(MAX_DATA_DEPTH)
      expect(data._ingest, r.id).toMatchObject({ producer: r.producer, collapsed: 1 })
      // deep (2) … the container at 64 holds the text of the 7 levels below it.
      expect(at(data, ['deep', ...Array<number>(MAX_DATA_DEPTH - 2).fill(0)]), r.id).toEqual(['[[[[[[["leaf"]]]]]]]'])
    }
  })

  it('the row returned is the row stored, and the app\'s chain verifier accepts it', async () => {
    const ev = ingestMod.ingest({ agentType: 'shell', data: overDeep({ subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1 }, 200), ...who }).event!
    expect(ev.data).toEqual(stored('events', ev.id).data)
    events.insertEvent('system', { subtype: 'session_start' }, who)
    const verdict = await chainAnchor.verifyChainFullAsync()
    expect(verdict).toMatchObject({ ok: true, walked: 2, brokenAtEventId: null })
  })

  it('a row within the limit is stored as before: no `collapsed`, the deep value byte for byte', () => {
    const data = overDeep({ subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1 }, MAX_DATA_DEPTH - 1)
    expect(depthOf(data)).toBe(MAX_DATA_DEPTH)
    const ev = ingestMod.ingest({ agentType: 'shell', data, ...who }).event!
    const { text, data: back } = stored('events', ev.id)
    expect('collapsed' in (back._ingest as object)).toBe(false)
    expect(text).toContain(`"deep":${JSON.stringify(data.deep)}`)
    expect(back.deep).toEqual(data.deep)
  })

  it('a sender cannot set `collapsed`: the stamp is the receiver\'s', () => {
    const forged = { subtype: 'note', text: 'x', _ingest: { collapsed: 99, v: 1 } }
    const ev = ingestMod.ingest({ agentType: 'external', data: forged, ...who }).event!
    expect('collapsed' in (stored('events', ev.id).data._ingest as object)).toBe(false)
    const deep = ingestMod.ingest({ agentType: 'external', data: overDeep({ ...forged, text: 'y' }, 70), ...who }).event!
    expect(stored('events', deep.id).data._ingest).toMatchObject({ collapsed: 1, stripped: ['_ingest'] })
  })

  it('a producer\'s rejected source time is the producer\'s value too, and is bounded with the rest', () => {
    let st: unknown = 1
    for (let i = 0; i < 80; i++) st = [st]
    const ev = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1, source_timestamp: st }, ...who }).event!
    const { data } = stored('events', ev.id)
    expect(depthOf(data)).toBe(MAX_DATA_DEPTH)
    expect(data._source_time_rejected).toMatchObject({ reason: 'not a finite number' })
    // source_timestamp (2) and _source_time_rejected.value (3) are both cut.
    expect(data._ingest).toMatchObject({ collapsed: 2 })
  })

  it('a redelivered over-deep command inside the 2 s window is the same command: the second is a duplicate', () => {
    const item = overDeep({ subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't-dup', pid: 7 }, 90)
    const first = ingestMod.ingest({ agentType: 'shell', data: item, ...who })
    const second = ingestMod.ingest({ agentType: 'shell', data: item, ...who })
    expect(first.event).not.toBeNull()
    expect(second).toMatchObject({ event: null, skipped: 'dedup' })
  })

  it('search finds a word that lived in the collapsed container, chained and logged', () => {
    const shell = ingestMod.ingest({ agentType: 'shell', data: overDeep({ subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1 }, 80, { note: 'wombatdeep' }), ...who }).event!
    const dns = ingestMod.ingest({ agentType: 'dns', data: overDeep({ subtype: 'dns_query', qname: 'q.test' }, 80, ['quollnested']), ...who }).event!
    expect(stored('events', shell.id).data._ingest).toMatchObject({ collapsed: 1 })
    expect(search('wombatdeep')).toEqual([shell.id])
    expect(search('quollnested')).toEqual([dns.id])
    // A key inside the collapsed text is a word of it too.
    expect(search('note')).toEqual([shell.id])
  })

  it('a 100,000-level row is written, chained and logged, and the search index takes it', () => {
    const N = 100_000
    const shell = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1, deep: chain(N) }, ...who }).event!
    const dns = ingestMod.ingest({ agentType: 'dns', data: { subtype: 'dns_query', qname: 'huge.test', deep: chain(N) }, ...who }).event!
    for (const [table, ev] of [['events', shell], ['events_logged', dns]] as const) {
      const { data } = stored(table, ev.id)
      expect(depthOf(data)).toBe(MAX_DATA_DEPTH)
      expect(data._ingest).toMatchObject({ collapsed: 1 })
    }
    expect(search('huge')).toEqual([dns.id])
  })
})
