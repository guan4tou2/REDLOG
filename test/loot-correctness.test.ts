import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Spec 031 — loot detection correctness. Before this spec:
//   - a secret seen once was dropped from every later scan, including the scan
//     that feeds redaction, so its second occurrence was stored unmasked;
//   - dedup keyed on the first 32 characters of the value, merging different
//     secrets that share a prefix, and ignored the target;
//   - the value was `m[1] || m[0]`, so the private-key rule recorded the
//     algorithm name (`RSA `) and every RSA key looked like the same key;
//   - a rule that can match the empty string never advanced;
//   - a failed loot write was swallowed after its key had been marked seen, so
//     the loot was never retried and nothing said it was missing;
//   - PTY session output (`session_output`, no `command`) was never scanned.
//
// Credential-shaped inputs are assembled at runtime (see the note in
// secret-patterns-golden.test.ts).
const cat = (...parts: string[]): string => parts.join('')
const AWS_A = cat('AK', 'IAIOSFODNN7EXAMPLE')
const AWS_B = cat('AK', 'IAI44QH8DHBEXAMPLE')
const KEY_HEADER = cat('-----BEGIN RSA PRIV', 'ATE KEY-----')

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ingestMod: typeof import('../src/core/ingest')
let loot: typeof import('../src/core/loot-detector')
let ops: typeof import('../src/core/db/operators')
let health: typeof import('../src/core/capture-health')
let dbAvailable = false
try {
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ingestMod = await import('../src/core/ingest')
  loot = await import('../src/core/loot-detector')
  ops = await import('../src/core/db/operators')
  health = await import('../src/core/capture-health')
  dbAvailable = true
} catch { /* native module unavailable */ }
const describeDB = dbAvailable ? describe : describe.skip

describe('loot matching (pure)', () => {
  it('records the whole private-key header plus its first key line, not the algorithm name', async () => {
    const { LootDetector } = await import('../src/core/loot-detector')
    const text = cat(KEY_HEADER, '\nMIIEpAIBAAKCAQEAyFirstKeyBodyLine\n')
    const [m] = new LootDetector().findMatches(text)
    expect(m.type).toBe('private_key')
    expect(m.value).not.toBe('RSA ')
    expect(m.value).toContain('MIIEpAIBAAKCAQEAyFirstKeyBodyLine')
  })

  it('reports every occurrence, so redaction can mask each one', async () => {
    const { LootDetector } = await import('../src/core/loot-detector')
    const d = new LootDetector()
    expect(d.findMatches(`key ${AWS_A}`).map((m) => m.value)).toEqual([AWS_A])
    // Same detector, same value again: still reported.
    expect(d.findMatches(`again ${AWS_A}`).map((m) => m.value)).toEqual([AWS_A])
  })

  it('uses the capture group a plugin rule names, and the whole match when it names none', async () => {
    const { LootDetector, registerLootPatterns, unregisterLootPatterns } = await import('../src/core/loot-detector')
    registerLootPatterns('spec031', [
      { type: 'cookie', pattern: 'sid=([a-z0-9]{8,})', group: 1 },
      { type: 'ticket', pattern: 'TKT-[0-9]{6}' },
      { type: 'wrapped', pattern: 'W\\(([0-9]{4})\\)' }
    ])
    try {
      const got = new LootDetector().findMatches('sid=abcd1234ef TKT-123456 W(4321)')
        .map((m) => [m.type, m.value])
      expect(got).toEqual([['cookie', 'abcd1234ef'], ['ticket', 'TKT-123456'], ['wrapped', 'W(4321)']])
    } finally { unregisterLootPatterns('spec031') }
  })

  it('does not spin on a rule that can match the empty string, and records no empty value', async () => {
    const { LootDetector, registerLootPatterns, unregisterLootPatterns } = await import('../src/core/loot-detector')
    registerLootPatterns('spec031-empty', [{ type: 'as', pattern: 'a*' }])
    try {
      const got = new LootDetector().findMatches('bbb aaa b').filter((m) => m.type === 'as').map((m) => m.value)
      expect(got).toEqual(['aaa'])
    } finally { unregisterLootPatterns('spec031-empty') }
  })
})

