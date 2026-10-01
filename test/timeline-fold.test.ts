// Folding a tool's traffic under the command that produced it.
//
// A fold is a causal claim in a record handed to a client, so there is one
// rule and it is not a heuristic: a child is an event whose `_causes` names a
// parent in the list. No User-Agent matching, no time windows, no "same host
// and close together" — `causes-resolver.ts` already drew that line for file
// events and wrote down why ("an investigation hint, not proof").
//
// The failure this avoids is concrete: the operator's own manual
// POST /admin/delete lands inside a dirb run's window, folds under it, and
// the collapsed row reads "automated enumeration, 920 flows". The client's
// counsel sees a scan, not a destructive request someone typed.

import { describe, it, expect } from 'vitest'
import { foldByCause, neverFold, statusSummary, MIN_FOLD_CHILDREN } from '../src/renderer/src/lib/timelineFold'
import type { RedLogEvent } from '../src/core/db/event-types'

let seq = 0
const ev = (id: string, agentType: string, data: Record<string, unknown> = {}): RedLogEvent => ({
  id, timestamp: ++seq, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: seq
} as RedLogEvent)

const flow = (id: string, cause?: string, extra: Record<string, unknown> = {}): RedLogEvent =>
  ev(id, 'scanner', { subtype: 'http_request_start', status: 404, ...(cause ? { _causes: [cause] } : {}), ...extra })

const kinds = (rows: ReturnType<typeof foldByCause>): string[] =>
  rows.map((r) => (r.kind === 'fold' ? `fold:${r.fold.parent.id}:${r.fold.children.length}` : r.event.id))

describe('what folds', () => {
  it('folds flows the record says that command caused', () => {
    const cmd = ev('dirb', 'shell', { subtype: 'command_start', command: 'dirb http://h' })
    const rows = foldByCause([cmd, flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb')])
    expect(kinds(rows)).toEqual(['fold:dirb:3'])
  })

  it('leaves the parent in its own place in time', () => {
    const before = ev('before', 'shell', { subtype: 'command_start' })
    const cmd = ev('dirb', 'shell', { subtype: 'command_start' })
    const rows = foldByCause([before, cmd, flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb')])
    expect(kinds(rows)).toEqual(['before', 'fold:dirb:3'])
  })

  it('does not fold a handful — hiding three rows to show a row about them', () => {
    const cmd = ev('curl', 'shell', { subtype: 'command_start' })
    const few = Array.from({ length: MIN_FOLD_CHILDREN - 1 }, (_, i) => flow(`f${i}`, 'curl'))
    expect(kinds(foldByCause([cmd, ...few]))).toEqual(['curl', ...few.map((f) => f.id)])
  })
})

describe('what it refuses to fold', () => {
  it('leaves traffic with no recorded cause exactly where it is', () => {
    // The browser request inside the scan's window. This is the whole point.
    const cmd = ev('dirb', 'shell', {})
    const rows = foldByCause([
      cmd, flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb'), flow('manual')
    ])
    expect(kinds(rows)).toEqual(['fold:dirb:3', 'manual'])
  })

  it('never folds an out-of-scope hit', () => {
    // A collapsed anomaly is an anomaly nobody sees, and it is the reason to
    // be looking at all.
    const cmd = ev('dirb', 'shell', {})
    const oos = flow('oos', 'dirb', { inScope: false })
    const rows = foldByCause([cmd, flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb'), oos])
    expect(kinds(rows)).toEqual(['fold:dirb:3', 'oos'])
  })

  it('never folds the moment access changed', () => {
    const cmd = ev('dirb', 'shell', {})
    const setCookie = flow('auth', 'dirb', { set_cookies: [{ name: 'session' }] })
    const unauthorised = flow('401', 'dirb', { status: 401 })
    const rows = foldByCause([
      cmd, flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb'), setCookie, unauthorised
    ])
    expect(kinds(rows)).toEqual(['fold:dirb:3', 'auth', '401'])
  })

  it('never folds what the operator made or touched', () => {
    const cmd = ev('dirb', 'shell', {})
    const kids = [flow('f1', 'dirb'), flow('f2', 'dirb'), flow('f3', 'dirb')]
    const noted = flow('noted', 'dirb')
    const open = flow('open', 'dirb')
    const rows = foldByCause([cmd, ...kids, noted, open], {
      annotated: new Set(['noted']), selected: 'open'
    })
    expect(kinds(rows)).toEqual(['fold:dirb:3', 'noted', 'open'])
  })

  it('never folds a failed command', () => {
    expect(neverFold(ev('x', 'shell', { exitCode: 1 }))).toBe(true)
    expect(neverFold(ev('x', 'shell', { exitCode: 0 }))).toBe(false)
  })

  it('ignores a cause that is not in this list', () => {
    // A parent on an earlier page. Folding under a row that is not on screen
    // would hide the children behind nothing.
    const rows = foldByCause([flow('f1', 'offscreen'), flow('f2', 'offscreen'), flow('f3', 'offscreen')])
    expect(kinds(rows)).toEqual(['f1', 'f2', 'f3'])
  })

  it('ignores an event citing itself', () => {
    const self = flow('self', 'self')
    expect(kinds(foldByCause([self]))).toEqual(['self'])
  })

  it('puts an event with several causes under one parent, not both', () => {
    // A reader counting rows must not count the same request twice.
    const a = ev('a', 'shell', {})
    const b = ev('b', 'shell', {})
    const multi = [1, 2, 3].map((i) => flow(`m${i}`, undefined, { _causes: ['a', 'b'] }))
    const rows = foldByCause([a, b, ...multi])
    const folded = rows.filter((r) => r.kind === 'fold')
    expect(folded).toHaveLength(1)
    expect(folded[0].kind === 'fold' && folded[0].fold.children).toHaveLength(3)
  })

  it('never shows a row inside two folds', () => {
    const outer = ev('outer', 'shell', {})
    const mid = ev('mid', 'shell', { _causes: ['outer'] })
    const rows = foldByCause([
      outer, mid,
      flow('a1', 'outer'), flow('a2', 'outer'),
      flow('b1', 'mid'), flow('b2', 'mid'), flow('b3', 'mid')
    ])
    const ids = rows.flatMap((r) => r.kind === 'fold'
      ? [r.fold.parent.id, ...r.fold.children.map((c) => c.id)]
      : [r.event.id])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns an empty list unchanged', () => {
    expect(foldByCause([])).toEqual([])
  })
})

describe('the summary line', () => {
  it('counts status classes, busiest first', () => {
    const kids = [
      ...Array.from({ length: 904 }, (_, i) => flow(`a${i}`, 'c', { status: 404 })),
      ...Array.from({ length: 12 }, (_, i) => flow(`b${i}`, 'c', { status: 200 })),
      ...Array.from({ length: 4 }, (_, i) => flow(`c${i}`, 'c', { status: 301 }))
    ]
    expect(statusSummary(kids)).toEqual([
      { status: 404, count: 904 }, { status: 200, count: 12 }, { status: 301, count: 4 }
    ])
  })

  it('says nothing about children that carry no status', () => {
    expect(statusSummary([ev('x', 'shell', {})])).toEqual([])
  })
})
