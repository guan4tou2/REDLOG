// Spec 071 FR-097 at the two outside doors: POST /api/events (the real
// handler, no port bound) and a handoff spool file drained as main drains it
// (test/helpers/ingest-delivery.ts). Both store an over-deep item bounded —
// the container at depth 64 replaced by `{"_collapsed": <its JSON text>}` and
// `_ingest.collapsed` set — in both tiers, up to a body 100,000 levels deep
// (JSON.parse takes it; JSON.stringify could not write it in Node). The API
// door used to answer such a body 400 and record nothing; the owner decided
// (2026-11-14) 「收下並摺疊」. One level past that ceiling the event is refused
// before it is parsed and the refusal is a capture gap (owner 2026-11-14,
// 「事件 API 超過十萬層就拒絕並記缺口，可以嗎？」「可以」): 413 from the API,
// quarantine from the spool. A body over the 20 MiB cap is still refused.
// Door equivalence for an over-deep item is in
// test/ingest-door-equivalence.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest'
import { requires } from './helpers/requires'
import { ENG, OP, interceptHttp, openRuntime, storedRows, type Item, type StoredRow } from './helpers/ingest-delivery'
import { COLLAPSED_KEY, EVENT_NESTING_CEILING, MAX_DATA_DEPTH, restoreDataDepth } from '../src/core/ingest/depth'

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
/** A body whose `data.deep` holds `levels` arrays, written as text (JSON.stringify overflows past a few thousand in Node). */
const bodyText = (agentType: string, data: string, levels: number, spool = false): string =>
  `{"agent_type":"${agentType}","data":{${data},"deep":${'['.repeat(levels)}"leaf"${']'.repeat(levels)}}${spool ? `,"_identity":{"engagementId":"${ENG}","operatorId":"${OP}"}` : ''}}`
const shellBody = (levels: number, spool = false): string => bodyText('shell', `"subtype":"command_start","command":"id","terminalId":"t${levels}","pid":${levels}`, levels, spool)
const dnsBody = (levels: number, spool = false): string => bodyText('dns', `"subtype":"dns_query","qname":"q${levels}.test"`, levels, spool)

/** Each row bounded at 64; wrapped exactly when `data` reaches past 64. */
function expectBounded(rows: StoredRow[], door: string, wrapped: boolean): void {
  for (const r of rows) {
    const label = `${door} ${r.table} ${String(r.data.terminalId ?? r.data.qname)}`
    expect(depthOf(r.data), label).toBeLessThanOrEqual(MAX_DATA_DEPTH)
    if (!wrapped) { expect('collapsed' in (r.data._ingest as object), label).toBe(false); continue }
    expect(r.data._ingest, label).toMatchObject({ door, collapsed: 1 })
    let holder: unknown = r.data.deep
    for (let d = 2; d < MAX_DATA_DEPTH; d++) holder = (holder as unknown[])[0]
    expect(Object.keys(holder as object), label).toEqual([COLLAPSED_KEY])
  }
}

