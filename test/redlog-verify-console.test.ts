// tools/redlog-verify.py prints what the bundle says — operator ids, file
// names, the bundle's own path. A recipient on Windows runs it in a console
// whose code page (cp1252, cp950, cp932…) lacks some of those characters, and
// Python raises UnicodeEncodeError on the first one: a traceback in the
// middle of the report on an intact bundle. The verifier keeps each stream's
// encoding and escapes only what it cannot show.
//
// Each case swaps sys.stdout for a strict TextIOWrapper in a given code page
// inside the script, so it does not depend on the console running the test
// (which `-I` would not let PYTHONIOENCODING set anyway). What comes back is
// ASCII JSON, for the same reason.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, expect } from 'vitest'
import { requires } from './helpers/requires'
import { VERIFIER, pythonBin, unpackTo } from './fixtures/golden-pre071-generate'
import { BUNDLE } from './fixtures/provenance-vectors-generate'

const python = requires('python-cryptography')
const tmps: string[] = []
afterAll(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const LOAD = [
  'import importlib.util, io, json, sys',
  'spec = importlib.util.spec_from_file_location("redlog_verify", sys.argv[1])',
  'rv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rv)'
]
function run(lines: string[], ...args: string[]): Record<string, unknown> {
  const r = spawnSync(pythonBin, ['-I', '-c', [...LOAD, ...lines].join('\n'), VERIFIER, ...args], { encoding: 'utf8' })
  expect(r.stderr, 'the script itself must not fail').toBe('')
  return JSON.parse(r.stdout) as Record<string, unknown>
}
/** Python lines that point stdout and stderr at strict `enc` buffers. */
const wrapped = (enc: string): string[] => [
  'real = sys.stdout',
  'out, err = io.BytesIO(), io.BytesIO()',
  `sys.stdout = io.TextIOWrapper(out, encoding="${enc}", errors="strict")`,
  `sys.stderr = io.TextIOWrapper(err, encoding="${enc}", errors="strict")`
]

python.it('a cp1252 console gets escapes for what it cannot show, and no exception', () => {
  const got = run([
    ...wrapped('cp1252'),
    'rv._console_cannot_fail()',
    'print("op \\U0001F600 \\u4e2d\\u6587 \\uff5e caf\\u00e9")',
    'print("on stderr \\U0001F600", file=sys.stderr)',
    'sys.stdout.flush(); sys.stderr.flush()',
    'real.write(json.dumps({"out": out.getvalue().hex(), "err": err.getvalue().hex()}))'
  ])
  // café is in cp1252 and stays a real byte (0xE9); the rest becomes escapes.
  const out = Buffer.from(String(got.out), 'hex').toString('latin1').replace(/\r?\n$/, '')
  expect(out).toBe('op \\U0001f600 \\u4e2d\\u6587 \\uff5e caf\u00e9')
  expect(Buffer.from(String(got.err), 'hex').toString('latin1')).toContain('on stderr \\U0001f600')
})

python.it('a cp950 console keeps showing Chinese as Chinese; only what it lacks is escaped', () => {
  const got = run([
    ...wrapped('cp950'),
    'rv._console_cannot_fail()',
    'sys.stdout.write("\\u4e2d\\u6587 \\U0001F600")',
    'sys.stdout.flush()',
    'real.write(json.dumps({"out": out.getvalue().hex(), "cp950": "\\u4e2d\\u6587 ".encode("cp950").hex()}))'
  ])
  expect(String(got.out)).toBe(String(got.cp950) + Buffer.from('\\U0001f600').toString('hex'))
})

python.it('the whole report on a cp1252 console: an intact bundle in a folder named with an emoji keeps its verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-console-'))
  tmps.push(root)
  const dir = unpackTo(path.join(__dirname, 'fixtures', 'provenance-vectors', BUNDLE), path.join(root, 'bundle-\u{1F600}'))
  const got = run([
    ...wrapped('cp1252'),
    'try:',
    '    status = rv.main([sys.argv[2]])',
    'except BaseException as e:',
    '    status = repr(e)',
    'sys.stdout.flush(); sys.stderr.flush()',
    'real.write(json.dumps({"status": status, "out": out.getvalue().decode("cp1252"), "err": err.getvalue().decode("cp1252")}))'
  ], dir)
  expect(got.status, String(got.err)).toBe(0)
  expect(String(got.out)).toContain('bundle-\\U0001f600')
  expect(String(got.out)).toMatch(/^Chain\s+: INTACT\r?$/m)
  expect(String(got.out)).toMatch(/^Seal\s+: SEALED/m)
})
