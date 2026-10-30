import { it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = 'specs/064-recording-first-workspace/coverage-manifest.json'
function check(change?: (value: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'redlog-contract-map-'))
  try {
    const value = JSON.parse(readFileSync(source, 'utf8'))
    change?.(value)
    const file = join(dir, 'coverage.json')
    writeFileSync(file, JSON.stringify(value))
    return spawnSync(process.execPath, ['scripts/verify-contract-coverage.mjs', file], { encoding: 'utf8' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
it('accepts existing mappings without turning them into acceptance', () => {
  const result = check()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('does not run tests or grant acceptance')
})
it('rejects a missing or duplicate contract', () => {
  expect(check(value => value.contracts.pop()).status).toBe(1)
  expect(check(value => value.contracts[1] = value.contracts[0]).status).toBe(1)
})
it('rejects a nonexistent mapped test or evidence file', () => {
  expect(check(value => value.contracts[0].tests = ['test/missing.test.ts']).status).toBe(1)
  expect(check(value => value.contracts[0].evidence.push('docs/missing.md')).status).toBe(1)
})
it('rejects a fabricated PASS or an evidence-free mapping', () => {
  expect(check(value => value.contracts[0].status = 'PASS').status).toBe(1)
  expect(check(value => value.contracts[0].evidence = []).status).toBe(1)
})
