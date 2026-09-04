import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  foldMarker, foldAllMarkers, groupAmendments, compareAmendments, diffAgainst,
  isMarkerAmendment, isMarkerOriginal, amendedFields, MARKER_SEVERITIES
} from '../src/renderer/src/lib/markerFold'
import type { RedLogEvent } from '../src/core/db/events'

// docs/DESIGN-core-and-capture.md §1, design turn 8b. The claim under test is
// not "the last value wins" — it is that the effective marker can be derived
// from the chain alone, that deriving it never touches what was written, and
// that the count an operator reads never disagrees with the number of rows the
// record actually holds.

let seq = 0
const ev = (o: Partial<RedLogEvent> & { data: Record<string, unknown> }): RedLogEvent => {
  seq += 1
  return {
    id: `evt-${String(seq).padStart(4, '0')}`,
    timestamp: 1_700_000_000_000 + seq,
    engagementId: 'eng', sessionId: 'sess', operatorId: 'op',
    agentType: 'marker', hostname: 'host', sourceIP: null, targetId: null,
    createdAt: 1_700_000_000_000 + seq,
    monotonicNs: mono(1_700_000_000_000, seq),
    ...o
  }
}
/** The real shape: 14-char boot epoch, hyphen, 20-char padded nanoseconds. */
const mono = (bootMs: number, ns: number): string =>
  `${String(bootMs).padStart(14, '0')}-${String(ns).padStart(20, '0')}`

const marker = (d: Record<string, unknown> = {}): RedLogEvent =>
  ev({ data: { title: 'original title', severity: 'info', notes: 'first pass', category: 'custom', ...d } })

const amend = (markerId: string, changes: Record<string, unknown>, o: Partial<RedLogEvent> = {}): RedLogEvent =>
  ev({ data: { subtype: 'amended', markerId, _causes: [markerId], ...changes }, ...o })

describe('telling an amendment from a marker', () => {
  it('needs the subtype AND a string markerId — half a shape is not an amendment', () => {
    const m = marker()
    expect(isMarkerAmendment(amend(m.id, { title: 'x' }))).toBe(true)
    expect(isMarkerAmendment(ev({ data: { subtype: 'amended', title: 'x' } }))).toBe(false)
    expect(isMarkerAmendment(ev({ data: { markerId: m.id, title: 'x' } }))).toBe(false)
    expect(isMarkerAmendment(ev({ agentType: 'shell', data: { subtype: 'amended', markerId: m.id } }))).toBe(false)
  })

  it('treats a marker carrying some other subtype as amendable', () => {
    // /api/events and plugin appendEvent write marker rows verbatim, so these
    // exist. Defining "original" as "no subtype" would make the feature
    // unavailable precisely where the record is least controlled.
    expect(isMarkerOriginal(ev({ data: { subtype: 'finding', title: 'from a plugin' } }))).toBe(true)
    expect(isMarkerOriginal(marker())).toBe(true)
    expect(isMarkerOriginal(amend('evt-0001', { title: 'x' }))).toBe(false)
  })

  it('reports only the fields an amendment carries', () => {
    expect(amendedFields(amend('m', { severity: 'critical' }))).toEqual(['severity'])
    expect(amendedFields(amend('m', { notes: 'n', title: 't' }))).toEqual(['title', 'notes'])
    // Structural only — callers ask it about a row they have already decided is
    // an amendment, so a plain marker naturally reports all three.
    expect(amendedFields(marker())).toEqual(['title', 'severity', 'notes'])
  })
})

