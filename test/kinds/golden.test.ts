// @vitest-environment jsdom
//
// Spec 072 T004 — the golden files of today's kind-keyed tables.
//
// Each golden (test/kinds/golden/<NN>-<table>.json) is what one table answers
// today for every example row (examples.ts), or — where the table is private
// and cannot be called — the kind words its source names (golden-tables.ts says
// which and why). This file recomputes each from the code as it stands and
// requires it to equal the file.
//
// Why it will go red, and what to do: when a table is folded into the registry
// (Phases 3-6) its old function stops answering from its own table, and this
// comparison is replaced for that table by `folded-tables.test.ts` (plan D7),
// which compares the registry's answer to the SAME file and allows only the
// differences listed in DOCUMENTED_FIXES. Until then, this is what stops a
// table from drifting unnoticed: it fails with the example ids whose answer
// moved.
//
// To regenerate on purpose, after deciding the change is right:
//   UPDATE_KIND_GOLDEN=1 npx vitest run test/kinds/golden.test.ts
// and read `git diff test/kinds/golden`.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { TABLES, TABLE_NUMBERS, computeGolden, goldenFile, stable, GOLDEN_DIR, type Golden } from './golden-tables'
import { EXAMPLES } from './examples'

const UPDATE = process.env.UPDATE_KIND_GOLDEN === '1'

describe('the 31 kind-keyed tables (plan 「表的清點」)', () => {
  it('are numbered as the plan numbers them, without #11 and #28', () => {
    const want = Array.from({ length: 33 }, (_, i) => i + 1).filter((n) => n !== 11 && n !== 28)
    expect([...TABLE_NUMBERS]).toEqual(want)
    expect(TABLE_NUMBERS).toHaveLength(31)
  })
})

describe('golden: what each table answers today', () => {
  for (const table of TABLES) {
    it(`#${table.n} ${table.name}`, () => {
      const file = goldenFile(table)
      const computed = computeGolden(table)
      // Through the same serialiser the file went through, so key order and undefined cannot differ.
      const actual = JSON.parse(stable(computed)) as Golden
      if (UPDATE) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true })
        // The SQL answers live in sql-answers.json; do not drop what is not ours to write.
        fs.writeFileSync(file, stable(computed))
        return
      }
      expect(fs.existsSync(file), `${file} is missing — run with UPDATE_KIND_GOLDEN=1`).toBe(true)
      const expected = JSON.parse(fs.readFileSync(file, 'utf8')) as Golden
      const moved = Object.keys({ ...(actual.answers ?? {}), ...(expected.answers ?? {}) })
        .filter((id) => JSON.stringify((actual.answers ?? {})[id]) !== JSON.stringify((expected.answers ?? {})[id]))
      expect(moved, `${table.name} answers differently for: ${moved.join(', ')}`).toEqual([])
      expect(actual.words ?? {}).toEqual(expected.words ?? {})
      expect(actual.sql ?? {}).toEqual(expected.sql ?? {})
      expect(actual.values ?? {}).toEqual(expected.values ?? {})
      expect(actual.mode).toBe(expected.mode)
    })
  }

  it('has no golden file that no table writes', () => {
    if (UPDATE) return
    const known = new Set(TABLES.map((t) => goldenFile(t)))
    const stray = fs.readdirSync(GOLDEN_DIR).map((f) => `${GOLDEN_DIR}/${f}`).filter((f) => !known.has(f) && !f.endsWith('sql-answers.json'))
    expect(stray).toEqual([])
  })

  it('has an example id for every key of every golden (an example removed leaves a stale key)', () => {
    if (UPDATE) return
    const ids = new Set(EXAMPLES.map((e) => e.id))
    const stale: string[] = []
    for (const table of TABLES) {
      const file = goldenFile(table)
      if (!fs.existsSync(file)) continue
      const g = JSON.parse(fs.readFileSync(file, 'utf8')) as Golden
      for (const id of Object.keys(g.answers ?? {})) if (!ids.has(id)) stale.push(`${table.name}: ${id}`)
    }
    expect(stale).toEqual([])
  })
})
