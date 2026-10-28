/** FTS5 MATCH treats bare punctuation and operators as syntax. Terminal
 *  searches are full of both — `10.0.0.5`, `-sV`, `/etc/passwd` — so each term
 *  is quoted as a phrase rather than handed through, and only the last term
 *  gets a trailing `*`: the operator is still typing it.
 *
 *  Event, HTTP body and recording search all read text this way
 *  (docs/domain/SPEC-search-query-semantics.md). */
export function toFtsMatch(raw: string): string | null {
  return ftsTerms(raw).join(' ') || null
}

export function ftsTerms(raw:string):string[] {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  return terms
    .map((term, i) => {
      const quoted = `"${term.replace(/"/g, '""')}"`
      return i === terms.length - 1 ? `${quoted}*` : quoted
    })
}