describe('folding a marker', () => {
  it('with no amendments reads exactly as it was written', () => {
    const m = marker()
    const f = foldMarker(m, [])
    expect(f.effective).toEqual({ title: 'original title', severity: 'info', notes: 'first pass' })
    expect(f.amendCount).toBe(0)
    expect(f.history).toEqual([])
  })

  it('replaces only the field the amendment carries', () => {
    const m = marker()
    const f = foldMarker(m, [amend(m.id, { title: 'corrected title' })])
    expect(f.effective).toEqual({ title: 'corrected title', severity: 'info', notes: 'first pass' })
    expect(f.amendCount).toBe(1)
    expect(f.history[0].changes).toEqual([{ field: 'title', from: 'original title', to: 'corrected title' }])
  })

  it('takes the latest amendment even when the input arrives out of order', () => {
    const m = marker()
    const first = amend(m.id, { severity: 'important' })
    const second = amend(m.id, { severity: 'critical' })
    expect(foldMarker(m, [second, first]).effective.severity).toBe('critical')
    expect(foldMarker(m, [first, second]).effective.severity).toBe('critical')
  })

  it('diffs each amendment against the value in force, not against the original', () => {
    const m = marker()
    const f = foldMarker(m, [amend(m.id, { title: 'second' }), amend(m.id, { title: 'third' })])
    expect(f.history[1].changes).toEqual([{ field: 'title', from: 'second', to: 'third' }])
  })

  it('ignores an amendment addressed at a different marker', () => {
    const m = marker()
    const other = marker()
    const f = foldMarker(m, [amend(other.id, { title: 'not mine' })])
    expect(f.effective.title).toBe('original title')
    expect(f.amendCount).toBe(0)
  })

  it('cannot move the drop point, the category, or the envelope', () => {
    const m = marker({ atTimestamp: 1_699_999_000_000 })
    const rogue = amend(m.id, {
      title: 'ok', atTimestamp: 1, category: 'exfiltration', source: 'forged', timestamp: 1
    })
    const f = foldMarker(m, [rogue])
    expect(f.effective).toEqual({ title: 'ok', severity: 'info', notes: 'first pass' })
    expect(f.history[0].changes.map((c) => c.field)).toEqual(['title'])
    expect(m.data.atTimestamp).toBe(1_699_999_000_000)
  })

  it('counts a nonsense amendment but applies nothing from it', () => {
    // A plugin writes marker rows unvalidated. The count must match the chain
    // even when the payload does not: 「已修訂 2 次」 beside three rows is the app
    // contradicting the record.
    const m = marker()
    const bad = [
      amend(m.id, { severity: 'high' }),      // not in the vocabulary
      amend(m.id, { severity: 42 }),
      amend(m.id, { title: '   ' })            // whitespace is not a title
    ]
    const f = foldMarker(m, bad)
    expect(f.amendCount).toBe(3)
    expect(f.history.map((h) => h.changes)).toEqual([[], [], []])
    expect(f.effective).toEqual({ title: 'original title', severity: 'info', notes: 'first pass' })
  })

  it('records an amendment that restates the value in force, with no change', () => {
    const m = marker()
    const f = foldMarker(m, [amend(m.id, { title: 'original title' })])
    expect(f.amendCount).toBe(1)
    expect(f.history[0].changes).toEqual([])
  })

  it('lets an amendment blank the notes only through an explicit non-empty value', () => {
    // Deliberate: '' is how a caller says "I am not touching this field" once
    // the payload is flat, so erasing a note is not expressible. Clearing
    // evidence silently is the failure mode this side of the trade avoids.
    const m = marker()
    expect(foldMarker(m, [amend(m.id, { notes: '' })]).effective.notes).toBe('first pass')
    expect(foldMarker(m, [amend(m.id, { notes: '—' })]).effective.notes).toBe('—')
  })

  it('does not mutate its inputs', () => {
    const m = marker()
    const a = amend(m.id, { title: 'corrected', severity: 'critical' })
    const before = JSON.stringify([m, a])
    foldMarker(m, [a])
    expect(JSON.stringify([m, a])).toBe(before)
  })
})

describe('chain order', () => {
  it('orders same-millisecond amendments by monotonic clock, not by id', () => {
    // The regression this exists for: Timeline's comparator does BigInt() on a
    // monotonicNs that carries a `bootMs-ns` prefix, which throws, so its
    // same-ms tiebreak silently degrades to comparing UUIDs. Ported as-is,
    // "the latest correction wins" would have meant "the highest random id
    // wins". These two rows share a millisecond and are deliberately named so
    // that id order is the REVERSE of chain order.
    const m = marker()
    const older = ev({ id: 'zzz-written-first', createdAt: 5, timestamp: 5, monotonicNs: mono(1_700_000_000_000, 10), data: { subtype: 'amended', markerId: m.id, title: 'written first' } })
    const newer = ev({ id: 'aaa-written-second', createdAt: 5, timestamp: 5, monotonicNs: mono(1_700_000_000_000, 11), data: { subtype: 'amended', markerId: m.id, title: 'written second' } })
    expect(foldMarker(m, [older, newer]).effective.title).toBe('written second')
    expect(foldMarker(m, [newer, older]).effective.title).toBe('written second')
    // And the naive path really would have thrown rather than compared.
    expect(() => BigInt(newer.monotonicNs!)).toThrow()
  })

  it('sorts across a process restart by boot epoch first', () => {
    const m = marker()
    const beforeRestart = ev({ createdAt: 9, monotonicNs: mono(1_700_000_000_000, 999_999), data: { subtype: 'amended', markerId: m.id, title: 'earlier boot' } })
    const afterRestart = ev({ createdAt: 9, monotonicNs: mono(1_700_000_900_000, 1), data: { subtype: 'amended', markerId: m.id, title: 'later boot' } })
    expect(foldMarker(m, [afterRestart, beforeRestart]).effective.title).toBe('later boot')
  })

  it('falls back to created_at, then id, when the monotonic clock is missing', () => {
    const a = ev({ id: 'a', createdAt: 100, monotonicNs: null, data: {} })
    const b = ev({ id: 'b', createdAt: 200, monotonicNs: null, data: {} })
    const c = ev({ id: 'c', createdAt: 200, monotonicNs: null, data: {} })
    expect(compareAmendments(a, b)).toBeLessThan(0)
    expect(compareAmendments(c, b)).toBeGreaterThan(0)
    expect(compareAmendments(b, b)).toBe(0)
  })

  it('sorts a pre-prefix row ahead of a prefixed one rather than throwing', () => {
    const legacy = ev({ createdAt: 1, monotonicNs: '00000000000000000042', data: {} })
    const modern = ev({ createdAt: 1, monotonicNs: mono(1_700_000_000_000, 1), data: {} })
    expect(compareAmendments(legacy, modern)).toBeLessThan(0)
  })
})

