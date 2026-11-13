// Spec 071 T034, review C and F: readers that judge a row by the whole of
// `data` must not count the receiver's stamp. Every new row carries
// `data._ingest` with its own event_id (FR-005), so comparing two deliveries
// of the same command_end or tool_call whole always found them different:
// the pair stopped collapsing and showed as a conflict. The comparison, the
// generic field list and "has content" go through one helper,
// src/renderer/src/lib/eventContent.ts, which leaves `_ingest` out.
//
// Found by searching src/ for whole-`data` equality (`JSON.stringify(*.data)`),
// hashing and key counts (`Object.keys(data)`); every site is here:
//   timelineEvents.ts collapseCommandPairs, timelineIncremental.ts drawnEvents
//   and toolPairs, toolPairing.ts buildToolPairIndex — pairing;
//   timelineEvents.ts hasContentReader and TimelineEventDetails.tsx
//   GenericEventDetail — content.
// Not changed, on purpose: TimelineEventInspector's raw JSON view (it shows the
// stored row, stamp included), event-write's INSERT (it stores the row), and
// bundle-verify's seal key check (the receiver keys a seal may carry are listed
// there).

import { describe, expect, it } from 'vitest'
import type { RedLogEvent } from '../src/core/db/events'
import { collapseCommandPairs, hasContentReader } from '../src/renderer/src/lib/timelineEvents'
import { drawnEvents, toolPairs } from '../src/renderer/src/lib/timelineIncremental'
import { buildToolPairIndex } from '../src/renderer/src/lib/toolPairing'
import { operationPairKey } from '../src/core/operation-pair-key'

let n = 0
const stamp = (): Record<string, unknown> => ({ v: 1, door: 'legacy-api', producer: 'legacy', credential: null, auth: 'bearer', event_id: `0000000${++n}-0000-7000-8000-000000000000` })
const shell = (data: Record<string, unknown>): RedLogEvent => ({ id: `e${++n}`, agentType: 'shell', engagementId: 'p', sessionId: 's',
  data: { shell: 'zsh', terminalId: 't1', command_id: 'c1', command: 'id', ...data, _ingest: stamp() } } as unknown as RedLogEvent)
const agent = (data: Record<string, unknown>): RedLogEvent => ({ id: `e${++n}`, agentType: 'agent', engagementId: 'p', sessionId: 's',
  data: { agent: 'claude-code', session_id: 'conv', tool_use_id: 'u1', ...data, _ingest: stamp() } } as unknown as RedLogEvent)

describe('command pairs: a re-delivered identical command_end is not a conflict', () => {
  const start = (): RedLogEvent => shell({ subtype: 'command_start' })
  const end = (exit = 0): RedLogEvent => shell({ subtype: 'command_end', exit_code: exit })

  it('timelineEvents collapseCommandPairs: the start folds; a genuinely different second end still keeps it', () => {
    const s = start()
    expect(collapseCommandPairs([s, end(), end()])).not.toContain(s)
    expect(collapseCommandPairs([s, end(0), end(1)])).toContain(s)
  })

  it('timelineIncremental drawnEvents.build: no conflict for identical ends, a conflict for different ones', () => {
    const s = start()
    const key = operationPairKey(s)!
    expect(drawnEvents.build([s, end(), end()], false).closed.get(key)?.conflict).toBe(false)
    expect(drawnEvents.build([s, end(0), end(1)], false).closed.get(key)?.conflict).toBe(true)
  })
})

describe('tool pairs: a re-delivered identical tool_call is not a conflict', () => {
  const call = (cmd = 'ls'): RedLogEvent => agent({ subtype: 'tool_call', tool_name: 'Bash', tool_input: { command: cmd } })

  it('toolPairing buildToolPairIndex', () => {
    expect(buildToolPairIndex([call(), call()]).conflicts.size).toBe(0)
    expect(buildToolPairIndex([call('ls'), call('id')]).conflicts.size).toBe(1)
  })

  it('timelineIncremental toolPairs.extend', () => {
    const first = call()
    const prev = toolPairs.build([first])
    expect(toolPairs.extend!(prev, [first, call()], 1)?.conflicts.size ?? prev.conflicts.size).toBe(0)
    expect(toolPairs.extend!(prev, [first, call('id')], 1)?.conflicts.size).toBe(1)
  })
})

describe('content: the stamp is not content (review F)', () => {
  it('hasContentReader: a generic row whose only key is `_ingest` offers no Reader', () => {
    expect(hasContentReader({ agentType: 'external', data: { _ingest: stamp() } })).toBe(false)
    expect(hasContentReader({ agentType: 'external', data: { note: 'x', _ingest: stamp() } })).toBe(true)
  })
})
