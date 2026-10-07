import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// v0.9.10: the evidence bundle is the deliverable — the thing an operator hands
// to a client or a court, and the only artefact a third party ever verifies.
// It had no tests. What matters here is not that files appear, but that the
// manifest describes them truthfully and that nothing sensitive leaks in by
// default.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let exportBundle: typeof import('../src/core/bundle-export').exportBundle
let takeExportSnapshot: typeof import('../src/core/export-plan').takeExportSnapshot
let mod: typeof import('../src/core/db/index')

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  const b = await import('../src/core/bundle-export')
  const p = await import('../src/core/export-plan')
  initDB = d.initDB; closeDB = d.closeDB; insertEventRaw = e.insertEvent; exportBundle = b.exportBundle; mod = d
  takeExportSnapshot = p.takeExportSnapshot
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const describeDB = dbAvailable ? describe : describe.skip
let dir: string
const ins = (type: string, data: Record<string, unknown>): void => {
  insertEventRaw(type, data, { engagementId: 'eng', operatorId: 'op' })
}
const seedFile = (sub: string, name: string, body: string): string => {
  const d = path.join(dir, sub)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, name), body)
  return path.join(d, name)
}

/** Every spawn below is bounded by this, so a hung interpreter is reported as
 *  the spawn that hung rather than as the test running out of time. */
const SPAWN_MS = 15_000

/**
 * An interpreter that actually runs Python, or null.
 *
 * Not `python3` on faith: on a Windows runner that name can be the Store's App
 * Execution Alias, which runs no Python and need not exit. `spawnSync` then
 * blocks until the test's own budget is gone and vitest reports a bare "Test
 * timed out" with nothing in it about Python — which is how the verifier tests
 * failed on windows-latest while passing on ubuntu, and why raising the budget
 * could not have fixed it.
 *
 * `pythonLocation` is what actions/setup-python exports. It names the
 * interpreter the workflow chose, rather than whatever PATH resolves to.
 */
function findPython(child: typeof import('node:child_process')): string | null {
  const loc = process.env.pythonLocation
  return [
    ...(loc ? [path.join(loc, 'python.exe'), path.join(loc, 'bin', 'python3')] : []),
    'python3', 'python'
  ].find((exe) => {
    const probe = child.spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf-8', timeout: SPAWN_MS })
    return !probe.error && probe.status === 0 && probe.stdout.trim() === '1'
  }) ?? null
}

