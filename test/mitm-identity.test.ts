import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

// #459: an event sent after its flow — the TTL dropped marker, a cookie
// rotation, a DNS answer — keeps the project the flow started in.
it('keeps a late flow-derived event in the project its flow started in', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-identity-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('flow identity checks passed')
})
