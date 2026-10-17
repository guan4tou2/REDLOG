import crypto from 'node:crypto'
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
    const bundle = bundleExport.exportBundle('default', { outRoot })
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
    const bundle = bundleExport.exportBundle('default', { outRoot })

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
  for (const placement of ['middle', 'tail', 'all'] as const) {
    it(`verifies a privacy projection with omitted ${placement} rows without claiming full-chain integrity`, { timeout: 30_000 }, () => {
      ops.createOperator({ id: 'projection-op', name: 'Projection Op', token: ops.generateToken(), isPrimary: true })
      for (let i = 0; i < 3; i++) {
        const personal = placement === 'all' || i === (placement === 'middle' ? 1 : 2)
        events.insertEvent('shell', { subtype: 'command_start', command: personal ? `private-secret-${i}` : `echo public-${i}` },
          { operatorId: 'projection-op', targetId: personal ? '127.0.0.1' : '192.0.2.1' })
      }
      const bundle = bundleExport.exportBundle('default', { scope: { targets: [], personalDomains: ['127.0.0.0/8'] } })
      expect(bundle.manifest.personalDropped).toBe(placement === 'all' ? 3 : 1)
      expect(fs.readFileSync(path.join(bundle.outDir, 'events.jsonl'), 'utf8')).not.toContain('private-secret')
      const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' })
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.stdout).toContain('Projection')
      expect(r.stdout).not.toContain('Chain            : INTACT')
      expect(r.stdout).toContain(`Omitted chained  : ${placement === 'all' ? 3 : 1}`)
    })
  }

  it('verifies noncontiguous selected rows and rejects deletion, duplicates and changed payloads even after file digests are refreshed', { timeout: 30_000 }, async () => {
    ops.createOperator({ id: 'subset-op', name: 'Subset Op', token: ops.generateToken(), isPrimary: true })
    const ids = Array.from({ length: 4 }, (_, i) => events.insertEvent('shell',
      { subtype: 'command_start', command: `echo subset-${i}` }, { operatorId: 'subset-op' })!.id)
    const bundle = bundleExport.exportBundle('default', { includeEventIds: new Set([ids[1], ids[3]]) })
    const eventPath = path.join(bundle.outDir, 'events.jsonl')
    const manifestPath = path.join(bundle.outDir, 'manifest.json')
    const original = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' }).status).toBe(0)
    for (const mutation of ['delete', 'duplicate', 'payload'] as const) {
      const rows = [...original]
      if (mutation === 'delete') rows.pop()
      if (mutation === 'duplicate') rows[1] = rows[0]
      if (mutation === 'payload') {
        const row = JSON.parse(rows[0]); row.data = JSON.stringify({ subtype: 'command_start', command: 'injected' }); rows[0] = JSON.stringify(row)
      }
      const text = rows.join('\n') + '\n'
      fs.writeFileSync(eventPath, text)
      manifest.files.find((f: { path: string }) => f.path === 'events.jsonl').sha256 = crypto.createHash('sha256').update(text).digest('hex')
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      fs.writeFileSync(path.join(bundle.outDir, 'manifest.sha256'), crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'))
      const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' })
      expect(r.status, mutation).not.toBe(0)
    }
  })

  it('verifies masked projection bytes but explicitly does not verify transformed source payloads', { timeout: 30_000 }, () => {
    ops.createOperator({ id: 'masked-op', name: 'Masked Op', token: ops.generateToken(), isPrimary: true })
    events.insertEvent('shell', { subtype: 'command_start', command: 'private command', stdout: 'private output' },
      { operatorId: 'masked-op', targetId: '198.51.100.1' })
    const bundle = bundleExport.exportBundle('default', { scope: { targets: ['192.0.2.0/24'] } })
    expect(bundle.manifest.evidence.transformedEventIds).toHaveLength(1)
    const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('Transformed rows : 1 (source payload/signature not verified)')
    expect(r.stdout).not.toContain('Chain            : INTACT')
  })

  it('rejects missing projection files, unknown kinds, uncovered digests and a logged-tier count mismatch', { timeout: 30_000 }, () => {
    ops.createOperator({ id: 'invalid-op', name: 'Invalid Op', token: ops.generateToken(), isPrimary: true })
    const a = events.insertEvent('shell', { subtype: 'command_start', command: 'one' }, { operatorId: 'invalid-op' })!
    events.insertEvent('shell', { subtype: 'command_start', command: 'two' }, { operatorId: 'invalid-op' })
    const bundle = bundleExport.exportBundle('default', { includeEventIds: new Set([a.id]) })
    const manifestPath = path.join(bundle.outDir, 'manifest.json')
    const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const mutation of ['kind', 'count', 'digest'] as const) {
      const manifest = structuredClone(original)
      if (mutation === 'kind') manifest.evidence.kind = 'unknown'
      if (mutation === 'count') manifest.tiers.logged = 1
      if (mutation === 'digest') delete manifest.files.find((f: { path: string }) => f.path === 'events.jsonl').sha256
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      fs.writeFileSync(path.join(bundle.outDir, 'manifest.sha256'), crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'))
      expect(spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' }).status, mutation).not.toBe(0)
    }
    fs.writeFileSync(manifestPath, JSON.stringify(original))
    fs.writeFileSync(path.join(bundle.outDir, 'manifest.sha256'), crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'))
    fs.unlinkSync(path.join(bundle.outDir, 'operators.json'))
    expect(spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' }).status).not.toBe(0)
  })

  it('reports policy exclusions from an approved plan instead of resetting them to zero', () => {
    const a = events.insertEvent('shell', { subtype: 'command_start', command: 'public' }, { operatorId: 'op', targetId: '192.0.2.1' })!
    events.insertEvent('shell', { subtype: 'command_start', command: 'private' }, { operatorId: 'op', targetId: '127.0.0.1' })
    const bundle = bundleExport.exportBundle('default', {
      includeEventIds: new Set([a.id]),
      exportPlan: { id: 'plan', fingerprint: 'fingerprint', counts: {
        examined: 2, included: 1, excludedPersonal: 1, excludedDoNotExport: 0, 
        maskedOutOfScope: 0, sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0,
        attachmentsUnattributed: 0, attachmentsExcludedByOperator: 0, unsupported: 0
      } }
    })
    expect(bundle.manifest.personalDropped).toBe(1)
  })

  it('rejects changed projection manifest metadata even when event bytes are unchanged', { timeout: 30_000 }, () => {
    const a = events.insertEvent('shell', { subtype: 'command_start', command: 'a' }, { operatorId: 'op' })!
    events.insertEvent('shell', { subtype: 'command_start', command: 'b' }, { operatorId: 'op' })
    const bundle = bundleExport.exportBundle('default', { includeEventIds: new Set([a.id]) })
    const manifestPath = path.join(bundle.outDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.tiers.chained = 0
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const r = spawnSync(pythonBin!, [verifierPath, bundle.outDir], { encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('manifest checksum mismatch')
  })

})
