import { describe, expect, it } from 'vitest'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import { dotShape, shapeTitle } from '../src/renderer/src/lib/timelineDomain'
import type { RedLogEvent } from '../src/core/db/events'

// An in-scope hit is stored as a `scope_violation` row (distance in_scope,
// severity clean) so adherence can be counted. The Timeline listed each one as
// "⚠ Scope violation" next to a Scope page saying everything was in scope, and
// drew it as the diamond reserved for a real violation. Found by running a
// request through the managed proxy with the target inside the scope.

const row = (data: Record<string, unknown>): RedLogEvent => ({
  id: 'e1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op-1', agentType: 'system',
  hostname: 'h', sourceIP: null, targetId: null, data: { subtype: 'scope_violation', target: '10.0.0.5', ...data }, createdAt: 1
})
const t = (k: string): string => k

describe('scope_violation rows that are really an in-scope tally', () => {
  it('is not titled as a violation', () => {
    const title = eventTitle(row({ distance: 'in_scope', severity: 'clean' }))
    expect(title).toContain('10.0.0.5')
    expect(title).not.toMatch(/violation|⚠/i)
  })

  it('does not get the violation diamond or the "out of scope" label', () => {
    const tally = row({ distance: 'in_scope', severity: 'clean' })
    expect(dotShape(tally)).toEqual({ shape: 'circle', scale: 1 })
    expect(shapeTitle(tally, t)).toBe('')
  })

  it('still reads as a violation for every distance that is one', () => {
    for (const distance of ['excluded', 'adjacent_subnet', 'adjacent_domain', 'unrelated']) {
      const violation = row({ distance, severity: 'warning' })
      expect(eventTitle(violation)).toMatch(/violation/i)
      expect(dotShape(violation).shape).toBe('diamond')
      expect(shapeTitle(violation, t)).toContain('timeline.shape.scopeViolation')
    }
  })

  it('treats a row from before `distance` was recorded as the violation it was', () => {
    const old = row({})
    expect(eventTitle(old)).toMatch(/violation/i)
    expect(dotShape(old).shape).toBe('diamond')
  })
})
