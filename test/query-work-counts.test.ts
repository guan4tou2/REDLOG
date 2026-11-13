import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { installWorkCounter, measureWork, uninstallWorkCounter, workTuple, type WorkProfile } from './helpers/work-counter'

// Spec 074 T010 — the work every main-thread read does TODAY, counted at 10k
// and at 100k rows. Phases 3 and 4 move these reads; this file is the "before".
//
// It counts work, never time (see test/helpers/work-counter.ts): statements,
// rows returned to JS, application-defined SQL function calls, JSON.parse
// calls, lstat/open calls, and "scan-class" statements (the cost is the size
// of the table however few rows come back). The rows of the table below are
// [statements, rows, udfCalls, jsonParse, lstat, open, scans]. A change in a
// number is not necessarily a regression: re-measure with PRINT_WORK=1, read
// the diff, and record why in the commit. What a later phase must achieve is
// stated by the `it.fails` cases at the bottom, which say the CORRECT
// behaviour; each flips to a plain `it` when its read stops growing.
//
// Not measured here, and why: `casts:search` (needs recorded cast files and
// lives behind Electron-only IPC), `content:*`/`httpBody:read` (one file each,
// class `file`), `scope:*` (main-process cache), the HTTP API routes (the same
// core functions as the channels above) and `GET /api/export/har` (already
// measured by the export tests).
//
// Dataset (deterministic; nothing here depends on the clock, locale or path
// separator): N rows over both tiers, N/100 distinct targets and hosts, N/50
// rows that reference a saved body file (each a real file), a few hundred
// screenshots, loot, markers and pivots.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let getReadonlyDB: typeof import('../src/core/db/index').getReadonlyDB
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
let bodySearchCoverage: typeof import('../src/core/http-body-index').bodySearchCoverage
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let storeBody: typeof import('../src/core/http-body-store').storeBody
let resetBodiesDirCache: typeof import('../src/core/http-body-store').resetBodiesDirCache
let parseQuery: typeof import('../src/core/query/contract').parseQuery
let reads: typeof import('../src/core/db/event-queries')
let aggregates: typeof import('../src/core/db/event-aggregates')
let activity: typeof import('../src/core/db/activity-queries')
let querySourceSessions: typeof import('../src/core/source-sessions').querySourceSessions
let streamCompletion: typeof import('../src/core/stream-completion').streamCompletion
let getChainLength: typeof import('../src/core/evidence-chain').getChainLength
let readActivePivots: typeof import('../src/main/active-pivots').readActivePivots

let available = false
if (requires('better-sqlite3').ok) {
  ;({ initDB, closeDB, getDB, getReadonlyDB } = await import('../src/core/db/index'))
  ;({ readActivitySnapshot } = await import('../src/core/db/dataset-snapshot'))
  ;({ closeHttpBodyIndex, bodySearchCoverage } = await import('../src/core/http-body-index'))
  ;({ storeBody, resetBodiesDirCache } = await import('../src/core/http-body-store'))
  ;({ parseQuery } = await import('../src/core/query/contract'))
  reads = await import('../src/core/db/event-queries')
  aggregates = await import('../src/core/db/event-aggregates')
  activity = await import('../src/core/db/activity-queries')
  ;({ querySourceSessions } = await import('../src/core/source-sessions'))
  ;({ streamCompletion } = await import('../src/core/stream-completion'))
  ;({ getChainLength } = await import('../src/core/evidence-chain'))
  ;({ readActivePivots } = await import('../src/main/active-pivots'))
  available = true
}

const SIZES = [10_000, 100_000] as const
type Size = (typeof SIZES)[number]
type Tuple = ReturnType<typeof workTuple>

