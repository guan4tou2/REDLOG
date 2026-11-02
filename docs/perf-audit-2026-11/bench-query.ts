// Timeline queries on a large project, main side only — PERF-AUDIT-2026-11 §2.
//
//   node docs/perf-audit-2026-11/run.mjs bench-query.ts [--prof] -- <projectDir> [reps]
//
// The request shapes are the Timeline's own (Timeline.tsx loadFirstPage /
// loadMore / requestTotal, SearchPanel readProjectPage, FilterBar lists).
// Each query runs `reps` times; the first run is reported separately because
// it is the one an operator waits for after opening a project (cold page
// cache), the median is what a repeated interaction costs.
//
// Run against a COPY of a seeded project if you want to keep it pristine:
// initDB may apply migrations.

import { initDB } from '../../src/core/db/index'
import { queryEventsPage, countEvents, executeEventQuery, matchEventIds, distinctAgentTypes, getEventCount } from '../../src/core/db/event-queries'
import { aggregateTargets, distinctHosts } from '../../src/core/db/event-aggregates'
import type { ParsedQuery } from '../../src/core/query/contract'
import { getCaptureHealth } from '../../src/core/capture-health'

const [projectDir, repsArg = '5'] = process.argv.slice(2)
const REPS = Number(repsArg)
initDB(projectDir)

const parsed = (text: string): ParsedQuery => ({ text, conditions: [], tokens: text.split(/\s+/).map((raw) => ({ raw, read: 'text' as const })) })
const json = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

function time(label: string, fn: () => unknown): unknown {
  const runs: number[] = []
  let last: unknown
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now()
    last = fn()
    runs.push(performance.now() - t0)
  }
  const sorted = [...runs].sort((a, b) => a - b)
  const items = (last as { items?: unknown[] })?.items
  console.log(JSON.stringify({
    query: label, firstMs: +runs[0].toFixed(1), medianMs: +sorted[Math.floor(REPS / 2)].toFixed(1),
    rows: Array.isArray(items) ? items.length : Array.isArray(last) ? last.length : last,
    payloadKiB: +(json(last) / 1024).toFixed(1)
  }))
  return last
}

console.log(JSON.stringify({ chained: getEventCount({ tier: 'chained' }), all: getEventCount({ tier: 'all' }) }))
const first = time('queryEventsPage first 200 (Timeline open)', () => queryEventsPage({ excludeHousekeeping: true, limit: 200 })) as { nextCursor: string | null }
time('countEvents all (N of M)', () => countEvents({ filter: {}, excludeHousekeeping: true }))
let cursor = first.nextCursor
const t0 = performance.now()
let pages = 0
while (cursor && pages < 50) {
  const p = queryEventsPage({ excludeHousekeeping: true, limit: 200, cursor })
  cursor = p.nextCursor; pages++
}
console.log(JSON.stringify({ query: 'loadMore ×50 pages of 200 (scrolling back 10k rows)', totalMs: Math.round(performance.now() - t0), perPageMs: +((performance.now() - t0) / pages).toFixed(1) }))
time('queryEventsPage agentType=shell', () => queryEventsPage({ agentType: 'shell', excludeHousekeeping: true, limit: 200 }))
time('countEvents agentType=shell', () => countEvents({ filter: { agentType: 'shell' }, excludeHousekeeping: true }))
time('queryEventsPage agentType=marker (rare)', () => queryEventsPage({ agentType: 'marker', excludeHousekeeping: true, limit: 200 }))
time('countEvents agentType=marker', () => countEvents({ filter: { agentType: 'marker' }, excludeHousekeeping: true }))
time('queryEventsPage targetId=10.10.11.5', () => queryEventsPage({ targetId: '10.10.11.5', excludeHousekeeping: true, limit: 200 }))
time('countEvents targetId=10.10.11.5', () => countEvents({ filter: { targetId: '10.10.11.5' }, excludeHousekeeping: true }))
time('queryEventsPage last 1h', () => queryEventsPage({ since: Date.now() - 3600_000, excludeHousekeeping: true, limit: 200 }))
time('executeEventQuery text "crackmapexec" limit 50', () => executeEventQuery({ parsed: parsed('crackmapexec'), limit: 50, excludeHousekeeping: true }))
time('countEvents text "crackmapexec"', () => countEvents({ parsed: parsed('crackmapexec'), filter: {}, excludeHousekeeping: true }))
time('executeEventQuery text "Apache" (common word) limit 50', () => executeEventQuery({ parsed: parsed('Apache'), limit: 50, excludeHousekeeping: true }))
time('countEvents text "Apache"', () => countEvents({ parsed: parsed('Apache'), filter: {}, excludeHousekeeping: true }))
time('executeEventQuery text "zzznotfound"', () => executeEventQuery({ parsed: parsed('zzznotfound'), limit: 50, excludeHousekeeping: true }))
const ids = (first as unknown as { items: Array<{ id: string }> }).items.map((e) => e.id)
time('matchEventIds 100 live ids, agentType=shell', () => matchEventIds({ ids: ids.slice(0, 100), filter: { agentType: 'shell' }, excludeHousekeeping: true }))
time('distinctAgentTypes (FilterBar)', () => distinctAgentTypes())
time('aggregateTargets (FilterBar / Targets)', () => aggregateTargets())
time('distinctHosts', () => distinctHosts())

// Capture health (Dashboard, StatusBar every 30 s, Settings). Its cache lives
// 750 ms and any new event clears it, so during a recording each poll pays this.
// `now` is moved past the TTL so every call computes.
for (let i = 0; i < 3; i++) {
  const t = performance.now()
  getCaptureHealth(Date.now() + i * 10_000)
  console.log(JSON.stringify({ query: `getCaptureHealth (computed, run ${i + 1})`, ms: Math.round(performance.now() - t) }))
}
