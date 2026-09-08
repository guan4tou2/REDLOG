import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Security HIGH #1: redaction must apply to EVERY export, not just the bundle.
// Pins the shared redactEventForExport: the layer-4 sanitize swap always wins,
// scope masking applies when a scope is given, and a masked body's sha256
// store pointer (_ref) is dropped so a ref-follower can't fetch the original.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getDB: typeof import('../src/core/db/index').getDB
let redactEventForExport: typeof import('../src/core/redact-export').redactEventForExport

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  insertEventRaw = eventsMod.insertEvent
  getDB = dbMod.getDB
  redactEventForExport = (await import('../src/core/redact-export')).redactEventForExport
  dbAvailable = true
} catch { /* no better-sqlite3 for this Node */ }

const insertEvent: typeof import('../src/core/db/events').insertEvent = (a, d, o) =>
  insertEventRaw(a, d, { operatorId: 'test-op', ...o })
const describeDB = dbAvailable ? describe : describe.skip
let tmpDir: string

describeDB('redactEventForExport', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-redact-')); initDB(tmpDir) })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('applies the layer-4 sanitize swap regardless of scope', () => {
    const e = insertEvent('shell', { command: 'aws', output: 'creds AKIAIOSFODNN7EXAMPLE end' })!
    // A sanitized_events row is what the operator's redaction writes; the export
    // redactor must swap it in. Write it directly (the span detector is a
    // separate concern, covered elsewhere).
    getDB().prepare(
      `INSERT INTO sanitized_events (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(e.id, 'output', 'creds \u2039REDACTED\u203a end', 'sha', Date.now(), 'san-1')
    const out = redactEventForExport(e)  // no scope
    expect(String(out.data.output)).not.toContain('AKIAIOSFODNN7EXAMPLE') // secret gone from export
    expect(out).not.toBe(e)                                                // a new object
    expect(String(e.data.output)).toContain('AKIAIOSFODNN7EXAMPLE')        // source row untouched
  })

  it('leaves an un-sanitized event untouched (returns the same object)', () => {
    const e = insertEvent('shell', { command: 'whoami', output: 'root' })!
    expect(redactEventForExport(e)).toBe(e)
  })

  it('masks out-of-scope bodies when a scope is given, and drops the body ref', () => {
    const e = insertEvent('scanner', {
      subtype: 'http_response', host: 'evil.example',
      response_body: 'secret-body', response_body_ref: { sha256: 'abc', size: 9, file: 'x', encoding: 'text' }
    }, { targetId: 'evil.example' })!
    const out = redactEventForExport(e, { targets: ['good.example'] })  // evil is out of scope
    expect(out.data.response_body).not.toBe('secret-body') // masked
    expect(out.data.response_body_ref).toBeUndefined()      // ref dropped so readBody can't fetch original
  })

  it('keeps in-scope events intact under a scope', () => {
    const e = insertEvent('scanner', { subtype: 'http_response', host: 'good.example', response_body: 'ok' }, { targetId: 'good.example' })!
    expect(redactEventForExport(e, { targets: ['good.example'] }).data.response_body).toBe('ok')
  })
})
