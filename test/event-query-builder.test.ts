import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery, type ParsedQuery } from '../src/core/query/contract'
import { seedTimelineFixture, HOUSEKEEPING_IDS, type TimelineFixture } from './helpers/timeline-query-fixture'
import { closeHttpBodyIndex } from '../src/core/http-body-index'

type Events = typeof import('../src/core/db/events')
let db: typeof import('../src/core/db')
let ev: Events
let available = false
try {
  db = await import('../src/core/db')
  ev = await import('../src/core/db/events')
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string
let fx: TimelineFixture

const parsed = (q: string): ParsedQuery => {
  const out = parseQuery(q)
  if (!out.ok) throw new Error(`fixture query does not parse: ${q}`)
  return out.parsed
}

function pageAllIds(fetch: (cursor: string | null) => { items: Array<{ id: string }>; nextCursor: string | null }): string[] {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = fetch(cursor)
    ids.push(...page.items.map((e) => e.id))
    cursor = page.nextCursor
  } while (cursor)
  return ids
}

// Spec 033 needs three reads over the one WHERE builder the page queries use:
// the page itself with housekeeping excluded, a count of what a page walks,
// and "which of these ids match". A count or a match check built separately
// from its page is how "N of M" and a dimmed row come to disagree with the
// rows beside them.
describeDB('one WHERE builder: page, count and id match', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-033-builder-'))
    db.initDB(dir)
    fx = seedTimelineFixture({ total: 300, newestShell: 40 })
  })
  afterEach(() => {
    // Text queries open the HTTP body index; Windows will not delete an open file.
    closeHttpBodyIndex()
    db.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('drops housekeeping rows from a page and from a query when asked', () => {
    const page = pageAllIds((cursor) => ev.queryEventsPage({ excludeHousekeeping: true, limit: 100, cursor }))
    expect(page.some((id) => HOUSEKEEPING_IDS.includes(id))).toBe(false)
    expect(pageAllIds((cursor) => ev.queryEventsPage({ limit: 100, cursor })).filter((id) => HOUSEKEEPING_IDS.includes(id)).sort())
      .toEqual([...HOUSEKEEPING_IDS].sort())

    const q = parsed('api_started')
    expect(ev.executeEventQuery({ parsed: q, limit: 50 }).items.map((e) => e.id)).toContain('fx-hk-api')
    expect(ev.executeEventQuery({ parsed: q, limit: 50, excludeHousekeeping: true }).items.map((e) => e.id)).not.toContain('fx-hk-api')
  })

  const filters: Array<[string, Record<string, unknown>]> = [
    ['no filter', {}],
    ['agentType', { agentType: 'dns' }],
    ['time range', { since: 1_700_000_000_000 - 200_000, before: 1_700_000_000_000 - 100_000 }],
    ['targetId', { targetId: '10.0.0.5' }],
    ['inScopeOnly', { inScopeOnly: true, scope: { targets: ['10.0.0.5'], excludeTargets: [] } }],
    ['hidePersonal', { hidePersonal: true, personalDomains: ['example.com'] }]
  ]
  for (const [name, filter] of filters) {
    it(`counts what the page walks: ${name}`, () => {
      const walked = pageAllIds((cursor) => ev.queryEventsPage({ ...filter, excludeHousekeeping: true, limit: 64, cursor }))
      expect(ev.countEvents({ filter, excludeHousekeeping: true })).toBe(walked.length)
    })
  }

  it('counts strictly past a cursor, as the next page would walk', () => {
    const first = ev.queryEventsPage({ excludeHousekeeping: true, limit: 50 })
    const total = ev.countEvents({ excludeHousekeeping: true })
    expect(ev.countEvents({ excludeHousekeeping: true, cursor: first.nextCursor })).toBe(total - 50)
  })

  it('counts what a query pages through, and nothing for an empty query', () => {
    const q = parsed('nmap')
    const walked = pageAllIds((cursor) => ev.executeEventQuery({ parsed: q, limit: 64, cursor }))
    expect(walked.length).toBeGreaterThan(0)
    expect(ev.countEvents({ parsed: q })).toBe(walked.length)
    expect(ev.countEvents({ parsed: parsed('""') })).toBe(0)
  })

  it('answers which given ids a filter admits, in input order', () => {
    const ids = ['fx-5', 'fx-host-1', 'fx-1', 'missing-id', 'fx-2']
    const admitted = ev.matchEventIds({ ids, filter: { targetId: '10.0.0.50' } })
    const expected = ids.filter((id) => fx.rows.find((r) => r.id === id)?.targetId === '10.0.0.50')
    expect(admitted).toEqual(expected)
    expect(ev.matchEventIds({ ids, filter: {} })).toEqual(ids.filter((id) => id !== 'missing-id'))
  })

  it('answers which given ids a query matches', () => {
    const ids = fx.rows.map((r) => r.id).slice(0, 400)
    const matched = ev.matchEventIds({ ids, parsed: parsed('10.0.0.50') })
    expect(matched.length).toBeGreaterThan(0)
    for (const id of matched) expect(fx.rows.find((r) => r.id === id)?.targetId).toBe('10.0.0.50')
  })

  it('refuses more than 1000 ids instead of truncating, and answers nothing for none', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `fx-${i}`)
    expect(() => ev.matchEventIds({ ids: tooMany })).toThrow('matchEventIds takes at most 1000 ids')
    expect(ev.matchEventIds({ ids: [] })).toEqual([])
  })

  // What the contract's text reading is, now that the Timeline shares it. The
  // last term is prefix-matched, so `10.0.0.5` also finds `10.0.0.50` while
  // the operator may still be typing. Nothing matches inside a word: `map`
  // does not find `nmap`, which the Timeline's old substring bag did.
  it('prefix-matches the last term, and never matches inside a word', () => {
    const ids = fx.rows.map((r) => r.id).slice(0, 1000)
    const five = ev.matchEventIds({ ids, parsed: parsed('10.0.0.5') })
    expect(five.some((id) => fx.rows.find((r) => r.id === id)?.targetId === '10.0.0.50')).toBe(true)
    expect(ev.matchEventIds({ ids, parsed: parsed('nma') }).length).toBeGreaterThan(0)
    expect(ev.matchEventIds({ ids, parsed: parsed('map') })).toEqual([])
  })

  // SC-003: the Timeline dims by id through matchEventIds, Search pages
  // through executeEventQuery. For the contract's own scenario inputs they
  // must select the same events.
  for (const input of ['nmap', '10.0.0.5', 'session:S1', '"nmap -sV"']) {
    it(`matches by id exactly what the query pages through: ${input}`, () => {
      const q = parsed(input)
      const paged = new Set(pageAllIds((cursor) => ev.executeEventQuery({ parsed: q, limit: 100, cursor })))
      const all = fx.rows.map((r) => r.id)
      const byId = new Set<string>()
      for (let i = 0; i < all.length; i += 1000) {
        for (const id of ev.matchEventIds({ ids: all.slice(i, i + 1000), parsed: q })) byId.add(id)
      }
      expect([...byId].sort()).toEqual([...paged].sort())
    })
  }
})
