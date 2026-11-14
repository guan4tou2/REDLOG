// Spec 071 FR-097: the writer bounds how deep `data` nests, without losing
// anything, and the stored row says by itself where it did. Containers down to
// depth 63 stay; at depth 64 a container stays only if it holds no container
// and is not marker-shaped (`{"_collapsed": <string>}`); every other container
// at 64 becomes `{"_collapsed": "<its JSON text>"}`, and `_ingest.collapsed`
// counts them. restoreDataDepth undoes it from the stored row alone.
//
// Here: the rule at the boundary, the text of a collapsed container (against
// JSON.stringify, special values included), the adversarial cases a count
// alone could not tell apart, a 100,000-level input, a property test whose
// round trip uses the stored row only, and the write path for both tiers. The
// doors are in test/ingest-depth-doors.test.ts and the door-equivalence test;
// the AI tailer in test/ingest-depth-tailer.test.ts; both bundle verifiers in
// test/depth-vectors.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { COLLAPSED_KEY, MAX_DATA_DEPTH, boundDataDepth, restoreDataDepth } from '../src/core/ingest/depth'
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
/** `levels` arrays around `leaf`. */
const nest = (levels: number, leaf: unknown): unknown => { let v = leaf; for (let i = 0; i < levels; i++) v = [v]; return v }
/** `data` (1) → `deep` → arrays down to `depth`, which is `leaf`'s depth if it is a container. */
const dataWithLeafAt = (depth: number, leaf: unknown): Record<string, unknown> => ({ subtype: 'x', deep: nest(depth - 2, leaf) })
/** The path from `data` to the value at `depth` inside dataWithLeafAt. */
const pathTo = (depth: number): Array<string | number> => ['deep', ...Array<number>(depth - 2).fill(0)]
const at = (v: unknown, p: Array<string | number>): unknown => p.reduce<unknown>((x, k) => (x as Record<string | number, unknown>)[k], v)
/** What JSON.stringify writes for `value` held under `key`. */
const textUnder = (key: string, value: unknown): string => JSON.stringify({ [key]: value }).slice(JSON.stringify(key).length + 2, -1)
const wrapper = (text: string): Record<string, string> => ({ [COLLAPSED_KEY]: text })

