import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import type { RedLogEvent } from '../src/core/db/events'

it('reports one observed close per TCP flow, interrupted when the connection carried an error', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-tcp-lifecycle-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
})

it('titles a TCP close by how it ended', () => {
  const end = (data: Record<string, unknown>): RedLogEvent => ({
    id: 'e', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op', agentType: 'scanner',
    hostname: 'h', sourceIP: null, targetId: null, data: { subtype: 'tcp_end', host: '10.0.0.1', port: 445, ...data }, createdAt: 1
  })
  expect(eventTitle(end({ stream_state: 'ended' }))).toBe('[TCP end] 10.0.0.1:445 closed')
  expect(eventTitle(end({ stream_state: 'interrupted', error: 'connection reset' }))).toBe('[TCP end] 10.0.0.1:445 interrupted: connection reset')
})
