import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// docs/DESIGN-OPEN-ITEMS §3b. sweepArtifactStore gives casts + screenshots the
// same scope-pinned size-pressure eviction the http-body store already has:
// under a byte budget the coldest UNPINNED file goes first, and a file whose
// referencing event is in scope is pinned and kept. The part that can go wrong
// quietly is the JOIN — matching a .cast / .jpg on disk back to the event that
// references it (by castPath / filePath / filename) and deciding pinned-by-
// scope. Getting it wrong evicts in-scope evidence, the one thing it must not.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let sweepArtifactStore: typeof import('../src/core/retention').sweepArtifactStore
let queryEvents: typeof import('../src/core/db/events').queryEvents
let castIndex: typeof import('../src/core/cast-index')

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  const r = await import('../src/core/retention')
  initDB = d.initDB; closeDB = d.closeDB
  insertEvent = e.insertEvent; queryEvents = e.queryEvents
  sweepArtifactStore = r.sweepArtifactStore
  castIndex = await import('../src/core/cast-index')
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node ABI */ }

const describeDB = dbAvailable ? describe : describe.skip
const OPTS = { engagementId: 'eng', operatorId: 'op' }
let dir: string

/** Write an artifact file of `size` bytes with a given age, return abs path. */
function write(sub: string, name: string, size: number, ageMs = 0): string {
  const d = path.join(dir, sub)
  fs.mkdirSync(d, { recursive: true })
  const full = path.join(d, name)
  fs.writeFileSync(full, Buffer.alloc(size, 1))
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(full, t, t) }
  return full
}

/** A shell session_end event that references a .cast by absolute path. */
function seedCast(castPath: string, target: string | null): void {
  insertEvent('shell', {
    subtype: 'session_end',
    castPath,
    castSha256: 'c'.repeat(64)
  }, { ...OPTS, targetId: target ?? undefined })
}

/** A screenshot event that references a .jpg by filePath + filename basename. */
function seedShot(filePath: string, target: string | null): void {
  insertEvent('screenshot', {
    filePath,
    filename: path.basename(filePath),
    sha256: 's'.repeat(64)
  }, { ...OPTS, targetId: target ?? undefined })
}

