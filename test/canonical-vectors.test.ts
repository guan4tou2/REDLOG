// One canonical form, two languages. A chained row's hash, its signature, the
// seal's manifest digest and the logged-tier digest are all sha256 over
// canonicalStringify (src/core/db/event-write.ts). tools/redlog-verify.py
// rebuilds them with canonical_stringify, and the two must produce the same
// bytes for every JSON value — a byte apart is a genuine row reported as
// tampered.
//
// test/fixtures/canonical-vectors.json holds the inputs where the languages
// differ by default: Python's sorted() orders keys by code point and the writer
// by UTF-16 code unit (a key outside the BMP sorts before one in U+E000–U+FFFF
// in JS, after it in Python); Python's repr prints `1e-05` where JS prints
// `0.00001`; a JSON integer past 2^53 is exact in Python and a double in JS;
// json.loads accepts NaN where JSON.parse refuses it. The expected bytes are
// the writer's own. Then a real chained row with such data goes through the
// exporter and both verifiers, which must accept it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalStringify } from '../src/core/db/event-write'
import { requires } from './helpers/requires'
import { VERIFIER, pythonBin } from './fixtures/golden-pre071-generate'

const FIXTURE = path.join(__dirname, 'fixtures', 'canonical-vectors.json')
const WRITE = process.env.REDLOG_WRITE_CANONICAL_VECTORS === '1'
const python = requires('python-cryptography')
const sqlite = requires('better-sqlite3')

interface Vectors {
  $comment: string
  cases: Array<{ name: string; text: string; canonical: string; sha256: string }>
  rejected: Array<{ name: string; text: string }>
}
const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Vectors
const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

if (WRITE) {
  for (const c of vectors.cases) {
    c.canonical = canonicalStringify(JSON.parse(c.text))
    c.sha256 = sha256(c.canonical)
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(vectors, null, 2) + '\n')
}

/** What the Python verifier's own functions make of each vector. */
function pythonCanonical(): { cases: Array<{ hex: string; sha256: string } | { error: string }>; rejected: boolean[] } {
  const script = [
    'import hashlib, importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("redlog_verify", sys.argv[1])',
    'rv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rv)',
    'v = json.load(open(sys.argv[2], encoding="utf-8"))',
    'out = {"cases": [], "rejected": []}',
    'for c in v["cases"]:',
    '    try:',
    '        b = rv.canonical_stringify(rv._json_loads(c["text"])).encode("utf-8")',
    '        out["cases"].append({"hex": b.hex(), "sha256": hashlib.sha256(b).hexdigest()})',
    '    except Exception as e:',
    '        out["cases"].append({"error": repr(e)})',
    'for c in v["rejected"]:',
    '    try:',
    '        rv._json_loads(c["text"]); out["rejected"].append(False)',
    '    except ValueError:',
    '        out["rejected"].append(True)',
    'print(json.dumps(out))'
  ].join('\n')
  const r = spawnSync(pythonBin, ['-I', '-c', script, VERIFIER, FIXTURE], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

describe('the canonical vectors', () => {
  it('are the inputs where the two languages differ by default', () => {
    // Order: the case the vectors exist for really does sort two ways.
    const keys = ['\u{1F600}', '～']
    expect([...keys].sort()).toEqual(['\u{1F600}', '～'])
    expect([...keys].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)).toEqual(['～', '\u{1F600}'])
    expect(vectors.cases.length).toBeGreaterThan(10)
  })

  it('the writer makes exactly the recorded bytes of each', () => {
    for (const c of vectors.cases) {
      const got = canonicalStringify(JSON.parse(c.text))
      expect(got, `${c.name}: regenerate with REDLOG_WRITE_CANONICAL_VECTORS=1 only if the writer changed on purpose`).toBe(c.canonical)
      expect(sha256(got), c.name).toBe(c.sha256)
      // What the writer stores is what the verifiers parse: hashing the
      // in-memory value and hashing JSON.parse(JSON.stringify(value)) agree.
      expect(canonicalStringify(JSON.parse(JSON.stringify(JSON.parse(c.text)))), c.name).toBe(c.canonical)
    }
    for (const c of vectors.rejected) expect(() => JSON.parse(c.text), c.name).toThrow()
  })

  python.it('tools/redlog-verify.py makes the same bytes and the same sha256 of each', () => {
    const py = pythonCanonical()
    vectors.cases.forEach((c, i) => {
      expect(py.cases[i], c.name).toEqual({ hex: Buffer.from(c.canonical, 'utf8').toString('hex'), sha256: c.sha256 })
    })
    expect(py.rejected, 'NaN / Infinity are refused, as JSON.parse refuses them').toEqual(vectors.rejected.map(() => true))
  })
})

// A chained row (and a logged one) whose data has those keys and numbers,
// written by the real writer, exported, and checked by both verifiers.
describe('a bundle whose rows carry them', () => {
  const tmps: string[] = []
  const keysEnv = process.env.REDLOG_KEYS_DIR
  afterAll(async () => {
    const { closeDB } = await import('../src/core/db/index')
    closeDB()
    if (keysEnv === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = keysEnv
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  async function exportWith(): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-canonical-'))
    tmps.push(root)
    process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
    const { initDB, bindDBEngagement } = await import('../src/core/db/index')
    const events = await import('../src/core/db/events')
    const ops = await import('../src/core/db/operators')
    const { exportBundle } = await import('../src/core/bundle-export')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    initDB(project); bindDBEngagement('default')
    ops.createOperator({ id: 'canon-op', name: 'canon-op', token: ops.generateToken(), isPrimary: true })
    const data = {
      subtype: 'tool_call',
      tool_name: 'mcp__vectors__call',
      tool_input: {
        '\u{1F600}': 1, '～': 2, a: { '\u{10000}': [0.00001, 1e-7], '': 2 ** 53 + 2 },
        '\uD800': 'lone', s: ' /\u007f\u0000'
      }
    }
    events.insertEvent('agent', data, { operatorId: 'canon-op' })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'vectors.test', extra: { '\u{1F600}': 0.000001, '～': 1 } }, { operatorId: 'canon-op' })
    const { outDir } = exportBundle('default', { outRoot: path.join(root, 'out') })
    return outDir
  }

  sqlite.describe('exported through the real writer', () => {
    let bundle = ''
    it('the app\'s verifier accepts it', async () => {
      bundle = await exportWith()
      const { verifyBundleDir } = await import('../src/core/bundle-verify')
      const got = verifyBundleDir(bundle)
      expect({ exitCode: got.exitCode, problems: got.problems, seal: got.seal }).toEqual({ exitCode: 0, problems: [], seal: 'sealed' })
    }, 60_000)

    python.it('tools/redlog-verify.py accepts it: chain intact, logged digest matches, seal holds', () => {
      expect(bundle, 'the bundle is made by the test before').not.toBe('')
      const r = spawnSync(pythonBin, ['-I', VERIFIER, bundle], { encoding: 'utf8' })
      const out = `${r.stdout}${r.stderr}`
      expect(out).not.toContain('CHAIN BROKEN')
      expect(out).not.toContain('SEAL MISMATCH')
      expect(out).not.toContain('logged tier differs')
      expect(r.stdout).toContain('digest matches')
      expect(r.stdout).toMatch(/^Chain\s+: INTACT$/m)
      expect(r.status, out).toBe(0)
    })
  })
})
