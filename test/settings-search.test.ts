import { describe, it, expect } from 'vitest'
import { matchGroups } from '../src/renderer/src/lib/settingsSearch'
import type { SettingsGroupIndex } from '../src/renderer/src/lib/settingsSearch'

// Settings is 8 tabs / 34 FieldGroups / 234 i18n keys with no way to find a
// setting except remembering its tab (UX-BACKLOG F3). matchGroups is the pure
// seam behind the filter box: given the operator's query and a static index of
// every group (tab + title + the labels inside it), it returns the groups whose
// title OR any label contains the query, case-insensitively, in original order.
// An empty query means "no filter" — the whole index passes through untouched so
// the component can fall back to its normal tabbed view. Keeping the matcher
// pure means the "typing 'exclude' finds the scope exclusion list" behaviour is
// written down and tested, not buried in a 2,681-line component.

const INDEX: SettingsGroupIndex[] = [
  { tab: 'general', groupId: 'engagement', title: 'Engagement', labels: ['ID', 'Name'] },
  { tab: 'scope', groupId: 'excluded', title: 'Excluded Targets', labels: ['Out-of-scope host'] },
  { tab: 'network', groupId: 'polling', title: 'Polling', labels: ['Check interval', 'IP mode'] }
]

describe('matchGroups', () => {
  it('returns the whole index when the query is empty (no filter)', () => {
    expect(matchGroups('', INDEX)).toEqual(INDEX)
  })

  it('treats a whitespace-only query as empty and returns everything', () => {
    expect(matchGroups('   ', INDEX)).toEqual(INDEX)
  })

  it('matches on the group title', () => {
    const hits = matchGroups('polling', INDEX)
    expect(hits.map((g) => g.groupId)).toEqual(['polling'])
  })

  it('matches on a field label inside the group', () => {
    const hits = matchGroups('interval', INDEX)
    expect(hits.map((g) => g.groupId)).toEqual(['polling'])
  })

  it('is case-insensitive over both title and labels', () => {
    expect(matchGroups('ENGAGEMENT', INDEX).map((g) => g.groupId)).toEqual(['engagement'])
    expect(matchGroups('ip MODE', INDEX).map((g) => g.groupId)).toEqual(['polling'])
  })

  it('surfaces the scope exclusion group regardless of tab (the F3 acceptance case)', () => {
    const hits = matchGroups('exclude', INDEX)
    expect(hits.map((g) => g.groupId)).toEqual(['excluded'])
    expect(hits[0].tab).toBe('scope')
  })

  it('returns [] when nothing matches', () => {
    expect(matchGroups('nonexistent-xyz', INDEX)).toEqual([])
  })

  it('preserves the original order of the index for multi-hit queries', () => {
    // "e" appears in Engagement (title), Excluded (title) and Polling
    // (label "Check interval") — all three, so order is observable.
    const hits = matchGroups('e', INDEX)
    expect(hits.map((g) => g.groupId)).toEqual(['engagement', 'excluded', 'polling'])
  })
})