describeDB('artifact store size-pressure eviction', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-artifact-'))
    initDB(dir)
  })
  afterEach(() => {
    castIndex.closeCastIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing when unbounded (budget 0)', () => {
    const c = write('casts', 'a.cast', 1000)
    seedCast(c, null)
    const r = sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 0 } }, OPTS)
    expect(r.evicted).toBe(0)
    expect(fs.existsSync(c)).toBe(true)
  })

  it('evicts the coldest unpinned cast to get under budget', () => {
    const cold = write('casts', 'cold.cast', 800, 60_000)
    const warm = write('casts', 'warm.cast', 800, 1_000)
    seedCast(cold, null)
    seedCast(warm, null)
    const r = sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 1000 } }, OPTS)
    expect(r.evicted).toBe(1)
    expect(fs.existsSync(cold)).toBe(false)
    expect(fs.existsSync(warm)).toBe(true)
  })

  it('never evicts an in-scope cast — scope is the pin', () => {
    // The in-scope recording is colder AND bigger, so a scope-blind planner
    // would take it first. It must survive; the out-of-scope one goes instead.
    const inScope = write('casts', 'inscope.cast', 900, 60_000)
    const outScope = write('casts', 'outscope.cast', 900, 1_000)
    seedCast(inScope, '10.10.11.24')
    seedCast(outScope, '8.8.8.8')
    const r = sweepArtifactStore(
      'cast',
      { terminal: { castStoreMaxBytes: 1000 }, scope: { targets: ['10.10.11.24'] } },
      OPTS
    )
    expect(fs.existsSync(inScope), 'in-scope recording was evicted').toBe(true)
    expect(fs.existsSync(outScope)).toBe(false)
    expect(r.evicted).toBe(1)
  })

  it('honours a wildcard scope pattern for screenshots', () => {
    const inScope = write('screenshots', 'sub.jpg', 900, 60_000)
    const outScope = write('screenshots', 'other.jpg', 900, 1_000)
    seedShot(inScope, 'api.target.com')
    seedShot(outScope, 'evil.example')
    sweepArtifactStore(
      'screenshot',
      { screenshots: { maxBytes: 1000 }, scope: { targets: ['*.target.com'] } },
      OPTS
    )
    expect(fs.existsSync(inScope)).toBe(true)
    expect(fs.existsSync(outScope)).toBe(false)
  })

  it('reports a shortfall and keeps pinned files when the scope set alone is over budget', () => {
    const p1 = write('casts', 'p1.cast', 800); const p2 = write('casts', 'p2.cast', 800)
    seedCast(p1, '10.10.11.24'); seedCast(p2, '10.10.11.24')
    const cold = write('casts', 'cold.cast', 400, 60_000); seedCast(cold, null)
    const r = sweepArtifactStore(
      'cast',
      { terminal: { castStoreMaxBytes: 1000 }, scope: { targets: ['10.10.11.24'] } },
      OPTS
    )
    expect(fs.existsSync(p1)).toBe(true)
    expect(fs.existsSync(p2)).toBe(true)
    expect(fs.existsSync(cold)).toBe(false)
    expect(r.shortfallBytes).toBe(600)  // 1600 pinned − 1000 budget
  })

  it('writes a cast_evicted / screenshot_evicted audit so shrinking evidence is on record', () => {
    const c = write('casts', 'a.cast', 2000, 60_000); seedCast(c, null)
    sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 500 } }, OPTS)
    const castAudit = queryEvents({ limit: 100 })
      .filter((e) => e.agentType === 'system' && e.data?.subtype === 'cast_evicted')
    expect(castAudit.length).toBe(1)
    expect(castAudit[0].data.count).toBe(1)
    expect(castAudit[0].data.freed_bytes).toBe(2000)

    const s = write('screenshots', 'a.jpg', 2000, 60_000); seedShot(s, null)
    sweepArtifactStore('screenshot', { screenshots: { maxBytes: 500 } }, OPTS)
    const shotAudit = queryEvents({ limit: 100 })
      .filter((e) => e.agentType === 'system' && e.data?.subtype === 'screenshot_evicted')
    expect(shotAudit.length).toBe(1)
    expect(shotAudit[0].data.count).toBe(1)
  })

  it('leaves the event and its attestation intact after eviction', () => {
    // The whole safety argument: the file goes, the event stays, so the chain
    // still proves what the recording was.
    const c = write('casts', 'a.cast', 2000, 60_000); seedCast(c, null)
    sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 500 } }, OPTS)
    expect(fs.existsSync(c)).toBe(false)
    const ev = queryEvents({ limit: 100 }).find(
      (e) => e.agentType === 'shell' && e.data?.subtype === 'session_end'
    )
    expect(ev).toBeTruthy()
    expect(ev?.data.castSha256).toBe('c'.repeat(64))  // attestation survives
  })

  it('is a no-op without an operator id — every event needs attribution', () => {
    const c = write('casts', 'a.cast', 2000, 60_000); seedCast(c, null)
    const r = sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 500 } }, { engagementId: 'e', operatorId: '' })
    expect(r.evicted).toBe(0)
    expect(fs.existsSync(c)).toBe(true)
  })

  it('tolerates a missing directory', () => {
    expect(() => sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 1 } }, OPTS)).not.toThrow()
    expect(() => sweepArtifactStore('screenshot', { screenshots: { maxBytes: 1 } }, OPTS)).not.toThrow()
  })

  it('takes an evicted recording out of the search index too', async () => {
    // Same "an index that outlives its file is a lie" rule the age-based sweep
    // follows — eviction must not leave the transcript searchable after the
    // .cast is gone.
    const castsDir = path.join(dir, 'casts')
    fs.mkdirSync(castsDir, { recursive: true })
    const cast = path.join(castsDir, 'old.cast')
    fs.writeFileSync(
      cast,
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000 }) + '\n' +
      JSON.stringify([0.1, 'o', 'EVICTION-CANARY-9317\r\n']) + '\n'
    )
    await castIndex.indexCast(cast, dir)
    expect(castIndex.searchCasts('EVICTION-CANARY-9317', 10, dir).length).toBe(1)
    // Age it so it is the coldest, and seed an out-of-scope ref so nothing pins it.
    fs.utimesSync(cast, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    seedCast(cast, null)

    const r = sweepArtifactStore('cast', { terminal: { castStoreMaxBytes: 1 } }, OPTS)
    expect(r.evicted).toBe(1)
    expect(fs.existsSync(cast)).toBe(false)
    expect(castIndex.searchCasts('EVICTION-CANARY-9317', 10, dir).length).toBe(0)
  })
})
