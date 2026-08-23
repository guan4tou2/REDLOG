import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let queryEvents: typeof import('../src/core/db/events').queryEvents
let getEventCount: typeof import('../src/core/db/events').getEventCount
let searchEvents: typeof import('../src/core/db/events').searchEvents
let queryScopeFilteredEvents: typeof import('../src/core/db/events').queryScopeFilteredEvents

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = eventsMod.insertEvent
  queryEvents = eventsMod.queryEvents
  getEventCount = eventsMod.getEventCount
  searchEvents = eventsMod.searchEvents
  queryScopeFilteredEvents = eventsMod.queryScopeFilteredEvents
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

let tmpDir: string

describeDB('insertEvent', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('inserts and returns an event', () => {
    const event = insertEvent('shell', { command: 'whoami' })
    expect(event).not.toBeNull()
    expect(event!.agentType).toBe('shell')
    expect(event!.data.command).toBe('whoami')
    expect(event!.hash).toBeTruthy()
  })

  it('assigns default engagement when not provided', () => {
    const event = insertEvent('marker', { title: 'test' })!
    expect(event.engagementId).toBe('default')
    expect(event.operatorId).toBe('test-op')
  })

  it('throws if operatorId is missing (no silent fallback)', () => {
    expect(() => insertEventRaw('marker', { title: 'x' })).toThrow(/operatorId is required/)
    expect(() => insertEventRaw('marker', { title: 'x' }, { engagementId: 'e' } as unknown as { operatorId: string })).toThrow(/operatorId is required/)
  })

  it('uses provided engagement and operator', () => {
    const event = insertEvent('marker', { title: 'test' }, {
      engagementId: 'eng-1', operatorId: 'op-2'
    })!
    expect(event.engagementId).toBe('eng-1')
    expect(event.operatorId).toBe('op-2')
  })
})

describeDB('shell dedup', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deduplicates shell events with same command + same subtype within 2 seconds', () => {
    const first = insertEvent('shell', { command: 'ls -la', subtype: 'command_start' })
    expect(first).not.toBeNull()
    const second = insertEvent('shell', { command: 'ls -la', subtype: 'command_start' })
    expect(second).toBeNull()
  })

  it('does NOT drop command_end when command_start with same command was just inserted (v0.6.85 regression)', () => {
    // Regression: prior dedup used data LIKE '%"command":"..."%' which matched
    // across subtypes — a fast command's command_end was silently dropped,
    // breaking timeline pair-collapse and replay.
    const start = insertEvent('shell', { command: 'ls -la', subtype: 'command_start' })
    const end = insertEvent('shell', { command: 'ls -la', subtype: 'command_end', exit_code: 0 })
    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
  })

  it('same subtype+command on different terminal_id is not deduped', () => {
    const a = insertEvent('shell', { command: 'ls', subtype: 'command_start', terminal_id: 't1' })
    const b = insertEvent('shell', { command: 'ls', subtype: 'command_start', terminal_id: 't2' })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  it('allows different commands', () => {
    const first = insertEvent('shell', { command: 'ls' })
    const second = insertEvent('shell', { command: 'pwd' })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
  })

  it('does not dedup non-shell events', () => {
    const first = insertEvent('marker', { title: 'a' })
    const second = insertEvent('marker', { title: 'a' })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
  })

  it('cross-source dedup: shell command_start followed by agent command_start with same terminal_id is dropped (v0.6.86)', () => {
    const shell = insertEvent('shell', { command: 'ls', subtype: 'command_start', terminal_id: 't1', pid: 1234 })
    const agent = insertEvent('agent', { command: 'ls', subtype: 'command_start', terminal_id: 't1', pid: 1234 })
    expect(shell).not.toBeNull()
    expect(agent).toBeNull()
  })

  it('cross-source dedup: matches on pid when terminal_id absent', () => {
    const shell = insertEvent('shell', { command: 'whoami', subtype: 'command_start', pid: 7777 })
    const agent = insertEvent('agent', { command: 'whoami', subtype: 'command_start', pid: 7777 })
    expect(shell).not.toBeNull()
    expect(agent).toBeNull()
  })

  it('cross-source dedup: DOES NOT drop unrelated agents with same command but different pid/terminal', () => {
    const a = insertEvent('shell', { command: 'ls', subtype: 'command_start', pid: 1 })
    const b = insertEvent('agent', { command: 'ls', subtype: 'command_start', pid: 2 })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })
})

