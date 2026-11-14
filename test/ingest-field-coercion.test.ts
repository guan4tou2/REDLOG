// A sender's field that is not the scalar the pipeline expects, through both
// outside doors: POST /api/events (the real handler, no port bound) and a
// handoff spool file drained as main drains it (test/helpers/ingest-delivery.ts).
//
// `String(x)` and a template literal on an array recurse through nested arrays
// (Array.prototype.join), so a 5,000-level `[[[…]]]` in one of these fields
// overflowed the stack — before the commit (a 500, nothing stored) or after it
// (a 500 for a row that was written, which the hook then spooled and sent
// again). Every such read now goes through src/core/ingest/field-text.ts. Each
// field is sent three ways: 5,000 levels of arrays, an object, and a 5 MB
// string. Spec 071 FR-097, third review.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { requires } from './helpers/requires'
import { ENG, OP, interceptHttp, openRuntime, storedRows, type Runtime, type StoredRow } from './helpers/ingest-delivery'
import { restoreDataDepth } from '../src/core/ingest/depth'

const sqlite = requires('better-sqlite3')
const SLOW = 120_000

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-field-coercion-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

const LEVELS = 5_000
const BIG = 5 * 1024 * 1024
/** The three shapes each field is sent in, as JSON text. */
const VARIANTS: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'array', text: `${'['.repeat(LEVELS)}"wombat"${']'.repeat(LEVELS)}` },
  { name: 'object', text: '{"length":1000000000,"toString":"wombat"}' },
  { name: 'string', text: `"${'w'.repeat(BIG)}"` }
]

interface Case {
  field: string
  /** The body, with the field's value spliced in as JSON text; `n` keeps two variants apart for the dedup window. */
  body: (value: string, n: number) => string
  /** The stored row's `data` key the value lands in, or null when it is the row's own column. */
  dataKey: string | null
}
const CASES: Case[] = [
  { field: 'agent_type', dataKey: null,
    body: (v, n) => `{"agent_type":${v},"data":{"tag":"v${n}","subtype":"note","text":"t${n}"}}` },
  { field: 'target_id', dataKey: null,
    body: (v, n) => `{"agent_type":"external","target_id":${v},"data":{"tag":"v${n}","subtype":"note","text":"t${n}"}}` },
  { field: 'agent data.command', dataKey: 'command',
    body: (v, n) => `{"agent_type":"agent","data":{"tag":"v${n}","subtype":"tool_call","agent":"claude","pid":${n},"command":${v}}}` },
  { field: 'shell data.pid', dataKey: 'pid',
    body: (v, n) => `{"agent_type":"shell","data":{"tag":"v${n}","subtype":"command_start","command":"id ${n}","terminalId":"t${n}","pid":${v}}}` },
  { field: 'scanner data.host', dataKey: 'host',
    body: (v, n) => `{"agent_type":"scanner","data":{"tag":"v${n}","subtype":"http_request_start","flow_id":"f${n}","method":"GET","url":"http://h/${n}","host":${v}}}` },
  { field: 'scanner data.method', dataKey: 'method',
    body: (v, n) => `{"agent_type":"scanner","data":{"tag":"v${n}","subtype":"http_request_start","flow_id":"f${n}","url":"http://h.test/${n}","host":"h.test","method":${v}}}` },
  { field: 'dns data.query_type', dataKey: 'query_type',
    body: (v, n) => `{"agent_type":"dns","data":{"tag":"v${n}","subtype":"dns_query","query_name":"q${n}.test","query_type":${v}}}` }
]
const withIdentity = (body: string): string => `${body.slice(0, -1)},"_identity":{"engagementId":"${ENG}","operatorId":"${OP}"}}`

/** How deep a value goes, without recursing. */
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

/** The value the case's field was stored as, restored from the row alone. */
function storedValue(c: Case, r: StoredRow): unknown {
  if (c.field === 'target_id') return r.row.target_id
  return restoreDataDepth(r.data)[c.dataKey!]
}

/** The stored value is what was sent: the same depth, the same text. */
function expectSent(c: Case, variant: string, value: unknown, label: string): void {
  if (variant === 'array') expect(depthOf(value), label).toBe(LEVELS)
  else if (variant === 'object') expect(value, label).toEqual({ length: 1_000_000_000, toString: 'wombat' })
  else expect((value as string).length, label).toBe(BIG)
}