describeDB('evidence bundle export', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-'))
    initDB(dir)
    ins('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 })
    ins('marker', { title: 'finding', severity: 'info' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('every file in the manifest exists and matches its recorded sha256', () => {
    seedFile('screenshots', 'a.jpg', 'jpegbytes')
    seedFile('casts', 's.cast', '{"version":2}\n')
    const { outDir, manifest } = exportBundle('eng', {})

    expect(manifest.files.length).toBeGreaterThan(0)
    for (const f of manifest.files) {
      const p = path.join(outDir, f.path)
      expect(fs.existsSync(p), `${f.path} listed in manifest but missing`).toBe(true)
      const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      expect(actual, `${f.path} sha256 does not match the manifest`).toBe(f.sha256)
      expect(fs.statSync(p).size).toBe(f.bytes)
    }
  })

  it('refuses to export, leaving nothing behind, when the verifier cannot be found', () => {
    // A packaged build that lost tools/redlog-verify.py used to skip the
    // verifier, its wrappers and the README silently. A bundle sold as
    // "with verifier" must not be produced without one.
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-out-'))
    const realExists = fs.existsSync
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('redlog-verify.py') ? false : realExists(p))
    try {
      expect(() => exportBundle('eng', { outRoot })).toThrow(/verifier/i)
      expect(fs.readdirSync(outRoot)).toEqual([])
    } finally {
      fs.rmSync(outRoot, { recursive: true, force: true })
    }
  })

  it('ships a self-contained verifier so a third party needs nothing from us', () => {
    const { outDir } = exportBundle('eng', {})
    for (const f of ['events.jsonl', 'manifest.json', 'manifest.sha256', 'redlog-verify.py', 'README.md']) {
      expect(fs.existsSync(path.join(outDir, f)), `${f} missing from bundle`).toBe(true)
    }
    // One of the two OS wrappers must be there for a double-clickable check.
    expect(
      fs.existsSync(path.join(outDir, 'verify.sh')) || fs.existsSync(path.join(outDir, 'verify.cmd'))
    ).toBe(true)
  })

  it('manifest.sha256 covers manifest.json exactly', () => {
    const { outDir } = exportBundle('eng', {})
    const declared = fs.readFileSync(path.join(outDir, 'manifest.sha256'), 'utf-8').trim().split(/\s+/)[0]
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outDir, 'manifest.json'))).digest('hex')
    expect(declared).toBe(actual)
  })

  it('publishes the final bundle name only after the manifest is complete', () => {
    const outRoot = path.join(dir, 'atomic-out')
    const write = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: never) => {
      if (typeof file === 'string' && path.basename(file) === 'manifest.json') throw new Error('simulated manifest failure')
      return write(file, data, options)
    }) as typeof fs.writeFileSync)

    expect(() => exportBundle('eng', { outRoot })).toThrow('simulated manifest failure')
    const names = fs.readdirSync(outRoot)
    expect(names.some((name) => /^bundle-.*\.partial-/.test(name))).toBe(true)
    expect(names.every((name) => name.includes('.partial-'))).toBe(true)
  })

  it('events.jsonl holds one parseable event per line, oldest first', () => {
    const { outDir } = exportBundle('eng', {})
    const lines = fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf-8').trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const parsed = lines.map((l) => JSON.parse(l) as { createdAt?: number; created_at?: number })
    const ts = parsed.map((p) => p.createdAt ?? p.created_at ?? 0)
    expect([...ts].sort((a, b) => a - b), 'export must be in insertion order').toEqual(ts)
  })

  it('leaves the recording search index out of the bundle', () => {
    // cast-index.db is derived, mutable and rebuildable — it is a search
    // cache over the recordings, not evidence about them. Shipping it would
    // make a bundle's bytes change for reasons unrelated to the engagement,
    // and it duplicates terminal output into a file the verifier says
    // nothing about.
    //
    // Today it stays out because the export copies named subdirectories
    // rather than walking the project root. This test is here so a later
    // "just copy the whole project" simplification cannot quietly include it.
    fs.writeFileSync(path.join(dir, 'cast-index.db'), 'not evidence')
    const { outDir } = exportBundle('eng', { outRoot: path.join(dir, 'out2') })
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [e.name])
    expect(walk(outDir)).not.toContain('cast-index.db')
  })

  it('excludes agent transcripts by default — they can contain pasted secrets', () => {
    seedFile('agent-transcripts', 'claude-1.jsonl', '{"text":"my api key is sk-SECRET"}\n')
    const { outDir, manifest } = exportBundle('eng', {})
    expect(fs.existsSync(path.join(outDir, 'agent-transcripts'))).toBe(false)
    expect(JSON.stringify(manifest.files)).not.toContain('agent-transcripts')
  })

  it('includes agent transcripts only when explicitly opted in', () => {
    seedFile('agent-transcripts', 'claude-1.jsonl', '{"text":"hello"}\n')
    const { outDir } = exportBundle('eng', { outRoot: path.join(dir, 'exports2'), includeAgentTranscripts: true })
    expect(fs.existsSync(path.join(outDir, 'agent-transcripts', 'claude-1.jsonl'))).toBe(true)
  })

  it('never exports operator token hashes', () => {
    const { outDir } = exportBundle('eng', {})
    const opsPath = path.join(outDir, 'operators.json')
    if (!fs.existsSync(opsPath)) return
    const raw = fs.readFileSync(opsPath, 'utf-8')
    expect(raw).not.toContain('tokenHash')
    expect(raw).not.toContain('token_hash')
  })

  it('records the chain head so the bundle can be tied to the live chain', () => {
    const { manifest } = exportBundle('eng', {})
    expect(manifest.chainHead?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.chainHead?.eventCount).toBeGreaterThanOrEqual(2)
  })

  it('copies screenshots and casts alongside their hashes', () => {
    seedFile('screenshots', 'shot.jpg', 'IMG')
    seedFile('casts', 'term.cast', 'CAST')
    const { outDir, manifest } = exportBundle('eng', {})
    expect(fs.readFileSync(path.join(outDir, 'screenshots', 'shot.jpg'), 'utf-8')).toBe('IMG')
    expect(fs.readFileSync(path.join(outDir, 'casts', 'term.cast'), 'utf-8')).toBe('CAST')
    const listed = manifest.files.map((f) => f.path)
    expect(listed.some((p) => p.includes('shot.jpg'))).toBe(true)
    expect(listed.some((p) => p.includes('term.cast'))).toBe(true)
  })

  it('two exports of an unchanged chain agree on the head', () => {
    const a = exportBundle('eng', { outRoot: path.join(dir, 'e1') })
    const b = exportBundle('eng', { outRoot: path.join(dir, 'e2') })
    expect(a.manifest.chainHead).toEqual(b.manifest.chainHead)
  })
})