function seed(n: number): { anchor: string; flow: string; commands: string[]; matchIds: string[] } {
  const db = getDB()
  const targets = n / 100, bodyEvery = 50
  const cols = 'id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at'
  const chained = db.prepare(`INSERT INTO events (${cols},hash,prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const logged = db.prepare(`INSERT INTO events_logged (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const bodies = new Map<number, ReturnType<typeof storeBody>>()
  for (let i = 0; i < n; i += bodyEvery) bodies.set(i, storeBody({ data: `body ${i} needle-${i % 7}`, encoding: 'text', size: 0, sha256: '' }))
  const commands: string[] = [], matchIds: string[] = []
  let flow = '', anchor = ''
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const ts = 1_700_000_000_000 + i, k = i % 10
      const target = `t${i % targets}.test`, put = (tier: 'c' | 'l', id: string, type: string, data: Record<string, unknown>): void => {
        const row = [id, ts, 'eng', 'binding', 'operator', type, String(data.subtype ?? ''), 'host', null, target, JSON.stringify(data), ts] as const
        if (tier === 'c') chained.run(...row, 'fixture-hash', null)
        else logged.run(...row)
        if (matchIds.length < 500 && i % 20 === 0) matchIds.push(id)
      }
      if (k === 0) { put('c', `s${i}`, 'shell', { subtype: 'command_start', terminalId: 't1', command_id: `c${i}`, command: 'id' }); if (commands.length < 50) commands.push(`c${i}`); anchor ||= `s${i}` }
      else if (k === 1) put('c', `e${i}`, 'shell', { subtype: 'command_end', terminalId: 't1', command_id: `c${i - 1}`, command: 'id', exit_code: 0 })
      else if (k === 2) put('c', `o${i}`, 'shell', { subtype: 'command_output', terminalId: 't1', command_id: `c${i - 2}`, late: 1, seq: 0, output: 'x' })
      else if (k === 3) {
        const m = i % 100
        if (m === 3) put('c', `p${i}`, 'screenshot', { subtype: 'captured', trigger: 'manual', file: `shot-${i}.png` })
        else if (m === 13) put('c', `l${i}`, 'loot', { subtype: 'secret', matches: [{ kind: 'k1' }, { kind: 'k2' }] })
        else if (m === 23) put('c', `m${i}`, 'marker', { title: `marker ${i}` })
        else if (m === 33) put('c', `v${i}`, 'pivot', { subtype: 'opened', via: `h${i % 3}`, tool: 'ssh', command: `ssh ${i}`, route: 'r' })
        else put('c', `a${i}`, 'agent', i % 20 === 3 ? { subtype: 'tool_call', agent: 'claude-code', session_id: 'conv', tool_use_id: `u${i}` } : { subtype: 'tool_result', agent: 'claude-code', session_id: 'conv', tool_use_id: `u${i - 10}` })
      } else {
        const flowId = `f${i >> 1}`
        if (i === 4) flow = flowId
        const ref = bodies.get(i - (i % bodyEvery))
        put('l', `h${i}`, 'scanner', k % 2 === 0
          ? { subtype: 'http_request_start', flow_id: flowId, host: `h${i % targets}.test`, url: `https://h${i % targets}.test/${i}` }
          : { subtype: 'http_response', flow_id: flowId, host: `h${i % targets}.test`, status: 200, ...(i % bodyEvery === 5 && ref ? { response_body_ref: ref } : {}) })
      }
    }
  })()
  return { anchor, flow, commands, matchIds }
}

const bodyCoverage = (parsed: import('../src/core/query/contract').ParsedQuery): unknown =>
  bodySearchCoverage(readActivitySnapshot(getReadonlyDB()), undefined, { parsed })

const noHousekeeping = { excludeHousekeeping: true }

/** The reads of plan.md's "主行程上的讀取" table that are `service` or `indexed`
 *  and that this repository can run without Electron, keyed by channel. */
function readsFor(fx: ReturnType<typeof seed>): Array<[name: string, run: () => unknown]> {
  const text = parseQuery('needle-3'); if (!text.ok) throw new Error('fixture query')
  const none = parseQuery('operator:operator'); if (!none.ok) throw new Error('fixture query')
  const empty = parseQuery(''); if (!empty.ok) throw new Error('fixture query')
  const activityRequest = { projectId: 'eng', parsed: empty.parsed, limit: 50 }
  let firstActivity: { nextCursor?: string | null } | undefined
  return [
    // service
    ['events:runQuery text, cold', () => reads.executeEventQuery({ parsed: text.parsed, limit: 100 })],
    ['events:runQuery text, warm', () => reads.executeEventQuery({ parsed: text.parsed, limit: 100 })],
    ['events:runQuery coverage only', () => bodyCoverage(text.parsed)],
    ['events:runQuery conditions only', () => reads.executeEventQuery({ parsed: none.parsed, limit: 100 })],
    ['events:activityPage first page', () => (firstActivity = activity.queryActivityPage(activityRequest))],
    ['events:activityPage next page', () => activity.queryActivityPage({ ...activityRequest, cursor: firstActivity?.nextCursor ?? undefined })],
    ['events:sourceSessions', () => querySourceSessions({ projectId: 'eng', kind: 'agent', limit: 50 })],
    ['events:aggregateTargets', () => aggregates.aggregateTargets()],
    ['events:distinctHosts', () => aggregates.distinctHosts()],
    ['events:distinctAgentTypes', () => reads.distinctAgentTypes()],
    ['events:count', () => reads.countEvents({ filter: {}, ...noHousekeeping })],
    ['events:span', () => reads.spanEvents({ filter: {}, ...noHousekeeping })],
    ['events:query limit -1', () => reads.queryEvents({ limit: -1 })],
    ['loot:getCount', () => reads.getLootCount()],
    // indexed
    ['events:matchIds', () => reads.matchEventIds({ ids: fx.matchIds, filter: {}, ...noHousekeeping })],
    ['events:queryPage', () => reads.queryEventsPage({ limit: 200, ...noHousekeeping })],
    ['events:queryHttpFlowPage', () => reads.queryHttpFlowPage({ limit: 100 })],
    ['events:queryScreenshotPage', () => reads.queryScreenshotPage({ limit: 50 })],
    ['events:commandOutput', () => reads.queryCommandOutput(fx.commands[0], 2001)],
    ['events:commandEnds', () => reads.queryCommandEnds(fx.commands)],
    ['events:queryByFlowId', () => reads.queryByFlowId(fx.flow)],
    ['events:streamCompletion', () => streamCompletion(reads.queryStreamSegments(fx.flow))],
    ['events:causalChain', () => reads.queryEventCausalChain(fx.anchor, {})],
    ['events:getCount all', () => reads.getEventCount({ tier: 'all' })],
    ['chain:length', () => getChainLength()],
    ['pivots:getActive', () => readActivePivots()]
  ]
}

