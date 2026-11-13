// Spec 071 T031 (US5): new rows, stamped by the receiver, accepted by both
// verifiers — the app's (bundle-verify.ts) and the recipient's
// (tools/redlog-verify.py) — with the same answer every time.
//
// test/fixtures/provenance-vectors holds one sealed bundle of rows written
// through every door, with what both verifiers said about it. How it is made
// and when to regenerate it is in test/fixtures/provenance-vectors-generate.ts.
//
// Held here:
//   - both verifiers accept the committed bundle, and say what they said;
//   - every row in it carries `_ingest`, and every door is there;
//   - a stamp altered in events.jsonl is caught by both (the stamp is inside
//     the chained hash, FR-020);
//   - the generator, run now, writes the same rows byte for byte (fixed clock,
//     ids and key give fixed hashes: a change to what the stamp writes is seen).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { runPythonVerifier, unpackTo } from './fixtures/golden-pre071-generate'
import { BUNDLE, CLOCK_BUNDLE, clockMockVectors, generateProvenanceVectors, type ProvenanceExpected } from './fixtures/provenance-vectors-generate'

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')
const FIXTURE = path.join(__dirname, 'fixtures', 'provenance-vectors')
const WRITE = process.env.REDLOG_WRITE_PROVENANCE_VECTORS === '1'
const STALE = 'test/fixtures/provenance-vectors does not match what provenance-vectors-generate.ts writes with this checkout. ' +
  'If this commit changes what new rows carry on purpose, regenerate with ' +
  '`REDLOG_WRITE_PROVENANCE_VECTORS=1 npx vitest run test/provenance-vectors.test.ts`, review the diff, and say so in the commit.'

async function regenerate(out: string): Promise<ProvenanceExpected> {
  vi.resetModules()
  vi.doMock('../src/core/clock', async (importOriginal) => clockMockVectors(await importOriginal<Record<string, unknown>>()))
  try {
    return await generateProvenanceVectors(out)
  } finally {
    vi.doUnmock('../src/core/clock')
    vi.resetModules()
  }
}

