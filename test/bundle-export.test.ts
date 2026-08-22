import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  const b = await import('../src/core/bundle-export')
  initDB = d.initDB; closeDB = d.closeDB; insertEventRaw = e.insertEvent; exportBundle = b.exportBundle
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

describeDB('evidence bundle export', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-'))
    initDB(dir)
    ins('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 })
    ins('marker', { title: 'finding', severity: 'info' })
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('every file in the manifest exists and matches its recorded sha256', () => {
    seedFile('screenshots', 'a.jpg', 'jpegbytes')
    seedFile('casts', 's.cast', '{"version":2}\n')
    const { outDir, manifest } = exportBundle('eng')

    expect(manifest.files.length).toBeGreaterThan(0)
    for (const f of manifest.files) {
      const p = path.join(outDir, f.path)
      expect(fs.existsSync(p), `${f.path} listed in manifest but missing`).toBe(true)
      const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      expect(actual, `${f.path} sha256 does not match the manifest`).toBe(f.sha256)
      expect(fs.statSync(p).size).toBe(f.bytes)
    }
  })

  it('ships a self-contained verifier so a third party needs nothing from us', () => {
    const { outDir } = exportBundle('eng')
    for (const f of ['events.jsonl', 'manifest.json', 'manifest.sha256', 'redlog-verify.py', 'README.md']) {
      expect(fs.existsSync(path.join(outDir, f)), `${f} missing from bundle`).toBe(true)
    }
    // One of the two OS wrappers must be there for a double-clickable check.
    expect(
      fs.existsSync(path.join(outDir, 'verify.sh')) || fs.existsSync(path.join(outDir, 'verify.cmd'))
    ).toBe(true)
  })

  it('manifest.sha256 covers manifest.json exactly', () => {
    const { outDir } = exportBundle('eng')
    const declared = fs.readFileSync(path.join(outDir, 'manifest.sha256'), 'utf-8').trim().split(/\s+/)[0]
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outDir, 'manifest.json'))).digest('hex')
    expect(declared).toBe(actual)
  })

  it('events.jsonl holds one parseable event per line, oldest first', () => {
    const { outDir } = exportBundle('eng')
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
    const { outDir, manifest } = exportBundle('eng')
    expect(fs.existsSync(path.join(outDir, 'agent-transcripts'))).toBe(false)
    expect(JSON.stringify(manifest.files)).not.toContain('agent-transcripts')
  })

  it('includes agent transcripts only when explicitly opted in', () => {
    seedFile('agent-transcripts', 'claude-1.jsonl', '{"text":"hello"}\n')
    const { outDir } = exportBundle('eng', { outRoot: path.join(dir, 'exports2'), includeAgentTranscripts: true })
    expect(fs.existsSync(path.join(outDir, 'agent-transcripts', 'claude-1.jsonl'))).toBe(true)
  })

  it('never exports operator token hashes', () => {
    const { outDir } = exportBundle('eng')
    const opsPath = path.join(outDir, 'operators.json')
    if (!fs.existsSync(opsPath)) return
    const raw = fs.readFileSync(opsPath, 'utf-8')
    expect(raw).not.toContain('tokenHash')
    expect(raw).not.toContain('token_hash')
  })

  it('records the chain head so the bundle can be tied to the live chain', () => {
    const { manifest } = exportBundle('eng')
    expect(manifest.chainHead?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.chainHead?.eventCount).toBeGreaterThanOrEqual(2)
  })

  it('copies screenshots and casts alongside their hashes', () => {
    seedFile('screenshots', 'shot.jpg', 'IMG')
    seedFile('casts', 'term.cast', 'CAST')
    const { outDir, manifest } = exportBundle('eng')
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
