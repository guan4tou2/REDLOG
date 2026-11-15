// Spec 071 T037, group "anchors, exports, sanitize": seven writers move from
// insertEvent + a hand-written eventBus.publish to the door (ingestEvent).
//
// This file calls the real functions and observes what a subscriber on the
// event bus receives and what is stored, so it reads the same before and after
// the move. The one difference it is written to show: `anchor_failed` was never
// published, and is now published once. Everything else — rows, deliveries,
// return values, what is thrown — is unchanged.
//
// An engagement that is "not passed" (update_pending, anchor_failed) must still
// be the open database's: with no project bound the write throws no-project and
// the caller's own catch handles it; another project's engagement is refused.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import type { RedLogEvent } from '../src/core/db/events'

const sqlite = requires('better-sqlite3')
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-writers-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

const dbMod = await import('../src/core/db/index')
const events = await import('../src/core/db/events')
const ops = await import('../src/core/db/operators')
const { eventBus } = await import('../src/core/event-bus')
const { withEntrance, LEGACY_API } = await import('../src/core/ingest/stamp')
const updateAnchor = await import('../src/core/update-anchor')
const chainAnchor = await import('../src/core/chain-anchor')
const bundleExport = await import('../src/core/bundle-export')
const { createDirectBundleExporter } = await import('../src/core/export-direct-bundle')
const { sanitize } = await import('../src/core/sanitize')
const { closeHttpBodyIndex } = await import('../src/core/http-body-index')

const describeDB = sqlite.ok ? describe : describe.skip

const ENG = 'eng-writers'
let dir = ''
let out = ''
let seen: RedLogEvent[] = []
const listener = (e: RedLogEvent): void => { seen.push(e) }

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const delivered = (subtype: string): RedLogEvent[] => seen.filter((e) => (e.data as { subtype?: string }).subtype === subtype)
const stored = (subtype: string): Array<{ id: string; data: Record<string, unknown> }> =>
  (dbMod.getDB().prepare("SELECT id, data FROM events WHERE agent_type='system' ORDER BY rowid").all() as Array<{ id: string; data: string }>)
    .map((r) => ({ id: r.id, data: JSON.parse(r.data) as Record<string, unknown> }))
    .filter((r) => r.data.subtype === subtype)
/** The stamp without its per-row id. */
const stamp = (row: { data: Record<string, unknown> }): Record<string, unknown> => {
  const { event_id: _id, ...rest } = row.data._ingest as Record<string, unknown>
  return rest
}
const fakeAnchor = (status: string, headHash: string) =>
  async () => ({ status, headHash } as unknown as import('../src/core/chain-anchor').ChainAnchor)

function open(bound: string | null = ENG): void {
  dbMod.initDB(dir)
  if (bound) dbMod.bindDBEngagement(bound)
  ops.ensurePrimaryOperator('op-writers', 'Writers', 'tok-' + Math.random())
}

