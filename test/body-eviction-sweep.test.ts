import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// The planner is unit-tested in body-eviction.test.ts; this drives the whole
// sweep against a real DB and a real http-bodies directory, because the part
// that can go wrong quietly is the JOIN — matching a .body file to the events
// that reference it and deciding pinned-by-scope. Getting that wrong evicts
// in-scope evidence, which is the one thing this must never do.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let sweepBodyStore: typeof import('../src/core/retention').sweepBodyStore
let queryEvents: typeof import('../src/core/db/events').queryEvents

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  const r = await import('../src/core/retention')
  initDB = d.initDB; closeDB = d.closeDB
  insertEvent = e.insertEvent; queryEvents = e.queryEvents
  sweepBodyStore = r.sweepBodyStore
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node ABI */ }

const describeDB = dbAvailable ? describe : describe.skip
const OPTS = { engagementId: 'eng', operatorId: 'op' }
let dir: string
let bodiesDir: string

/** Write a body file of `size` bytes with a given age, return its filename. */
function writeBody(name: string, size: number, ageMs = 0): string {
  const file = `${name}.body`
  const full = path.join(bodiesDir, file)
  fs.writeFileSync(full, Buffer.alloc(size, 1))
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(full, t, t) }
  return file
}

/** A scanner http event that references a body file, with a target. */
function seedRef(file: string, size: number, target: string | null): void {
  insertEvent('scanner', {
    subtype: 'http_response',
    host: target ?? 'unknown',
    response_body_ref: { sha256: 'x'.repeat(64), size, file, encoding: 'text' }
  }, { ...OPTS, targetId: target ?? undefined })
}

describeDB('body store size-pressure eviction', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-'))
    initDB(dir)
    bodiesDir = path.join(dir, 'http-bodies')
    fs.mkdirSync(bodiesDir, { recursive: true })
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const exists = (file: string): boolean => fs.existsSync(path.join(bodiesDir, file))

  it('does nothing when unbounded (maxBytes 0)', () => {
    const f = writeBody('a', 1000)
    seedRef(f, 1000, null)
    const r = sweepBodyStore({ httpBodies: { maxBytes: 0 } }, OPTS)
    expect(r.evicted).toBe(0)
    expect(exists(f)).toBe(true)
  })

  it('evicts the coldest unpinned body to get under budget', () => {
    const cold = writeBody('cold', 800, 60_000)
    const warm = writeBody('warm', 800, 1_000)
    seedRef(cold, 800, null)
    seedRef(warm, 800, null)
    const r = sweepBodyStore({ httpBodies: { maxBytes: 1000 } }, OPTS)
    expect(r.evicted).toBe(1)
    expect(exists(cold)).toBe(false)
    expect(exists(warm)).toBe(true)
  })

  it('never evicts an in-scope body — scope is the pin', () => {
    // The in-scope body is colder AND bigger, so a scope-blind planner would
    // take it first. It must survive; the out-of-scope body goes instead.
    const inScope = writeBody('inscope', 900, 60_000)
    const outScope = writeBody('outscope', 900, 1_000)
    seedRef(inScope, 900, '10.10.11.24')
    seedRef(outScope, 900, '8.8.8.8')
    const r = sweepBodyStore(
      { httpBodies: { maxBytes: 1000 }, scope: { targets: ['10.10.11.24'] } },
      OPTS
    )
    expect(exists(inScope), 'in-scope evidence was evicted').toBe(true)
    expect(exists(outScope)).toBe(false)
    expect(r.evicted).toBe(1)
  })

  it('honours a wildcard scope pattern', () => {
    const inScope = writeBody('sub', 900, 60_000)
    const outScope = writeBody('other', 900, 1_000)
    seedRef(inScope, 900, 'api.target.com')
    seedRef(outScope, 900, 'evil.example')
    sweepBodyStore(
      { httpBodies: { maxBytes: 1000 }, scope: { targets: ['*.target.com'] } },
      OPTS
    )
    expect(exists(inScope)).toBe(true)
    expect(exists(outScope)).toBe(false)
  })

  it('reports a shortfall and keeps pinned bodies when the scope set alone is over budget', () => {
    const p1 = writeBody('p1', 800); const p2 = writeBody('p2', 800)
    seedRef(p1, 800, '10.10.11.24'); seedRef(p2, 800, '10.10.11.24')
    const cold = writeBody('cold', 400, 60_000); seedRef(cold, 400, null)
    const r = sweepBodyStore(
      { httpBodies: { maxBytes: 1000 }, scope: { targets: ['10.10.11.24'] } },
      OPTS
    )
    expect(exists(p1)).toBe(true)
    expect(exists(p2)).toBe(true)
    expect(exists(cold)).toBe(false)
    expect(r.shortfallBytes).toBe(600)  // 1600 pinned − 1000 budget
  })

  it('writes an audit event so shrinking evidence is on the record', () => {
    const f = writeBody('a', 2000, 60_000); seedRef(f, 2000, null)
    sweepBodyStore({ httpBodies: { maxBytes: 500 } }, OPTS)
    const audit = queryEvents({ limit: 100 })
      .filter((e) => e.agentType === 'system' && e.data?.subtype === 'body_evicted')
    expect(audit.length).toBe(1)
    expect(audit[0].data.count).toBe(1)
    expect(audit[0].data.freed_bytes).toBe(2000)
  })

  it('leaves the event and its attestation intact after eviction', () => {
    // The whole safety argument: the body file goes, the event stays, so the
    // chain still proves what the body was.
    const f = writeBody('a', 2000, 60_000)
    seedRef(f, 2000, null)
    sweepBodyStore({ httpBodies: { maxBytes: 500 } }, OPTS)
    expect(exists(f)).toBe(false)
    const ev = queryEvents({ limit: 100 }).find((e) =>
      (e.data?.response_body_ref as { file?: string } | undefined)?.file === f)
    expect(ev, 'the referencing event was destroyed').toBeTruthy()
    expect((ev!.data.response_body_ref as { sha256: string }).sha256).toHaveLength(64)
  })

  it('with no scope declared, falls back to purely coldest-first', () => {
    const cold = writeBody('cold', 800, 60_000); seedRef(cold, 800, '10.10.11.24')
    const warm = writeBody('warm', 800, 1_000); seedRef(warm, 800, '10.10.11.24')
    // No scope targets → nothing is pinned → coldest goes even though it has a
    // target, because "in-scope" is undefined without a declared scope.
    const r = sweepBodyStore({ httpBodies: { maxBytes: 1000 } }, OPTS)
    expect(r.evicted).toBe(1)
    expect(exists(cold)).toBe(false)
    expect(exists(warm)).toBe(true)
  })
})
