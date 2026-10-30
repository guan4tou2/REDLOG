import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

it('pins HTTP transport identity before asynchronous send and never spools refused capture', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-transport-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('transport identity and refusal checks passed')
})
