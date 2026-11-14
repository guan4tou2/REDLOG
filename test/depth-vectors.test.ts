// Spec 071 FR-097: a bundle holding collapsed rows is accepted by both
// verifiers — the app's (bundle-verify.ts) and the recipient's
// (tools/redlog-verify.py) — and the Python verifier's recursion has wide
// headroom over MAX_DATA_DEPTH. Neither verifier changes in FR-097; this is
// the proof that they need not.
//
// test/fixtures/depth-vectors holds the bundle and what both verifiers said
// (test/fixtures/depth-vectors-generate.ts). provenance-vectors is not
// re-recorded: rows within the limit do not change.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { VERIFIER, pythonBin, runPythonVerifier, sha256, unpackTo } from './fixtures/golden-pre071-generate'
import { AWKWARD, BUNDLE, clockMockDepth, generateDepthVectors, type DepthExpected } from './fixtures/depth-vectors-generate'
import { COLLAPSED_KEY, MAX_DATA_DEPTH, restoreDataDepth } from '../src/core/ingest/depth'
import { canonicalStringify } from '../src/core/db/event-write'

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')
const FIXTURE = path.join(__dirname, 'fixtures', 'depth-vectors')
const WRITE = process.env.REDLOG_WRITE_DEPTH_VECTORS === '1'
const REGENERATE = 'regenerate with `REDLOG_WRITE_DEPTH_VECTORS=1 npx vitest run test/depth-vectors.test.ts`, review the diff, and say so in the commit.'

async function regenerate(out: string): Promise<DepthExpected> {
  vi.resetModules()
  vi.doMock('../src/core/clock', async (importOriginal) => clockMockDepth(await importOriginal<Record<string, unknown>>()))
  try {
    return await generateDepthVectors(out)
  } finally {
    vi.doUnmock('../src/core/clock')
    vi.resetModules()
  }
}

