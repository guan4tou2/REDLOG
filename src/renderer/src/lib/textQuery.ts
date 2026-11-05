// The one text-query matcher: whitespace-separated terms, all of which must
// appear (case-insensitive) in the haystack. The plugin list and the project
// picker search with the same rule, so a rule change cannot split them.

export function matchesQuery(searchText: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = searchText.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