describe('grouping and folding a mixed list', () => {
  it('groups by the marker named, never by the amendment id', () => {
    const m1 = marker(); const m2 = marker()
    const g = groupAmendments([m1, amend(m1.id, { title: 'a' }), m2, amend(m2.id, { title: 'b' }), amend(m1.id, { title: 'c' })])
    expect([...g.keys()].sort()).toEqual([m1.id, m2.id].sort())
    expect(g.get(m1.id)!.map((e) => e.data.title)).toEqual(['a', 'c'])
  })

  it('folds every amended marker in one pass and leaves untouched ones out', () => {
    const amended = marker(); const untouched = marker()
    const folds = foldAllMarkers([amended, untouched, amend(amended.id, { severity: 'critical' })])
    expect([...folds.keys()]).toEqual([amended.id])
    expect(folds.get(amended.id)!.effective.severity).toBe('critical')
  })

  it('drops an amendment whose marker is not in the list', () => {
    const orphan = amend('a-marker-not-here', { title: 'x' })
    expect(foldAllMarkers([marker(), orphan]).size).toBe(0)
    expect(groupAmendments([orphan]).has('a-marker-not-here')).toBe(true)
  })
})

describe('the no-op guard', () => {
  const effective = { title: 'title', severity: 'info', notes: 'notes' }

  it('returns nothing for an identical draft, so commit writes no row', () => {
    expect(diffAgainst(effective, { title: 'title', severity: 'info', notes: 'notes' })).toEqual({})
  })

  it('returns only what actually differs', () => {
    expect(diffAgainst(effective, { title: 'new', severity: 'info' })).toEqual({ title: 'new' })
  })

  it('trims a title but never the notes', () => {
    expect(diffAgainst(effective, { title: '  title  ' })).toEqual({})
    expect(diffAgainst(effective, { notes: 'notes ' })).toEqual({ notes: 'notes ' })
  })

  it('refuses an empty title and an unknown severity', () => {
    expect(diffAgainst(effective, { title: '   ' })).toEqual({})
    expect(diffAgainst(effective, { severity: 'high' })).toEqual({})
  })
})

describe('the vocabulary that spans the bundle boundary', () => {
  it('matches the copy in src/core/marker-amend.ts', () => {
    // The renderer and main bundles share no module graph (lib/defaults.ts),
    // so the severity list is written twice on purpose. This reads both
    // sources rather than importing, which is the only way to notice a drift
    // that nothing else would fail on.
    const core = fs.readFileSync(path.join(__dirname, '../src/core/marker-amend.ts'), 'utf-8')
    const m = core.match(/MARKER_SEVERITIES\s*=\s*\[([^\]]+)\]/)
    expect(m, 'MARKER_SEVERITIES not found in src/core/marker-amend.ts').toBeTruthy()
    const coreList = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect(coreList).toEqual([...MARKER_SEVERITIES])
  })

  it('shares one monotonic comparator with the timeline', () => {
    // These used to disagree: Timeline's tiebreak did BigInt() on a stamp that
    // carries a boot prefix, so it threw every time and ordered ties by UUID.
    // Two answers to "which happened first" is one too many.
    const tl = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/Timeline.tsx'), 'utf-8')
    const fold = fs.readFileSync(path.join(__dirname, '../src/renderer/src/lib/markerFold.ts'), 'utf-8')
    expect(tl).toContain('compareMonotonicNs')
    expect(fold).toContain('compareMonotonicNs')
    expect(tl, 'the dead BigInt tiebreak is back').not.toMatch(/BigInt\(am\)|BigInt\(a\.monotonicNs\)/)
  })
})