/** [read, work at 10k rows, work at 100k rows], each [statements, rows, udfCalls, jsonParse, lstat, open, scans]. */
const PINNED: Array<[name: string, small: Tuple, large: Tuple]> = [
  ['events:runQuery text, cold', [1027, 671, 0, 429, 1003, 200, 12], [10027, 6400, 0, 4101, 10003, 2000, 12]],
  ['events:runQuery text, warm', [225, 673, 0, 229, 203, 0, 12], [2025, 6402, 0, 2101, 2003, 0, 12]],
  ['events:runQuery coverage only', [209, 406, 0, 200, 0, 0, 6], [2009, 4006, 0, 2000, 0, 0, 6]],
  ['events:runQuery conditions only', [9, 109, 0, 100, 0, 0, 4], [9, 109, 0, 100, 0, 0, 4]],
  ['events:activityPage first page', [62, 109, 30000, 30250, 0, 0, 7], [62, 109, 300000, 300250, 0, 0, 7]],
  ['events:activityPage next page', [63, 113, 0, 251, 0, 0, 7], [63, 113, 0, 251, 0, 0, 7]],
  ['events:sourceSessions', [5, 5, 600, 601, 0, 0, 2], [5, 5, 6000, 6001, 0, 0, 2]],
  ['events:aggregateTargets', [1, 90, 0, 0, 0, 0, 1], [1, 900, 0, 0, 0, 0, 1]],
  ['events:distinctHosts', [1, 60, 0, 0, 0, 0, 1], [1, 500, 0, 0, 0, 0, 1]],
  ['events:distinctAgentTypes', [1, 7, 0, 0, 0, 0, 1], [1, 7, 0, 0, 0, 0, 1]],
  ['events:count', [1, 1, 0, 0, 0, 0, 1], [1, 1, 0, 0, 0, 0, 1]],
  ['events:span', [1, 1, 0, 0, 0, 0, 1], [1, 1, 0, 0, 0, 0, 1]],
  ['events:query limit -1', [1, 10000, 0, 10000, 0, 0, 0], [1, 100000, 0, 100000, 0, 0, 0]],
  ['loot:getCount', [1, 1, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0]],
  ['events:matchIds', [1, 500, 0, 0, 0, 0, 0], [1, 500, 0, 0, 0, 0, 0]],
  ['events:queryPage', [1, 201, 0, 200, 0, 0, 0], [1, 201, 0, 200, 0, 0, 0]],
  ['events:queryHttpFlowPage', [2, 301, 0, 200, 0, 0, 0], [2, 301, 0, 200, 0, 0, 0]],
  ['events:queryScreenshotPage', [1, 51, 0, 50, 0, 0, 0], [1, 51, 0, 50, 0, 0, 0]],
  ['events:commandOutput', [1, 1, 0, 1, 0, 0, 0], [1, 1, 0, 1, 0, 0, 0]],
  ['events:commandEnds', [2, 50, 0, 50, 0, 0, 0], [2, 50, 0, 50, 0, 0, 0]],
  ['events:queryByFlowId', [1, 2, 0, 2, 0, 0, 0], [1, 2, 0, 2, 0, 0, 0]],
  ['events:streamCompletion', [3, 1, 0, 0, 0, 0, 0], [3, 1, 0, 0, 0, 0, 0]],
  ['events:causalChain', [2, 1, 0, 1, 0, 0, 0], [2, 1, 0, 1, 0, 0, 0]],
  ['events:getCount all', [2, 2, 0, 0, 0, 0, 2], [2, 2, 0, 0, 0, 0, 2]],
  ['chain:length', [1, 1, 0, 0, 0, 0, 1], [1, 1, 0, 0, 0, 0, 1]],
  ['pivots:getActive', [1, 40, 0, 40, 0, 0, 0], [1, 40, 0, 40, 0, 0, 0]],
]

