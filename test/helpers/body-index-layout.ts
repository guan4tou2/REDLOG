// Reading the body index's documents as the tests check them. A document's
// rowid is ref * refSpan + kind * kindSpan + n (src/core/http-body-index.ts,
// KIND_SPAN); its ref row counts the documents of each kind. All arithmetic
// is in SQL, on integer rowids.
import type Database from 'better-sqlite3'
import { _documentLayout } from '../../src/core/http-body-index'

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