describeDB('monotonic_ns padding', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stores monotonic_ns with boot-epoch prefix + padded ns (v0.6.88 P3-A)', () => {
    const e = insertEvent('marker', { title: 'a' })!
    expect(e.monotonicNs).toBeTruthy()
    // `${bootMsPad14}-${nsPad20}` = 14 + 1 + 20 = 35 chars.
    expect(e.monotonicNs!.length).toBe(35)
    expect(e.monotonicNs).toMatch(/^\d{14}-\d{20}$/)
    // The strip-prefix half is still BigInt-parseable — required for the
    // Timeline sort comparator + clock-anomaly detector.
    const nsPart = e.monotonicNs!.split('-')[1]
    expect(() => BigInt(nsPart)).not.toThrow()
  })
})

describeDB('queryEvents excludeHousekeeping', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('filters system.api_started + shell.session_start + hook-source command_start', () => {
    insertEvent('system', { subtype: 'api_started', port: 8420 })
    insertEvent('shell', { subtype: 'session_start', terminalId: 't1' })
    insertEvent('shell', { subtype: 'command_start', command: 'source ~/.redlog/shell-preexec-hook.sh' })
    insertEvent('marker', { title: 'real user event' })
    insertEvent('shell', { command: 'ls', subtype: 'command_start' })

    const all = queryEvents({ limit: 100 })
    expect(all.length).toBe(5)
    const clean = queryEvents({ limit: 100, excludeHousekeeping: true })
    // Only the marker + the real `ls` should survive.
    expect(clean.length).toBe(2)
    const kinds = clean.map((e) => `${e.agentType}.${e.data?.subtype ?? ''}`).sort()
    expect(kinds).toEqual(['marker.', 'shell.command_start'])
  })
})

describeDB('evidence chain', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('first event has null prevHash', () => {
    const event = insertEvent('marker', { title: 'first' })!
    expect(event.prevHash).toBeNull()
  })

  it('second event links to first via prevHash', () => {
    const first = insertEvent('marker', { title: 'first' })!
    const second = insertEvent('marker', { title: 'second' })!
    expect(second.prevHash).toBe(first.hash)
  })

  it('chain of 3 events has correct linkage', () => {
    const e1 = insertEvent('marker', { title: '1' })!
    const e2 = insertEvent('marker', { title: '2' })!
    const e3 = insertEvent('marker', { title: '3' })!
    expect(e1.prevHash).toBeNull()
    expect(e2.prevHash).toBe(e1.hash)
    expect(e3.prevHash).toBe(e2.hash)
  })

  it('each event has a unique hash', () => {
    const e1 = insertEvent('marker', { title: '1' })!
    const e2 = insertEvent('marker', { title: '2' })!
    expect(e1.hash).not.toBe(e2.hash)
  })
})

describeDB('queryEvents', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('filters by agentType', () => {
    insertEvent('shell', { command: 'whoami' })
    insertEvent('marker', { title: 'test' })
    const shells = queryEvents({ agentType: 'shell' })
    expect(shells.length).toBe(1)
  })

  it('filters by targetId', () => {
    insertEvent('shell', { command: 'nmap' }, { targetId: '10.0.0.1' })
    insertEvent('shell', { command: 'whoami' })
    const targeted = queryEvents({ targetId: '10.0.0.1' })
    expect(targeted.length).toBe(1)
  })
})

describeDB('getEventCount', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 0 for empty DB', () => {
    expect(getEventCount()).toBe(0)
  })

  it('counts inserted events', () => {
    insertEvent('marker', { title: 'a' })
    insertEvent('marker', { title: 'b' })
    expect(getEventCount()).toBe(2)
  })
})

describeDB('searchEvents', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds events by data content', () => {
    insertEvent('shell', { command: 'nmap 192.168.1.1' })
    insertEvent('shell', { command: 'whoami' })
    const results = searchEvents('nmap')
    expect(results.length).toBe(1)
  })
})

describeDB('queryScopeFilteredEvents', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes marker events without targetId (whitelist)', () => {
    insertEvent('marker', { title: 'found something' })
    const filtered = queryScopeFilteredEvents(['10.0.0.1'])
    expect(filtered.length).toBe(1)
  })

  it('excludes clipboard events without targetId', () => {
    insertEvent('clipboard', { text: 'password123' })
    const filtered = queryScopeFilteredEvents(['10.0.0.1'])
    expect(filtered.length).toBe(0)
  })

  it('excludes system events without targetId', () => {
    insertEvent('system', { subtype: 'session_start' })
    const filtered = queryScopeFilteredEvents(['10.0.0.1'])
    expect(filtered.length).toBe(0)
  })

  it('matches wildcard domain scope', () => {
    insertEvent('shell', { command: 'curl' }, { targetId: 'api.example.com' })
    insertEvent('shell', { command: 'curl' }, { targetId: 'other.net' })
    const filtered = queryScopeFilteredEvents(['*.example.com'])
    expect(filtered.length).toBe(1)
  })
})
