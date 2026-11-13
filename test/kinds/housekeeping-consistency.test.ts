// @vitest-environment jsdom
//
// Spec 072 T009 (US4, F9) — the housekeeping rule exists in three copies, and
// the copies disagree.
//
//   HOUSEKEEPING_SQL   src/core/db/event-queries.ts   which rows the Timeline hides
//   EVIDENCE_SQL       src/core/db/event-queries.ts   which rows are the operator's work (SQL)
//   isEvidence         src/renderer/src/lib/housekeeping.ts   the same question in JS
//   knownLists         src/renderer/src/lib/knownLists.ts     a third copy of HOUSEKEEPING_SQL (private;
//                      asked through mergeKnownTargets, the one function that uses it)
//
// For one class of row all four have to say the same thing: a shell command row
// whose command is one of RedLog's own hook scripts. The Timeline hides it
// (housekeeping), so it is not the operator's work, so the first-run screen must
// not count it as evidence. The SQL hides five scripts and the JS evidence rule
// knows three. A PowerShell profile reload or the POSIX prompt function is
// hidden from the Timeline AND counted as work.
//
// What this file pins:
//   - the agreement that exists today (the rows that pass are ordinary `it`);
//   - the disagreement, written as the CORRECT behaviour and marked `it.fails`
//     with the reason: one assertion per row, so the day a copy is fixed the
//     matching case starts passing and `it.fails` fails — remove the marker then.
//   - the full list of example rows on which the copies disagree today, so a
//     NEW disagreement (a kind added to one copy only) fails too.
//
// The SQL runs in memory against better-sqlite3 (test/helpers/requires.ts); the
// JS-only agreement and the example-row pins are in the second describe, which
// needs nothing.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { requires } from '../helpers/requires'
import { EVIDENCE_SQL, HOUSEKEEPING_SQL } from '../../src/core/db/event-queries'
import { isEvidence } from '../../src/renderer/src/lib/housekeeping'
import { mergeKnownTargets } from '../../src/renderer/src/lib/knownLists'
import { EXAMPLES, exampleById, type Example } from './examples'
import { sqlAnswers, type SqlDb } from './golden-tables'

const sqlite = requires('better-sqlite3')

interface Answers { hiddenBySql: boolean; hiddenByKnownLists: boolean; evidenceBySql: boolean; evidenceByJs: boolean }

function answers(db: SqlDb, e: Example): Answers {
  const visible = sqlAnswers(db, HOUSEKEEPING_SQL, (x) => x.id === e.id)[e.id] === 1
  const evidence = sqlAnswers(db, EVIDENCE_SQL, (x) => x.id === e.id)[e.id] === 1
  return {
    hiddenBySql: !visible,
    // knownLists keeps a row's target unless the row is housekeeping.
    hiddenByKnownLists: mergeKnownTargets([], [{ ...e.row, targetId: 'probe-target' }]).length === 0,
    evidenceBySql: evidence,
    evidenceByJs: isEvidence(e.row)
  }
}

/** The five scripts HOUSEKEEPING_SQL names, one row each (a command_start and a command_end where the example set has both). */
const HOOK_ROWS: Array<{ id: string; why: string; agreesToday: boolean }> = [
  { id: 'shell:command_end#hook-source', why: 'zsh hook script (all four copies name it)', agreesToday: true },
  { id: 'shell:command_end#tlogger-prompt', why: 'POSIX adapter prompt function (HOUSEKEEPING_SQL and knownLists name it; the evidence rule does not)', agreesToday: false },
  { id: 'shell:command_end#powershell-profile', why: 'PowerShell profile reload (HOUSEKEEPING_SQL and knownLists name it; the evidence rule does not)', agreesToday: false },
  { id: 'shell:command_start#tlogger-prompt', why: 'the same prompt function, as a command_start', agreesToday: false },
  { id: 'shell:command_start#powershell-profile', why: 'the same profile reload, as a command_start', agreesToday: false }
]

