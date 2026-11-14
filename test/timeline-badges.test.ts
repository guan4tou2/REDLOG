// The Timeline's 📮 badge says a row came in through the handoff spool. It
// reads the receiver's stamp (`data._ingest.door`), which a producer cannot
// write; a key in the producer's own data cannot give a row the badge
// (Spec 071 T036, FR-093; owner's ruling 2026-11-15).
import { describe, expect, it } from 'vitest'
import { computeBadges } from '../src/renderer/src/lib/timelineDomain'
import type { RedLogEvent } from '../src/renderer/src/types'

function row(data: Record<string, unknown>): RedLogEvent {
  return { id: 'e1', timestamp: 1, engagementId: 'p', sessionId: 's', operatorId: 'o', agentType: 'shell', hostname: 'h', sourceIP: null, targetId: null, data } as unknown as RedLogEvent
}
const stamp = (door: string): Record<string, unknown> => ({ v: 1, door, producer: 'x', auth: 'none', credential: null })
const spoolKeys = (e: RedLogEvent): string[] => computeBadges(e).filter((b) => b.key === 'spool').map((b) => b.icon)

describe('the handoff-spool badge', () => {
  it('shows for a row whose stamp says the handoff door', () => {
    expect(spoolKeys(row({ subtype: 'command_start', _ingest: stamp('legacy-handoff') }))).toEqual(['📮'])
    expect(spoolKeys(row({ subtype: 'command_start', _ingest: stamp('handoff') }))).toEqual(['📮'])
  })

  it('does not show for the other doors, nor for a row with no stamp', () => {
    for (const door of ['legacy-api', 'api', 'in-process']) expect(spoolKeys(row({ subtype: 'command_start', _ingest: stamp(door) })), door).toEqual([])
    expect(spoolKeys(row({ subtype: 'command_start' }))).toEqual([])
  })

  it('a producer cannot give itself the badge, and a row written before this keeps no badge', () => {
    expect(spoolKeys(row({ subtype: 'command_start', recovered_from_spool: true, _ingest: stamp('legacy-api') }))).toEqual([])
    expect(spoolKeys(row({ subtype: 'command_start', recovered_from_spool: true }))).toEqual([])
  })
})
