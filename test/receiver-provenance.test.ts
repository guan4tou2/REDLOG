// Spec 071 FR-022–024: one rule for a row's receiver provenance, in both
// verifiers. A row is proven when it carries `_ingest` and the session_start
// of its session carries it too; self-described otherwise; cannot be
// determined when the bundle holds no session_start for its session. A logged
// row is never proven.
//
// test/fixtures/provenance-rule-vectors.json holds the cases. Each goes
// through evidence-rules.ts receiverProvenance and through
// tools/redlog-verify.py receiver_provenance, and both must give the counts
// the file records. REDLOG_TEST_PYTHONS (comma-separated) runs the Python half
// under each interpreter named; by default, the one the other verifier tests
// use.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { receiverProvenance, type ProvenanceCounts, type ProvenanceRow } from '../src/core/evidence-rules'
import { VERIFIER, pythonBin } from './fixtures/golden-pre071-generate'

const python = requires('python-cryptography')
const VECTORS = path.join(__dirname, 'fixtures', 'provenance-rule-vectors.json')
interface VectorRow { tier: 'chained' | 'logged'; hashChecked: boolean; session_id: unknown; agent_type: unknown; data: unknown }
const { cases } = JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as { cases: Array<{ name: string; rows: VectorRow[]; expected: ProvenanceCounts }> }
const asRows = (rows: VectorRow[]): ProvenanceRow[] =>
  rows.map((r) => ({ tier: r.tier, hashChecked: r.hashChecked, sessionId: r.session_id, agentType: r.agent_type, data: r.data }))

const PYTHONS = (process.env.REDLOG_TEST_PYTHONS ?? pythonBin).split(',').map((s) => s.trim()).filter(Boolean)
const PROBE = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("redlog_verify", sys.argv[1])',
  'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'cases = json.load(open(sys.argv[2], encoding="utf-8"))["cases"]',
  'print(json.dumps({"version": sys.version.split()[0], "got": [m.receiver_provenance([',
  '  {"tier": r["tier"], "hash_checked": r["hashChecked"], "session_id": r["session_id"], "agent_type": r["agent_type"], "data": r["data"]}',
  '  for r in c["rows"]]) for c in cases]}))'
].join('\n')

describe('receiver provenance (FR-022–024): the rule', () => {
  it('the vectors cover every combination the spec names', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    const all = cases.flatMap((c) => c.rows)
    expect(all.some((r) => r.tier === 'logged' && typeof (r.data as Record<string, unknown>)?._ingest === 'object')).toBe(true)
    expect(all.some((r) => r.hashChecked === false && r.tier === 'chained')).toBe(true)
  })

  for (const c of cases) {
    it(`evidence-rules.ts: ${c.name}`, () => {
      expect(receiverProvenance(asRows(c.rows))).toEqual(c.expected)
    })
  }

  it('order does not matter: every case, reversed, counts the same', () => {
    for (const c of cases) expect(receiverProvenance(asRows([...c.rows].reverse())), c.name).toEqual(c.expected)
  })

  it('a logged row is never proven, whatever it carries', () => {
    for (const c of cases) {
      const logged = c.rows.filter((r) => r.tier === 'logged')
      const got = receiverProvenance(asRows(c.rows))
      expect(got.logged.selfDescribed + got.logged.undetermined, c.name).toBe(logged.length)
      expect(Object.keys(got.logged).sort()).toEqual(['selfDescribed', 'stamped', 'undetermined'])
    }
  })

  for (const bin of PYTHONS) {
    python.it(`tools/redlog-verify.py receiver_provenance gives the same counts for every case (${bin})`, () => {
      const r = spawnSync(bin, ['-I', '-c', PROBE, VERIFIER, VECTORS], { encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      const out = JSON.parse(r.stdout) as { version: string; got: ProvenanceCounts[] }
      expect(out.got.length).toBe(cases.length)
      cases.forEach((c, i) => expect(out.got[i], `${out.version}: ${c.name}`).toEqual(c.expected))
    })
  }
})
