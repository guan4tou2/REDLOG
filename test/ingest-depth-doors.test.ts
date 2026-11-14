// Spec 071 FR-097 at the two outside doors: POST /api/events (the real
// handler, no port bound) and a handoff spool file drained as main drains it
// (test/helpers/ingest-delivery.ts). The handoff door stores an over-deep
// item bounded, with `_ingest.collapsed`, in both tiers, a 100,000-level file
// too (JSON.parse takes it; JSON.stringify could not write it in Node), and
// keeps a redelivered over-deep command once. The API door refuses such a
// body before the writer sees it (pinned below). Door equivalence for an
// over-deep item is in test/ingest-door-equivalence.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { requires } from './helpers/requires'
import { ENG, OP, interceptHttp, openRuntime, storedRows, type Item, type StoredRow } from './helpers/ingest-delivery'
import { MAX_DATA_DEPTH } from '../src/core/ingest/depth'

const sqlite = requires('better-sqlite3')
const SLOW = 60_000

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-depth-doors-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

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
const nested = (levels: number, leaf: unknown): unknown => { let v = leaf; for (let i = 0; i < levels; i++) v = [v]; return v }

const ITEMS: Item[] = [
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1, deep: nested(90, 'marmotleaf') } },
  { agent_type: 'dns', data: { subtype: 'dns_query', qname: 'deep.test', deep: nested(90, 'marmotleaf') } }
]
const N = 100_000
const huge = (agentType: string, data: string, spool = false): string =>
  `{"agent_type":"${agentType}","data":{${data},"deep":${'['.repeat(N)}${']'.repeat(N)}}${spool ? `,"_identity":{"engagementId":"${ENG}","operatorId":"${OP}"}` : ''}}`
const HUGE_SHELL = (spool = false): string => huge('shell', '"subtype":"command_start","command":"id","terminalId":"t9","pid":9', spool)
const HUGE_DNS = (spool = false): string => huge('dns', '"subtype":"dns_query","qname":"huge.test"', spool)

function expectBounded(rows: StoredRow[], door: string): void {
  expect(rows.map((r) => `${r.table}:${String(r.row.agent_type)}`)).toEqual(['events:shell', 'events_logged:dns'])
  for (const r of rows) {
    expect(depthOf(r.data), `${door} ${r.table}`).toBe(MAX_DATA_DEPTH)
    expect(r.data._ingest, `${door} ${r.table}`).toMatchObject({ door, collapsed: 1 })
  }
}

sqlite.describe('the outside doors store an over-deep item bounded (FR-097)', () => {
  const dirs: string[] = []
  const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-depth-doors-${label}-`)); dirs.push(d); return d }
  beforeEach(() => { interceptHttp() })
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  // KNOWN DIVERGENCE (FR-097, open question for the owner): POST /api/events
  // refuses, before parsing, a body nested more than 64 levels
  // (api-request.ts MAX_JSON_DEPTH, #695), which is `data` deeper than 63. So
  // nothing over the writer's bound reaches the writer by this door: the item
  // is answered 400 and not recorded, where the handoff door and in-process
  // writers keep it collapsed. Pinned here so the answer is a visible change.
  sqlite.it('POST /api/events: `data` at 63 levels is stored as sent; one level more is refused with 400 and not recorded', async () => {
    const dir = tmp('api')
    const rt = await openRuntime(dir)
    try {
      // body (1) → data (2) → deep: 62 arrays (64).
      await rt.api({ agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1', pid: 1, deep: nested(62, 'x') } }, 201)
      await rt.api({ agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't2', pid: 2, deep: nested(63, 'x') } }, 400)
      for (const item of ITEMS) await rt.api(item, 400)
      await rt.api(HUGE_SHELL(), 400)
    } finally { await rt.close() }
    const rows = await storedRows(dir)
    expect(rows.map((r) => `${r.table}:${String(r.data.terminalId)}`)).toEqual(['events:t1'])
    expect(depthOf(rows[0].data)).toBe(MAX_DATA_DEPTH - 1)
    expect('collapsed' in (rows[0].data._ingest as object)).toBe(false)
  }, SLOW)

  sqlite.it('a handoff spool file: both tiers, and a 100,000-level file', async () => {
    const dir = tmp('spool')
    const rt = await openRuntime(dir)
    try { rt.spool(ITEMS, tmp('spool-files')) } finally { await rt.close() }
    expectBounded(await storedRows(dir), 'legacy-handoff')

    const dir2 = tmp('spool-huge')
    const rt2 = await openRuntime(dir2)
    try { rt2.spool([HUGE_SHELL(true), HUGE_DNS(true)], tmp('spool-files-huge')) } finally { await rt2.close() }
    expectBounded(await storedRows(dir2), 'legacy-handoff')
  }, SLOW)

  sqlite.it('a handoff spool holding the same over-deep command twice keeps it once: the second is a duplicate', async () => {
    const dir = tmp('spool-dup')
    const rt = await openRuntime(dir)
    try { rt.spool([ITEMS[0], ITEMS[0]], tmp('spool-files-dup')) } finally { await rt.close() }
    const rows = (await storedRows(dir)).filter((r) => r.table === 'events')
    expect(rows).toHaveLength(1)
    expect(rows[0].data._ingest).toMatchObject({ door: 'legacy-handoff', collapsed: 1 })
  }, SLOW)
})
