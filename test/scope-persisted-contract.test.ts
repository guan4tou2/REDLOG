// Spec 069 FR-010 / D1=A. The user-facing words changed from "violation" to
// "observation", but a handful of names are PERSISTED or PUBLIC and must not
// move with them: they sit inside the hash chain, in config.yaml, and in the
// API that scripts and the blue-team hand-off read. This file pins them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SCOPE_VIOLATION_SUBTYPE } from '../src/core/scope-vocabulary'
import { loadConfig, DEFAULT_CONFIG } from '../src/core/config'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let anchor: typeof import('../src/core/chain-anchor')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  anchor = await import('../src/core/chain-anchor')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB; insertEvent = evMod.insertEvent
  dbAvailable = true
} catch { /* better-sqlite3 not compiled for this Node ABI */ }

describe('persisted scope vocabulary', () => {
  it('keeps the stored event subtype exactly as old projects and bundles carry it', () => {
    expect(SCOPE_VIOLATION_SUBTYPE).toBe('scope_violation')
  })

  it('still reads a config.yaml written with the old warnOnViolation key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-'))
    try {
      fs.writeFileSync(path.join(dir, 'config.yaml'), 'scope:\n  warnOnViolation: false\n', 'utf-8')
      expect(loadConfig(dir).scope.warnOnViolation).toBe(false)
      expect(DEFAULT_CONFIG.scope.warnOnViolation).toBe(true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe.skipIf(!dbAvailable)('a chain holding scope_violation events', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-chain-')); initDB(dir) })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('still verifies, so the old subtype was never rewritten', async () => {
    insertEvent('system', { subtype: SCOPE_VIOLATION_SUBTYPE, target: '10.9.9.9', distance: 'out_of_scope' }, { operatorId: 'op' })
    insertEvent('shell', { command: 'id' }, { operatorId: 'op' })
    const r = await anchor.verifyChainFullAsync()
    expect(r.ok).toBe(true)
    expect(r.brokenAtEventId).toBeNull()
  })
})
