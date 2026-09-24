import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { queryEventsPage, countEvents, matchEventIds, executeEventQuery, type EventFilter } from '../src/core/db/events'
import { parseQuery, type ParsedQuery } from '../src/core/query/contract'
import { closeHttpBodyIndex } from '../src/core/http-body-index'

// Spec 038 SC-006 and research R13: the Timeline's reads on a 100,000-event
// project, 50/50 tiers, 200 targets in mixed case. Skipped unless
// REDLOG_PERF=1: it takes a while to seed, and a timing is only evidence on
// the machine it is recorded for, which the report prints.

const PERF = process.env.REDLOG_PERF === '1'
const N = 100_000
const TARGETS = 200
const BUDGET_MS = 200
const T0 = 1_700_000_000_000
const TYPES = [
  ['shell', 'command_end'], ['agent', 'tool_use'], ['scanner', 'http_request_start'], ['dns', 'query'],
  ['system', 'note'], ['marker', 'marker'], ['process', 'spawn'], ['browser', 'console']
] as const

/** Median of five runs, after one to warm the page cache and the statement. */
function median(fn: () => unknown): number {
  fn()
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    fn()
    runs.push(performance.now() - t)
  }
  return runs.sort((a, b) => a - b)[2]
}

const parsed = (q: string): ParsedQuery => {
  const r = parseQuery(q)
  if (!r.ok) throw new Error(`unparsable: ${q}`)
  return r.parsed
}

describe.skipIf(!PERF)('the Timeline query budget on 100,000 events', () => {
  let dir: string
  const report: Array<{ name: string; ms: number }> = []
  const record = (name: string, ms: number): number => { report.push({ name, ms }); return ms }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-038-perf-'))
    initDB(dir)
    const db = getDB()
    const insert = (table: 'events' | 'events_logged') => db.prepare(`
      INSERT INTO ${table} (id, timestamp, engagement_id, session_id, operator_id,
        agent_type, subtype, hostname, source_ip, target_id, data, created_at
        ${table === 'events' ? ', hash, prev_hash, signature' : ''})
      VALUES (?, ?, 'eng-1', 's', ?, ?, ?, '', '', ?, ?, ?
        ${table === 'events' ? ", 'h', 'p', 's'" : ''})
    `)
    const chained = insert('events')
    const logged = insert('events_logged')
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const [agentType, subtype] = TYPES[i % TYPES.length]
        const host = `host-${i % TARGETS}.example.com`
        // Every target in two casings, so the case-insensitive predicate is
        // what finds all of its rows.
        const target = i % 3 === 0 ? host.toUpperCase() : host
        const data = JSON.stringify({ subtype, command: `nmap -sV ${host} --reason run-${i}`, host })
        const ts = T0 + i * 1000
        ;(i % 2 === 0 ? chained : logged).run(`e${i}`, ts, `op-${i % 4}`, agentType, subtype, target, data, ts)
      }
    })()
  }, 600_000)

  afterAll(() => {
    const cpu = os.cpus()[0]?.model ?? 'unknown CPU'
    const lines = report.map((r) => `  ${r.ms.toFixed(1).padStart(8)} ms  ${r.name}`)
    console.log([
      `timeline-query-perf: ${N} events, median of 5 warm runs`,
      `machine: ${cpu}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}, node ${process.version}`,
      ...lines
    ].join('\n'))
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // One of each condition kind the shared filter can set.
  const KINDS: Array<[string, EventFilter]> = [
    ['no filter', {}],
    ['target (other casing)', { targetId: 'HOST-7.example.com' }],
    ['type', { agentType: 'dns' }],
    ['time', { since: T0 + 40_000_000, before: T0 + 60_000_000 }],
    ['in scope', { inScopeOnly: true, scope: { targets: ['host-1.example.com', '*.example.com'], excludeTargets: ['host-2.example.com'] } }],
    ['personal', { hidePersonal: true, personalDomains: ['gmail.com', 'slack.com'] }],
    ['chained only', { tier: 'chained' }]
  ]

  for (const [kind, filter] of KINDS) {
    it(`first page and total under ${BUDGET_MS} ms each: ${kind}`, () => {
      const pageMs = record(`first page, ${kind}`, median(() => queryEventsPage({ ...filter, limit: 200, excludeHousekeeping: true })))
      const countMs = record(`total, ${kind}`, median(() => countEvents({ filter, excludeHousekeeping: true })))
      expect(pageMs).toBeLessThan(BUDGET_MS)
      expect(countMs).toBeLessThan(BUDGET_MS)
    })
  }

  it('checks 1,000 held rows, and the earlier matches past a cursor, under budget', () => {
    const ids = Array.from({ length: 1000 }, (_, k) => `e${k * 97}`)
    const filter: EventFilter = { targetId: 'host-7.example.com' }
    const text = parsed('nmap host-7')
    const cursor = queryEventsPage({ limit: 200, excludeHousekeeping: true }).nextCursor
    expect(cursor).not.toBeNull()
    const checks = [
      record('matchEventIds, 1,000 ids, filter', median(() => matchEventIds({ ids, filter, excludeHousekeeping: true }))),
      record('matchEventIds, 1,000 ids, filter + text', median(() => matchEventIds({ ids, filter, parsed: text, excludeHousekeeping: true }))),
      record('earlier matches: executeEventQuery, cursor, limit 1', median(() => executeEventQuery({ parsed: text, filter, cursor, limit: 1, excludeHousekeeping: true }))),
      record('earlier matches: countEvents, text + cursor', median(() => countEvents({ parsed: text, filter, cursor, excludeHousekeeping: true })))
    ]
    for (const ms of checks) expect(ms).toBeLessThan(BUDGET_MS)
  })

  // Research R10: live rows are admitted by the persistence layer, one call
  // per frame of new rows. A busy second is 60 frames of 100 rows; the main
  // process may spend a tenth of it answering.
  it('admits a busy second of live rows in under 100 ms', () => {
    const batches = Array.from({ length: 60 }, (_, b) =>
      Array.from({ length: 100 }, (_, k) => `e${N - 1 - b * 100 - k}`))
    const filter: EventFilter = { inScopeOnly: true, scope: { targets: ['*.example.com'], excludeTargets: [] } }
    const burst = (): void => { for (const ids of batches) matchEventIds({ ids, filter, excludeHousekeeping: true }) }
    const ms = record('live burst: 60 x matchEventIds(100 ids)', median(burst))
    expect(ms).toBeLessThan(100)
  })
})
