import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The violation count is asked for on every captured event (StatusBar,
// Sidebar), so it is cached. The proxy writes one `in_scope` verdict per
// in-scope request, and a cache that those drop is a full scan of every scope
// row per request: 0.6 s at 42k flows, 38% of the main process's CPU in the
// #291 soak, and an /api/health p99 of 3.6 s. An `in_scope` row can never
// change the count, so it must not drop the cache.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let counter: typeof import('../src/core/scope-observation-count') | null = null
let runner: typeof import('../src/core/scope-recompute-run') | null = null
let bus: typeof import('../src/core/event-bus') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  counter = await import('../src/core/scope-observation-count')
  runner = await import('../src/core/scope-recompute-run')
  bus = await import('../src/core/event-bus')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = events !== null
const IDS = { engagementId: 'eng', operatorId: 'op' }
type Ev = import('../src/core/db/events').RedLogEvent

describe.skipIf(!available)('the cached scope-violation count', () => {
  let dir: string
  let scans = 0
  let unwrap: () => void

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-violation-count-'))
    dbmod!.initDB(dir)
    counter!.invalidateObservationCount()
    // Count executions of the one statement that reads every scope row.
    scans = 0
    const db = dbmod!.getDB() as unknown as { prepare: (sql: string) => unknown }
    const original = db.prepare
    db.prepare = function (this: unknown, sql: string) {
      if (sql.includes(`subtype IN ('scope_violation','scope_cleared')`)) scans++
      return original.call(this, sql)
    }
    unwrap = () => { db.prepare = original }
  })
  afterEach(() => {
    unwrap()
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // The bus fans out on a microtask; wait for it the way a real listener would.
  const publish = async (e: Ev): Promise<void> => {
    bus!.eventBus.publish(e)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const system = (data: Record<string, unknown>, targetId: string): Ev =>
    events!.insertEvent('system', data, { ...IDS, targetId })!
  // Taken straight from the chain, bypassing the cache, then undone so `scans`
  // keeps counting only what the cache did.
  const fresh = (): number => {
    const before = scans
    const n = runner!.countActiveScopeObservations()
    scans = before
    return n
  }

  it('survives 200 in_scope verdicts, and is dropped by the rows that can change it', async () => {
    expect(counter!.activeObservationCount()).toBe(0)
    expect(scans).toBe(1)

    for (let i = 0; i < 200; i++) {
      await publish(system({
        subtype: 'scope_violation', target: 'in.example', action: `GET /${i}`, source: 'mitm',
        distance: 'in_scope', authority: 'fact', severity: 'info'
      }, 'in.example'))
      expect(counter!.activeObservationCount()).toBe(0)
    }
    // The first read; none of the 200 verdicts forced another.
    expect(scans).toBe(1)
    expect(fresh()).toBe(0)

    const violation = system({
      subtype: 'scope_violation', target: 'out.example', action: 'curl out.example', source: 'shell',
      distance: 'unrelated', authority: 'fact', severity: 'critical', _causes: ['src-1']
    }, 'out.example')
    await publish(violation)
    expect(counter!.activeObservationCount()).toBe(1)
    expect(scans).toBe(2)
    expect(fresh()).toBe(1)

    await publish(system({
      subtype: 'scope_cleared', target: 'out.example', violation_id: violation.id,
      distance_before: 'unrelated', distance_after: 'in_scope'
    }, 'out.example'))
    expect(counter!.activeObservationCount()).toBe(0)
    expect(scans).toBe(3)
    expect(fresh()).toBe(0)
  })

  it('is dropped by a recompute summary', async () => {
    expect(counter!.activeObservationCount()).toBe(0)
    await publish(system({ subtype: 'scope_recomputed', recompute_id: 'r1' }, 'scope'))
    counter!.activeObservationCount()
    expect(scans).toBe(2)
  })
})