sqlite.describe('a field that is not the scalar the pipeline expects (FR-097, review 3)', () => {
  const dirs: string[] = []
  const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-coerce-${label}-`)); dirs.push(d); return d }
  beforeEach(() => { interceptHttp() })
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  /** Open a project with a scope runtime that records what it was handed. */
  async function open(dir: string): Promise<{ rt: Runtime; hits: Array<{ target: string; action: string }> }> {
    const rt = await openRuntime(dir)
    const hits: Array<{ target: string; action: string }> = []
    const ingest = await import('../src/core/ingest')
    ingest.configureIngest({ alertRuntime: { dispatchTargetHit: (h) => { hits.push({ target: h.target, action: h.action }) } } })
    return { rt, hits }
  }

  for (const c of CASES) {
    sqlite.it(`POST /api/events: ${c.field} as 5,000 levels, an object and a 5 MB string`, async () => {
      const dir = tmp('api')
      const { rt, hits } = await open(dir)
      const t0 = performance.now()
      try {
        for (const [n, v] of VARIANTS.entries()) {
          // A type is a string: a container is refused where the sender sees
          // why; a 5 MB string is a type the API does not take.
          const want = c.field === 'agent_type' ? (v.name === 'string' ? 403 : 400) : 201
          await rt.api(c.body(v.text, n), want)
        }
      } finally { await rt.close() }
      const ms = performance.now() - t0
      const rows = await storedRows(dir)
      if (c.field === 'agent_type') { expect(rows).toEqual([]); return }
      const own = rows
      for (const [n, v] of VARIANTS.entries()) {
        const label = `${c.field} ${v.name}`
        const hit = own.filter((r) => r.data.tag === `v${n}`)
        expect(hit.length, label).toBeGreaterThan(0)
        for (const r of hit.slice(0, 1)) {
          const stored = storedValue(c, r)
          // A container target is no target; anything else is kept as sent.
          if (c.field === 'target_id' && v.name !== 'string') expect(stored, label).toBeNull()
          else expectSent(c, v.name, stored, label)
        }
      }
      // The scope check takes a scalar or nothing: a container host is no
      // target, a container method or query type reads as the default.
      if (c.field === 'scanner data.host') expect(hits.map((h) => h.target.length)).toEqual([BIG])
      if (c.field === 'scanner data.method') expect(hits.map((h) => h.action.split(' ')[0].length)).toEqual([3, 3, BIG])
      if (c.field === 'dns data.query_type') expect(hits.map((h) => h.action.split(' ')[0].length)).toEqual([1, 1, BIG])
      console.log(`[timing] api ${c.field}: ${Math.round(ms)} ms for three variants`)
    }, SLOW)

    sqlite.it(`a spool file: ${c.field} as 5,000 levels, an object and a 5 MB string`, async () => {
      const dir = tmp('spool')
      const { rt } = await open(dir)
      let run
      try {
        run = rt.spool(VARIANTS.map((v, n) => withIdentity(c.body(v.text, n))), tmp('spool-files'),
          c.field === 'agent_type' ? 0 : VARIANTS.length)
      } finally { await rt.close() }
      const rows = await storedRows(dir)
      if (c.field === 'agent_type') {
        // A container type is malformed; a 5 MB one is a kind the spool may
        // not write. All three are set aside and counted, none written.
        expect(Object.values(run!.outcomes)).toEqual(['quarantined', 'quarantined', 'quarantined'])
        const gaps = rows.filter((r) => r.data.subtype === 'capture_gap')
        expect(gaps.map((g) => g.data.reason).sort()).toEqual(['kind-not-allowed', 'malformed'])
        for (const g of gaps) expect(JSON.stringify(g.data).length).toBeLessThan(4096)
        return
      }
      for (const [n, v] of VARIANTS.entries()) {
        const label = `${c.field} ${v.name}`
        const hit = rows.filter((r) => r.data.recovered_from_spool === true && r.data.tag === `v${n}`)
        expect(hit.length, label).toBeGreaterThan(0)
        const stored = storedValue(c, hit[0])
        if (c.field === 'target_id' && v.name !== 'string') expect(stored, label).toBeNull()
        else expectSent(c, v.name, stored, label)
      }
    }, SLOW)
  }

  sqlite.it('an HTTP body is moved to its sidecar only after everything that can fail has run: no sidecar file without its row', async () => {
    const dir = tmp('sidecar')
    const { rt } = await open(dir)
    const body = 'B'.repeat(8192)
    try {
      for (const [n, v] of VARIANTS.entries()) {
        await rt.api(`{"agent_type":"scanner","data":{"tag":"v${n}","subtype":"http_request_start","flow_id":"s${n}","method":"POST","url":"http://h.test/${n}",` +
          `"host":${v.text},"request_headers":{"Authorization":${v.text}},"request_body":{"data":"${body}${n}","encoding":"text","size":${body.length + 1},"sha256":""}}}`, 201)
      }
      // A body whose bytes are not a string is no body: left in place, not
      // read as an array of numbers (a nested array converted level by level,
      // `{"length": 1e9}` a gigabyte).
      await rt.api(`{"agent_type":"scanner","data":{"tag":"v9","subtype":"http_response","flow_id":"s9","host":"h.test","response_body":{"data":{"length":1000000000},"encoding":"text"}}}`, 201)
      await rt.api(`{"agent_type":"shell","data":{"tag":"v9","subtype":"command_output","command_id":"c9","output_body":{"data":${VARIANTS[0].text},"encoding":"text"}}}`, 201)
    } finally { await rt.close() }
    const files = fs.existsSync(path.join(dir, 'http-bodies')) ? fs.readdirSync(path.join(dir, 'http-bodies')).filter((f) => f.endsWith('.body')) : []
    const referenced = new Set((await storedRows(dir)).map((r) => (r.data.request_body_ref as { file?: string; sha256?: string } | undefined)?.sha256).filter(Boolean))
    expect(files.length).toBe(VARIANTS.length)
    for (const f of files) expect(referenced.has(f.replace(/\.body$/, '')), f).toBe(true)
  }, SLOW)
})
