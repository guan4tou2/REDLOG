import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import dgram from 'dgram'

// Work a project started that outlived it. An anchor that waited on the
// calendars wrote one project's head into the next project's anchors, which
// its verify then reads as tampering. And the first, sooner tick of the anchor
// and NTP loops was never cancelled: a switch to an air-gapped project inside
// that window still sent its chain head, or a time query, off the machine.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let anchor: typeof import('../src/core/chain-anchor') | null = null
let clock: typeof import('../src/core/clock') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  anchor = await import('../src/core/chain-anchor')
  clock = await import('../src/core/clock')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const IDS = { engagementId: 'eng', operatorId: 'op' }

describe.skipIf(events === null)('work that outlives its project', () => {
  const dirs: string[] = []
  const open = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-switch-net-'))
    dirs.push(dir)
    dbmod!.initDB(dir)
    return dir
  }
  beforeEach(() => { open() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    anchor!.stopAnchorLoop()
    clock!.stopNtpLoop()
    dbmod!.closeDB()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  const anchorRows = (): number =>
    (dbmod!.getDB().prepare('SELECT COUNT(*) AS c FROM chain_anchors').get() as { c: number }).c

  it('does not write an anchor into the project that opened while it waited', async () => {
    events!.insertEvent('marker', { title: 'in A', severity: 'info' }, IDS)
    // Nothing listens on port 1: the calendar fails, after a real network
    // round trip, which is the window a switch lands in.
    const pending = anchor!.anchorNow(['https://127.0.0.1:1'])
    dbmod!.closeDB()
    open()
    expect(await pending).toBeNull()
    expect(anchorRows()).toBe(0)
    expect(events!.queryEvents({ limit: -1, tier: 'all' })).toHaveLength(0)
  })

  it('cancels the first anchor tick when the loop stops', () => {
    vi.useFakeTimers()
    events!.insertEvent('marker', { title: 'online project', severity: 'info' }, IDS)
    const request = vi.spyOn(https, 'request')
    anchor!.startAnchorLoop()
    anchor!.stopAnchorLoop()
    vi.advanceTimersByTime(3 * 60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels the first NTP query when the loop stops', () => {
    vi.useFakeTimers()
    const socket = vi.spyOn(dgram, 'createSocket')
    clock!.startNtpLoop()
    clock!.stopNtpLoop()
    vi.advanceTimersByTime(10_000)
    expect(socket).not.toHaveBeenCalled()
  })
})
