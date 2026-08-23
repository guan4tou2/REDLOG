import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.9.10: retention deletes evidence from disk. It had no tests at all, and
// v0.9.4 P0-4 found it had also never *run* in a packaged build for several
// releases — a runtime require() that rollup could not bundle, failing into a
// catch. Both the behaviour and the fact that it executes are now pinned.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let sweepRetention: typeof import('../src/core/retention').sweepRetention
let queryEvents: typeof import('../src/core/db/events').queryEvents
let castIndex: typeof import('../src/core/cast-index')

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const r = await import('../src/core/retention')
  const e = await import('../src/core/db/events')
  initDB = d.initDB; closeDB = d.closeDB; sweepRetention = r.sweepRetention; queryEvents = e.queryEvents
  castIndex = await import('../src/core/cast-index')
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const describeDB = dbAvailable ? describe : describe.skip
const OPTS = { engagementId: 'test', operatorId: 'op' }
let dir: string

const ageFile = (p: string, days: number): void => {
  const t = new Date(Date.now() - days * 86400_000)
  fs.utimesSync(p, t, t)
}
const seed = (sub: string, name: string, days: number): string => {
  const d = path.join(dir, sub)
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, name)
  fs.writeFileSync(f, 'x')
  ageFile(f, days)
  return f
}
const auditEvents = (subtype: string): number =>
  queryEvents({ limit: 500 }).filter((e) => e.agentType === 'system' && e.data?.subtype === subtype).length

describeDB('retention sweep', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ret-'))
    initDB(dir)
  })
  afterEach(() => {
    castIndex.closeCastIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps everything forever when keepDays is 0 (the default)', () => {
    const cast = seed('casts', 'old.cast', 400)
    const shot = seed('screenshots', 'old.jpg', 400)
    const swept = sweepRetention({}, OPTS)
    expect(swept).toEqual({ cast: 0, screenshots: 0, agentTranscripts: 0, httpBodies: 0 })
    expect(fs.existsSync(cast)).toBe(true)
    expect(fs.existsSync(shot)).toBe(true)
  })

  it('prunes only files older than the window', () => {
    const old = seed('casts', 'old.cast', 40)
    const fresh = seed('casts', 'fresh.cast', 2)
    const swept = sweepRetention({ terminal: { castKeepDays: 30 } }, OPTS)
    expect(swept.cast).toBe(1)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('writes an audit event per deletion — evidence never disappears silently', () => {
    seed('casts', 'a.cast', 40)
    seed('casts', 'b.cast', 40)
    sweepRetention({ terminal: { castKeepDays: 30 } }, OPTS)
    // The whole point: a reviewer looking at a missing .cast finds the row
    // explaining it, rather than an unexplained gap.
    expect(auditEvents('cast_pruned')).toBe(2)
  })

  it('sweeps each directory against its own window', () => {
    seed('casts', 'a.cast', 40)
    seed('screenshots', 'a.jpg', 40)
    seed('agent-transcripts', 'a.jsonl', 40)
    const swept = sweepRetention(
      { terminal: { castKeepDays: 30 }, screenshots: { keepDays: 0 }, agentTranscripts: { keepDays: 10 } }, OPTS
    )
    expect(swept).toEqual({ cast: 1, screenshots: 0, agentTranscripts: 1, httpBodies: 0 })
    expect(auditEvents('screenshot_pruned')).toBe(0)
    expect(auditEvents('agent_transcript_pruned')).toBe(1)
  })

  it('ignores files it does not own', () => {
    const other = seed('casts', 'notes.txt', 400)
    sweepRetention({ terminal: { castKeepDays: 1 } }, OPTS)
    expect(fs.existsSync(other)).toBe(true)
  })

  it('is a no-op without an operator id — every event needs attribution', () => {
    const f = seed('casts', 'a.cast', 400)
    expect(sweepRetention({ terminal: { castKeepDays: 1 } }, { engagementId: 'e', operatorId: '' }))
      .toEqual({ cast: 0, screenshots: 0, agentTranscripts: 0, httpBodies: 0 })
    expect(fs.existsSync(f)).toBe(true)
  })

  it('takes a pruned recording out of the search index too', async () => {
    // The recording's text lives in a second place (src/core/cast-index.ts).
    // If the sweep deletes the .cast and leaves the index, retention becomes
    // a lie: the operator is told the recording aged out, and its contents
    // are still searchable — which is worse than never having pruned, because
    // now nobody thinks to look.
    const castsDir = path.join(dir, 'casts')
    fs.mkdirSync(castsDir, { recursive: true })
    const cast = path.join(castsDir, 'old.cast')
    fs.writeFileSync(
      cast,
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000 }) + '\n' +
      JSON.stringify([0.1, 'o', 'RETENTION-CANARY-4471\r\n']) + '\n'
    )
    await castIndex.indexCast(cast, dir)
    expect(castIndex.searchCasts('RETENTION-CANARY-4471', 10, dir).length).toBe(1)

    ageFile(cast, 400)
    const swept = sweepRetention({ terminal: { castKeepDays: 30 } }, OPTS)
    expect(swept.cast).toBe(1)
    expect(fs.existsSync(cast)).toBe(false)
    expect(castIndex.searchCasts('RETENTION-CANARY-4471', 10, dir).length).toBe(0)
  })

  it('tolerates a missing directory', () => {
    expect(() => sweepRetention({ terminal: { castKeepDays: 1 } }, OPTS)).not.toThrow()
  })
})
