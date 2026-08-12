// Pure matcher behind the Settings filter box (UX-BACKLOG F3 / DESIGN-PRINCIPLES
// §9). Settings is 8 tabs of FieldGroups and the only way to find a setting is
// remembering its tab; this seam lets the header input filter groups by title
// and field-label text so the operator can "find it" instead of re-tabbing.
//
// The index is static presentation data — one entry per FieldGroup, carrying its
// owning tab, a stable id, its resolved (localized) title, and the resolved
// labels of the fields inside it. Keeping the match rule out of the component
// keeps the behaviour tested and the component thin.

export interface SettingsGroupIndex {
  tab: string
  groupId: string
  title: string
  labels: string[]
}

/**
 * Filter a settings group index by a free-text query.
 *
 * An empty (or whitespace-only) query is "no filter" and returns the index
 * unchanged, so the caller can fall back to its normal tabbed view. Otherwise a
 * group matches when its title OR any of its labels contains the query as a
 * case-insensitive substring. Matching groups are returned in their original
 * index order; no match returns [].
 */
export function matchGroups(query: string, index: SettingsGroupIndex[]): SettingsGroupIndex[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return index
  return index.filter((group) => {
    if (group.title.toLowerCase().includes(needle)) return true
    return group.labels.some((label) => label.toLowerCase().includes(needle))
  })
}