sqlite.describe('the outside doors store an over-deep item bounded (FR-097)', () => {
  const dirs: string[] = []
  const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-depth-doors-${label}-`)); dirs.push(d); return d }
  beforeEach(() => { interceptHttp() })
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  // `data.deep` holds L arrays, so `data` is L + 1 deep and the body L + 2.
  // 62 and 63 stay as sent (the container at 64 holds only a string); 64 and
  // beyond are wrapped, up to a body exactly at the ceiling.
  sqlite.it('POST /api/events: `data` 63 and 64 deep stays; 65, 1,000 and 99,999 deep (a body of 100,000) is stored, wrapped, in both tiers', async () => {
    for (const [levels, wrapped] of [[62, false], [63, false], [64, true], [999, true], [EVENT_NESTING_CEILING - 2, true]] as const) {
      const dir = tmp(`api-${levels}`)
      const rt = await openRuntime(dir)
      try {
        await rt.api(shellBody(levels), 201)
        await rt.api(dnsBody(levels), 201)
      } finally { await rt.close() }
      const rows = await storedRows(dir)
      expect(rows.map((r) => r.table), String(levels)).toEqual(['events', 'events_logged'])
      expectBounded(rows, 'legacy-api', wrapped)
      for (const r of rows) expect(depthOf(restoreDataDepth(r.data)), String(levels)).toBe(levels + 1)
    }
  }, SLOW)

  sqlite.it('POST /api/events: an HTTP request whose parsed JSON body is nested 5,000 levels (`params.body_json`, as the proxy sends it) is stored', async () => {
    const dir = tmp('api-mitm')
    const rt = await openRuntime(dir)
    try {
      await rt.api(`{"agent_type":"scanner","data":{"subtype":"http_request_start","flow_id":"f-deep","method":"POST","url":"http://10.0.0.5/api","host":"10.0.0.5",` +
        `"params":{"body_json":{"a":${'['.repeat(5_000)}"quokka"${']'.repeat(5_000)}}}}}`, 201)
    } finally { await rt.close() }
    const rows = await storedRows(dir)
    expect(rows.map((r) => `${r.table}:${String(r.data.subtype)}`)).toEqual(['events_logged:http_request_start'])
    expect(rows[0].data._ingest).toMatchObject({ door: 'legacy-api', collapsed: 1 })
    expect(depthOf(rows[0].data)).toBe(MAX_DATA_DEPTH)
    expect(depthOf(restoreDataDepth(rows[0].data))).toBe(5_003)
  }, SLOW)

  sqlite.it('POST /api/events: a body over the 20 MiB cap is still refused, and nothing is stored', async () => {
    const dir = tmp('api-cap')
    const rt = await openRuntime(dir)
    try {
      const filler = 'x'.repeat(20 * 1024 * 1024)
      await rt.api(`{"agent_type":"external","data":{"subtype":"note","text":"${filler}"}}`, 500)
    } finally { await rt.close() }
    expect(await storedRows(dir)).toEqual([])
  }, SLOW)

  sqlite.it('a handoff spool file: both tiers, and a file exactly 100,000 levels deep', async () => {
    const dir = tmp('spool')
    const rt = await openRuntime(dir)
    try { rt.spool(ITEMS, tmp('spool-files')) } finally { await rt.close() }
    expectBounded(await storedRows(dir), 'legacy-handoff', true)

    const dir2 = tmp('spool-huge')
    const rt2 = await openRuntime(dir2)
    try { rt2.spool([shellBody(EVENT_NESTING_CEILING - 2, true), dnsBody(EVENT_NESTING_CEILING - 2, true)], tmp('spool-files-huge')) } finally { await rt2.close() }
    expectBounded(await storedRows(dir2), 'legacy-handoff', true)
  }, SLOW)

  /** The capture_gap rows of a project, oldest first. */
  const gapsOf = (rows: StoredRow[]): Array<Record<string, unknown>> => rows.filter((r) => r.data.subtype === 'capture_gap').map((r) => r.data)

  sqlite.it('POST /api/events: one level past the ceiling is refused 413 naming the reason, nothing of it is stored, and a capture gap says so', async () => {
    const dir = tmp('api-ceiling')
    const rt = await openRuntime(dir)
    const text = shellBody(EVENT_NESTING_CEILING - 1)
    try {
      await rt.api(text, 413)
      await rt.api(ITEMS[1], 201)
    } finally { await rt.close() }
    const rows = await storedRows(dir)
    expect(rows.filter((r) => r.row.agent_type === 'shell')).toEqual([])
    const [gap, ...more] = gapsOf(rows)
    expect(more).toEqual([])
    expect(gap).toMatchObject({
      subtype: 'capture_gap', source: 'api', door: 'legacy-api', reason: 'nested-too-deep', intentional: false,
      skipped_units: 1, bytes: Buffer.byteLength(text), max_nesting: EVENT_NESTING_CEILING
    })
    expect(gap.gap_started_at).toBe(gap.gap_ended_at)
    // RedLog's own record, as the spool's gap rows are: in-process.
    expect(gap._ingest).toMatchObject({ door: 'in-process', producer: 'in-process' })
    expect(String(gap.description)).toMatch(/1 event\(s\) refused by the API: nested more than 100,000 levels deep/)
  }, SLOW)

  sqlite.it('POST /api/events: refusals within a minute of the first are one more gap row, written when the minute is up', async () => {
    const dir = tmp('api-ceiling-coalesce')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const rt = await openRuntime(dir)
    const text = dnsBody(EVENT_NESTING_CEILING - 1)
    try {
      await rt.api(text, 413)
      for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(1_000); await rt.api(text, 413) }
      // 58 s after the first: only the first is on the record.
      vi.advanceTimersByTime(54_000)
      expect(gapsOf(await storedRows(dir)).map((g) => g.skipped_units)).toEqual([1])
      vi.advanceTimersByTime(2_000)
    } finally { await rt.close(); vi.useRealTimers() }
    const gaps = gapsOf(await storedRows(dir))
    expect(gaps.map((g) => g.skipped_units)).toEqual([1, 4])
    expect(gaps[1].bytes).toBe(4 * Buffer.byteLength(text))
    expect(Number(gaps[1].gap_ended_at) - Number(gaps[1].gap_started_at)).toBe(3_000)
  }, SLOW)

  sqlite.it('a spool file one level past the ceiling is set aside unparsed, and counted in the drain pass\'s gap row', async () => {
    const dir = tmp('spool-ceiling')
    const rt = await openRuntime(dir)
    let run
    try { run = rt.spool([shellBody(EVENT_NESTING_CEILING - 1, true), dnsBody(EVENT_NESTING_CEILING - 1, true), ITEMS[1]], tmp('spool-files-ceiling'), 1) } finally { await rt.close() }
    expect(run!.outcomes).toEqual({ '0000.json': 'quarantined', '0001.json': 'quarantined', '0002.json': 'ingested' })
    const rows = await storedRows(dir)
    expect(rows.filter((r) => r.row.agent_type === 'shell')).toEqual([])
    const gaps = gapsOf(rows)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ source: 'hook-spool', reason: 'nested-too-deep', intentional: false, skipped_units: 2, quarantined: 2, files: ['0000.json', '0001.json'] })
    expect(String(gaps[0].description)).toMatch(/2 spooled event\(s\) not recorded: nested more than 100,000 levels deep; kept in/)
  }, SLOW)

  sqlite.it('a resend of an over-deep command inside the 2 s window is a duplicate, through the API (409) and through a spool file', async () => {
    const dir = tmp('api-dup')
    const rt = await openRuntime(dir)
    try {
      await rt.api(ITEMS[0], 201)
      await rt.api(ITEMS[0], 409)
    } finally { await rt.close() }
    expect((await storedRows(dir)).filter((r) => r.table === 'events')).toHaveLength(1)

    const dir2 = tmp('spool-dup')
    const rt2 = await openRuntime(dir2)
    try { rt2.spool([ITEMS[0], ITEMS[0]], tmp('spool-files-dup')) } finally { await rt2.close() }
    const rows = (await storedRows(dir2)).filter((r) => r.table === 'events')
    expect(rows).toHaveLength(1)
    expect(rows[0].data._ingest).toMatchObject({ door: 'legacy-handoff', collapsed: 1 })
  }, SLOW)
})
