import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.15: heavy reads route through a cached read-only connection
// (getReadonlyDB) so a long scan doesn't serialise capture writes on the
// read-write handle. This covers the four invariants that matter:
//   1. the handle is genuinely read-only,
//   2. it is cached (one handle reused),
//   3. it sees writes committed on the read-write connection (WAL), and
//   4. a project switch invalidates it (old handle closed, new file served).

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getReadonlyDB: typeof import('../src/core/db/index').getReadonlyDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let queryEvents: typeof import('../src/core/db/events').queryEvents

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getReadonlyDB = dbMod.getReadonlyDB
  insertEventRaw = eventsMod.insertEvent
  queryEvents = eventsMod.queryEvents
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

let tmpDir: string

describeDB('getReadonlyDB', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ro-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the same cached handle across calls', () => {
    expect(getReadonlyDB()).toBe(getReadonlyDB())
  })

  it('rejects writes on the handle', () => {
    const ro = getReadonlyDB()
    // A readonly connection throws on any attempt to write the file.
    expect(() => ro.exec('CREATE TABLE ro_probe (x)')).toThrow()
  })

  it('sees writes committed on the read-write connection', () => {
    // queryEvents now reads through getReadonlyDB — if the readonly handle
    // could not see the committed insert, this would come back empty.
    insertEvent('marker', { subtype: 'note', text: 'hello' })
    const evs = queryEvents({ agentType: 'marker' })
    expect(evs).toHaveLength(1)
    expect(getReadonlyDB().prepare('SELECT COUNT(*) AS c FROM events').get()).toEqual({ c: 1 })
  })

  it('invalidates the cached handle on project switch', () => {
    insertEvent('marker', { subtype: 'note', text: 'proj-1' })
    const ro1 = getReadonlyDB()
    expect(ro1.prepare('SELECT COUNT(*) AS c FROM events').get()).toEqual({ c: 1 })

    // Switch projects. initDB → closeDB closes the old read-only handle and
    // reopens against the new (empty) file.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ro2-'))
    try {
      initDB(tmpDir2)
      const ro2 = getReadonlyDB()
      expect(ro2).not.toBe(ro1)
      // Old handle is closed.
      expect(() => ro1.prepare('SELECT 1').get()).toThrow()
      // New handle reads the new project's empty events table.
      expect(ro2.prepare('SELECT COUNT(*) AS c FROM events').get()).toEqual({ c: 0 })
    } finally {
      // Point the outer teardown at the project that is actually open now, and
      // clean up the first project's dir.
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = tmpDir2
    }
  })
})