describe('the depth bound (FR-097)', () => {
  it('is 64, and the wrapper key is `_collapsed`', () => {
    expect(MAX_DATA_DEPTH).toBe(64)
    expect(COLLAPSED_KEY).toBe('_collapsed')
  })

  it('a leaf container at 64 stays: the same object, nothing counted', () => {
    const data = dataWithLeafAt(MAX_DATA_DEPTH, ['leaf'])
    expect(depthOf(data)).toBe(64)
    const r = boundDataDepth(data)
    expect(r).toEqual({ data, collapsed: 0 })
    expect(r.data).toBe(data)
  })

  it('a container at 64 that holds one is replaced by the wrapper of its own text; nothing at 63 changes', () => {
    const data = dataWithLeafAt(MAX_DATA_DEPTH, [[1], 'two'])
    const before = JSON.stringify(data)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    expect(at(r.data, pathTo(MAX_DATA_DEPTH))).toEqual(wrapper('[[1],"two"]'))
    expect(Array.isArray(at(r.data, pathTo(MAX_DATA_DEPTH - 1)))).toBe(true)
    expect(JSON.stringify(data), 'the caller\'s value is not changed').toBe(before)
    expect(restoreDataDepth(r.data)).toEqual(data)
  })

  it('arrays and objects count alike, mixed', () => {
    let inner: unknown = 'leaf'
    for (let d = 71; d >= 2; d--) inner = d % 2 === 0 ? { k: inner, n: d } : [d, inner]
    const data = { subtype: 'x', mixed: inner }
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    const p: Array<string | number> = ['mixed']
    for (let d = 2; d < 64; d++) p.push(d % 2 === 0 ? 'k' : 1)
    expect(at(r.data, p)).toEqual(wrapper(textUnder(String(p.at(-1)), at(data, p))))
    expect(restoreDataDepth(r.data)).toEqual(data)
  })

  it('several containers at 64 are each wrapped and counted; leaf ones and scalars beside them stay', () => {
    const atLimit = { a: [1], b: { c: [2] }, d: [[3]], e: 'kept', f: 7, g: null, h: {} }
    let data: Record<string, unknown> = atLimit
    for (let d = 0; d < MAX_DATA_DEPTH - 2; d++) data = { down: data }
    expect(depthOf(data)).toBe(65)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(2)
    const holder = at(r.data, Array<string>(MAX_DATA_DEPTH - 2).fill('down'))
    expect(holder).toEqual({ a: [1], b: wrapper('{"c":[2]}'), d: wrapper('[[3]]'), e: 'kept', f: 7, g: null, h: {} })
    expect(restoreDataDepth(r.data)).toEqual(data)
    const sibling = { untouched: [1, 2] }
    expect(boundDataDepth({ deep: data, other: sibling }).data.other, 'off the path nothing is copied').toBe(sibling)
  })

  describe('a reader can tell a wrapper from what the sender sent (the count alone could not)', () => {
    it('`["[1]", [1]]` and `[[1], "[1]"]` at 64 store differently and each restores to itself', () => {
      const a = dataWithLeafAt(MAX_DATA_DEPTH, ['[1]', [1]])
      const b = dataWithLeafAt(MAX_DATA_DEPTH, [[1], '[1]'])
      const sa = boundDataDepth(a).data, sb = boundDataDepth(b).data
      expect(JSON.stringify(sa)).not.toBe(JSON.stringify(sb))
      expect(restoreDataDepth(sa)).toEqual(a)
      expect(restoreDataDepth(sb)).toEqual(b)
      // Two levels further down, inside a container at 64.
      const c = dataWithLeafAt(MAX_DATA_DEPTH - 1, ['[1]', [[1]]])
      const d = dataWithLeafAt(MAX_DATA_DEPTH - 1, [[[1]], '[1]'])
      expect(restoreDataDepth(boundDataDepth(c).data)).toEqual(c)
      expect(restoreDataDepth(boundDataDepth(d).data)).toEqual(d)
    })

    it('a sender string holding JSON text beside a wrapped sibling stays a string', () => {
      const data = dataWithLeafAt(MAX_DATA_DEPTH - 1, ['{"a":[1]}', { a: [1] }])
      const r = boundDataDepth(data)
      expect(at(r.data, [...pathTo(MAX_DATA_DEPTH - 1), 0])).toBe('{"a":[1]}')
      expect(at(r.data, [...pathTo(MAX_DATA_DEPTH - 1), 1])).toEqual(wrapper('{"a":[1]}'))
      expect(restoreDataDepth(r.data)).toEqual(data)
    })

    it('a sender\'s marker-shaped object at 63 is the sender\'s: kept, and not read as a wrapper', () => {
      const own = wrapper('[1]')
      const data = dataWithLeafAt(MAX_DATA_DEPTH - 1, own)
      const r = boundDataDepth(data)
      expect(r.collapsed).toBe(0)
      expect(r.data).toBe(data)
      expect(restoreDataDepth(r.data)).toBe(r.data)
      expect(at(restoreDataDepth(r.data), pathTo(MAX_DATA_DEPTH - 1))).toEqual(own)
    })

    it('a sender\'s marker-shaped object at 64 is wrapped, so every marker-shaped object at 64 is the writer\'s', () => {
      for (const own of [wrapper('[1]'), wrapper('not json {')]) {
        const data = dataWithLeafAt(MAX_DATA_DEPTH, own)
        const r = boundDataDepth(data)
        expect(r.collapsed).toBe(1)
        expect(at(r.data, pathTo(MAX_DATA_DEPTH))).toEqual(wrapper(JSON.stringify(own)))
        expect(restoreDataDepth(r.data)).toEqual(data)
      }
    })

    it('a marker-shaped object inside a wrapped container comes back as it was', () => {
      const data = dataWithLeafAt(MAX_DATA_DEPTH, [wrapper('[2]'), [wrapper('x')]])
      const r = boundDataDepth(data)
      expect(r.collapsed).toBe(1)
      expect(restoreDataDepth(r.data)).toEqual(data)
    })

    it('the marker key among other keys is not marker-shaped: a leaf object at 64 holding it stays', () => {
      const own = { [COLLAPSED_KEY]: '[1]', other: 1 }
      const data = dataWithLeafAt(MAX_DATA_DEPTH, own)
      const r = boundDataDepth(data)
      expect(r.collapsed).toBe(0)
      expect(restoreDataDepth(r.data)).toEqual(data)
      // Nor is one whose value is not a string.
      const notString = dataWithLeafAt(MAX_DATA_DEPTH, { [COLLAPSED_KEY]: 5 })
      expect(boundDataDepth(notString).collapsed).toBe(0)
    })
  })

  it('keys and strings outside the BMP, a lone surrogate, U+2028/2029 and control characters are written as JSON.stringify writes them', () => {
    const lone = String.fromCharCode(0xd800)
    const subtree = { ['clef \u{1D11E}']: [`emoji \u{1F600} ${lone}    end`], [`k${lone}`]: ['\u{10FFFF}', '\u0000\u001f"\\\n'] }
    const data = dataWithLeafAt(MAX_DATA_DEPTH, subtree)
    const text = (at(boundDataDepth(data).data, pathTo(MAX_DATA_DEPTH)) as Record<string, string>)[COLLAPSED_KEY]
    expect(text).toBe(JSON.stringify(subtree))
    expect(text).toContain('\\ud800')
    expect(restoreDataDepth(boundDataDepth(data).data)).toEqual(data)
  })

  it('numbers inside a collapsed container are JavaScript\'s text, inside a string', () => {
    const subtree = { tiny: [0.00001], huge: 1e21, neg: -0, frac: 0.1 + 0.2, min: 5e-324, big: 2 ** 53 + 2 }
    const data = dataWithLeafAt(MAX_DATA_DEPTH, subtree)
    const r = boundDataDepth(data)
    const text = (at(r.data, pathTo(MAX_DATA_DEPTH)) as Record<string, string>)[COLLAPSED_KEY]
    expect(text).toBe('{"tiny":[0.00001],"huge":1e+21,"neg":0,"frac":0.30000000000000004,"min":5e-324,"big":9007199254740994}')
    expect(canonicalStringify(r.data)).toContain(JSON.stringify(text))
  })

  it('what JSON.stringify leaves out or rewrites, it leaves out or rewrites the same way, `toJSON` with the real key', () => {
    class Stamp { constructor(public v: number) {} toJSON(k: string): unknown { return { stamp: this.v, k } } }
    const when = new Date(Date.UTC(2026, 10, 14))
    // eslint-disable-next-line no-sparse-arrays
    const holes = [1, , 3]
    const keyed = { toJSON: (k: string) => `key=${k}` }
    const proto = JSON.parse('{"__proto__": {"x": 1}, "y": [2]}') as Record<string, unknown>
    const subtree = {
      u: undefined, f: () => 1, s: Symbol('x'), nan: NaN, inf: -Infinity, when, keyed, inArr: [keyed, keyed],
      own: { toJSON: () => ({ replaced: [true] }) }, gone: { toJSON: () => undefined }, cls: new Stamp(3), deepCls: [[new Stamp(4)]],
      arr: [undefined, () => 1, Symbol('y'), NaN, when, holes], boxed: [Object(5), Object('s'), Object(false)], nul: Object.create(null) as unknown,
      proto, ints: { b: 1, 10: 2, 2: 3 }
    }
    ;(subtree.nul as Record<string, unknown>).k = 'v'
    const data = dataWithLeafAt(MAX_DATA_DEPTH, subtree)
    const text = (at(boundDataDepth(data).data, pathTo(MAX_DATA_DEPTH)) as Record<string, string>)[COLLAPSED_KEY]
    expect(text).toBe(textUnder('0', subtree))
    expect(text).toContain('"keyed":"key=keyed","inArr":["key=0","key=1"]')
    expect(text).toContain('"__proto__":{"x":1}')
  })

  it('a class instance with toJSON on its prototype, copied along the path, is still written by its toJSON', () => {
    class Box { constructor(public inner: unknown) {} toJSON(): unknown { return { box: this.inner } } }
    // The instance sits at 10; below it a container at 64 is wrapped, so the
    // instance is copied — and must keep its prototype.
    const deepInside = nest(MAX_DATA_DEPTH - 10, [[1]])
    let data: Record<string, unknown> = { b: new Box(deepInside) }
    for (let i = 0; i < 8; i++) data = { down: data }
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    const box = at(r.data, [...Array<string>(8).fill('down'), 'b'])
    expect(box).toBeInstanceOf(Box)
    expect(JSON.stringify(box)).toMatch(/^\{"box":/)
  })

  it('an own `__proto__` key on the copied path stays a key, not a prototype', () => {
    const data = JSON.parse(`{"__proto__": ${JSON.stringify(nest(MAX_DATA_DEPTH, 1))}}`) as Record<string, unknown>
    expect(Object.keys(data)).toEqual(['__proto__'])
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(Object.keys(r.data)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype)
    expect(JSON.stringify(restoreDataDepth(r.data))).toBe(JSON.stringify(data))
  })

  it('a cycle throws, as JSON.stringify does', () => {
    const loop: Record<string, unknown> = { subtype: 'x' }
    loop.self = loop
    expect(() => boundDataDepth(loop)).toThrow(TypeError)
    const a: unknown[] = []; const b: unknown[] = [a]; a.push(1, [2, b])
    expect(() => boundDataDepth({ deep: nest(70, a) })).toThrow(TypeError)
    // The same object twice, without a cycle, is written twice.
    const shared = [1]
    expect(() => boundDataDepth({ deep: nest(70, [shared, shared]) })).not.toThrow()
  })

  it('a 100,000-level input is stored: one wrapper, its text exact, no stack overflow, and it restores', () => {
    const N = 100_000
    const data = { subtype: 'x', deep: chain(N) }
    expect(() => canonicalStringify(data)).toThrow(RangeError)
    const r = boundDataDepth(data)
    expect(r.collapsed).toBe(1)
    expect(depthOf(r.data)).toBe(64)
    // deep's containers sit at 2..N+1; the one at 64 holds N+1-63 levels.
    const text = (at(r.data, pathTo(MAX_DATA_DEPTH)) as Record<string, string>)[COLLAPSED_KEY]
    expect(text).toBe('['.repeat(N + 1 - 63) + ']'.repeat(N + 1 - 63))
    expect(() => canonicalStringify(r.data)).not.toThrow()
    expect(depthOf(restoreDataDepth(r.data))).toBe(N + 1)
  })

  describe('property: random values up to depth 200', () => {
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
    const lone = String.fromCharCode(0xdc00)
    const JSON_SCALARS: unknown[] = ['', 'a', 'é\u{1F600}', lone, '  ', '\u0001\n"\\', '[1]', '{"_collapsed":"x"}', 0, -1, 0.00001, 1e21, 5e-324, 3.5, true, false, null]
    const KEYS = ['k', '0', '10', '__proto__', '_collapsed', 'é', lone, '']
    const keyed = { toJSON: (k: string) => `key=${k}` }
    const SPECIAL: Array<() => unknown> = [() => undefined, () => -0, () => new Date(Date.UTC(2026, 0, 1)), () => Object(7), () => Object('s'),
      () => keyed, () => ({ toJSON: () => [[1, 2]] }), () => () => 1]

    /** A value whose first branch (the spine) runs to `maxDepth`; the others
     *  end within a few levels, never past `maxDepth`. */
    function value(r: () => number, depth: number, maxDepth: number, spine: boolean, special: boolean): unknown {
      if (depth >= maxDepth || (!spine && r() < 0.3)) {
        if (special && r() < 0.3) return SPECIAL[Math.floor(r() * SPECIAL.length)]()
        return JSON_SCALARS[Math.floor(r() * JSON_SCALARS.length)]
      }
      if (!spine && r() < 0.15) return { [COLLAPSED_KEY]: JSON_SCALARS[Math.floor(r() * 7)] }
      const width = 1 + Math.floor(r() * 3)
      const child = (i: number): unknown => value(r, depth + 1, i === 0 ? maxDepth : Math.min(maxDepth, depth + 1 + Math.floor(r() * 4)), spine && i === 0, special)
      if (r() < 0.5) return Array.from({ length: width }, (_, i) => child(i))
      const o: Record<string, unknown> = {}
      for (let i = 0; i < width; i++) Object.defineProperty(o, KEYS[Math.floor(r() * KEYS.length)] + (i || ''), { value: child(i), enumerable: true, writable: true, configurable: true })
      return o
    }

    /** Every container at depth 64 of `original`, with its key and the stored value there. */
    function at64(original: unknown, stored: unknown, depth = 1, key = '', out: Array<{ key: string; o: unknown; s: unknown }> = []): typeof out {
      if (original === null || typeof original !== 'object') return out
      if (depth === MAX_DATA_DEPTH) { out.push({ key, o: original, s: stored }); return out }
      for (const k of Object.keys(original)) at64((original as Record<string, unknown>)[k], (stored as Record<string, unknown>)[k], depth + 1, k, out)
      return out
    }

    for (const special of [false, true]) {
      it(`${special ? 'with the special values' : 'JSON values'}: bounded, the round trip from the stored row alone, the text JSON.stringify's, the count, untouched within the limit`, () => {
        let deeper = 0
        for (let seed = 1; seed <= 400; seed++) {
          const r = rng(seed * (special ? 7919 : 1))
          const maxDepth = 1 + Math.floor(r() * 200)
          const data: Record<string, unknown> = { subtype: 's', a: value(r, 2, maxDepth, true, special), b: value(r, 2, 2 + Math.floor(r() * 80), r() < 0.5, special) }
          const text = JSON.stringify(data)
          const out = boundDataDepth(data)
          const label = `seed ${seed}`
          expect(depthOf(out.data), label).toBeLessThanOrEqual(MAX_DATA_DEPTH)
          const restored = restoreDataDepth(out.data)
          expect(JSON.stringify(restored), label).toBe(text)
          if (!special) expect(restored, label).toEqual(data)
          expect(JSON.stringify(data), `${label}: the input is not changed`).toBe(text)
          let wrapped = 0
          for (const { key, o, s } of at64(data, out.data)) {
            const isLeaf = Object.values(o as object).every((c) => c === null || typeof c !== 'object')
            const marker = !Array.isArray(o) && Object.keys(o as object).length === 1 && Object.keys(o as object)[0] === COLLAPSED_KEY && typeof (o as Record<string, unknown>)[COLLAPSED_KEY] === 'string'
            if (isLeaf && !marker) { expect(s, label).toBe(o); continue }
            wrapped++
            expect(s, label).toEqual(wrapper(textUnder(key, o)))
          }
          expect(out.collapsed, label).toBe(wrapped)
          if (wrapped === 0) expect(out.data, label).toBe(data)
          else deeper++
        }
        expect(deeper).toBeGreaterThan(100)
        expect(deeper).toBeLessThan(400)
      })
    }
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
      // deep (2) … the container at 64 is the wrapper of its own 8 levels.
      expect(at(data, pathTo(MAX_DATA_DEPTH)), r.id).toEqual(wrapper(JSON.stringify(nest(8, 'leaf'))))
      const { _ingest: _s, ...sent } = restoreDataDepth(data)
      expect(sent.deep, r.id).toEqual(nest(70, 'leaf'))
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

  // The wrapper's string is one json_tree atom: JSON text, so a word directly
  // after an escape sequence that ends in a letter (`\n`, `\t`) is tokenised
  // with that letter (`nwombatword`) and is not found. The trigger is not
  // changed for this: running json_tree on the text would meet SQLite's own
  // depth limit and refuse the row.
  it('search inside a wrapper: a word after `\\n` or `\\t` is not found (pinned limit); the rest is', () => {
    const ev = ingestMod.ingest({ agentType: 'shell', data: overDeep({ subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1 }, 80, 'line1\nwombatword\ttabword "quoted" plainword'), ...who }).event!
    expect(stored('events', ev.id).data._ingest).toMatchObject({ collapsed: 1 })
    for (const w of ['line1', 'plainword', 'quoted']) expect(search(w), w).toEqual([ev.id])
    for (const w of ['wombatword', 'tabword']) expect(search(w), w).toEqual([])
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