describeDB('anchor, export and sanitize writers: one row, one delivery', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-writers-'))
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-writers-out-'))
    seen = []
    eventBus.on('event', listener)
    eventBus.resume()
  })
  afterEach(() => {
    eventBus.off('event', listener)
    eventBus.resume()
    closeHttpBodyIndex()
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  })

  describe('#19 update_pending (anchorBeforeRestart)', () => {
    it('writes one chained row under the open project and delivers it once', async () => {
      open()
      const res = await updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { anchorNow: fakeAnchor('complete', 'abc') })
      expect(res.localError).toBeNull()
      await flush()
      const rows = stored('update_pending')
      expect(rows).toHaveLength(1)
      expect(rows[0].data).toMatchObject({ from_version: '1.0.0', to_version: '1.1.0', anchored_head: 'abc', gap_expected: true })
      expect(stamp(rows[0])).toMatchObject({ door: 'in-process' })
      expect(delivered('update_pending').map((e) => e.id)).toEqual([rows[0].id])
    })

    it('under an API route the row keeps the legacy-api door', async () => {
      open()
      await withEntrance(LEGACY_API, () => updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0' }, { anchorNow: fakeAnchor('complete', 'abc') }))
      expect(stamp(stored('update_pending')[0])).toMatchObject({ door: 'legacy-api' })
    })

    it('with no project bound and none named, nothing is written and the restart stops on localError', async () => {
      open(null)
      const res = await updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0' }, { anchorNow: fakeAnchor('complete', 'abc') })
      expect(res.anchored).toBe(false)
      expect(res.localError).toMatch(/^marker: no project/)
      await flush()
      expect(stored('update_pending')).toHaveLength(0)
      expect(delivered('update_pending')).toHaveLength(0)
    })

    it('another project\'s engagement is refused: not stored, not delivered, reported as not stored', async () => {
      open()
      const res = await updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0', engagementId: 'eng-other' }, { anchorNow: fakeAnchor('complete', 'abc') })
      expect(res.localError).toBe('marker row was not stored')
      await flush()
      expect(stored('update_pending')).toHaveLength(0)
      expect(delivered('update_pending')).toHaveLength(0)
    })

    it('an engagement named in an unbound database is the one written', async () => {
      open(null)
      const res = await updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0', engagementId: 'eng-named' }, { anchorNow: fakeAnchor('complete', 'abc') })
      expect(res.localError).toBeNull()
      const row = dbMod.getDB().prepare("SELECT engagement_id FROM events WHERE agent_type='system'").get() as { engagement_id: string }
      expect(row.engagement_id).toBe('eng-named')
    })

    it('a pause holds the row back from subscribers; it is still stored', async () => {
      open()
      eventBus.pause('ui')
      await updateAnchor.anchorBeforeRestart({ fromVersion: '1.0.0' }, { anchorNow: fakeAnchor('complete', 'abc') })
      await flush()
      expect(delivered('update_pending')).toHaveLength(0)
      expect(stored('update_pending')).toHaveLength(1)
    })
  })

  describe('#20 update_completed / update_not_applied (recordUpdateOutcome)', () => {
    it('returns the stored row and delivers it once', async () => {
      open()
      const done = updateAnchor.recordUpdateOutcome(
        { kind: 'completed', fromVersion: '1.0.0', toVersion: '1.1.0', actualVersion: '1.1.0' }, { engagementId: ENG, operatorId: 'op-writers' })
      expect(done).not.toBeNull()
      await flush()
      const rows = stored('update_completed')
      expect(rows).toHaveLength(1)
      expect(done!.id).toBe(rows[0].id)
      expect(delivered('update_completed').map((e) => e.id)).toEqual([done!.id])
    })

    it('another project\'s engagement returns null and delivers nothing', async () => {
      open()
      const miss = updateAnchor.recordUpdateOutcome(
        { kind: 'not-applied', fromVersion: '1.0.0', toVersion: '1.1.0', actualVersion: '1.0.0' }, { engagementId: 'eng-other', operatorId: 'op-writers' })
      expect(miss).toBeNull()
      await flush()
      expect(delivered('update_not_applied')).toHaveLength(0)
    })
  })

  describe('#21 anchor_failed (anchorNow)', () => {
    it('is stored once and, since the move to the door, delivered once (it was never delivered before)', async () => {
      open()
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-writers' })
      seen = []
      const anchor = await chainAnchor.anchorNow([])
      expect(anchor!.status).toBe('failed')
      await flush()
      const rows = stored('anchor_failed')
      expect(rows).toHaveLength(1)
      expect(rows[0].data).toMatchObject({ calendarsAttempted: 0, eventCount: 1 })
      expect(delivered('anchor_failed').map((e) => e.id)).toEqual([rows[0].id])
    })

    it('under an API route the row keeps the legacy-api door', async () => {
      open()
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-writers' })
      await withEntrance(LEGACY_API, () => chainAnchor.anchorNow([]))
      expect(stamp(stored('anchor_failed')[0])).toMatchObject({ door: 'legacy-api' })
    })

    it('a database bound to its project writes under that project', async () => {
      open()
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-writers' })
      await chainAnchor.anchorNow([])
      const row = dbMod.getDB().prepare("SELECT engagement_id FROM events WHERE data LIKE '%anchor_failed%'").get() as { engagement_id: string }
      expect(row.engagement_id).toBe(ENG)
    })

    it('without a primary operator there is no audit row, and anchorNow still returns the anchor', async () => {
      dbMod.initDB(dir); dbMod.bindDBEngagement(ENG)
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-x' })
      const anchor = await chainAnchor.anchorNow([])
      expect(anchor!.status).toBe('failed')
      await flush()
      expect(stored('anchor_failed')).toHaveLength(0)
      expect(delivered('anchor_failed')).toHaveLength(0)
    })

    it('with no project bound the audit row is not written, silently, and anchorNow still returns the anchor', async () => {
      open(null)
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-writers' })
      const anchor = await chainAnchor.anchorNow([])
      expect(anchor!.status).toBe('failed')
      await flush()
      expect(stored('anchor_failed')).toHaveLength(0)
      expect(delivered('anchor_failed')).toHaveLength(0)
    })
  })

  describe('#22 logged_tier_digest (createDirectBundleExporter)', () => {
    const run = async (task: { kind: string; options?: { outRoot: string } }): Promise<unknown> => {
      if (task.kind === 'logged-digest') return { loggedDigest: { count: 3, sha256: 'a'.repeat(64), oldest: 10, newest: 20 } }
      const art = path.join(task.options!.outRoot, 'bundle-stub')
      fs.mkdirSync(art, { recursive: true })
      fs.writeFileSync(path.join(art, 'manifest.json'), '{}')
      return { artifactPath: art }
    }

    it('writes one digest row under the API door, delivers it once, and the snapshot boundary is the digest row', async () => {
      open()
      let boundary = -1
      const exporter = createDirectBundleExporter(async (task) => {
        if (task.kind === 'direct-bundle') boundary = (task as { options: { snapshot: { chainedMaxRowId: number } } }).options.snapshot.chainedMaxRowId
        return run(task as never) as never
      }, () => ({ id: 'p', name: 'p', path: dir, createdAt: 1, lastOpened: 1 }))
      await withEntrance(LEGACY_API, () => exporter(ENG, {}))
      await flush()
      const rows = stored('logged_tier_digest')
      expect(rows).toHaveLength(1)
      expect(rows[0].data).toMatchObject({ count: 3, reason: 'export' })
      expect(stamp(rows[0])).toMatchObject({ door: 'legacy-api' })
      expect(delivered('logged_tier_digest').map((e) => e.id)).toEqual([rows[0].id])
      const digestRowid = (dbMod.getDB().prepare('SELECT rowid AS r FROM events WHERE id=?').get(rows[0].id) as { r: number }).r
      expect(boundary).toBe(digestRowid)
    })

    it('an empty logged tier writes and delivers nothing', async () => {
      open()
      const exporter = createDirectBundleExporter(async (task) => {
        if (task.kind === 'logged-digest') return { loggedDigest: { count: 0, sha256: '', oldest: null, newest: null } } as never
        return run(task as never) as never
      }, () => ({ id: 'p', name: 'p', path: dir, createdAt: 1, lastOpened: 1 }))
      await exporter(ENG, {})
      await flush()
      expect(stored('logged_tier_digest')).toHaveLength(0)
      expect(delivered('logged_tier_digest')).toHaveLength(0)
    })
  })

  describe('#23 export_sealed (writeExportSeal) and #24 logged_tier_digest (in-process exportBundle)', () => {
    const seal = { subtype: 'export_sealed', events_sha256: 'b'.repeat(64), event_count: 1 }

    it('writeExportSeal returns the stored row read back by id and delivers it once', async () => {
      open()
      const row = bundleExport.writeExportSeal(ENG, { ...seal })
      await flush()
      const rows = stored('export_sealed')
      expect(rows).toHaveLength(1)
      expect(row.id).toBe(rows[0].id)
      expect(row.operator_id).toBe('op-writers')
      expect(typeof row.hash).toBe('string')
      expect(delivered('export_sealed').map((e) => e.id)).toEqual([rows[0].id])
    })

    it('a project with no primary operator is sealed by the stand-in operator, unsigned', async () => {
      dbMod.initDB(dir); dbMod.bindDBEngagement(ENG)
      const row = bundleExport.writeExportSeal(ENG, { ...seal })
      await flush()
      expect(row.operator_id).toBe('unattributed-export')
      expect(delivered('export_sealed')).toHaveLength(1)
    })

    it('a seal that is not a seal throws before anything is written', () => {
      open()
      expect(() => bundleExport.writeExportSeal(ENG, { subtype: 'other' })).toThrow('Not an export seal')
    })

    it('another project\'s engagement cannot be sealed: it throws and delivers nothing', async () => {
      open()
      expect(() => bundleExport.writeExportSeal('eng-other', { ...seal })).toThrow('Export seal could not be recorded')
      await flush()
      expect(delivered('export_sealed')).toHaveLength(0)
    })

    it('in-process exportBundle without a snapshot delivers one digest and one seal, each once', async () => {
      open()
      events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { engagementId: ENG, operatorId: 'op-writers' })
      seen = []
      withEntrance(LEGACY_API, () => bundleExport.exportBundle(ENG, { outRoot: out }))
      await flush()
      const digest = stored('logged_tier_digest')
      const sealed = stored('export_sealed')
      expect(digest).toHaveLength(1)
      expect(sealed).toHaveLength(1)
      expect(delivered('logged_tier_digest').map((e) => e.id)).toEqual([digest[0].id])
      expect(delivered('export_sealed').map((e) => e.id)).toEqual([sealed[0].id])
      expect(stamp(digest[0])).toMatchObject({ door: 'legacy-api' })
      expect(stamp(sealed[0])).toMatchObject({ door: 'legacy-api' })
    })

    it('an empty logged tier writes no digest', async () => {
      open()
      events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { engagementId: ENG, operatorId: 'op-writers' })
      bundleExport.exportBundle(ENG, { outRoot: out })
      await flush()
      expect(stored('logged_tier_digest')).toHaveLength(0)
      expect(delivered('export_sealed')).toHaveLength(1)
    })
  })

  describe('#25 sanitized (sanitize)', () => {
    const OP = { operatorId: 'op-writers', engagementId: ENG }
    const target = (): string => events.insertEvent('shell', {
      subtype: 'command_end', output: 'header\nAKIAIOSFODNN7EXAMPLE trailer',
      redactions: [{ field: 'output', start: 7, end: 27, pattern: 'entropy', hint: '' }]
    }, OP)!.id

    it('stores the audit row, delivers it once, and returns its id', async () => {
      open()
      const id = target()
      seen = []
      const r = withEntrance(LEGACY_API, () => sanitize({ eventIds: [id], fields: ['output'], ...OP }))
      await flush()
      const rows = stored('sanitized')
      expect(rows).toHaveLength(1)
      expect(r.sanitizedEventId).toBe(rows[0].id)
      expect(stamp(rows[0])).toMatchObject({ door: 'legacy-api' })
      expect(delivered('sanitized').map((e) => e.id)).toEqual([rows[0].id])
    })

    it('a dry run writes and delivers nothing', async () => {
      open()
      const id = target()
      sanitize({ eventIds: [id], fields: ['output'], ...OP, dryRun: true })
      await flush()
      expect(delivered('sanitized')).toHaveLength(0)
    })

    it('another project\'s engagement throws and nothing is delivered', async () => {
      open()
      const id = target()
      expect(() => sanitize({ eventIds: [id], fields: ['output'], operatorId: 'op-writers', engagementId: 'eng-other' }))
        .toThrow('Failed to append system.sanitized event')
      await flush()
      expect(delivered('sanitized')).toHaveLength(0)
    })
  })
})
