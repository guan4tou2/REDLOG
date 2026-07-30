import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let queryEvents: typeof import('../src/core/db/events').queryEvents
let sanitize: typeof import('../src/core/sanitize').sanitize
let getSanitizedFields: typeof import('../src/core/sanitize').getSanitizedFields

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  const sanMod = await import('../src/core/sanitize')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEvent = eventsMod.insertEvent
  queryEvents = eventsMod.queryEvents
  sanitize = sanMod.sanitize
  getSanitizedFields = sanMod.getSanitizedFields
  dbAvailable = true
} catch { /* better-sqlite3 unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

let tmpDir: string

describeDB('sanitize (four-layer redaction, layer 4)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-sanitize-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const OP = { operatorId: 'op-1', engagementId: 'eng-1' }

  it('dry-run reports plan without writing', () => {
    const ev = insertEvent('shell', {
      subtype: 'command_end',
      output: 'header\nAKIAIOSFODNN7EXAMPLE trailer',
      redactions: [{ field: 'output', start: 7, end: 27, pattern: 'entropy', hint: '' }]
    }, OP)!
    const before = queryEvents({ agentType: 'system' }).length
    const r = sanitize({ eventIds: [ev.id], fields: ['output'], ...OP, dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.applied).toBe(0)
    expect(r.planned.length).toBe(1)
    expect(r.planned[0].field).toBe('output')
    expect(r.planned[0].spanCount).toBe(1)
    expect(getSanitizedFields(ev.id)).toEqual({})
    // No system.sanitized event on dry-run.
    expect(queryEvents({ agentType: 'system' }).length).toBe(before)
  })

  it('confirmed run writes replacement + appends chained system.sanitized', () => {
    const raw = 'header AKIAIOSFODNN7EXAMPLE trailer'
    const ev = insertEvent('shell', {
      subtype: 'command_end',
      output: raw,
      redactions: [{ field: 'output', start: 7, end: 27, pattern: 'entropy', hint: '' }]
    }, OP)!
    const r = sanitize({ eventIds: [ev.id], fields: ['output'], reason: 'unit-test', ...OP })
    expect(r.dryRun).toBe(false)
    expect(r.applied).toBe(1)
    expect(r.sanitizedEventId).toBeTruthy()

    const stored = getSanitizedFields(ev.id)
    // Bullet chars sized to the span (end - start = 20).
    expect(stored.output).toBe('header ' + '•'.repeat(20) + ' trailer')

    // Source event is UNCHANGED — the whole point of layer 4.
    const reloaded = queryEvents({ agentType: 'shell' }).find((e) => e.id === ev.id)!
    expect(reloaded.data.output).toBe(raw)

    // A system.sanitized event is chained.
    const sanEv = queryEvents({ agentType: 'system' }).find((e) => e.data?.subtype === 'sanitized')
    expect(sanEv).toBeTruthy()
    expect((sanEv!.data.source_events as string[]).includes(ev.id)).toBe(true)
    expect((sanEv!.data.fields as string[]).includes('output')).toBe(true)
    expect(sanEv!.data.reason).toBe('unit-test')
  })

  it('skips events with no spans; skips non-string fields', () => {
    const evNoSpans = insertEvent('shell', { subtype: 'command_end', output: 'clean output' }, OP)!
    const evWithSpans = insertEvent('shell', {
      subtype: 'command_end',
      output: 'AKIAIOSFODNN7EXAMPLE',
      count: 42,
      redactions: [{ field: 'output', start: 0, end: 20, pattern: 'entropy', hint: '' }]
    }, OP)!
    const r = sanitize({ eventIds: [evNoSpans.id, evWithSpans.id], fields: ['output', 'count'], ...OP })
    // Only the one event with a matching string span + redaction should apply.
    expect(r.applied).toBe(1)
    expect(r.planned[0].eventId).toBe(evWithSpans.id)
    expect(r.planned[0].field).toBe('output')
  })

  it('a subsequent sanitize on the same field REPLACES the prior row', () => {
    const ev = insertEvent('shell', {
      subtype: 'command_end',
      output: 'raw AKIAIOSFODNN7EXAMPLE',
      redactions: [{ field: 'output', start: 4, end: 24, pattern: 'entropy', hint: '' }]
    }, OP)!
    sanitize({ eventIds: [ev.id], fields: ['output'], ...OP })
    sanitize({ eventIds: [ev.id], fields: ['output'], reason: 'redo', ...OP })
    // The PRIMARY KEY (source_event_id, field) means the row was overwritten,
    // not duplicated — one row per field per event.
    const stored = getSanitizedFields(ev.id)
    expect(Object.keys(stored)).toEqual(['output'])
    // But TWO system.sanitized events exist — each pass is auditable.
    const sanEvs = queryEvents({ agentType: 'system' }).filter((e) => e.data?.subtype === 'sanitized')
    expect(sanEvs.length).toBe(2)
  })
})
