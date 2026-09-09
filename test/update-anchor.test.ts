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
    expect(res).toEqual({ anchored: true, headHash: 'deadbeef', anchorStatus: 'complete' })

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
    expect(res).toEqual({ anchored: false, headHash: null, anchorStatus: 'none' })
    const evs = pendingEvents()
    expect(evs).toHaveLength(1)
    expect((evs[0].data as Record<string, unknown>).anchored_head).toBeNull()
  })

  it('a throwing anchor is swallowed (never blocks the update)', async () => {
    const res = await ua.anchorBeforeRestart(
      { fromVersion: '0.15.1' }, { anchorNow: async () => { throw new Error('calendar down') } }
    )
    expect(res.anchored).toBe(false)
    expect(res.anchorStatus).toBe('none')
  })
})
