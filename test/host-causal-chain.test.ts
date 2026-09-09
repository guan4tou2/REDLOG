import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// 10a Inspector 〈相關〉backend: hostCausalChain returns a header aggregate over
// every event touching a host, plus ONLY the curated turning-point events
// (dns resolution / command / loot / marker / violation), time-ordered, across
// both tiers. Non-turning-point rows (HTTP) count in the header but not the chain.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('hostCausalChain (10a backend)', () => {
  let tmpDir: string
  let operatorId: string
  const HOST = '10.10.11.24'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hostchain-'))
    initDB(tmpDir)
    operatorId = ops.ensurePrimaryOperator('chain-op', 'Chain Op', 'tok-' + Math.random()).id

    // Distinct, strictly-increasing wall clocks so the ORDER BY has a clean key
    // (real chains are seconds apart; a same-ms burst would tie and the per-tier
    // rowid tiebreak can't order across the two tables). Turning points for HOST
    // span both tiers: dns is logged; shell/loot/marker/system are chained.
    const base = 1_700_000_000_000
    vi.useFakeTimers()
    try {
      let t = 0
      const at = (): void => { vi.setSystemTime(base + (t += 1000)) }
      at(); events.insertEvent('dns', { subtype: 'dns_response', host: HOST, query_name: 'acme.example.com' }, { operatorId, targetId: HOST })
      at(); events.insertEvent('shell', { subtype: 'command_start', command: `nmap -sV ${HOST}`, detectedTarget: HOST }, { operatorId, targetId: HOST })
      at(); events.insertEvent('loot', { subtype: 'loot_found', loot_type: 'password_hash', detectedTarget: HOST }, { operatorId, targetId: HOST })
      at(); events.insertEvent('marker', { subtype: 'created', title: 'admin panel', severity: 'important' }, { operatorId, targetId: HOST })
      at(); events.insertEvent('system', { subtype: 'scope_violation', target: HOST, host: HOST }, { operatorId, targetId: HOST })
      // Noise for HOST: HTTP counts in the header but is NOT a turning point.
      at(); events.insertEvent('scanner', { subtype: 'http_request_start', host: HOST, method: 'GET' }, { operatorId, targetId: HOST })
      // A different host — must not appear in HOST's chain or count.
      at(); events.insertEvent('shell', { subtype: 'command_start', command: 'id', detectedTarget: 'other.test' }, { operatorId, targetId: 'other.test' })
    } finally {
      vi.useRealTimers()
    }
  })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('header counts every event touching the host, across both tiers', () => {
    const r = events.hostCausalChain(HOST)
    expect(r.eventCount).toBe(6)          // 5 turning + 1 http, all touch HOST
    expect(r.operatorCount).toBe(1)
    expect(r.firstSeen).not.toBeNull()
    expect(r.lastSeen).toBeGreaterThanOrEqual(r.firstSeen!)
  })

  it('chain is only the turning-point events, oldest-first', () => {
    const r = events.hostCausalChain(HOST)
    const types = r.chain.map((e) => e.agentType)
    expect(types).toEqual(['dns', 'shell', 'loot', 'marker', 'system']) // insertion = time order
    // HTTP (scanner) is excluded from the curated chain though it counted above.
    expect(types).not.toContain('scanner')
    for (let i = 1; i < r.chain.length; i++) {
      expect(r.chain[i].timestamp).toBeGreaterThanOrEqual(r.chain[i - 1].timestamp)
    }
  })

  it('does not bleed events from another host', () => {
    const other = events.hostCausalChain('other.test')
    expect(other.eventCount).toBe(1)
    expect(other.chain.map((e) => e.agentType)).toEqual(['shell'])
    // and HOST's chain never contains the other host's command
    const r = events.hostCausalChain(HOST)
    expect(r.chain.some((e) => (e.data as { command?: string }).command === 'id')).toBe(false)
  })

  it('empty / unknown host yields an empty result', () => {
    expect(events.hostCausalChain('').eventCount).toBe(0)
    const none = events.hostCausalChain('192.0.2.99')
    expect(none.eventCount).toBe(0)
    expect(none.chain).toEqual([])
  })
})
