import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// The HUD's active-pivot list, read back from the record. A foreground tunnel
// that exits must leave the list and stay off it however much the operator
// types afterwards; a pivot opened again after that must come back. DB-backed,
// so it rides the native-module guard.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let ingestMod: typeof import('../src/core/ingest')
let ops: typeof import('../src/core/db/operators')
let pivots: typeof import('../src/main/active-pivots')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  ingestMod = await import('../src/core/ingest')
  ops = await import('../src/core/db/operators')
  pivots = await import('../src/main/active-pivots')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('readActivePivots', () => {
  let tmpDir: string
  const base = { operatorId: '', engagementId: 'eng-1' }
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pivots-'))
    initDB(tmpDir)
    base.operatorId = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
  })
  afterAll(() => {
    try { closeDB() } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  })
  afterEach(() => ingestMod._resetIngest())

  const shell = (subtype: string, command: string, terminal: string, extra: Record<string, unknown> = {}): void => {
    ingestMod.ingest({ ...base, agentType: 'shell', data: { subtype, command, terminal_id: terminal, ...extra } })
  }
  const vias = (): string[] => pivots.readActivePivots().map(p => p.via)

  it('keeps a closed foreground tunnel closed after many more commands', () => {
    const tunnel = 'ssh -D 1080 user@10.0.0.9'
    shell('command_start', tunnel, 't1')
    expect(vias()).toContain('10.0.0.9')
    shell('command_end', tunnel, 't1', { duration_sec: 30, exit_code: 0 })
    expect(vias()).not.toContain('10.0.0.9')
    // Each command is a start and an end: 61 of them push the close past the
    // last 120 shell rows, which is where it used to be looked for.
    for (let i = 0; i < 61; i++) {
      shell('command_start', `echo ${i}`, 't1')
      shell('command_end', `echo ${i}`, 't1', { duration_sec: 0, exit_code: 0 })
    }
    expect(vias()).not.toContain('10.0.0.9')
  })

  it('shows a tunnel opened again after it was closed', () => {
    const tunnel = 'ssh -D 1081 user@10.0.0.10'
    shell('command_start', tunnel, 't2')
    shell('command_end', tunnel, 't2', { duration_sec: 30, exit_code: 0 })
    expect(vias()).not.toContain('10.0.0.10')
    shell('command_start', tunnel, 't3')
    expect(vias()).toContain('10.0.0.10')
  })

  it('keeps a backgrounded tunnel whose command ended at once', () => {
    const tunnel = 'ssh -fN -D 1082 user@10.0.0.11'
    shell('command_start', tunnel, 't4')
    shell('command_end', tunnel, 't4', { duration_sec: 0, exit_code: 0 })
    expect(vias()).toContain('10.0.0.11')
  })
})
