// Reading the body index's documents as the tests check them. A document's
// rowid is ref * refSpan + kind * kindSpan + n (src/core/http-body-index.ts,
// KIND_SPAN); its ref row counts the documents of each kind. All arithmetic
// is in SQL, on integer rowids. The FTS table is contentless: a document's
// text is not stored, only its words, which fts5vocab lists.
import Database from 'better-sqlite3'
import { _documentLayout } from '../../src/core/http-body-index'
import { FTS_TOKENIZE } from '../../src/core/query/fts-match'

const { refSpan, kindSpan } = _documentLayout()

/** The rowids of every document of `eventId`'s refs, in `fts` / `refs`. */
export function documentRowids(index: Database.Database, eventId: string, tables = { fts: 'body_fts', refs: 'body_event_refs' }): number[] {
  return (index.prepare(`SELECT f.rowid AS id FROM ${tables.fts} f WHERE f.rowid/${refSpan} IN (SELECT ref FROM ${tables.refs} WHERE event_id=?) ORDER BY f.rowid`)
    .all(eventId) as { id: number }[]).map(r => r.id)
}

/** What the layout promises, as counts that must all be 0:
 *  - `stray`: a document whose rowid decodes to no ref, or to a ref whose
 *    recorded counts do not cover it (a rowid outside every ref's range);
 *  - `missing`: documents a ref's counts promise beyond those present (with
 *    no stray, the counts and the documents then match one to one);
 *  - `textless`: documents counted for a ref without text. */
export function layoutViolations(index: Database.Database): { stray: number; missing: number; textless: number } {
  const n = (sql: string): number => (index.prepare(sql).get() as { n: number }).n
  const stray = n(`SELECT count(*) AS n FROM body_fts f WHERE NOT EXISTS(SELECT 1 FROM body_event_refs r WHERE r.ref=f.rowid/${refSpan}
    AND CASE WHEN f.rowid%${refSpan}<${kindSpan} THEN f.rowid%${refSpan}<r.raw_docs ELSE f.rowid%${refSpan}-${kindSpan}<r.decoded_docs END)`)
  const missing = n('SELECT coalesce(sum(raw_docs+decoded_docs),0) AS n FROM body_event_refs') - n('SELECT count(*) AS n FROM body_fts')
  const textless = n("SELECT count(*) AS n FROM body_event_refs WHERE status NOT IN ('indexed','partial') AND raw_docs+decoded_docs>0")
  return { stray, missing, textless }
}

/** Whether the document at `rowid` holds `term`. The rowid is cast: bound as a
 *  JS number it is a REAL, which FTS5 ignores beside MATCH. */
export function documentHolds(index: Database.Database, rowid: number, term: string, fts = 'body_fts'): boolean {
  return (index.prepare(`SELECT count(*) AS n FROM ${fts} WHERE ${fts} MATCH ? AND rowid=CAST(? AS INTEGER)`).get(`"${term}"`, rowid) as { n: number }).n > 0
}

/** The words of the document at `rowid`, in order, as the tokenizer keeps
 *  them (lower case, diacritics removed). */
export function documentTerms(index: Database.Database, rowid: number, fts = 'body_fts'): string[] {
  index.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${fts}_terms USING fts5vocab(main, '${fts}', 'instance')`)
  return (index.prepare(`SELECT term FROM temp.${fts}_terms WHERE doc=CAST(? AS INTEGER) ORDER BY offset`).all(rowid) as { term: string }[]).map(r => r.term)
}
/** The words `text` makes under the body index's tokenizer. */
export function termsOf(text: string): string[] {
  const scratch = new Database(':memory:')
  try {
    scratch.exec(`CREATE VIRTUAL TABLE t USING fts5(content,tokenize='${FTS_TOKENIZE}'); CREATE VIRTUAL TABLE v USING fts5vocab(t, instance)`)
    scratch.prepare('INSERT INTO t(rowid,content) VALUES(1,?)').run(text)
    return (scratch.prepare('SELECT term FROM v ORDER BY offset').all() as { term: string }[]).map(r => r.term)
  } finally { scratch.close() }
}
