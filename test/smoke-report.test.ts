import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'redlog-smoke-report-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const good = () => ({
  suites: [{ title: 'packaged', suites: [], specs: [{ title: 'captures', tests: [{
    expectedStatus: 'passed', annotations: [] as { type: string; description: string }[],
    results: [{ status: 'passed', annotations: [] as { type: string; description: string }[] }]
  }] }] }],
  stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 }
})
function verify(report: unknown): { code: number | null; output: string } {
  const file = join(root, 'report with spaces.json')
  writeFileSync(file, JSON.stringify(report))
  const r = spawnSync(process.execPath, [resolve('scripts/verify-smoke-report.mjs'), file], { encoding: 'utf8' })
  return { code: r.status, output: r.stdout + r.stderr }
}

describe('installed smoke report gate', () => {
  it('accepts an actually passing current-format report', () => {
    expect(verify(good())).toMatchObject({ code: 0 })
  })
  it('rejects an empty or missing test population', () => {
    expect(verify({ suites: [], stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } })).toMatchObject({ code: 1 })
  })
  it('rejects a wholly skipped package test even without not-exercised annotations', () => {
    const r = good()
    r.suites[0].specs[0].tests[0].results[0].status = 'skipped'
    r.stats.expected = 0
    r.stats.skipped = 1
    expect(verify(r)).toMatchObject({ code: 1 })
  })
  it('rejects a passed test whose capture step did not run', () => {
    const r = good()
    r.suites[0].specs[0].tests[0].annotations.push({ type: 'not-exercised', description: 'HTTP tools missing' })
    expect(verify(r)).toMatchObject({ code: 1, output: expect.stringContaining('HTTP tools missing') })
  })
  it('also checks result-level runtime annotations', () => {
    const r = good()
    r.suites[0].specs[0].tests[0].results[0].annotations.push({ type: 'not-exercised', description: 'verifier absent' })
    expect(verify(r)).toMatchObject({ code: 1 })
  })
  it('rejects failures, flaky retries and missing summary data', () => {
    const r = good()
    r.suites[0].specs[0].tests[0].results[0].status = 'failed'
    expect(verify(r)).toMatchObject({ code: 1 })
    const retry = good()
    retry.stats.flaky = 1
    expect(verify(retry)).toMatchObject({ code: 1 })
    expect(verify({ suites: good().suites })).toMatchObject({ code: 1 })
  })
})