const tmps: string[] = []
const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-vectors-${label}-`)); tmps.push(d); return d }
const committed = (name = BUNDLE): string => unpackTo(path.join(FIXTURE, name), path.join(tmp('bundle'), 'bundle'))
const lines = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const stampOf = (line: string): Record<string, unknown> | undefined =>
  (JSON.parse(String((JSON.parse(line) as { data: string }).data)) as { _ingest?: Record<string, unknown> })._ingest

let expected: ProvenanceExpected
const prevKeys = process.env.REDLOG_KEYS_DIR

beforeAll(async () => {
  if (WRITE && sqlite.ok) await regenerate(FIXTURE)
  expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as ProvenanceExpected
  process.env.REDLOG_KEYS_DIR = tmp('keys')
}, 60_000)
afterAll(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = prevKeys
})

it('every row in the bundle carries the stamp, and every door is there', () => {
  const dir = committed()
  const all = [...lines(path.join(dir, 'events.jsonl')), ...lines(path.join(dir, 'events_logged.jsonl'))]
  const stamps = all.map(stampOf)
  expect(stamps.filter((s) => s === undefined)).toEqual([])
  const doors = new Set(stamps.map((s) => `${String(s!.door)}/${String(s!.producer)}/${String(s!.auth)}`))
  expect([...doors].sort()).toEqual(['in-process/derived/in-process', 'in-process/in-process/in-process', 'legacy-api/legacy/bearer', 'legacy-handoff/legacy-handoff/none'])
  expect(stamps.some((s) => Array.isArray(s!.stripped) && (s!.stripped as string[]).length === 4), 'the forged row names all four keys').toBe(true)
  expect(lines(path.join(dir, 'events_logged.jsonl')).length, 'a logged row is in the vectors').toBeGreaterThan(0)
  // The receiver's own keys sit beside the stamp, each on a row of its own.
  const keys = lines(path.join(dir, 'events.jsonl')).map((l) => Object.keys(JSON.parse(String((JSON.parse(l) as { data: string }).data)) as object))
  for (const k of ['_raw', '_clock_anomaly', '_source_time_rejected']) {
    expect(keys.filter((ks) => ks.includes(k) && ks.includes('_ingest')), k).toHaveLength(1)
  }
  // The seal is a stamped row too, and the verifiers below accept it.
  expect(stampOf(lines(path.join(dir, 'events.jsonl')).at(-1)!)).toMatchObject({ door: 'in-process' })
})

it('the app\'s bundle verifier accepts the bundle, and says what it said', async () => {
  const { verifyBundleDir } = await import('../src/core/bundle-verify')
  const got = verifyBundleDir(committed())
  expect(got).toEqual(expected.bundleVerify)
  expect({ exitCode: got.exitCode, seal: got.seal, problems: got.problems }).toEqual({ exitCode: 0, seal: 'sealed', problems: [] })
})

python.it('tools/redlog-verify.py accepts the bundle, and says what it said', () => {
  const got = runPythonVerifier(committed())
  expect(got).toEqual(expected.pythonVerify)
  expect(got.status).toBe(0)
})

// A seal written while the clock is off carries `_clock_anomaly`. The seal's
// key check is strict — an unknown field means a seal format this verifier
// does not understand — but the receiver's own keys are not seal fields. Both
// verifiers accept exactly `_ingest` and `_clock_anomaly` on a seal row; a seal
// row can carry no other (insertEvent adds `_raw` only for an envelope with raw
// bytes and `_source_time_rejected` only for a producer-supplied time, and
// writeExportSeal passes neither).
it('a seal written with the clock off carries `_clock_anomaly`, and the app\'s verifier accepts it', async () => {
  const dir = committed(CLOCK_BUNDLE)
  const seal = JSON.parse(String((JSON.parse(lines(path.join(dir, 'events.jsonl')).at(-1)!) as { data: string }).data)) as Record<string, unknown>
  expect(seal.subtype).toBe('export_sealed')
  expect(Object.keys(seal).filter((k) => k.startsWith('_')).sort()).toEqual(['_clock_anomaly', '_ingest'])
  const { verifyBundleDir } = await import('../src/core/bundle-verify')
  const got = verifyBundleDir(dir)
  expect(got).toEqual(expected.clockAnomaly.bundleVerify)
  expect({ exitCode: got.exitCode, seal: got.seal, problems: got.problems }).toEqual({ exitCode: 0, seal: 'sealed', problems: [] })
})

python.it('a seal written with the clock off: tools/redlog-verify.py accepts it', () => {
  const got = runPythonVerifier(committed(CLOCK_BUNDLE))
  expect(got).toEqual(expected.clockAnomaly.pythonVerify)
  expect(got.status).toBe(0)
})

/** The committed bundle with one chained row's stamp changed to another door. */
function tampered(): string {
  const dir = committed()
  const file = path.join(dir, 'events.jsonl')
  const rows = lines(file)
  const i = rows.findIndex((l) => stampOf(l)?.door === 'legacy-api')
  const row = JSON.parse(rows[i]) as { data: string }
  const data = JSON.parse(row.data) as { _ingest: Record<string, unknown> }
  data._ingest.door = 'in-process'
  rows[i] = JSON.stringify({ ...row, data: JSON.stringify(data) })
  fs.writeFileSync(file, rows.join('\n') + '\n')
  return dir
}

it('a stamp changed after the fact fails the app\'s verifier', async () => {
  const { verifyBundleDir } = await import('../src/core/bundle-verify')
  expect(verifyBundleDir(tampered()).exitCode).not.toBe(0)
})

python.it('a stamp changed after the fact fails tools/redlog-verify.py', () => {
  expect(runPythonVerifier(tampered()).status).not.toBe(0)
})

sqlite.it('the generator writes the same rows today: the stamp\'s bytes are pinned', async () => {
  const out = path.join(tmp('regen'), 'provenance-vectors')
  const got = await regenerate(out)
  expect({ rows: got.rows, rowsSha256: got.rowsSha256, stamps: got.stamps }, STALE)
    .toEqual({ rows: expected.rows, rowsSha256: expected.rowsSha256, stamps: expected.stamps })
  const mine = unpackTo(path.join(out, BUNDLE), path.join(tmp('mine'), 'bundle'))
  const theirs = committed()
  for (const f of ['events.jsonl', 'events_logged.jsonl']) {
    expect(fs.readFileSync(path.join(mine, f)).equals(fs.readFileSync(path.join(theirs, f))), `${f}: ${STALE}`).toBe(true)
  }
}, 60_000)
