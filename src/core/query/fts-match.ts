import Database from 'better-sqlite3'

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

/** The tokenizer every searched index is created with: events_fts and
 *  events_logged_fts (db/index.ts), body_fts (http-body-index.ts) and cast_fts
 *  (cast-index.ts). No tokenchars or separators are configured on any of them. */
export const FTS_TOKENIZE = 'unicode61 remove_diacritics 2'

/** Each term matches on its own (an event matches when every term is somewhere
 *  in it), so a term in which the tokenizer finds no token at all — `|`, `&&`,
 *  `>`, `--` in a pasted command line — would match nothing and empty the
 *  result. It says nothing about the text and is left out. A query made only of
 *  such terms keeps them, and matches nothing, as it did before. The `*` stays
 *  on the term the operator was typing: after `cat /etc/passwd |` they are past
 *  `passwd`, which stays a whole word. */
export function ftsTerms(raw:string):string[] {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  const quoted = terms.map((term, i) => {
    const phrase = `"${term.replace(/"/g, '""')}"`
    return i === terms.length - 1 ? `${phrase}*` : phrase
  })
  const tokens = hasToken(terms)
  const kept = quoted.filter((_, i) => tokens[i])
  return kept.length ? kept : quoted
}

/** Whether the tokenizer finds a token in each term. ASCII is decided here: its
 *  token characters under unicode61 are exactly the letters and digits.
 *  Anything else is asked of SQLite itself, whose Unicode tables are not the
 *  runtime's: a term is put in a one-row table and matched against itself, and
 *  a term with a token always finds its own row. */
function hasToken(terms: string[]): boolean[] {
  const ascii = terms.map(term => /^[\x00-\x7f]*$/.test(term))
  if (ascii.every(Boolean)) return terms.map(term => /[A-Za-z0-9]/.test(term))
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE VIRTUAL TABLE probe USING fts5(t, tokenize='${FTS_TOKENIZE}')`)
    const insert = db.prepare('INSERT INTO probe(rowid,t) VALUES(?,?)')
    terms.forEach((term, i) => insert.run(i + 1, term))
    // CAST: a JS number binds as REAL, and FTS5 ignores a REAL rowid
    // equality beside MATCH. A tokenless phrase matches no row at all, so the
    // answer was right without it; with it, a term is matched against its own
    // row only, as said above.
    const found = db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ? AND rowid=CAST(? AS INTEGER)')
    return terms.map((term, i) => ascii[i] ? /[A-Za-z0-9]/.test(term)
      : (found.get(`"${term.replace(/"/g, '""')}"`, i + 1) as { n: number }).n > 0)
  } finally { db.close() }
}
