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

let bindDBEngagement: typeof import('../src/core/db/index').bindDBEngagement
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
  initDB = dbMod.initDB; bindDBEngagement = dbMod.bindDBEngagement
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

// Ed25519 checks need the optional `cryptography` package. The verifier fails
// closed without it when signing is in use, so signed fixtures behave
// differently on machines with and without it. Detect once, with the same
// interpreter the tests spawn.
const hasCryptography = pythonBin
  ? spawnSync(pythonBin, ['-c', 'import cryptography.hazmat.primitives.asymmetric.ed25519'], { encoding: 'utf-8' }).status === 0
  : false

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
    initDB(tmpDir); bindDBEngagement('default')
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

    // With `cryptography` the signatures are checked and the chain is INTACT.
    // Without it that test is about the hash chain only: --hash-only must still
    // exit 0 and say plainly that nothing was authenticated.
    const r = spawnSync(pythonBin!, [verifierPath, ...(hasCryptography ? [] : ['--hash-only']), bundle.outDir], { encoding: 'utf-8' })
    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('verifier stdout:', r.stdout)
      // eslint-disable-next-line no-console
      console.error('verifier stderr:', r.stderr)
    }
    expect(r.status).toBe(0)
    if (hasCryptography) expect(r.stdout).toContain('Chain            : INTACT')
    else {
      expect(r.stdout).toContain('Chain            : hash chain consistent, NOT AUTHENTICATED')
      expect(r.stdout).not.toContain('Chain            : INTACT')
    }

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
    expect(lines.length).toBe(4) // three rows and the export's seal
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
      // About the projection boundary, not signatures: --hash-only keeps it independent of `cryptography`.
      const r = spawnSync(pythonBin!, [verifierPath, '--hash-only', bundle.outDir], { encoding: 'utf8' })
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
    // Chain/projection test: --hash-only so a missing `cryptography` cannot be the reason for either verdict.
    expect(spawnSync(pythonBin!, [verifierPath, '--hash-only', bundle.outDir], { encoding: 'utf8' }).status).toBe(0)
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
      const r = spawnSync(pythonBin!, [verifierPath, '--hash-only', bundle.outDir], { encoding: 'utf8' })
      expect(r.status, mutation).not.toBe(0)
    }
  })

  it('verifies masked projection bytes but explicitly does not verify transformed source payloads', { timeout: 30_000 }, () => {
    ops.createOperator({ id: 'masked-op', name: 'Masked Op', token: ops.generateToken(), isPrimary: true })
    events.insertEvent('shell', { subtype: 'command_start', command: 'private command', stdout: 'private output' },
      { operatorId: 'masked-op', targetId: '198.51.100.1' })
    const bundle = bundleExport.exportBundle('default', { scope: { targets: ['192.0.2.0/24'] } })
    expect(bundle.manifest.evidence.transformedEventIds).toHaveLength(1)
    const r = spawnSync(pythonBin!, [verifierPath, '--hash-only', bundle.outDir], { encoding: 'utf8' })
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


  // Authentication. Hashes can be recomputed by anyone holding the bundle, so
  // a bundle whose events were rewritten, re-hashed and stripped of signatures
  // used to verify as "Chain: INTACT". These pin the rules that stop that.
  describe('authentication of the chain', () => {
    const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')

    /** Re-hash the files a tampering recipient would also have to refresh. */
    function refresh(dir: string): void {
      const manifestPath = path.join(dir, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      for (const f of manifest.files as Array<{ path: string; sha256?: string }>) {
        if (f.path === 'events.jsonl' || f.path === 'operators.json') f.sha256 = sha(fs.readFileSync(path.join(dir, f.path)))
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha(fs.readFileSync(manifestPath)))
    }
    function rewriteEvents(dir: string, edit: (row: Record<string, unknown>, i: number) => void): void {
      const p = path.join(dir, 'events.jsonl')
      const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      rows.forEach(edit)
      fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }
    const run = (dir: string, ...flags: string[]) => spawnSync(pythonBin!, [verifierPath, ...flags, dir], { encoding: 'utf8' })

    function signedBundle(opId: string, n = 3): string {
      ops.createOperator({ id: opId, name: opId, token: ops.generateToken(), isPrimary: true })
      for (let i = 0; i < n; i++) events.insertEvent('shell', { subtype: 'command_start', command: `echo ${i}` }, { operatorId: opId })
      return bundleExport.exportBundle('default', { outRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-auth-')) }).outDir
    }

    it('passes an untouched signed bundle and prints each signer key fingerprint', { timeout: 30_000 }, () => {
      const dir = signedBundle('auth-ok')
      const r = run(dir)
      if (!hasCryptography) {
        // Fail closed: signatures cannot be checked, so the bundle must not pass.
        expect(r.status, r.stdout + r.stderr).toBe(1)
        expect(r.stdout).toMatch(/AUTHENTICATION FAILED: 4 signed event\(s\) cannot be checked: the `cryptography` module is not installed/)
        expect(r.stdout).not.toContain('Chain            : INTACT')
        return
      }
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain('Chain            : INTACT')
      const pub = (JSON.parse(fs.readFileSync(path.join(dir, 'operators.json'), 'utf8')) as Array<{ id: string; signerPubKey: string }>)
        .find((o) => o.id === 'auth-ok')!.signerPubKey
      expect(r.stdout).toContain(`Signer           : auth-ok  sha256:${sha(Buffer.from(pub, 'base64'))}`)
    })

    it('fails a bundle re-hashed with its signatures stripped, operators.json still listing the key', { timeout: 30_000 }, () => {
      const dir = signedBundle('auth-strip')
      rewriteEvents(dir, (row) => { delete row.signature; row.signature = null })
      refresh(dir)
      const r = run(dir)
      expect(r.status, r.stdout).toBe(1)
      // Three rows and the export's seal, all stripped.
      expect(r.stdout).toMatch(/AUTHENTICATION FAILED: 4 event\(s\) carry no signature/)
      expect(r.stdout).not.toContain('Chain            : INTACT')
      // --hash-only accepts the missing signatures, but not that the rows and
      // manifest are no longer the ones the export sealed (v4).
      const relaxed = run(dir, '--hash-only')
      expect(relaxed.status, relaxed.stdout).toBe(5)
      expect(relaxed.stdout).toContain('NOT AUTHENTICATED (--hash-only): 4 event(s) carry no signature')
      expect(relaxed.stdout).toContain('SEAL MISMATCH')
      expect(relaxed.stdout).not.toContain('Chain            : INTACT')
    })

    it('does not call a bundle INTACT when signatures AND signer keys were both stripped', { timeout: 30_000 }, () => {
      const dir = signedBundle('auth-strip-all')
      rewriteEvents(dir, (row) => { row.signature = null })
      const opsPath = path.join(dir, 'operators.json')
      fs.writeFileSync(opsPath, JSON.stringify((JSON.parse(fs.readFileSync(opsPath, 'utf8')) as Array<Record<string, unknown>>).map((o) => ({ ...o, signerPubKey: null }))))
      refresh(dir)
      const r = run(dir)
      // Not authenticated, and (v4) no longer what the export sealed.
      expect(r.status, r.stdout).toBe(5)
      expect(r.stdout).toContain('hash chain consistent, NOT AUTHENTICATED')
      expect(r.stdout).not.toContain('Chain            : INTACT')
    })

    it('fails a signed bundle that contains one unsigned event', { timeout: 30_000 }, () => {
      ops.createOperator({ id: 'auth-mixed', name: 'm', token: ops.generateToken(), isPrimary: true })
      events.insertEvent('shell', { subtype: 'command_start', command: 'a' }, { operatorId: 'auth-mixed' })
      // No key exists for this id, so the row is written unsigned.
      const unsignedRow = events.insertEvent('shell', { subtype: 'command_start', command: 'b' }, { operatorId: 'auth-nokey' })!
      events.insertEvent('shell', { subtype: 'command_start', command: 'c' }, { operatorId: 'auth-mixed' })
      const dir = bundleExport.exportBundle('default', { outRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-auth-')) }).outDir
      const r = run(dir)
      expect(r.status, r.stdout).toBe(1)
      expect(r.stdout).toMatch(/AUTHENTICATION FAILED: 1 event\(s\) carry no signature/)
      expect(r.stdout).toContain(`first: ${unsignedRow.id}`)
      expect(r.stdout).toContain('This is not a bad signature')
      expect(r.stdout).toContain('--hash-only reports the chain without authentication')
      expect(r.stdout).not.toContain('SIGNATURE INVALID')
    })

    it('fails when a signed event\'s operator has no public key in operators.json', { timeout: 30_000 }, () => {
      const dir = signedBundle('auth-nopub')
      fs.writeFileSync(path.join(dir, 'operators.json'), JSON.stringify([{ id: 'someone-else', signerPubKey: 'AAAA' }]))
      refresh(dir)
      const r = run(dir)
      expect(r.status, r.stdout).toBe(1)
      // Without `cryptography` the verifier reports the missing module, not the missing key.
      expect(r.stdout).toMatch(hasCryptography
        ? /AUTHENTICATION FAILED: 4 signed event\(s\) cannot be checked: their operator has no signerPubKey/
        : /AUTHENTICATION FAILED: 4 signed event\(s\) cannot be checked: the `cryptography` module is not installed/)
    })

    it('fails, rather than skips, when `cryptography` is missing from a signed bundle', { timeout: 30_000 }, () => {
      const dir = signedBundle('auth-nodep')
      const code = `import sys, runpy; sys.modules['cryptography'] = None; sys.argv = ['v', ${JSON.stringify(dir)}]; runpy.run_path(${JSON.stringify(verifierPath)}, run_name='__main__')`
      const r = spawnSync(pythonBin!, ['-c', code], { encoding: 'utf8' })
      expect(r.status, r.stdout + r.stderr).toBe(1)
      expect(r.stdout).toMatch(/AUTHENTICATION FAILED: 4 signed event\(s\) cannot be checked: the `cryptography` module is not installed/)
    })

    it('a bundle with nothing signed fails by default and passes with --hash-only, with the distinct verdict', { timeout: 30_000 }, () => {
      for (let i = 0; i < 3; i++) events.insertEvent('shell', { subtype: 'command_start', command: `echo ${i}` }, { operatorId: 'plain-op' })
      const dir = bundleExport.exportBundle('default', { outRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-auth-')) }).outDir
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'operators.json'), 'utf8'))).toEqual([])
      const strict = run(dir)
      expect(strict.status, strict.stdout + strict.stderr).toBe(3)
      expect(strict.stdout).toContain('Chain            : hash chain consistent, NOT AUTHENTICATED')
      expect(strict.stdout).not.toContain('Chain            : INTACT')
      const relaxed = run(dir, '--hash-only')
      expect(relaxed.status, relaxed.stdout + relaxed.stderr).toBe(0)
      expect(relaxed.stdout).toContain('Chain            : hash chain consistent, NOT AUTHENTICATED')
      expect(relaxed.stdout).not.toContain('Chain            : INTACT')
    })
  })
})