describeDB('private bookmarks stay out of the bundle', () => {
  // They shipped here for two years beside events.jsonl while being none of the
  // things this bundle claims — not chained, not signed, not anchored, not
  // attributed to an operator, editable in place — and the bundled verifier
  // never opened the file. The recipient had no way to tell one had been edited.
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bm-'))
    initDB(dir)
  })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes no bookmark file, and leaks no bookmark text anywhere in the bundle', async () => {
    const findings = await import('../src/core/db/bookmarks')
    findings.createBookmark({ title: 'a private note', url: 'https://internal.example/admin', note: 'BOOKMARK-CANARY-9182' })
    ins('shell', { subtype: 'command_end', command: 'id', exitCode: 0 })

    const out = exportBundle('eng', { outRoot: path.join(dir, 'exports') })
    const names = fs.readdirSync(out.outDir)
    expect(names).not.toContain('quickmarks.json')
    expect(names).not.toContain('bookmarks.json')
    expect(out.manifest.files.map((f) => f.path)).not.toContain('quickmarks.json')

    // And not under some other name: read every file in the bundle.
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    for (const f of walk(out.outDir)) {
      expect(fs.readFileSync(f, 'utf-8'), `canary found in ${path.basename(f)}`).not.toContain('BOOKMARK-CANARY-9182')
    }
  })

  const insT = (data: Record<string, unknown>, targetId: string): void => {
    insertEventRaw('shell', data, { engagementId: 'eng', operatorId: 'op', targetId })
  }

  it('masks out-of-scope events content in the bundle when scope is supplied (A2)', () => {
    insT({ subtype: 'command_end', command: 'curl https://in.example.com', output: 'IN-SCOPE-BODY' }, 'in.example.com')
    insT({ subtype: 'command_end', command: 'curl https://out.evil.com', output: 'OUT-OF-SCOPE-SECRET' }, 'out.evil.com')

    const { outDir, manifest } = exportBundle('eng', { outRoot: path.join(dir, 'a2'), scope: { targets: ['*.example.com'] } })
    const lines = fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const inRow = lines.find((r) => r.target_id === 'in.example.com')
    const outRow = lines.find((r) => r.target_id === 'out.evil.com')
    expect(JSON.parse(inRow.data).output).toBe('IN-SCOPE-BODY')            // untouched
    expect(JSON.parse(outRow.data).output).toBe('[redacted: out of scope]') // masked
    expect(manifest.sanitizedOutOfScope).toBe(1)
  })

  it('does not mask anything when no scope is supplied (A2 default is safe)', () => {
    insT({ subtype: 'command_end', command: 'curl https://out.evil.com', output: 'STILL-HERE' }, 'out.evil.com')
    const { outDir, manifest } = exportBundle('eng', { outRoot: path.join(dir, 'a2b') })
    const lines = fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const row = lines.find((r) => r.target_id === 'out.evil.com')
    expect(JSON.parse(row.data).output).toBe('STILL-HERE')
    expect(manifest.sanitizedOutOfScope).toBe(0)
  })

  // The offline verifier (tools/redlog-verify.py) is what a recipient runs.
  // Before the manifest-file check it walked only the event chain, so a
  // swapped screenshot passed "chain intact". These two tests pin the fix:
  // an untouched bundle verifies, a tampered evidence file fails.
  it('the python verifier passes a clean bundle and fails a tampered evidence file', () => {
    seedFile('screenshots', 'shot.jpg', 'REAL-IMAGE-BYTES')
    const { outDir } = exportBundle('eng', {})
    const child = require('node:child_process') as typeof import('node:child_process')
    const verifier = path.join(outDir, 'redlog-verify.py')
    if (!fs.existsSync(verifier)) return // verifier not embedded in this build shape

    const python = findPython(child)
    if (!python) return // no usable Python on this runner — skip, as before

    const clean = child.spawnSync(python, [verifier, outDir], { encoding: 'utf-8', timeout: SPAWN_MS })
    expect(clean.error, String(clean.error)).toBeUndefined()
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    expect(clean.stdout).toMatch(/Manifest files\s+:\s+\d+ verified/)

    // Swap the bytes of a listed evidence file without touching the manifest.
    fs.writeFileSync(path.join(outDir, 'screenshots', 'shot.jpg'), 'SWAPPED-IMAGE')
    const tampered = child.spawnSync(python, [verifier, outDir], { encoding: 'utf-8', timeout: SPAWN_MS })
    expect(tampered.error, String(tampered.error)).toBeUndefined()
    expect(tampered.status).toBe(1)
    expect(tampered.stdout + tampered.stderr).toMatch(/MISMATCH|sha256 differs/)
  }, 60_000) // a probe and two verifier runs, each bounded at 15s above; this is
  // the budget they add up to, so a hang is reported as the spawn that hung
  // rather than as the test running out of time.
})

