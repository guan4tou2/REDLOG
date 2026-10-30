import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The last line of defence for "A's events must never land in B". The open
// database is told which engagement it belongs to when the project opens, and
// a row that names a different one is refused, whichever path it came by.
// Two such paths were found and closed by name (scope recompute, cast
// backfill); this is for the ones nobody has found. docs/DESIGN-project-runtime.md.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
} catch { /* better-sqlite3 not built for this Node ABI */ }

describe.skipIf(events === null)('a database bound to its engagement', () => {
  let dir: string
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-db-guard-'))
    dbmod!.initDB(dir)
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errors.mockRestore()
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const count = (): number => events!.queryEvents({ limit: -1, tier: 'all' }).length

  it('refuses a chained row that names another engagement, and says so', () => {
    dbmod!.bindDBEngagement('eng-b')
    const before = count()
    expect(events!.insertEvent('marker', { title: 'from A', severity: 'info' }, { engagementId: 'eng-a', operatorId: 'op' })).toBeNull()
    expect(count()).toBe(before)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('eng-a'))
  })

  it('refuses a logged-tier row that names another engagement', () => {
    dbmod!.bindDBEngagement('eng-b')
    const before = count()
    // dns_query is logged tier: the second insert arm, checked the same way.
    expect(events!.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.example.', query_type: 'A' }, { engagementId: 'eng-a', operatorId: 'op' })).toBeNull()
    expect(count()).toBe(before)
  })

  it('writes rows for its own engagement as before', () => {
    dbmod!.bindDBEngagement('eng-b')
    expect(events!.insertEvent('marker', { title: 'from B', severity: 'info' }, { engagementId: 'eng-b', operatorId: 'op' })).toBeTruthy()
    expect(events!.insertEvent('dns', { subtype: 'dns_query', query_name: 'b.example.', query_type: 'A' }, { engagementId: 'eng-b', operatorId: 'op' })).toBeTruthy()
    expect(errors).not.toHaveBeenCalled()
  })

  it('forgets the binding when the database closes', () => {
    dbmod!.bindDBEngagement('eng-b')
    dbmod!.closeDB()
    dbmod!.initDB(dir)
    // Unbound — tools and tests that open a database directly — checks nothing.
    expect(events!.insertEvent('marker', { title: 'unbound', severity: 'info' }, { engagementId: 'eng-a', operatorId: 'op' })).toBeTruthy()
  })
})
