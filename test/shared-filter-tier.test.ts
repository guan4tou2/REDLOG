import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db/index'
import { queryEventsPage, executeEventQuery, countEvents, matchEventIds, queryHttpFlowPage } from '../src/core/db/events'
import { parseQuery } from '../src/core/query/contract'
import { insertFixtureRow, type FixtureRow } from './helpers/timeline-query-fixture'
import { closeHttpBodyIndex } from '../src/core/http-body-index'

const row = (table: FixtureRow['table'], id: string, ts: number, extra: Partial<FixtureRow> = {}): FixtureRow => ({
  table, id, timestamp: ts, agentType: 'shell', subtype: 'command_end', operatorId: 'op-1', targetId: 'h1',
  data: { command: `nmap ${id}` }, ...extra
})

// Spec 038 US4: "chained only" is a shared-filter condition, applied inside
// each tier's SQL like every other, so every event view can ask it and every
// count covers the whole project. It was a Timeline switch that dropped
// logged rows after loading them.
describe('the tier as a shared-filter condition', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-038-tier-'))
    initDB(dir)
    for (const r of [
      row('events', 'c1', 5), row('events_logged', 'l1', 4), row('events', 'c2', 3), row('events_logged', 'l2', 2),
      row('events_logged', 'f1', 1, { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: 'flow-1' } })
    ]) insertFixtureRow(r)
  })
  afterEach(() => {
    // The text query opens the HTTP body index; Windows will not delete an open file.
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const chained = { tier: 'chained' as const }

  it('pages, queries, counts and matches only chained rows', () => {
    expect(queryEventsPage({ ...chained, limit: 10 }).items.map((e) => e.id)).toEqual(['c1', 'c2'])
    const q = parseQuery('nmap')
    if (!q.ok) throw new Error('parse')
    expect(executeEventQuery({ parsed: q.parsed, filter: chained, limit: 10 }).items.map((e) => e.id)).toEqual(['c1', 'c2'])
    expect(countEvents({ filter: chained })).toBe(2)
    expect(matchEventIds({ ids: ['c1', 'l1', 'c2', 'l2'], filter: chained })).toEqual(['c1', 'c2'])
  })

  it('leaves HTTP History, whose flows are all logged, with nothing', () => {
    expect(queryHttpFlowPage({ limit: 10 }).flowCount).toBe(1)
    expect(queryHttpFlowPage({ ...chained, limit: 10 })).toMatchObject({ items: [], flowCount: 0, hasMore: false })
  })

  it('reads both tiers when no tier is asked for', () => {
    expect(countEvents({})).toBe(5)
  })
})
