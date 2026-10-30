import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// 5a "重啟前先錨定鏈頭": anchorBeforeRestart anchors the head (injected here so
// the test never hits an OTS calendar) and appends a chained
// `system.update_pending` event recording the anchored head + the expected gap.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ua: typeof import('../src/core/update-anchor')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ua = await import('../src/core/update-anchor')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }
const describeDB = dbAvailable ? describe : describe.skip

const fakeAnchor = (status: string, headHash: string) =>
  async () => ({ status, headHash } as unknown as import('../src/core/chain-anchor').ChainAnchor)

const pendingEvents = () =>
  events.queryEvents({ agentType: 'system', limit: 50 })
    .filter((e) => (e.data as { subtype?: string }).subtype === 'update_pending')

describeDB('anchorBeforeRestart (5a backend)', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-updanchor-'))
    initDB(tmpDir)
    ops.ensurePrimaryOperator('upd-op', 'Upd Op', 'tok-' + Math.random())
  })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('anchors the head and marks the expected gap (chained)', async () => {
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1', toVersion: '0.16.0' },
      { anchorNow: fakeAnchor('complete', 'deadbeef') }
    )
    expect(res).toEqual({ anchored: true, headHash: 'deadbeef', anchorStatus: 'complete', external: 'confirmed', localError: null })

    const evs = pendingEvents()
    expect(evs).toHaveLength(1)
    const d = evs[0].data as Record<string, unknown>
    expect(d.gap_expected).toBe(true)
    expect(d.from_version).toBe('0.15.1')
    expect(d.to_version).toBe('0.16.0')
    expect(d.anchored_head).toBe('deadbeef')
    expect(d.anchor_status).toBe('complete')
    expect(evs[0].tier).toBe('chained')  // update_pending is NOT in LOGGED_TIER
  })

  it('records the marker in a database bound to its project', async () => {
    // The updater names no engagement. Passing `default` for it made the row
    // name a foreign one, which the bound database refuses — and the restart
    // then had no record of its gap.
    const dbMod = await import('../src/core/db/index')
    dbMod.bindDBEngagement('eng-open')
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1', toVersion: '0.16.0' },
      { anchorNow: fakeAnchor('complete', 'deadbeef') }
    )
    expect(res.localError).toBeNull()
    expect(pendingEvents()).toHaveLength(1)
  })

  it('partial anchor still counts as anchored', async () => {
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: fakeAnchor('partial', 'abc') }
    )
    expect(res.anchored).toBe(true)
    expect(res.anchorStatus).toBe('partial')
  })

  it('a null anchor (empty chain) reports not-anchored but still records the marker', async () => {
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: async () => null }
    )
    expect(res).toEqual({ anchored: false, headHash: null, anchorStatus: 'none', external: 'none', localError: null })
    const evs = pendingEvents()
    expect(evs).toHaveLength(1)
    expect((evs[0].data as Record<string, unknown>).anchored_head).toBeNull()
  })

  // FR-007: the outside timestamp being out of reach is not a local failure.
  it('an unreachable calendar is reported as unavailable, not as a failure, and the marker is still written', async () => {
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: fakeAnchor('failed', 'abc') }
    )
    expect(res.external).toBe('unavailable')
    expect(res.localError).toBeNull()
    expect(pendingEvents()).toHaveLength(1)
  })

  it('air-gap makes no request: the anchor is never called, the head is read locally, the marker says so', async () => {
    let called = false
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1', offline: true },
      { anchorNow: async () => { called = true; return null }, computeChainHead: () => ({ hash: 'localhead' }) }
    )
    expect(called).toBe(false)
    expect(res).toMatchObject({ external: 'skipped', headHash: 'localhead', localError: null })
    const d = pendingEvents()[0].data as Record<string, unknown>
    expect(d.external_timestamp).toBe('skipped')
    expect(d.anchored_head).toBe('localhead')
    expect(String(d.description)).toContain('air-gap')
  })

  it('a failure to read or write the chain locally is reported, so the caller can stop', async () => {
    const reading = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: async () => { throw new Error('disk error') } }
    )
    expect(reading.localError).toContain('disk error')
    expect(pendingEvents()).toHaveLength(0)

    closeDB()
    const writing = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: fakeAnchor('complete', 'abc'), projectOpen: () => true }
    )
    expect(writing.localError).toContain('marker')
  })

  it('with no project open there is nothing to mark and nothing has failed', async () => {
    let called = false
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: async () => { called = true; return null }, projectOpen: () => false }
    )
    expect(called).toBe(false)
    expect(res.localError).toBeNull()
    expect(res.anchored).toBe(false)
  })

  it('records what the update did, and says the sessions before it were not resumed', () => {
    const done = ua.recordUpdateOutcome(
      { kind: 'completed', fromVersion: '1.0.0', toVersion: '1.1.0', actualVersion: '1.1.0' },
      { engagementId: 'default', operatorId: 'upd-op' }
    )
    expect(done).not.toBeNull()
    const miss = ua.recordUpdateOutcome(
      { kind: 'not-applied', fromVersion: '1.0.0', toVersion: '1.1.0', actualVersion: '1.0.0' },
      { engagementId: 'default', operatorId: 'upd-op' }
    )
    const subs = events.queryEvents({ agentType: 'system', limit: 50 }).map((e) => e.data as Record<string, unknown>)
    const completed = subs.find((d) => d.subtype === 'update_completed')!
    expect(completed).toMatchObject({ actual_version: '1.1.0', from_version: '1.0.0', sessions_resumed: false })
    expect(String(completed.description)).toContain('不會自動恢復')
    expect(subs.find((d) => d.subtype === 'update_not_applied')).toMatchObject({ actual_version: '1.0.0', to_version: '1.1.0' })
    expect(miss).not.toBeNull()
  })
})