describeDB('the chain head a recipient verifies', () => {
  // The Export menu previews a plan and then runs it against the plan's
  // snapshot, so every bundle an operator makes takes the snapshot branch of
  // the head computation. That branch wrote the last event's own hash as
  // chainHead.hash, where computeChainHead() and redlog-verify.py both use
  // sha256(lastHash || eventCount). So a bundle nobody had touched reported
  // "Chain-head match : NO" and verify.sh / verify.cmd exited 1 (#226). Every
  // other test here exports without a snapshot, and the verifier test above
  // runs on an empty chain, where the head check does not apply.
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-head-'))
    initDB(dir)
    ins('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 })
    ins('marker', { title: 'finding', severity: 'info' })
    ins('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
  })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('a planned export records the same chain head as an unplanned one, in the verifier\'s form', () => {
    const planned = exportBundle('eng', { snapshot: takeExportSnapshot(), outRoot: path.join(dir, 'planned') })
    const unplanned = exportBundle('eng', { outRoot: path.join(dir, 'unplanned') })
    expect(planned.manifest.chainHead).toEqual(unplanned.manifest.chainHead)

    const lines = fs.readFileSync(path.join(planned.outDir, 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const last = lines[lines.length - 1]
    const recomputed = crypto.createHash('sha256').update(last.hash).update(String(lines.length)).digest('hex')
    expect(planned.manifest.chainHead).toEqual({ hash: recomputed, eventCount: lines.length })
  })

  it('the python verifier passes a planned bundle and an unplanned one, chain head included', () => {
    const child = require('node:child_process') as typeof import('node:child_process')
    const python = findPython(child)
    if (!python) return // no usable Python on this runner — skip
    for (const [label, opts] of [
      ['planned', { snapshot: takeExportSnapshot(), outRoot: path.join(dir, 'planned') }],
      ['unplanned', { outRoot: path.join(dir, 'unplanned') }]
    ] as const) {
      const { outDir } = exportBundle('eng', opts)
      const verifier = path.join(outDir, 'redlog-verify.py')
      if (!fs.existsSync(verifier)) return // verifier not embedded in this build shape
      const run = child.spawnSync(python, [verifier, outDir], { encoding: 'utf-8', timeout: SPAWN_MS })
      expect(run.error, String(run.error)).toBeUndefined()
      expect(run.stdout, label).toMatch(/Events walked\s+:\s+3/)
      expect(run.stdout, label).toMatch(/Chain-head match\s+:\s+yes/)
      expect(run.status, `${label}: ${run.stdout}${run.stderr}`).toBe(0)
    }
  }, 60_000) // a probe and two verifier runs, each bounded at SPAWN_MS
})
