// Spec 072 T004 — the SQL tables (#18 HOUSEKEEPING_SQL, #19 EVIDENCE_SQL, #30 BODY_SOURCE_PREDICATE),
// run against in-memory SQLite for every example row.
//
// Their text is pinned in the table goldens (golden.test.ts); here it is
// EXECUTED, because the text is only what the database does with it. The
// partial index that BODY_SOURCE_PREDICATE builds is the reason the plan wants
// the generated text byte-identical after the fold: a changed predicate is a
// different index.
//
// Needs better-sqlite3 for this Node (test/helpers/requires.ts): skipped, with
// a reason, on a machine that has only the Electron build; a failure in CI,
// where test/capabilities.json marks it required on every platform.
//
// Regenerate: UPDATE_KIND_GOLDEN=1 npx vitest run test/kinds/golden-sql.test.ts
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { requires } from '../helpers/requires'
import { BODY_SOURCE_PREDICATE } from '../../src/core/content-contract'
import { EVIDENCE_SQL, HOUSEKEEPING_SQL } from '../../src/core/db/event-queries'
import { GOLDEN_DIR, sqlAnswers, stable, type SqlDb } from './golden-tables'

const sqlite = requires('better-sqlite3')
const FILE = path.join(GOLDEN_DIR, 'sql-answers.json')

function compute(): Record<string, Record<string, number>> {
  const Database = createRequire(__filename)('better-sqlite3') as new (f: string) => SqlDb
  const db = new Database(':memory:')
  return {
    // 1 = the row is shown (not housekeeping)
    HOUSEKEEPING_SQL: sqlAnswers(db, HOUSEKEEPING_SQL),
    // 1 = the row counts as the operator's work
    EVIDENCE_SQL: sqlAnswers(db, EVIDENCE_SQL),
    // 1 = the row is in the partial index
    BODY_SOURCE_PREDICATE: sqlAnswers(db, BODY_SOURCE_PREDICATE)
  }
}

sqlite.describe('SQL kind tables, executed (#18 #19 #30)', () => {
  it('answer for every example row as they did', () => {
    const actual = compute()
    if (process.env.UPDATE_KIND_GOLDEN === '1') {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true })
      fs.writeFileSync(FILE, stable(actual))
      return
    }
    const expected = JSON.parse(fs.readFileSync(FILE, 'utf8')) as typeof actual
    for (const table of Object.keys(actual)) {
      const moved = Object.keys({ ...actual[table], ...expected[table] }).filter((id) => actual[table][id] !== expected[table]?.[id])
      expect(moved, `${table} answers differently for: ${moved.join(', ')}`).toEqual([])
    }
  })
})
