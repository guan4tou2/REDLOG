// Whether the view the export dialog opens from has been narrowed by the
// operator, for every state a page can contribute. Narrowed: open on "current
// results". Not narrowed: open on the whole project, so the default
// deliverable is not labelled partial evidence.

import { describe, expect, it } from 'vitest'
import { subsetNarrows } from '../src/renderer/src/lib/exportSubsetText'
import type { ExportRequest } from '../src/core/export-plan'

type Subset = NonNullable<ExportRequest['subset']>
const SNAP = { chainedMaxRowId: 1, loggedMaxRowId: 1, chainedCount: 1, loggedCount: 1, chainedTailId: 'a', loggedTailId: null, takenAt: 1 }
// What an untouched view sends as its filter (`toEventFilter`): only the
// default-on exclusion of non-work traffic.
const DEFAULT_FILTER = { hidePersonal: true }

describe('subsetNarrows: the view state each page can export from', () => {
  const sel = (filter: Record<string, unknown>, extra: Record<string, unknown> = {}): Subset =>
    ({ kind: 'selection', projection: 'events', filter, ...extra }) as Subset
  const http = (filter: Record<string, unknown>, h: Record<string, string>): Subset =>
    ({ kind: 'selection', projection: 'http', filter, http: h }) as Subset

  // Dashboard, Terminal, Targets, Scope, Evidence and Settings contribute no
  // export: the dialog exports the filter the app holds.
  it('a page with no contribution, default filter: not narrowed', () => {
    expect(subsetNarrows(sel(DEFAULT_FILTER))).toBe(false)
  })
  it('hiding personal traffic, on or off, is not narrowing', () => {
    expect(subsetNarrows(sel({ hidePersonal: false }))).toBe(false)
    expect(subsetNarrows(sel({}))).toBe(false)
  })
  it('a target picked on the Targets page, a type, a time window, in-scope-only and chain-only narrow it', () => {
    for (const filter of [{ targetId: 'a.test' }, { agentType: 'shell' }, { since: 1 }, { before: 2 }, { inScopeOnly: true }, { tier: 'chained' }]) {
      expect(subsetNarrows(sel({ ...DEFAULT_FILTER, ...filter })), JSON.stringify(filter)).toBe(true)
    }
    expect(subsetNarrows(sel({ ...DEFAULT_FILTER, inScopeOnly: false }))).toBe(false)
  })
  it('Activity page: the housekeeping exclusion is not narrowing; a search query is', () => {
    expect(subsetNarrows(sel(DEFAULT_FILTER, { query: '', excludeHousekeeping: true }))).toBe(false)
    expect(subsetNarrows(sel(DEFAULT_FILTER, { query: '   ', excludeHousekeeping: true }))).toBe(false)
    expect(subsetNarrows(sel(DEFAULT_FILTER, { query: 'nmap', excludeHousekeeping: true }))).toBe(true)
  })
  it('Activity page: an activity or a source session keeps its own subset', () => {
    expect(subsetNarrows({ kind: 'activity', projectId: 'p', anchorEventId: 'e', snapshot: SNAP })).toBe(true)
    expect(subsetNarrows({ kind: 'session', projectId: 'p', anchorEventId: 'e', snapshot: SNAP })).toBe(true)
  })
  it('HTTP page: an empty filter box is not narrowing; method, status, host and text are', () => {
    expect(subsetNarrows(http(DEFAULT_FILTER, { text: '' }))).toBe(false)
    for (const h of [{ text: 'login' }, { method: 'POST' }, { statusPrefix: '4' }, { host: 'a.test' }]) {
      expect(subsetNarrows(http(DEFAULT_FILTER, { text: '', ...h })), JSON.stringify(h)).toBe(true)
    }
  })
  it('Timeline page: the visible slice is a time window, so it narrows', () => {
    expect(subsetNarrows(sel({ ...DEFAULT_FILTER, since: 100, before: 200 }, { excludeHousekeeping: true }))).toBe(true)
  })
  it('a time range narrows; the whole project does not', () => {
    expect(subsetNarrows({ kind: 'time-range', since: 1, before: 2 })).toBe(true)
    expect(subsetNarrows({ kind: 'all' })).toBe(false)
  })
})

