import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// 2d batch-delete guard: screenshotsReferencedByMarker returns the subset of a
// batch of screenshot ids that a marker cites, so the renderer can pick the
// confirmation tier (checkbox vs type-to-confirm). The only link is
// screenshot._causes ∋ markerId (screenshot-agent stamps it; marker:create
// strips _causes, so markers never point forward).

let initDB: typeof import('../../src/core/db/index').initDB
let closeDB: typeof import('../../src/core/db/index').closeDB
let events: typeof import('../../src/core/db/events')
let ops: typeof import('../../src/core/db/operators')
let dbAvailable = false
try {
  const dbMod = await import('../../src/core/db/index')
  events = await import('../../src/core/db/events')
  ops = await import('../../src/core/db/operators')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled for this Node */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('screenshotsReferencedByMarker (2d backend)', () => {
  let tmpDir: string
  let operatorId: string

  // Insert a screenshot carrying an optional _causes, return its event id.
  const shot = (causes?: string[]): string =>
    events.insertEvent('screenshot', {
      trigger: 'manual', filename: 'x.jpg', sha256: 'deadbeef',
      ...(causes ? { _causes: causes } : {})
    }, { operatorId })!.id

  const marker = (title: string): string =>
    events.insertEvent('marker', { subtype: 'created', title, severity: 'info' }, { operatorId })!.id

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shotref-'))
    initDB(tmpDir)
    operatorId = ops.ensurePrimaryOperator('op', 'Op', 'tok-' + Math.random()).id
  })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('flags a screenshot whose _causes points at a marker', () => {
    const m = marker('admin panel')
    const cited = shot([m])
    const orphan = shot()                                 // no _causes at all
    const commandLinked = shot(['some-command-event-id']) // _causes, but not a marker
    const r = events.screenshotsReferencedByMarker([cited, orphan, commandLinked])
    expect(r).toEqual([cited])
  })

  it('preserves input order and dedups nothing it should not', () => {
    const m1 = marker('a'); const m2 = marker('b')
    const s1 = shot([m1]); const s2 = shot(); const s3 = shot([m2])
    // Passed out of order — result follows the input order, not insertion order.
    expect(events.screenshotsReferencedByMarker([s3, s2, s1])).toEqual([s3, s1])
  })

  it('ignores non-screenshot ids and unknown ids', () => {
    const m = marker('x')
    const s = shot([m])
    // A marker id and a made-up id are silently dropped — never mis-attributed.
    expect(events.screenshotsReferencedByMarker([s, m, 'nope'])).toEqual([s])
  })

  it('empty input and a batch with no marker links yield []', () => {
    expect(events.screenshotsReferencedByMarker([])).toEqual([])
    const s1 = shot(); const s2 = shot(['not-a-marker'])
    expect(events.screenshotsReferencedByMarker([s1, s2])).toEqual([])
  })

  it('a screenshot with several causes counts if any one is a marker', () => {
    const m = marker('finding')
    const s = shot(['cmd-1', m, 'cmd-2'])
    expect(events.screenshotsReferencedByMarker([s])).toEqual([s])
  })
})
