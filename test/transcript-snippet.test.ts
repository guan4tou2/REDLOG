// #225: a step copied into a write-up says where it came from — target,
// time with its UTC offset, event and session IDs — and whether its output is
// verbatim, only a preview in the record, clipped in this copy, or absent.
import { describe, it, expect } from 'vitest'
import { blockToMarkdown, blocksToMarkdown, fenceFor, localTimeWithOffset, outputState } from '../src/renderer/src/lib/transcriptSnippet'
import { pickedSteps } from '../src/renderer/src/lib/transcriptPicks'
import { markerCauses } from '../src/main/ipc/markers'

const t = (key: string, vars?: Record<string, string | number>): string => `${key}${vars ? JSON.stringify(vars) : ''}`
const ts = Date.UTC(2026, 8, 27, 2, 0, 4)
const step = {
  ts, actor: 'op', input: '$ nmap -sV 10.0.0.5', meta: 'exit 0',
  output: 'PORT   STATE\n22/tcp open\n\n80/tcp open',
  events: [{ id: 'ev-1', timestamp: ts, targetId: '10.0.0.5', data: { subtype: 'command_end', terminalId: 'term-3' } }]
}

describe('blockToMarkdown', () => {
  it('carries target, time with offset and UTC, event and session IDs, and keeps newlines', () => {
    const md = blockToMarkdown(step, t)
    expect(md).toContain('snippet.target: `10.0.0.5`')
    expect(md).toContain(`snippet.time: ${localTimeWithOffset(ts)} (UTC 2026-09-27T02:00:04.000Z)`)
    expect(localTimeWithOffset(ts)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/)
    expect(md).toContain('snippet.events: `ev-1`')
    expect(md).toContain('snippet.session: `term-3`')
    expect(md).toContain('PORT   STATE\n22/tcp open\n\n80/tcp open')
    expect(md).toContain('snippet.verbatim')
  })

  it('says when the record holds only a preview, and when this copy clipped it', () => {
    expect(outputState({ ...step, output: 'abc', outputBytes: 9000 })).toEqual({ kind: 'partial-in-record', kept: 3, total: 9000 })
    const clipped = blocksToMarkdown([{ ...step, output: 'x'.repeat(50) }], t, { clipAt: 10 })
    expect(clipped).toContain('snippet.clippedHere{"kept":10,"total":50}')
    expect(clipped).not.toContain('x'.repeat(11))
    // A single step is never clipped.
    expect(blockToMarkdown({ ...step, output: 'x'.repeat(50) }, t)).toContain('x'.repeat(50))
  })

  it('names the missing output instead of leaving a blank', () => {
    const md = blockToMarkdown({ ...step, output: undefined, outputNote: 'uncaptured', events: [{ id: 'e', timestamp: ts, targetId: null }] }, t)
    expect(md).toContain('transcript.note.uncaptured')
    expect(md).toContain('snippet.target: snippet.noTarget')
  })

  it('fences output that itself contains backticks so it cannot close early', () => {
    expect(fenceFor('plain')).toBe('```')
    expect(fenceFor('a ```` b')).toBe('`````')
    const md = blockToMarkdown({ ...step, output: '```\nnot the end\n```' }, t)
    expect(md).toContain('````\n```\nnot the end\n```\n````')
  })

  it('heads a multi-step copy with the disclaimer, the selection and the partial note', () => {
    const md = blocksToMarkdown([step], t, { selection: 'picked', partialNote: 'partial' })
    expect(md.split('\n').slice(0, 5)).toEqual(['# snippet.title', '', '> snippet.disclaimer', '> picked', '> partial'])
  })
})

describe('pickedSteps', () => {
  it('maps each cited event to the pick categories citing it, ignoring other markers and amendments', () => {
    const picks = pickedSteps([
      { id: 'm1', agentType: 'marker', data: { category: 'key_step', _causes: ['ev-1', 'ev-2'] } },
      { id: 'm2', agentType: 'marker', data: { category: 'failed_attempt', _causes: ['ev-2'] } },
      { id: 'm3', agentType: 'marker', data: { category: 'privilege_escalation', _causes: ['ev-3'] } },
      { id: 'a1', agentType: 'marker', data: { subtype: 'amended', markerId: 'm1', _causes: ['m1'] } },
      { id: 'ev-1', agentType: 'shell', data: {} }
    ])
    expect([...picks.keys()].sort()).toEqual(['ev-1', 'ev-2'])
    expect([...picks.get('ev-2')!].sort()).toEqual(['failed_attempt', 'key_step'])
  })
})

describe('markerCauses', () => {
  it('keeps only plausible event ids, deduplicated and bounded', () => {
    expect(markerCauses(['a', 'a', 7, '', 'x'.repeat(200), 'b'])).toEqual(['a', 'b'])
    expect(markerCauses('a')).toEqual([])
    expect(markerCauses(Array.from({ length: 30 }, (_, i) => `e${i}`))).toHaveLength(20)
  })
})
