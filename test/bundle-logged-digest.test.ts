import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.15 (docs/DESIGN-two-tier-chain.md §7.5 / §8): the logged tier is
// deliberately un-chained, so an export folds one cheap digest over it and
// records it as a chained `system.logged_tier_digest` event — an anchored
// snapshot of the tier with no per-row write-path cost. This locks that
// contract: the event exists, its count matches the tier, its hash is stable
// for unchanged rows and moves when a row is added, and an empty tier emits
// nothing.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let takeExportSnapshot: typeof import('../src/core/export-plan').takeExportSnapshot
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let exportBundle: typeof import('../src/core/bundle-export').exportBundle

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  const bundle = await import('../src/core/bundle-export')
  const plan = await import('../src/core/export-plan')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  exportBundle = bundle.exportBundle
  takeExportSnapshot = plan.takeExportSnapshot
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

const HEX64 = /^[0-9a-f]{64}$/

const readJsonl = (file: string): Array<Record<string, any>> =>
  fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }))

const lastDigest = (bundleDir: string) =>
  readJsonl(path.join(bundleDir, 'events.jsonl'))
    .filter((r) => r.agent_type === 'system' && r.data.subtype === 'logged_tier_digest')
    .pop()

describeDB('bundle export — logged-tier digest (§7.5)', () => {
  let tmpDir: string
  let outDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-logged-digest-'))
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-logged-digest-out-'))
    initDB(tmpDir)
    const op = ops.ensurePrimaryOperator('digest-op', 'Digest Op', 'tok-' + Math.random())
    operatorId = op.id
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('emits one chained system.logged_tier_digest covering every logged row', () => {
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'b.test' }, { operatorId })
    events.insertEvent('scanner', { subtype: 'http_request_start', host: 'x', method: 'GET' }, { operatorId })

    const { outDir: bundleDir, manifest } = exportBundle('eng-1', { outRoot: outDir })

    const chained = readJsonl(path.join(bundleDir, 'events.jsonl'))
    const digests = chained.filter((r) => r.agent_type === 'system' && r.data.subtype === 'logged_tier_digest')
    expect(digests).toHaveLength(1)
    expect(digests[0].data.count).toBe(3) // 2 dns + 1 scanner all land in events_logged
    expect(digests[0].data.sha256).toMatch(HEX64)
    // The digest event is itself chained — it carries a hash like any events row.
    expect(digests[0].hash).toMatch(HEX64)

    // Mirrored into the manifest for manifest-only consumers.
    expect(manifest.tiers?.loggedDigest?.count).toBe(3)
    expect(manifest.tiers?.loggedDigest?.sha256).toBe(digests[0].data.sha256)
  })

  it('the digest is stable for identical logged content across exports', () => {
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    const first = exportBundle('eng-1', { outRoot: outDir })
    const d1 = lastDigest(first.outDir)!.data.sha256

    // A second export over the SAME logged rows recomputes the SAME hash. (A new
    // digest event is appended each export — expected, like any audit marker —
    // but the fingerprint of unchanged rows is deterministic.)
    const second = exportBundle('eng-1', { outRoot: outDir })
    const d2 = lastDigest(second.outDir)!.data.sha256
    expect(d2).toBe(d1)
  })

  it('the digest changes when a logged row is added', () => {
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    const first = exportBundle('eng-1', { outRoot: outDir })
    const d1 = lastDigest(first.outDir)!.data.sha256

    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'c.test' }, { operatorId })
    const second = exportBundle('eng-1', { outRoot: outDir })
    const d2 = lastDigest(second.outDir)!.data
    expect(d2.count).toBe(2)
    expect(d2.sha256).not.toBe(d1)
  })

  it('an empty logged tier emits no digest event', () => {
    // Only a chained row; nothing routed to events_logged.
    events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { operatorId })
    const { outDir: bundleDir, manifest } = exportBundle('eng-1', { outRoot: outDir })
    const chained = readJsonl(path.join(bundleDir, 'events.jsonl'))
    expect(chained.some((r) => r.data.subtype === 'logged_tier_digest')).toBe(false)
    expect(manifest.tiers?.loggedDigest).toBeUndefined()
  })

  it('planned export keeps logged digest and chain metadata at the approved snapshot', () => {
    const before = events.insertEvent(
      'shell',
      { subtype: 'command_start', command: 'id' },
      { engagementId: 'eng-1', operatorId }
    )!
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'before.test' }, { operatorId })
    const snapshot = takeExportSnapshot()

    events.insertEvent(
      'shell',
      { subtype: 'command_end', command: 'id', exitCode: 0 },
      { engagementId: 'eng-1', operatorId }
    )
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'after.test' }, { operatorId })

    const { outDir: bundleDir, manifest } = exportBundle('eng-1', {
      outRoot: outDir,
      snapshot,
      includeEventIds: new Set([before.id]),
      exportPlan: {
        id: 'plan-1',
        fingerprint: 'f'.repeat(64),
        counts: {
          examined: 2, included: 2, excludedDoNotExport: 0,
          excludedPersonal: 0, excludedBlacklist: 0, maskedOutOfScope: 0,
          sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0,
          attachmentsUnattributed: 0, unsupported: 0
        }
      }
    })

    const chained = readJsonl(path.join(bundleDir, 'events.jsonl'))
    const logged = readJsonl(path.join(bundleDir, 'events_logged.jsonl'))
    expect(chained.map((r) => r.id)).toEqual([before.id])
    expect(chained.some((r) => r.data.subtype === 'logged_tier_digest')).toBe(false)
    expect(logged).toHaveLength(0) // exact plan selection excludes the logged row
    expect(manifest.tiers?.loggedDigest?.count).toBe(1)
    expect(events.loggedTierDigest(snapshot.loggedMaxRowId).count).toBe(1)
    expect(events.loggedTierDigest().count).toBe(2)
    expect(manifest.chainHead).toEqual({ hash: before.hash, eventCount: 1 })
    expect(manifest.tiers?.chained).toBe(1)
  })
})
