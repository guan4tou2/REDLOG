import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// docs/DESIGN-core-and-capture.md §1, design turn 8b. The fold is unit-tested in
// marker-fold.test.ts; this drives the write path against a real database,
// because the claim worth proving is not "a row lands" — it is that correcting a
// finding leaves the original byte-for-byte intact and the chain still verifying.
// If that fails, the feature has turned an audit log into a document.

// The binding only loads on the first `new Database`, so an import-only guard
// reports "available" and then every test dies inside the module under test.
// This repo routinely carries node_modules built for Electron's ABI.
let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let amendMod: typeof import('../src/core/marker-amend') | null = null
let chain: typeof import('../src/core/chain-anchor') | null = null
let bus: typeof import('../src/core/event-bus') | null = null
let redaction: typeof import('../src/core/redaction') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  amendMod = await import('../src/core/marker-amend')
  chain = await import('../src/core/chain-anchor')
  bus = await import('../src/core/event-bus')
  redaction = await import('../src/core/redaction')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = events !== null
const OPTS = { engagementId: 'eng', operatorId: 'op' }

describe.skipIf(!available)('amending a marker', () => {
  let dir: string

  const marker = (data: Record<string, unknown> = {}): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('marker', { title: 'original title', severity: 'info', notes: 'first pass', category: 'custom', ...data }, OPTS)!

  const row = (id: string): Record<string, unknown> =>
    dbmod!.getDB().prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-amend-'))
    dbmod!.initDB(dir)
    bus!.eventBus.resume()
    redaction!.configureRedaction(redaction!.DEFAULT_RULES)
  })
  afterEach(() => {
    bus!.eventBus.resume()
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('appends exactly one row carrying only what changed', () => {
    const m = marker()
    const before = events!.getEventCount()
    const r = amendMod!.amendMarker(m.id, { title: 'corrected title' }, OPTS)
    expect(r.ok).toBe(true)
    expect(events!.getEventCount()).toBe(before + 1)

    const ev = (r as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event
    expect(ev.agentType).toBe('marker')
    expect(ev.data.subtype).toBe('amended')
    expect(ev.data.markerId).toBe(m.id)
    expect(ev.data._causes).toEqual([m.id])
    // Only the changed key — an amendment that restated every field would make
    // "what did this correction actually change" unanswerable from the row.
    expect(Object.keys(ev.data).sort()).toEqual(['_causes', 'markerId', 'subtype', 'title'])
  })

  it('leaves the original byte-for-byte identical after three amendments', () => {
    const m = marker()
    const before = row(m.id)
    amendMod!.amendMarker(m.id, { title: 'second' }, OPTS)
    amendMod!.amendMarker(m.id, { severity: 'critical' }, OPTS)
    amendMod!.amendMarker(m.id, { notes: 'third pass' }, OPTS)
    expect(row(m.id)).toEqual(before)
  })

  it('could not have edited it in place even if it tried', () => {
    // The alternative, on the record: the database refuses. This is why an
    // amendment is a new row rather than an UPDATE with a history table.
    const m = marker()
    expect(() =>
      dbmod!.getDB().prepare('UPDATE events SET data = ? WHERE id = ?').run('{"title":"tampered"}', m.id)
    ).toThrow(/immutable|append-only|abort/i)
    expect(() => dbmod!.getDB().prepare('DELETE FROM events WHERE id = ?').run(m.id)).toThrow()
  })

  it('keeps the hash chain intact', () => {
    const m = marker()
    amendMod!.amendMarker(m.id, { title: 'second' }, OPTS)
    const third = amendMod!.amendMarker(m.id, { severity: 'critical' }, OPTS)
    const ev = (third as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event
    const all = events!.queryEvents({ limit: 100 })
    const prior = all.find((e) => e.hash === ev.prevHash)
    expect(prior, 'the amendment does not link to any row').toBeTruthy()
    const verdict = chain!.verifyChainFull()
    expect(verdict.ok).toBe(true)
  })

  it('inherits the marker target so it cannot escape a scoped export', () => {
    const m = events!.insertEvent('marker', { title: 'on a target', severity: 'info' }, { ...OPTS, targetId: '10.10.11.24' })!
    const r = amendMod!.amendMarker(m.id, { title: 'corrected' }, OPTS)
    expect((r as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event.targetId).toBe('10.10.11.24')
  })

  it('records while recording is paused', () => {
    // §10 promises an explicit "write this down" records while paused, and a
    // correction is exactly that. `marker` is pause-exempt at insert.
    const m = marker()
    bus!.eventBus.pause()
    expect(amendMod!.amendMarker(m.id, { title: 'noticed while paused' }, OPTS).ok).toBe(true)
  })

  it('lands in the chained tier', () => {
    // A logged-tier amendment would be swept by retention after 30 days and the
    // marker would silently revert to what it used to say — a change of record
    // with no record of the change.
    expect(events!.classifyTier('marker', { subtype: 'amended' })).toBe('chained')
    const m = marker()
    const r = amendMod!.amendMarker(m.id, { title: 'x' }, OPTS)
    expect((r as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event.hash).toBeTruthy()
  })

  it('attaches redaction spans so a secret in a note can still be masked at export', () => {
    const secret = 'placeholder' + '-' + '0123456789abcdef'
    redaction!.configureRedaction({ ...redaction!.DEFAULT_RULES, denylist: [secret] })
    const m = marker()
    const r = amendMod!.amendMarker(m.id, { notes: `found ${secret}` }, OPTS)
    const ev = (r as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event
    const spans = ev.data.redactions as Array<{ field: string }> | undefined
    expect(spans?.map((s) => s.field)).toEqual(['notes'])
    // Raw bytes stay — the hash closes over the true text (four-layer design).
    expect(ev.data.notes).toBe(`found ${secret}`)
  })

  describe('refusals, each named rather than silently dropped', () => {
    it('unknown marker id', () => {
      expect(amendMod!.amendMarker('no-such-id', { title: 'x' }, OPTS)).toMatchObject({ ok: false, error: 'not-found' })
    })

    it('a non-marker event', () => {
      const shell = events!.insertEvent('shell', { subtype: 'command_end', command: 'id', exitCode: 0 }, OPTS)!
      expect(amendMod!.amendMarker(shell.id, { title: 'x' }, OPTS)).toMatchObject({ ok: false, error: 'not-a-marker' })
    })

    it('an amendment — a correction of a correction is just another correction', () => {
      const m = marker()
      const first = amendMod!.amendMarker(m.id, { title: 'second' }, OPTS)
      const id = (first as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event.id
      expect(amendMod!.amendMarker(id, { title: 'third' }, OPTS)).toMatchObject({ ok: false, error: 'not-a-marker' })
    })

    it('an unknown field, NAMED — the drop-by-omission that lost atTimestamp', () => {
      const m = marker()
      const r = amendMod!.amendMarker(m.id, { atTimestamp: 1 } as never, OPTS)
      expect(r).toMatchObject({ ok: false, error: 'invalid-changes' })
      expect((r as { detail: string }).detail).toContain('atTimestamp')
    })

    it('an empty change set', () => {
      const m = marker()
      expect(amendMod!.amendMarker(m.id, {}, OPTS)).toMatchObject({ ok: false, error: 'invalid-changes' })
    })

    it('a severity outside the vocabulary, and a blank title', () => {
      const m = marker()
      expect(amendMod!.amendMarker(m.id, { severity: 'high' }, OPTS)).toMatchObject({ ok: false, error: 'invalid-changes' })
      expect(amendMod!.amendMarker(m.id, { title: '   ' }, OPTS)).toMatchObject({ ok: false, error: 'invalid-changes' })
    })

    it('writes nothing when it refuses', () => {
      const m = marker()
      const before = events!.getEventCount()
      amendMod!.amendMarker(m.id, { severity: 'high' }, OPTS)
      amendMod!.amendMarker('no-such-id', { title: 'x' }, OPTS)
      expect(events!.getEventCount()).toBe(before)
    })
  })

  describe('reading amendments back', () => {
    it('returns only the amendments of the markers asked for, oldest first', () => {
      const a = marker(); const b = marker()
      amendMod!.amendMarker(a.id, { title: 'a1' }, OPTS)
      amendMod!.amendMarker(b.id, { title: 'b1' }, OPTS)
      amendMod!.amendMarker(a.id, { title: 'a2' }, OPTS)
      const got = events!.queryMarkerAmendments([a.id])
      expect(got.map((e) => e.data.title)).toEqual(['a1', 'a2'])
      expect(events!.queryMarkerAmendments([a.id, b.id])).toHaveLength(3)
      expect(events!.queryMarkerAmendments(['nobody'])).toEqual([])
      expect(events!.queryMarkerAmendments([])).toEqual([])
    })

    it('tags each row with the tier it really came from', () => {
      // The union projects its tier literally; rowToEvent would otherwise
      // default a missing hint to `chained` and a logged row would arrive
      // claiming a hash chain it was never part of.
      const m = marker()
      amendMod!.amendMarker(m.id, { title: 'x' }, OPTS)
      expect(events!.queryMarkerAmendments([m.id]).map((e) => e.tier)).toEqual(['chained'])
    })

    it('chunks a long id list without a variable-count error', () => {
      const m = marker()
      amendMod!.amendMarker(m.id, { title: 'x' }, OPTS)
      const ids = [m.id, ...Array.from({ length: 900 }, (_, i) => `pad-${i}`)]
      expect(events!.queryMarkerAmendments(ids)).toHaveLength(1)
    })
  })

  describe('what search can and cannot do afterwards', () => {
    it('still finds the marker by what it used to say, and the amendment by what it says now', () => {
      // searchEvents is a LIKE over each row's own bytes. The original keeps its
      // recorded title — that IS "the original is still searchable" — and the new
      // title exists only on the amendment row, which is why SearchPanel has to
      // resolve an amendment hit back to its marker rather than show the operator
      // a bare correction with no finding attached.
      const m = marker()
      amendMod!.amendMarker(m.id, { title: 'corrected title' }, OPTS)
      const old = events!.searchEvents('original title')
      expect(old.map((e) => e.id)).toContain(m.id)
      const fresh = events!.searchEvents('corrected title')
      expect(fresh.map((e) => e.id)).not.toContain(m.id)
      expect(fresh.every((e) => e.data.subtype === 'amended')).toBe(true)
    })
  })
})