describeDB('loot recording', () => {
  let dir: string
  let opId: string
  const lootRows = (): Array<{ targetId?: string | null; data: Record<string, unknown> }> =>
    events.queryEvents({ limit: 500 }).filter((e) => e.agentType === 'loot')
  const shell = (data: Record<string, unknown>, targetId?: string) =>
    ingestMod.ingest({ agentType: 'shell', data, operatorId: opId, engagementId: 'eng', targetId })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-031-'))
    db.initDB(dir)
    opId = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
    const d = new loot.LootDetector()
    d.configure({ engagementId: 'eng', operatorId: opId })
    ingestMod.configureIngest({ lootDetector: d })
  })
  afterEach(() => {
    ingestMod._resetIngest()
    try { db.closeDB() } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('masks the second occurrence of a secret it has already recorded', () => {
    const first = shell({ subtype: 'command_end', command: 'cat a', stdout: `aws ${AWS_A}` }).event!
    const second = shell({ subtype: 'command_end', command: 'cat b', stdout: `again ${AWS_A}` }).event!
    for (const e of [first, second]) {
      const spans = (e.data.redactions as Array<{ field: string }> | undefined) ?? []
      expect({ id: e.id, masked: spans.some((r) => r.field === 'stdout') }).toEqual({ id: e.id, masked: true })
    }
    expect(lootRows()).toHaveLength(1)
  })

  it('keeps two different secrets that share a long prefix apart', () => {
    const prefix = 'A'.repeat(40)
    shell({ subtype: 'command_end', command: 'x', stdout: `token=${prefix}one\ntoken=${prefix}two` })
    const matches = lootRows().flatMap((r) => r.data.matches as unknown[])
    expect(matches).toHaveLength(2)
  })

  it('records the same secret once per target it was seen on', () => {
    // Distinct commands: identical consecutive shell rows are deduplicated
    // before loot ever sees them.
    shell({ subtype: 'command_end', command: 'cat one', stdout: AWS_B }, '10.0.0.1')
    shell({ subtype: 'command_end', command: 'cat two', stdout: AWS_B }, '10.0.0.1')
    shell({ subtype: 'command_end', command: 'cat three', stdout: AWS_B }, '10.0.0.2')
    expect(lootRows().map((r) => r.targetId).sort()).toEqual(['10.0.0.1', '10.0.0.2'])
  })

  it('treats two private keys with the same header as two keys', () => {
    shell({ subtype: 'command_end', command: 'cat k1', stdout: cat(KEY_HEADER, '\nMIIEpAIBAAKCAQEAfirstkey\n') })
    shell({ subtype: 'command_end', command: 'cat k2', stdout: cat(KEY_HEADER, '\nMIIEowIBAAKCAQEAsecondkey\n') })
    expect(lootRows()).toHaveLength(2)
  })

  it('scans PTY session output and links the loot to the output row', () => {
    const out = shell({ subtype: 'session_output', source: 'external-session', terminalId: 't1', stdout: `leak ${AWS_A}\r\n` }).event!
    const rows = lootRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].data._causes).toEqual([out.id])
    const spans = (out.data.redactions as Array<{ field: string }> | undefined) ?? []
    expect(spans.some((r) => r.field === 'stdout')).toBe(true)
  })

  it('finds a secret split across two PTY output chunks of one session', () => {
    const split = 10
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't2', stdout: `x ${AWS_A.slice(0, split)}` })
    expect(lootRows()).toHaveLength(0)
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't2', stdout: `${AWS_A.slice(split)} y` })
    expect(lootRows()).toHaveLength(1)
  })

  it('does not join output across sessions, or across a session end', () => {
    const split = 10
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't3', stdout: AWS_A.slice(0, split) })
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't4', stdout: AWS_A.slice(split) })
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't5', stdout: AWS_A.slice(0, split) })
    shell({ subtype: 'session_end', source: 'external-session', terminalId: 't5', exitCode: 0 })
    shell({ subtype: 'session_output', source: 'external-session', terminalId: 't5', stdout: AWS_A.slice(split) })
    expect(lootRows()).toHaveLength(0)
  })

  it('reports a failed loot write, and records it on the next sighting instead of forgetting it', () => {
    const d = new loot.LootDetector()
    d.configure({ engagementId: 'eng', operatorId: opId })
    const matches = d.findMatches(`k ${AWS_B}`)
    db.closeDB()
    expect(d.emit(matches, { targetId: 't' })).toBe(false)
    db.initDB(dir)
    expect(health.getCaptureHealth().lastDbError?.source).toBe('loot')
    expect(d.emit(matches, { targetId: 't' })).toBe(true)
    expect(lootRows()).toHaveLength(1)
  })
})
