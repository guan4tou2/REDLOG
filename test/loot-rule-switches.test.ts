import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig } from '../src/core/config'

// Spec 032 — every loot rule can be switched off on its own, and the two
// noisiest built-ins (`jwt`, `generic_api_key`) ship off. Switching a rule off
// stops it being RECORDED as loot; it never stops its values being MASKED.
//
// Credential-shaped inputs are assembled at runtime (see the note in
// secret-patterns-golden.test.ts).
const cat = (...parts: string[]): string => parts.join('')
const JWT = [cat('ey', 'JhbGciOiJIUzI1NiJ9'), cat('ey', 'JzdWIiOiIxMjM0In0'), 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.')
const AWS = cat('AK', 'IAIOSFODNN7EXAMPLE')

describe('loot rule switches (pure)', () => {
  it('ships jwt and generic_api_key off, everything else on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-032-'))
    try {
      expect(loadConfig(dir).loot?.disabledRules).toEqual(['jwt', 'generic_api_key'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('lists every rule with a stable id: built-ins by type, plugin rules by plugin and name', async () => {
    const { listLootRules, registerLootPatterns, unregisterLootPatterns } = await import('../src/core/loot-detector')
    registerLootPatterns('acme-pack', [{ type: 'acme_session', pattern: 'ACME-[A-Z0-9]{16}', name: 'acme-v2' }])
    try {
      const rules = listLootRules()
      const ids = rules.map((r) => r.id)
      expect(ids).toEqual(expect.arrayContaining(['aws_key', 'jwt', 'generic_api_key', 'private_key', 'acme-pack:acme-v2']))
      expect(new Set(ids).size).toBe(ids.length)
      const plugin = rules.find((r) => r.id === 'acme-pack:acme-v2')!
      expect(plugin).toMatchObject({ type: 'acme_session', pluginId: 'acme-pack' })
      expect(rules.find((r) => r.id === 'aws_key')).toMatchObject({ type: 'aws_key', pluginId: null })
    } finally { unregisterLootPatterns('acme-pack') }
  })

  it('still finds a switched-off rule for masking, but does not report it as loot', async () => {
    const { LootDetector } = await import('../src/core/loot-detector')
    const d = new LootDetector()
    d.configure({ disabledRules: ['jwt'] })
    const text = `jwt ${JWT} and ${AWS}`
    expect(d.findMatches(text).map((m) => m.type).sort()).toEqual(['aws_key', 'jwt'])
    expect(d.scan(text).map((m) => m.type)).toEqual(['aws_key'])
  })

  it('switches a plugin rule off by its id', async () => {
    const { LootDetector, registerLootPatterns, unregisterLootPatterns } = await import('../src/core/loot-detector')
    registerLootPatterns('acme-pack', [{ type: 'acme_session', pattern: 'ACME-[A-Z0-9]{16}', name: 'acme-v2' }])
    try {
      const d = new LootDetector()
      d.configure({ disabledRules: ['acme-pack:acme-v2'] })
      expect(d.scan('ACME-ABCDEFGHIJKLMNOP')).toEqual([])
    } finally { unregisterLootPatterns('acme-pack') }
  })
})

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ingestMod: typeof import('../src/core/ingest')
let loot: typeof import('../src/core/loot-detector')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
try {
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ingestMod = await import('../src/core/ingest')
  loot = await import('../src/core/loot-detector')
  ops = await import('../src/core/db/operators')
  dbAvailable = true
} catch { /* native module unavailable */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('loot rule switches (recorded)', () => {
  let dir: string
  let opId: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-032-db-'))
    db.initDB(dir)
    opId = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
    const d = new loot.LootDetector()
    d.configure({ engagementId: 'eng', operatorId: opId, disabledRules: ['jwt'] })
    ingestMod.configureIngest({ lootDetector: d })
  })
  afterEach(() => {
    ingestMod._resetIngest()
    try { db.closeDB() } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes no loot row for a switched-off rule, and still masks its value', () => {
    const e = ingestMod.ingest({
      agentType: 'shell', operatorId: opId, engagementId: 'eng',
      data: { subtype: 'command_end', command: 'curl -v https://x', stdout: `Authorization: ${JWT}` }
    }).event!
    const lootRows = events.queryEvents({ limit: 100 }).filter((r) => r.agentType === 'loot')
    expect(lootRows).toHaveLength(0)
    const spans = (e.data.redactions as Array<{ field: string }> | undefined) ?? []
    expect(spans.some((r) => r.field === 'stdout')).toBe(true)
  })
})