const ORDINARY: string[] = ['shell:command_end#relay-complete', 'shell:command_start', 'system:ip_verdict', 'marker', 'scanner:http_response']

const describeSql = sqlite.describe

describeSql('housekeeping: four copies, one rule (Spec 072 F9)', () => {
  const Database = (): SqlDb => new (createRequire(__filename)('better-sqlite3') as new (f: string) => SqlDb)(':memory:')
  const db = sqlite.ok ? Database() : (null as never)

  for (const { id, why, agreesToday } of HOOK_ROWS) {
    // Correct behaviour: a row the Timeline hides is not the operator's work, in SQL and in JS, and every
    // copy of the hiding rule hides it.
    const consistent = (): void => {
      const a = answers(db, exampleById(id))
      expect(a.hiddenBySql, `${id}: HOUSEKEEPING_SQL`).toBe(true)
      expect(a.hiddenByKnownLists, `${id}: knownLists`).toBe(true)
      expect(a.evidenceBySql, `${id}: EVIDENCE_SQL counts it as work`).toBe(false)
      expect(a.evidenceByJs, `${id}: isEvidence counts it as work`).toBe(false)
    }
    if (agreesToday) it(`${id} — ${why}`, consistent)
    // F9: today EVIDENCE_SQL and isEvidence know three scripts, not five, so these rows are hidden AND counted.
    else it.fails(`${id} — ${why}`, consistent)
  }

  it.each(ORDINARY)('%s: the copies agree (not housekeeping)', (id) => {
    const a = answers(db, exampleById(id))
    expect(a.hiddenBySql).toBe(false)
    expect(a.hiddenByKnownLists).toBe(false)
    // SQL and JS evidence agree on whatever they answer.
    expect(a.evidenceBySql).toBe(a.evidenceByJs)
  })

  // The two `command_output` rows are NOT in the plan's F9: HOUSEKEEPING_SQL hides a late or streamed
  // chunk (it belongs to the command that produced it), while EVIDENCE_SQL and isEvidence do not exclude
  // `command_output` at all, so such a chunk is hidden from the Timeline and counted as work. Whether that
  // is a defect or intended is not decided by the spec; it is pinned here as a third place the copies differ.
  it('the example rows on which the copies disagree are the F9 rows and the late-output chunks', () => {
    const disagree: string[] = []
    for (const e of EXAMPLES) {
      const a = answers(db, e)
      if (a.hiddenBySql !== a.hiddenByKnownLists || a.evidenceBySql !== a.evidenceByJs) disagree.push(e.id)
      // a hidden row that is also counted as work is the F9 shape
      else if (a.hiddenBySql && a.evidenceBySql) disagree.push(`${e.id} (hidden and counted as work)`)
    }
    expect(disagree.sort(), 'copies disagree on these example rows').toEqual([
      'shell:command_end#powershell-profile (hidden and counted as work)',
      'shell:command_end#tlogger-prompt (hidden and counted as work)',
      'shell:command_output (hidden and counted as work)',
      'shell:command_output#streamed (hidden and counted as work)',
      'shell:command_start#powershell-profile (hidden and counted as work)',
      'shell:command_start#tlogger-prompt (hidden and counted as work)'
    ])
  })
})

describe('housekeeping: the two JavaScript copies, without a database', () => {
  it('the hook-script rows split isEvidence from knownLists exactly where the SQL pair splits', () => {
    const split = HOOK_ROWS.filter(({ id }) => {
      const e = exampleById(id)
      const hidden = mergeKnownTargets([], [{ ...e.row, targetId: 'probe-target' }]).length === 0
      return hidden && isEvidence(e.row)
    }).map((r) => r.id)
    expect(split.sort()).toEqual(HOOK_ROWS.filter((r) => !r.agreesToday).map((r) => r.id).sort())
  })
})