const tmps: string[] = []
const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-depth-vectors-${label}-`)); tmps.push(d); return d }
const committed = (): string => unpackTo(path.join(FIXTURE, BUNDLE), path.join(tmp('bundle'), 'bundle'))
const lines = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const dataOf = (line: string): Record<string, unknown> => JSON.parse(String((JSON.parse(line) as { data: string }).data)) as Record<string, unknown>

function depthOf(v: unknown): number {
  let max = 0
  const stack: Array<[unknown, number]> = [[v, 1]]
  while (stack.length > 0) {
    const [x, d] = stack.pop()!
    if (x === null || typeof x !== 'object') continue
    if (d > max) max = d
    for (const c of Object.values(x as object)) stack.push([c, d + 1])
  }
  return max
}

let expected: DepthExpected
const prevKeys = process.env.REDLOG_KEYS_DIR
beforeAll(async () => {
  if (WRITE && sqlite.ok) await regenerate(FIXTURE)
  expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as DepthExpected
  process.env.REDLOG_KEYS_DIR = tmp('keys')
}, 60_000)
afterAll(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = prevKeys
})

it('the bundle holds collapsed rows in both tiers, a row at the limit, and nothing deeper than the limit', () => {
  const dir = committed()
  const chained = lines(path.join(dir, 'events.jsonl')).map(dataOf)
  const logged = lines(path.join(dir, 'events_logged.jsonl')).map(dataOf)
  for (const d of [...chained, ...logged]) expect(depthOf(d), String(d.subtype)).toBeLessThanOrEqual(MAX_DATA_DEPTH)
  const count = (rows: Array<Record<string, unknown>>): number[] => rows.map((d) => (d._ingest as { collapsed?: number }).collapsed ?? 0).filter((n) => n > 0)
  expect(count(chained)).toEqual([1, 1, 1])
  expect(count(logged)).toEqual([1])
  expect(chained.filter((d) => d.command === 'echo limit').map(depthOf)).toEqual([MAX_DATA_DEPTH])
  expect(expected.collapsed).toEqual({
    'events:command_start:curl -d @deep.json http://10.0.0.5/api': 1,
    'events:command_start:echo markers': 1,
    'events:command_start:ls /deep': 1,
    'events_logged:http_request_start:': 1
  })
})

it('each row restores from itself alone: the sender\'s marker-shaped object at 63 stays, the one at 64 comes back from its wrapper', () => {
  const rows = lines(path.join(committed(), 'events.jsonl')).map(dataOf)
  const markers = rows.find((d) => d.command === 'echo markers')!
  const back = restoreDataDepth(markers)
  let a: unknown = back.at63, b: unknown = back.at64
  for (let d = 2; d < MAX_DATA_DEPTH - 1; d++) a = (a as unknown[])[0]
  for (let d = 2; d < MAX_DATA_DEPTH; d++) b = (b as unknown[])[0]
  expect(a).toEqual({ [COLLAPSED_KEY]: '[1]' })
  expect(b).toEqual({ [COLLAPSED_KEY]: 'not json' })
  const api = rows.find((d) => String(d.command).startsWith('curl'))!
  let c: unknown = restoreDataDepth(api).deep
  for (let d = 2; d <= MAX_DATA_DEPTH; d++) c = (c as unknown[])[0]
  // As JSON: AWKWARD holds -0, which JSON writes 0.
  expect(JSON.stringify(c)).toBe(JSON.stringify(AWKWARD))
})

it('the numbers and characters the two languages write differently are, inside the collapsed text, one JSON string', () => {
  const api = lines(path.join(committed(), 'events.jsonl')).map(dataOf).find((d) => String(d.command).startsWith('curl'))!
  let holder: unknown = api.deep
  for (let d = 2; d < MAX_DATA_DEPTH; d++) holder = (holder as unknown[])[0]
  const text = (holder as Record<string, string>)[COLLAPSED_KEY]
  expect(Object.keys(holder as object)).toEqual([COLLAPSED_KEY])
  expect(text).toBe(JSON.stringify([AWKWARD]))
  for (const s of ['0.00001', '1e+21', '1.5e-7', '123456789012345680000', '\\ud800', '\u{1F600}']) expect(text, s).toContain(s)
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
  expect(got.stdout).toMatch(/^Chain\s+: INTACT$/m)
})

// Run the verifier's own row rebuild (`_rebuild_shapes`: json.loads of `data`,
// then canonical_stringify, both recursive) on a row whose `data` is `levels`
// nested arrays — the costliest shape per level — beneath `pad` extra frames
// standing in for the verifier's own call stack and more.
const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rv", sys.argv[1])
rv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rv)
levels, pad = int(sys.argv[2]), int(sys.argv[3])
row = {"id": "x", "timestamp": 1, "engagement_id": "e", "session_id": "s", "operator_id": "o", "agent_type": "shell",
       "hostname": "h", "source_ip": None, "target_id": None, "prev_hash": None, "created_at": 1,
       "monotonic_ns": None, "ntp_offset_ms": None, "data": "[" * levels + "]" * levels}
def down(n):
    if n > 0:
        return down(n - 1)
    # _parsed_data falls back to the raw string when json.loads fails, which
    # the verifier then reports as a hash mismatch: that is a failure too.
    if not isinstance(rv._parsed_data(row), list):
        return "unparsed"
    shapes, strings = rv._rebuild_shapes(row)
    return "ok %d" % len(strings["canonical"])
try:
    print(down(pad))
except RecursionError:
    print("RecursionError")
`
const probe = (levels: number, pad: number): string =>
  (spawnSync(pythonBin, ['-I', '-c', PROBE, VERIFIER, String(levels), String(pad)], { encoding: 'utf8' }).stdout ?? '').trim()

python.it('the Python verifier rebuilds a row four times deeper than the limit, under 100 extra frames; far deeper it cannot', () => {
  const HEADROOM = 4
  expect(probe(HEADROOM * MAX_DATA_DEPTH, 100)).toMatch(/^ok \d+$/)
  // The probe can fail: well past Python's recursion limit it does.
  expect(probe(1500, 100)).toMatch(/^(RecursionError|unparsed)$/)
})

it('the app\'s canonical form of a row at the limit is far from its own recursion limit', () => {
  // data at the limit inside the hashed payload (one more level).
  let deep: unknown = 'x'
  for (let i = 0; i < 16 * MAX_DATA_DEPTH; i++) deep = [deep]
  expect(() => canonicalStringify({ data: deep })).not.toThrow()
})

sqlite.it('the generator writes the same rows and bundle today', async () => {
  expect(sha256(fs.readFileSync(VERIFIER)), `tools/redlog-verify.py is not the verifier the depth vectors were recorded with; ${REGENERATE}`).toBe(expected.verifierSha256)
  const out = path.join(tmp('regen'), 'depth-vectors')
  const got = await regenerate(out)
  expect({ rows: got.rows, rowsSha256: got.rowsSha256, collapsed: got.collapsed }, REGENERATE)
    .toEqual({ rows: expected.rows, rowsSha256: expected.rowsSha256, collapsed: expected.collapsed })
  const mine = unpackTo(path.join(out, BUNDLE), path.join(tmp('mine'), 'bundle'))
  const theirs = committed()
  for (const f of ['events.jsonl', 'events_logged.jsonl']) {
    expect(fs.readFileSync(path.join(mine, f)).equals(fs.readFileSync(path.join(theirs, f))), `${f}: ${REGENERATE}`).toBe(true)
  }
}, 60_000)
