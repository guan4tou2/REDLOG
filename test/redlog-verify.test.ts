import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

// End-to-end test for tools/redlog-verify.py: export a real bundle via
// src/core/bundle-export.ts, then invoke the standalone Python verifier
// against it and assert it returns 0 (chain intact).
//
// Skips when:
//   - better-sqlite3 isn't compiled for this Node.js version (dbAvailable=false)
//   - python3 isn't on PATH (pythonAvailable=false)

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let bundleExport: typeof import('../src/core/bundle-export')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  bundleExport = await import('../src/core/bundle-export')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

// Prefer python3, fall back to python (Windows).
function findPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf-8' })
    if (r.status === 0) return candidate
  }
  return null
}
const pythonBin = findPython()
if (!pythonBin) {
  // eslint-disable-next-line no-console
  console.warn('[redlog-verify.test] python3 not found on PATH — skipping verifier E2E test')
}

const describeVerify = (dbAvailable && pythonBin) ? describe : describe.skip

describeVerify('tools/redlog-verify.py against real bundle', () => {
  let tmpDir: string
  let keysDir: string
  let prevKeysEnv: string | undefined
  const verifierPath = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-verify-test-'))
    // Isolate operator signing keys from the developer's real ~/.redlog/keys
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-verify-keys-'))
    prevKeysEnv = process.env.REDLOG_KEYS_DIR
    process.env.REDLOG_KEYS_DIR = keysDir
    initDB(tmpDir)
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(keysDir, { recursive: true, force: true })
    if (prevKeysEnv === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeysEnv
  })

  // 30s timeout: Windows CI takes ~5-8s just to cold-spawn python3 the first
  // time (interpreter warmup + PATH resolution + antivirus scan), so the
  // default 5s ceiling races. macOS/Linux finish in <1s.
  it('validates an intact chain and exits 0', { timeout: 30_000 }, () => {
    // Real operator with a keypair — events land signed under the v0.6.88
    // canonical shape.
    const token = ops.generateToken()
    ops.createOperator({ id: 'verify-op', name: 'Verify Op', token, isPrimary: true })

    // Populate a small chain (5 events).
    for (let i = 0; i < 5; i++) {
      const ev = events.insertEvent('shell',
        { subtype: 'command_start', command: `echo hello-${i}` },
        { operatorId: 'verify-op' })
      expect(ev).not.toBeNull()
    }

    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-verify-out-'))
    const bundle = bundleExport.exportBundle('default', outRoot)
    expect(fs.existsSync(path.join(bundle.outDir, 'events.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(bundle.outDir, 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(bundle.outDir, 'operators.json'))).toBe(true)

    // operators.json must carry signerPubKey now — the verifier needs it to
    // check signatures (when cryptography is installed).
    const opsExport = JSON.parse(
      fs.readFileSync(path.join(bundle.outDir, 'operators.json'), 'utf-8')
    ) as Array<{ id: string; signerPubKey: string | null }>
    const verifyOp = opsExport.find((o) => o.id === 'verify-op')
    expect(verifyOp).toBeTruthy()
    expect(verifyOp!.signerPubKey).toMatch(/^[A-Za-z0-9+/=]+$/)

    // Run the verifier — it must exit 0.
    const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf-8' })
    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('verifier stdout:', r.stdout)
      // eslint-disable-next-line no-console
      console.error('verifier stderr:', r.stderr)
    }
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Chain            : INTACT')

    fs.rmSync(outRoot, { recursive: true, force: true })
  })

  it('detects a tampered event and exits non-zero', { timeout: 30_000 }, () => {
    const token = ops.generateToken()
    ops.createOperator({ id: 'verify-op-t', name: 'Verify Op T', token, isPrimary: true })

    for (let i = 0; i < 3; i++) {
      events.insertEvent('shell',
        { subtype: 'command_start', command: `whoami-${i}` },
        { operatorId: 'verify-op-t' })
    }

    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-verify-out-t-'))
    const bundle = bundleExport.exportBundle('default', outRoot)

    // Tamper: rewrite the middle event's data field to something else.
    const eventsPath = path.join(bundle.outDir, 'events.jsonl')
    const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)
    expect(lines.length).toBe(3)
    const mid = JSON.parse(lines[1])
    const midData = JSON.parse(mid.data)
    midData.command = 'evil-injected'
    mid.data = JSON.stringify(midData)
    lines[1] = JSON.stringify(mid)
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n')

    const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf-8' })
    expect(r.status).not.toBe(0)
    // Verifier prints the reason to stderr.
    expect(r.stderr).toMatch(/CHAIN BROKEN|SIGNATURE INVALID/)

    fs.rmSync(outRoot, { recursive: true, force: true })
  })
})
