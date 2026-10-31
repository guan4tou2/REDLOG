import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
it('keeps mitmproxy WebSocket/TCP history bounded while numbering every message once', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-message-history-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
})