/** Reads that grow today, in PINNED's order. Only ever shorter. */
const GROWS_TODAY = [
  'events:runQuery text, cold', 'events:runQuery text, warm', 'events:runQuery coverage only', 'events:runQuery conditions only',
  'events:activityPage first page', 'events:activityPage next page', 'events:sourceSessions', 'events:aggregateTargets',
  'events:distinctHosts', 'events:distinctAgentTypes', 'events:count', 'events:span', 'events:query limit -1',
  'events:getCount all', 'chain:length'
]

const describeDB = available ? describe : describe.skip
const profiles = new Map<Size, Map<string, { work: WorkProfile; scans: string[] }>>()
const dirs: string[] = []

describeDB('work of the main-thread reads, today', () => {
  beforeAll(() => {
    installWorkCounter()
    for (const size of SIZES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-work-${size}-`))
      dirs.push(dir)
      initDB(dir)
      resetBodiesDirCache()
      const fx = seed(size)
      const measured = new Map<string, { work: WorkProfile; scans: string[] }>()
      for (const [name, run] of readsFor(fx)) {
        const { work, scanStatements } = measureWork(run)
        measured.set(name, { work, scans: scanStatements })
      }
      profiles.set(size, measured)
      closeHttpBodyIndex()
      closeDB()
    }
    if (process.env.PRINT_WORK) {
      for (const size of SIZES) for (const [name, { work, scans }] of profiles.get(size)!) console.log(`${size}\t${name}\t${JSON.stringify(workTuple(work))}${size === 10_000 ? scans.map((q) => `\n\t\t> ${q.replace(/\s+/g, ' ').slice(0, 110)}`).join('') : ''}`)
    }
  }, 120_000)
  afterAll(() => {
    uninstallWorkCounter()
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  })

  const at = (size: Size, name: string): Tuple => workTuple(profiles.get(size)!.get(name)!.work)

  it('does the work recorded for each read at 10k and 100k rows', () => {
    const measured = Object.fromEntries(PINNED.map(([name]) => [name, [at(10_000, name), at(100_000, name)]]))
    expect(measured).toEqual(Object.fromEntries(PINNED.map(([name, small, large]) => [name, [small, large]])))
    expect([...profiles.get(10_000)!.keys()].sort()).toEqual(PINNED.map(([name]) => name).sort())
  })

  // A read "grows" when its work differs between 10k and 100k, or when it runs
  // a scan-class statement (the cost is the table, however few rows come back).
  // New growth fails; so does an entry that no longer grows, so a phase that
  // fixes a read has to take it off this list in the same change.
  const growers = (): string[] => PINNED.filter(([, small, large]) =>
    small.some((v, i) => i < 6 && v !== large[i]) || large[6] > 0 || small[6] > 0).map(([name]) => name)
  it('lists the reads whose work grows with the project (ratchet: only shrinks)', () => {
    expect(growers()).toEqual(GROWS_TODAY)
  })
  it('records which of those it measured as scan-class statements', () => {
    const named = profiles.get(100_000)!.get('events:aggregateTargets')!.scans
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/GROUP BY LOWER\(target\)/)
  })

  // The CORRECT behaviour, in the words of plan.md "閘門": a read's cost does
  // not grow with the project. Each is red today for the reason in its title;
  // Phases 3–4 turn it into a plain `it` when the read comes from a projection.
  const doesNotGrow = (name: string, what: 'work' | 'scans'): void => {
    const small = at(10_000, name), large = at(100_000, name)
    if (what === 'scans') expect(large[6], `${name}: scan-class statements at 100k rows`).toBe(0)
    else expect(large.slice(0, 6), `${name}: work at 100k rows`).toEqual(small.slice(0, 6))
  }
  it.fails('a text search covers the saved bodies without a statement and a JSON.parse per reference (coverage)', () => {
    doesNotGrow('events:runQuery coverage only', 'work')
  })
  it.fails('a repeated text search does not lstat and re-link every saved body file (recheck)', () => {
    doesNotGrow('events:runQuery text, warm', 'work')
  })
  it.fails('an Activity page does not run a rowid-range COUNT over both tiers per page', () => {
    doesNotGrow('events:activityPage next page', 'scans')
  })
  it.fails('aggregateTargets does not group both tiers whole on every call', () => {
    doesNotGrow('events:aggregateTargets', 'scans')
  })
  it.fails('distinctHosts does not json_extract every row of both tiers on every call', () => {
    doesNotGrow('events:distinctHosts', 'scans')
  })
})
