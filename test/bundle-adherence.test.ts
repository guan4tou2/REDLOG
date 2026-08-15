// G-D1, the bundle half. The loose `data:exportAdherence` file proves nothing on
// its own — anyone can write a JSON file claiming 244 of 247 targets were in
// scope. Inside the bundle the report is a hashed entry in `manifest.files`, so
// it inherits the manifest sha256 and the HMAC and travels signed with the rest
// of the evidence.
//
// The load-bearing invariant is that the report is built from the rows AS
// WRITTEN TO THE BUNDLE, after the layer-4 sanitize swap — otherwise a
// client-deliverable bundle would ship a side channel around its own gate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

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
let dir = ''

const SCOPE = {
  targets: ['192.168.1.10', '192.168.1.20', '*.app.example.com'],
  excludeTargets: ['dc01.app.example.com']
}

const hit = (target: string, command = `nmap ${target}`): void => {
  insertEventRaw('shell', { subtype: 'command_start', command, detectedTarget: target },
    { engagementId: 'eng', operatorId: 'op', targetId: target })
}

const readReport = (outDir: string): Record<string, never> =>
  JSON.parse(fs.readFileSync(path.join(outDir, 'scope-adherence.json'), 'utf-8'))

describeDB('evidence bundle — scope adherence', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-adh-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ships the report as a hashed file and a manifest headline', () => {
    hit('192.168.1.10'); hit('192.168.1.20'); hit('192.168.1.55')
    const { outDir, manifest } = exportBundle('eng', { outRoot: dir, scope: SCOPE })

    const entry = manifest.files.find((f) => f.path === 'scope-adherence.json')
    expect(entry).toBeTruthy()
    expect(manifest.scopeAdherence?.summary).toBe('3 targets, 2 in scope, 0 excluded, 1 adjacent')

    // The claim in the manifest and the evidence beside it must agree.
    const report = readReport(outDir) as unknown as { totals: Record<string, number> }
    expect(report.totals).toEqual(manifest.scopeAdherence?.totals)
  })

  // This is what makes the bundle copy worth more than the loose file.
  it('the report is covered by the manifest hash', () => {
    hit('192.168.1.10')
    const { outDir, manifest } = exportBundle('eng', { outRoot: dir, scope: SCOPE })
    const entry = manifest.files.find((f) => f.path === 'scope-adherence.json')!
    const onDisk = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outDir, 'scope-adherence.json'))).digest('hex')
    expect(onDisk).toBe(entry.sha256)

    const manifestSha = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outDir, 'manifest.json'))).digest('hex')
    expect(fs.readFileSync(path.join(outDir, 'manifest.sha256'), 'utf-8').trim()).toBe(manifestSha)
  })

  it('classifies every rung, not just the ones that alerted', () => {
    hit('192.168.1.10')             // D0
    hit('api.app.example.com')      // D0
    hit('dc01.app.example.com')     // D1
    hit('192.168.1.55')             // D2 subnet
    hit('vpn.example.com')          // D2 domain
    hit('8.8.8.8')                  // D3
    const { manifest } = exportBundle('eng', { outRoot: dir, scope: SCOPE })
    expect(manifest.scopeAdherence?.totals).toMatchObject({
      targets: 6, in_scope: 2, excluded: 1, adjacent_subnet: 1, adjacent_domain: 1, unrelated: 1
    })
  })

  // An empty report reads as "nothing was out of bounds", which is a claim the
  // bundle has no basis for making when no scope was ever declared.
  it('no scope means no file and no claim, not an empty one', () => {
    hit('anything.test')
    const { outDir, manifest } = exportBundle('eng', { outRoot: dir })
    expect(manifest.scopeAdherence).toBeNull()
    expect(fs.existsSync(path.join(outDir, 'scope-adherence.json'))).toBe(false)
    expect(manifest.files.some((f) => f.path === 'scope-adherence.json')).toBe(false)
  })

  it('an internal bundle gets the proof too — it stayed inside something as well', () => {
    hit('192.168.1.10')
    const { manifest } = exportBundle('eng', { outRoot: dir, scope: SCOPE })
    expect(manifest.scopeAdherence?.totals.in_scope).toBe(1)
  })

  it('carries the scope provenance so a reviewer can join it to the issued document', () => {
    hit('192.168.1.10')
    const prov = {
      path: '/engagements/acme/scope.txt',
      digest: 'b'.repeat(64),
      bytes: 64,
      entries: 3,
      modifiedAt: 1,
      loadedAt: 2
    }
    const { manifest } = exportBundle('eng', { outRoot: dir, scope: { ...SCOPE, provenance: prov } })
    expect(manifest.scopeAdherence?.provenance).toEqual({
      path: prov.path, digest: prov.digest, entries: prov.entries
    })
  })

  it('tells the reviewer how to check it', () => {
    hit('192.168.1.10')
    const { outDir } = exportBundle('eng', { outRoot: dir, scope: SCOPE })
    const readme = fs.readFileSync(path.join(outDir, 'README.md'), 'utf-8')
    expect(readme).toContain('scope-adherence.json')
    expect(readme).toContain('shasum -a 256')
    expect(readme).toContain('denominator')
  })

  it('RedLog\'s own bookkeeping does not inflate the target count', () => {
    hit('192.168.1.55')
    insertEventRaw('system', {
      subtype: 'scope_violation', target: '192.168.1.55', reason: 'adjacent_subnet', authority: 'inferred'
    }, { engagementId: 'eng', operatorId: 'op', targetId: '192.168.1.55' })
    const { manifest } = exportBundle('eng', { outRoot: dir, scope: SCOPE })
    expect(manifest.scopeAdherence?.totals.targets).toBe(1)
    expect(manifest.scopeAdherence?.totals.actions).toBe(1)
  })

  // THE load-bearing invariant. The report is built from the rows as written to
  // the bundle, after the layer-4 sanitize swap — so it is structurally unable
  // to carry content the bundle itself does not. Asserted as a property rather
  // than against a specific redaction, so it keeps holding when the sanitize
  // rules change.
  it('every command sample in the report also appears in events.jsonl', () => {
    hit('192.168.1.10', 'nmap -sV 192.168.1.10')
    hit('192.168.1.55', 'curl -H "Authorization: Bearer sk-live-abc" http://192.168.1.55/admin')
    hit('8.8.8.8', 'dig @8.8.8.8 example.com')
    const { outDir } = exportBundle('eng', {
      outRoot: dir,
      profile: 'client-deliverable',
      scope: SCOPE,
      operatorId: 'op'
    })
    // Every command the bundle actually ships, decoded. (events.jsonl rows carry
    // `data` as a JSON STRING, so the text is double-escaped in the file —
    // comparing raw text would test the escaping, not the invariant.)
    const shipped = new Set<string>()
    for (const line of fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf-8').split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as { data?: string }
      if (typeof row.data !== 'string') continue
      const d = JSON.parse(row.data) as { command?: unknown }
      if (typeof d.command === 'string') shipped.add(d.command)
    }

    const report = readReport(outDir) as unknown as {
      targets: Array<{ target: string; commands: string[] }>
    }
    expect(report.targets.length).toBeGreaterThan(0)
    const samples = report.targets.flatMap((r) => r.commands)
    expect(samples.length).toBeGreaterThan(0)
    for (const cmd of samples) {
      // Samples are sliced to 200 chars, so a prefix match is the honest test.
      expect([...shipped].some((s) => s.startsWith(cmd))).toBe(true)
    }
  })

  it('a client-deliverable bundle still states the denominator', () => {
    hit('192.168.1.10'); hit('192.168.1.55')
    const { manifest } = exportBundle('eng', {
      outRoot: dir, profile: 'client-deliverable', scope: SCOPE, operatorId: 'op'
    })
    expect(manifest.scopeAdherence?.totals.targets).toBe(2)
    expect(manifest.scopeAdherence?.totals.in_scope).toBe(1)
  })
})
