import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { operatorPiiReplacements } from '../src/core/operator-pii'

// The operator-PII scrub is pure given explicit identifiers — test it without a
// DB so it's deterministic regardless of the machine the suite runs on.
describe('ndjson-export — operator PII scrub', () => {
  const apply = (line: string, ids: { home?: string; user?: string; host?: string }): string => {
    let out = line
    for (const [re, rep] of operatorPiiReplacements(ids)) out = out.replace(re, rep)
    return out
  }

  it('replaces home path, hostname, and username', () => {
    const line = JSON.stringify({ cmd: 'cat /Users/alice/eng/creds', host: 'alice-mbp', who: 'alice' })
    const scrubbed = apply(line, { home: '/Users/alice', user: 'alice', host: 'alice-mbp' })
    expect(scrubbed).toContain('<home>/eng/creds')
    expect(scrubbed).toContain('<host>')
    expect(scrubbed).not.toContain('/Users/alice')
    expect(scrubbed).not.toContain('alice-mbp')
  })

  it('guards the username with word boundaries + length floor', () => {
    // a 2-char user is not scrubbed (too collision-prone); a normal one is
    expect(apply('malice and alice', { user: 'al' })).toBe('malice and alice')
    expect(apply('alice ran', { user: 'alice' })).toBe('<user> ran')
    expect(apply('malicious', { user: 'ali' })).toBe('malicious') // no word boundary → untouched
  })

  it('handles Windows backslash home paths as they appear inside JSON', () => {
    const jsonLine = JSON.stringify({ p: 'C:\\Users\\bob\\loot' })
    const scrubbed = apply(jsonLine, { home: 'C:\\Users\\bob' })
    expect(scrubbed).toContain('<home>')
    expect(scrubbed).not.toContain('Users\\\\bob')
  })
})

// Structural test against a real DB — one line per event, ISO @timestamp,
// chain columns preserved.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ndjson: typeof import('../src/core/ndjson-export')
let redact: typeof import('../src/core/redact-export')
let dbIndex: typeof import('../src/core/db/index')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ndjson = await import('../src/core/ndjson-export')
  redact = await import('../src/core/redact-export')
  dbIndex = dbMod
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled for this runtime */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('ndjson-export — eventsToNdjson', () => {
  let tmpDir: string
  let operatorId: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ndjson-'))
    initDB(tmpDir)
    operatorId = ops.ensurePrimaryOperator('ndjson-op', 'NDJSON Op', 'tok-' + Math.random()).id
  })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('emits one parseable JSON line per event with an ISO @timestamp', () => {
    events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'x.test' }, { operatorId })
    const all = events.queryEvents({ limit: 100 })
    const out = ndjson.eventsToNdjson(all)
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(all.length)
    for (const l of lines) {
      const obj = JSON.parse(l)
      expect(obj['@timestamp']).toBe(new Date(obj.timestamp).toISOString())
      expect(typeof obj.id).toBe('string')
    }
    // A chained row keeps its hash so integrity survives ingestion.
    const chained = JSON.parse(lines.find((l) => JSON.parse(l).agentType === 'shell')!)
    expect(typeof chained.hash).toBe('string')
  })

  // Export redacts once, verifies that result against the plan, then writes
  // those same rows (data-export.ts passes alreadyRedacted). The bytes must be
  // exactly what the writer produced when it redacted for itself.
  it('writes already-redacted rows byte-for-byte as it would redact them itself', () => {
    const plain = events.insertEvent('shell', { subtype: 'command_end', command: 'ls', stdout: 'ok' }, { operatorId })!
    const secret = events.insertEvent('shell', { subtype: 'command_end', command: 'cat k', stdout: 'AKIA-SECRET', stdout_ref: 'sha256:abc', output_body: 'AKIA-SECRET' }, { operatorId })!
    const masked = events.insertEvent('scanner', { subtype: 'http_request_start', url: 'https://other.test/', request_body: 'payload', request_body_ref: 'sha256:def' }, { operatorId, targetId: 'other.test' })!
    dbIndex.getDB().prepare(
      `INSERT INTO sanitized_events (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id)
       VALUES (?, 'stdout', '[redacted]', 'x', 1, ?)`
    ).run(secret.id, plain.id)
    const scope = { targets: ['in-scope.test'] }
    const all = events.queryEvents({ limit: -1 })
    for (const opts of [{}, { scope }]) {
      const own = ndjson.eventsToNdjson(all, opts)
      const pre = ndjson.eventsToNdjson(redact.redactEventsForExport(all, opts), { ...opts, alreadyRedacted: true })
      expect(pre).toBe(own)
    }
    // The fixture really exercised both kinds of redaction.
    const swapped = ndjson.eventsToNdjson(all)
    expect(swapped).toContain('"stdout":"[redacted]"')
    expect(swapped).not.toContain('AKIA-SECRET')
    const scoped = ndjson.eventsToNdjson(all, { scope })
    const maskedRow = JSON.parse(scoped.split('\n').find((l) => l.includes(masked.id))!)
    expect(maskedRow.data.request_body).toMatch(/^\[redacted: out of scope/)
    expect(maskedRow.data.request_body_ref).toBeUndefined()
  })

  it('empty input yields an empty string (no stray newline)', () => {
    expect(ndjson.eventsToNdjson([])).toBe('')
  })
})
