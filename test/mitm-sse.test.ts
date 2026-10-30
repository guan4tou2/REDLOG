import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
it('saves bounded SSE segments before completion without changing original bytes or another transform', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-sse-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
})
