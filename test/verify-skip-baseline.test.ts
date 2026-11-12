import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// scripts/verify-skip-baseline.mjs against hand-written JUnit reports: the
// gate must fail on every way a test can stop running, and only on those.

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-skip-baseline.mjs')
let dir = ''

function suite(file: string, tests: number, skipped: number): string {
  return `<testsuite name="${file}" timestamp="x" hostname="h" tests="${tests}" failures="0" errors="0" skipped="${skipped}" time="0"></testsuite>`
}

function run(suites: string[], baseline: object, caps?: object, env: Record<string, string> = {}): { status: number | null; out: string } {
  fs.writeFileSync(path.join(dir, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests">\n${suites.join('\n')}\n</testsuites>\n`)
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ linux: baseline }))
  if (caps) fs.writeFileSync(path.join(dir, 'capabilities-linux.json'), JSON.stringify({ platform: 'linux', capabilities: caps }))
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'junit.xml'), '--platform', 'linux', '--baseline', path.join(dir, 'baseline.json')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', REDLOG_CI_CAPABILITIES: '', ...env }
  })
  return { status: r.status, out: r.stdout + r.stderr }
}

const BASE = { skippedCases: 3, mustRun: ['test/must.test.ts'], skippedFiles: { 'test/perf.test.ts': 3 } }
const SAME = [suite('test/must.test.ts', 4, 0), suite('test/perf.test.ts', 3, 3), suite('test/other.test.ts', 5, 0)]

describe('skip baseline gate', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-skipgate-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('passes a run that skipped exactly what the baseline records', () => {
    const r = run(SAME, BASE)
    expect(r.out).toContain('3 skipped cases (baseline 3)')
    expect(r.status).toBe(0)
  })

  it('fails a file that starts skipping', () => {
    const r = run([suite('test/must.test.ts', 4, 0), suite('test/perf.test.ts', 3, 3), suite('test/other.test.ts', 5, 2)], { ...BASE, skippedCases: 5 })
    expect(r.out).toMatch(/test\/other\.test\.ts: 2 skipped, and it is not in the linux baseline/)
    expect(r.status).toBe(1)
  })

  it('fails more skips in a listed file, and a higher total', () => {
    const r = run([suite('test/must.test.ts', 4, 0), suite('test/perf.test.ts', 5, 5), suite('test/other.test.ts', 5, 0)], BASE)
    expect(r.out).toMatch(/test\/perf\.test\.ts: 5 skipped, baseline 3/)
    expect(r.out).toMatch(/5 skipped cases on linux, baseline 3/)
    expect(r.status).toBe(1)
  })

  it('fails a must-run file that skipped, and one missing from the report', () => {
    const skipped = run([suite('test/must.test.ts', 4, 1), suite('test/perf.test.ts', 3, 2)], BASE)
    expect(skipped.out).toMatch(/test\/must\.test\.ts must run on linux: 4 cases, 1 skipped/)
    expect(skipped.status).toBe(1)
    const missing = run([suite('test/perf.test.ts', 3, 3)], BASE)
    expect(missing.out).toMatch(/test\/must\.test\.ts must run on linux but is not in the report/)
    expect(missing.status).toBe(1)
  })

  it('passes fewer skips and says to lower the baseline', () => {
    const r = run([suite('test/must.test.ts', 4, 0), suite('test/perf.test.ts', 3, 1)], BASE)
    expect(r.out).toMatch(/1 skipped cases on linux, baseline 3/)
    expect(r.out).toContain('lower test/skip-baseline.json')
    expect(r.status).toBe(0)
  })

  it('fails a required capability that is absent, and only reports an unknown one', () => {
    const required = run(SAME, BASE, { zsh: { ok: false, detail: 'ENOENT', manifest: 'required' } })
    expect(required.out).toMatch(/capability zsh is required on linux .* but absent: ENOENT/)
    expect(required.status).toBe(1)
    const unknown = run(SAME, BASE, { bash: { ok: true, detail: '5.2.21', manifest: 'unknown' } })
    expect(unknown.out).toMatch(/capability bash is "unknown" on linux .* present \(5\.2\.21\)/)
    expect(unknown.status).toBe(0)
  })

  it('fails when CI asked for the capability report and none was written', () => {
    const r = run(SAME, BASE, undefined, { REDLOG_CI_CAPABILITIES: '1' })
    expect(r.out).toMatch(/capabilities-linux\.json was not written/)
    expect(r.status).toBe(1)
  })

  it('fails when there is no report at all', () => {
    const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'absent.xml'), '--platform', 'linux'], { encoding: 'utf8' })
    expect(r.stderr).toMatch(/does not exist/)
    expect(r.status).toBe(1)
  })
})
