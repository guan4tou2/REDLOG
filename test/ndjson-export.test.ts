import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { operatorPiiReplacements } from '../src/core/ndjson-export'

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
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ndjson = await import('../src/core/ndjson-export')
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

  it('empty input yields an empty string (no stray newline)', () => {
    expect(ndjson.eventsToNdjson([])).toBe('')
  })
})
