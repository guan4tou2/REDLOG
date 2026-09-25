import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { seedTimelineFixture, HOUSEKEEPING_IDS, type FixtureRow, type TimelineFixture } from './helpers/timeline-query-fixture'

let db: typeof import('../src/core/db')
let ev: typeof import('../src/core/db/events')
let available = false
try {
  db = await import('../src/core/db')
  ev = await import('../src/core/db/events')
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string
let fx: TimelineFixture

function walk(filter: Record<string, unknown>): string[] {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = ev.queryEventsPage({ ...filter, excludeHousekeeping: true, limit: 200, cursor })
    ids.push(...page.items.map((e) => e.id))
    cursor = page.nextCursor
  } while (cursor)
  return ids
}

const expectIds = (keep: (r: FixtureRow) => boolean): string[] =>
  fx.rows.filter((r) => !HOUSEKEEPING_IDS.includes(r.id) && keep(r)).map((r) => r.id).sort()

// SC-001, at the layer the Timeline now reads through: every filtered event,
// including those older than the first 200, and nothing else. The newest 200
// rows are all shell, so a reader that filtered only its first page would
// find no DNS at all.
describeDB('the Timeline page query is complete for every shared-filter condition', () => {
  const START = 1_700_000_000_000
  // Seeded once for the file, not once per test. 1250 rows is a real write,
  // and re-seeding for each of these read-only tests pushed the file to ~22s
  // on a loaded Windows runner against a 15s per-test timeout - which is what
  // made it fail in CI, intermittently and on a different case each time,
  // while passing every time locally. Nothing here mutates the fixture.
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-038-complete-'))
    db.initDB(dir)
    fx = seedTimelineFixture({ total: 1250, newestShell: 200, start: START })
  })
  afterAll(() => {
    db.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('type and time: every DNS row in the oldest stretch, past the first page', () => {
    const since = START - 1_100_000
    const before = START - 900_000
    const got = walk({ agentType: 'dns', since, before }).sort()
    expect(got.length).toBeGreaterThan(0)
    expect(got).toEqual(expectIds((r) => r.agentType === 'dns' && r.timestamp >= since && r.timestamp <= before))
  })

  it('target', () => {
    expect(walk({ targetId: '10.0.0.50' }).sort()).toEqual(expectIds((r) => r.targetId === '10.0.0.50'))
  })

  it('in scope only keeps in-scope and untargeted rows', () => {
    const got = walk({ inScopeOnly: true, scope: { targets: ['10.0.0.5'], excludeTargets: [] } }).sort()
    expect(got).toEqual(expectIds((r) => r.targetId === null || r.targetId === '10.0.0.5'))
  })

  it('personal traffic hidden drops personal targets and keeps untargeted rows', () => {
    const got = walk({ hidePersonal: true, personalDomains: ['10.0.0.50'] }).sort()
    expect(got).toEqual(expectIds((r) => r.targetId !== '10.0.0.50'))
  })
})
