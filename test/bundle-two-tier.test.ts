import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.13.0 (docs/DESIGN-two-tier-chain.md §7 + §11.4): the bundle carries
// both `events.jsonl` (chained tier) and `events_logged.jsonl`
// (supporting-evidence tier). Manifest bundleVersion bumps 1 → 2 and
// gains a `tiers` field. This test locks the shape.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let exportBundle: typeof import('../src/core/bundle-export').exportBundle

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  const bundle = await import('../src/core/bundle-export')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  exportBundle = bundle.exportBundle
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('bundle export — two tiers (v0.13.0)', () => {
  let tmpDir: string
  let outDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-tier-'))
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-tier-out-'))
    initDB(tmpDir)
    const op = ops.ensurePrimaryOperator('bundle-op', 'Bundle Op', 'test-token-' + Math.random())
    operatorId = op.id
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('bundle contains events.jsonl AND events_logged.jsonl', () => {
    events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'example.test' }, { operatorId })
    events.insertEvent('scanner', { subtype: 'http_request_start', host: 'api.example.com', method: 'GET' }, { operatorId })

    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    expect(fs.existsSync(path.join(bundleDir, 'events.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(bundleDir, 'events_logged.jsonl'))).toBe(true)

    const chained = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf-8')
      .split('\n').filter(Boolean)
    const logged = fs.readFileSync(path.join(bundleDir, 'events_logged.jsonl'), 'utf-8')
      .split('\n').filter(Boolean)
    expect(chained).toHaveLength(1)  // shell command_start
    expect(logged).toHaveLength(2)   // dns + scanner
  })

  it('manifest bundleVersion === 2 and tiers has correct counts', () => {
    events.insertEvent('shell', { subtype: 'command_start', command: 'a' }, { operatorId })
    events.insertEvent('shell', { subtype: 'command_end', command: 'a', duration_sec: 1 }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'x.test' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'y.test' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'z.test' }, { operatorId })

    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf-8'))
    expect(manifest.bundleVersion).toBe(2)
    expect(manifest.tiers).toBeDefined()
    expect(manifest.tiers.chained).toBe(2)
    expect(manifest.tiers.logged).toBe(3)
  })

  it('events_logged.jsonl rows have no chain columns', () => {
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    const logged = fs.readFileSync(path.join(bundleDir, 'events_logged.jsonl'), 'utf-8')
      .split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(logged).toHaveLength(1)
    const row = logged[0]
    // Chain columns are absent from the SELECT — they're deliberately
    // NOT in the row shape, not just null. A consumer that iterates
    // Object.keys(row) sees the tier as "the columns that aren't there".
    expect('hash' in row).toBe(false)
    expect('prev_hash' in row).toBe(false)
    expect('signature' in row).toBe(false)
    expect('monotonic_ns' in row).toBe(false)
    expect(row.agent_type).toBe('dns')
    expect((row.data as string).length).toBeGreaterThan(0)
  })

  it('empty tiers still produce a bundle with well-formed manifest', () => {
    // No events inserted → both tables empty. Bundle should still be
    // written; manifest.tiers should show 0/0; empty events_logged.jsonl.
    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf-8'))
    expect(manifest.tiers.chained).toBe(0)
    expect(manifest.tiers.logged).toBe(0)
    const logged = fs.readFileSync(path.join(bundleDir, 'events_logged.jsonl'), 'utf-8')
    expect(logged).toBe('')
  })

  it('bundle README explains the tier split', () => {
    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    const readme = fs.readFileSync(path.join(bundleDir, 'README.md'), 'utf-8')
    expect(readme).toContain('events.jsonl')
    expect(readme).toContain('events_logged.jsonl')
    expect(readme).toContain('primary evidence')
    expect(readme).toContain('supporting')
  })

  it('bundle files entry lists events_logged.jsonl with sha256', () => {
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    const { outDir: bundleDir } = exportBundle('test-engagement', { outRoot: outDir })
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf-8'))
    const loggedFile = (manifest.files as Array<{ path: string; sha256: string; bytes: number }>)
      .find((f) => f.path === 'events_logged.jsonl')
    expect(loggedFile).toBeDefined()
    expect(loggedFile!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(loggedFile!.bytes).toBeGreaterThan(0)
  })
})
