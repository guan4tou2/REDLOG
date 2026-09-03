import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.9.5: pause means "do not record". Before this the gate lived only on
// eventBus.publish(), so a paused RedLog still wrote every row into the DB and
// the hash chain — it only muted the UI feed.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getEventCount: typeof import('../src/core/db/events').getEventCount
let queryEvents: typeof import('../src/core/db/events').queryEvents
let exemptSet: ReadonlySet<string>
let bus: typeof import('../src/core/event-bus').eventBus

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  const busMod = await import('../src/core/event-bus')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = eventsMod.insertEvent
  getEventCount = eventsMod.getEventCount
  queryEvents = eventsMod.queryEvents
  exemptSet = eventsMod.PAUSE_EXEMPT_AGENT_TYPES
  bus = busMod.eventBus
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const insert: typeof import('../src/core/db/events').insertEvent = (a, d, o) =>
  insertEventRaw(a, d, { operatorId: 'test-op', ...o })

const describeDB = dbAvailable ? describe : describe.skip
let tmpDir: string

describeDB('pause gate (v0.9.5)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pause-'))
    initDB(tmpDir)
    bus.resume()
  })
  afterEach(() => {
    bus.resume()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records passive capture while recording', () => {
    expect(insert('shell', { subtype: 'command_end', command: 'id' })).not.toBeNull()
    expect(getEventCount()).toBe(1)
  })

  it('drops passive capture while paused — nothing reaches the DB or the chain', () => {
    const before = getEventCount()
    bus.pause()
    for (const t of ['shell', 'agent', 'scanner', 'browser', 'dns', 'pivot', 'clipboard', 'process', 'loot', 'screenshot', 'http_navigation', 'file_transfer', 'cleanup']) {
      expect(insert(t, { subtype: 'x', command: `cmd-${t}` }), `${t} should be dropped`).toBeNull()
    }
    expect(getEventCount()).toBe(before)
  })

  it('keeps recording `system` — the pause itself has to stay explainable', () => {
    bus.pause()
    const ev = insert('system', { subtype: 'recording_paused', description: 'Recording paused' })
    expect(ev).not.toBeNull()
    expect(getEventCount()).toBe(1)
  })

  it('keeps recording `marker` — an explicit "write this down" is not passive capture', () => {
    bus.pause()
    expect(insert('marker', { title: 'seen while paused', severity: 'info' })).not.toBeNull()
  })

  it('honours bypassPause for deliberate actions (manual screenshot)', () => {
    bus.pause()
    expect(insert('screenshot', { trigger: 'periodic' })).toBeNull()
    expect(insert('screenshot', { trigger: 'manual' }, { bypassPause: true })).not.toBeNull()
  })

  it('publishes a pause-exempt row only when the publisher says bypassPause', async () => {
    // The second half of the exemption, and the half that was missing. A marker
    // is exempt at INSERT, so it reaches the chain while paused — but the
    // publish gate is separate, and a producer that publishes plainly leaves the
    // row invisible in the timeline until the next reload. The operator writes a
    // marker, sees nothing, and writes it again. Both marker producers in
    // src/main/index.ts pass bypassPause for this reason.
    const seen: string[] = []
    const onEvent = (e: { data?: Record<string, unknown> }): number => seen.push(String(e.data?.title))
    bus.on('event', onEvent)
    bus.pause()
    const quiet = insert('marker', { title: 'plain publish', severity: 'info' })!
    bus.publish(quiet)
    const loud = insert('marker', { title: 'bypassing publish', severity: 'info' })!
    bus.publish(loud, { bypassPause: true })
    await Promise.resolve()   // fanout is deferred via queueMicrotask
    expect(seen).toEqual(['bypassing publish'])
    bus.off('event', onEvent)
  })

  it('resumes cleanly and leaves no gap in the hash chain', () => {
    insert('shell', { subtype: 'command_end', command: 'before' })
    bus.pause()
    insert('shell', { subtype: 'command_end', command: 'during' })
    const paused = insert('system', { subtype: 'recording_paused' })
    bus.resume()
    const resumed = insert('system', { subtype: 'recording_resumed' })
    insert('shell', { subtype: 'command_end', command: 'after' })

    const rows = queryEvents({ limit: 100 }).slice().reverse()
    const commands = rows.filter((e) => e.agentType === 'shell').map((e) => e.data?.command)
    expect(commands).toEqual(['before', 'after'])
    // The gap is bracketed by the pause/resume pair, and prev_hash still links
    // straight through — dropping a row before insert never breaks the chain.
    expect(paused).not.toBeNull()
    expect(resumed!.prevHash).toBe(paused!.hash)
  })

  it('exempt set is exactly system + marker', () => {
    expect([...exemptSet].sort()).toEqual(['marker', 'system'])
  })
})
