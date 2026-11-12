import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requires } from './helpers/requires'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** events.jsonl keeps `data` as the stored JSON string, exactly as the row held
 *  it — the bundle is a copy of the table, not a re-rendering of it. */
const readJsonl = (file: string): Array<Record<string, unknown> & { data: Record<string, unknown> }> =>
  fs.readFileSync(file, 'utf-8').trim().split('\n')
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }))

// Design turn 8b, constraint (e): what leaves the app must still be true. An
// amendment is written after the moment its marker belongs to, so every export
// path that slices by time can ship a finding with wording the operator has
// since retracted — an export that misstates the operator's own conclusion. The
// bundle carries both rows and still verifies. Approved Timeline selection
// boundaries are exercised through the real IPC export in export-plan-ipc.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let amendMod: typeof import('../src/core/marker-amend') | null = null
let bundle: typeof import('../src/core/bundle-export') | null = null
let sanitizeMod: typeof import('../src/core/sanitize') | null = null
let retention: typeof import('../src/core/retention') | null = null
let chain: typeof import('../src/core/chain-anchor') | null = null
if (requires('better-sqlite3').ok) {
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  amendMod = await import('../src/core/marker-amend')
  bundle = await import('../src/core/bundle-export')
  sanitizeMod = await import('../src/core/sanitize')
  retention = await import('../src/core/retention')
  chain = await import('../src/core/chain-anchor')
}

const available = events !== null
const OPTS = { engagementId: 'eng', operatorId: 'op' }

describe.skipIf(!available)('an amended marker on the way out', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bundle-amend-'))
    dbmod!.initDB(dir)
  })
  afterEach(() => {
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const marker = (): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('marker', { title: 'original title', severity: 'info', notes: 'first pass' }, OPTS)!

  it('ships both rows, with the original exactly as it was written', () => {
    const m = marker()
    amendMod!.amendMarker(m.id, { title: 'corrected title', severity: 'critical' }, OPTS)
    const out = bundle!.exportBundle('eng', { outRoot: path.join(dir, 'exports') })
    const lines = readJsonl(path.join(out.outDir, 'events.jsonl'))

    const exported = lines.find((l) => l.id === m.id)
    expect(exported.data.title, 'the export rewrote the original').toBe('original title')
    expect(exported.data.severity).toBe('info')
    const amendment = lines.find((l) => l.data?.subtype === 'amended')
    expect(amendment.data.markerId).toBe(m.id)
    // Insertion order: a reader walks the file and sees the correction after
    // the thing it corrects.
    expect(lines.indexOf(exported)).toBeLessThan(lines.indexOf(amendment))
  })

  it('leaves the chain verifying with amendments in it', async () => {
    const m = marker()
    amendMod!.amendMarker(m.id, { title: 'second' }, OPTS)
    amendMod!.amendMarker(m.id, { notes: 'third' }, OPTS)
    expect((await chain!.verifyChainFullAsync()).ok).toBe(true)
  })

  it('sanitizes each row on its own — listing one does not cover the other', () => {
    // sanitize is keyed (source_event_id, field), so redacting a note on the
    // marker leaves the same text visible in every amendment that restated it.
    // Worth a failing export rather than a quiet half-masked one, so it is
    // asserted here and documented in the schema.
    const secret = 'placeholder' + '-' + '0123456789abcdef'
    const m = events!.insertEvent('marker', {
      title: 'has a secret', severity: 'info', notes: `pw ${secret}`,
      redactions: [{ field: 'notes', pattern: 'denylist', hint: 'x', start: 3, end: 3 + secret.length }]
    }, OPTS)!
    const r = amendMod!.amendMarker(m.id, { notes: `still ${secret}` }, OPTS)
    const amendmentId = (r as { ok: true; event: import('../src/core/db/events').RedLogEvent }).event.id

    const planned = sanitizeMod!.sanitize({ eventIds: [m.id], fields: ['notes'], ...OPTS })
    expect(planned.planned.map((x) => x.eventId)).toEqual([m.id])

    const out = bundle!.exportBundle('eng', { outRoot: path.join(dir, 'exports') })
    const lines = readJsonl(path.join(out.outDir, 'events.jsonl'))
    expect(String(lines.find((l) => l.id === m.id)!.data.notes)).not.toContain(secret)
    expect(String(lines.find((l) => l.id === amendmentId)!.data.notes), 'the amendment was masked without being asked for').toContain(secret)
  })

  it('never prunes a correction — retention deletes nothing chained', () => {
    const m = marker()
    amendMod!.amendMarker(m.id, { title: 'corrected' }, OPTS)
    const before = events!.getEventCount()
    retention!.sweepLoggedTier({ keepDays: 0 }, OPTS)
    expect(events!.getEventCount()).toBe(before)
  })
})
