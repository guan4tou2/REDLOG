import { describe, it, expect } from 'vitest'
import { buildToolPairIndex, pairedToolHalf } from '../src/renderer/src/lib/toolPairing'
import type { RedLogEvent } from '../src/core/db/events'

// The helpers only ever read `event.data`, so a minimal shape suffices.
const ev = (data: Record<string, unknown>): RedLogEvent => ({ data } as unknown as RedLogEvent)

const call = (tuid: string, name = 'Bash', input: unknown = { command: 'ls' }): RedLogEvent =>
  ev({ subtype: 'tool_call', tool_use_id: tuid, tool_name: name, tool_input: input })
const result = (tuid: string, output = 'out'): RedLogEvent =>
  ev({ subtype: 'tool_result', tool_use_id: tuid, output, output_length: output.length })

describe('toolPairing', () => {
  it('a selected tool_call resolves to its result half', () => {
    const c = call('t1'); const r = result('t1', 'files listed')
    const idx = buildToolPairIndex([c, r])
    const paired = pairedToolHalf(c, idx)
    expect(paired?.kind).toBe('result')
    expect(paired?.data.output).toBe('files listed')
  })

  it('a selected tool_result resolves to its call half', () => {
    const c = call('t2', 'Read', { file: 'a.ts' }); const r = result('t2')
    const idx = buildToolPairIndex([c, r])
    const paired = pairedToolHalf(r, idx)
    expect(paired?.kind).toBe('call')
    expect(paired?.data.tool_name).toBe('Read')
    expect(paired?.data.tool_input).toEqual({ file: 'a.ts' })
  })

  it('returns undefined when the partner has not been loaded', () => {
    const idx = buildToolPairIndex([call('lonely')])
    expect(pairedToolHalf(call('lonely'), idx)).toBeUndefined()
  })

  it('returns undefined for events without a tool_use_id', () => {
    const idx = buildToolPairIndex([call('x'), result('x')])
    expect(pairedToolHalf(ev({ subtype: 'assistant_message', full: 'hi' }), idx)).toBeUndefined()
    expect(pairedToolHalf(ev({ subtype: 'tool_call' }), idx)).toBeUndefined() // no tool_use_id
  })

  it('ignores non-tool subtypes and id-less rows when indexing', () => {
    const idx = buildToolPairIndex([
      ev({ subtype: 'user_message', full: 'do it' }),
      ev({ subtype: 'tool_call' }), // no id — skipped
      call('t3'), result('t3')
    ])
    expect(idx.calls.size).toBe(1)
    expect(idx.results.size).toBe(1)
    expect(idx.calls.has('t3')).toBe(true)
  })

  it('on a retried tool_use_id the later turn wins', () => {
    const first = call('dup', 'Bash', { command: 'first' })
    const second = call('dup', 'Bash', { command: 'second' })
    const idx = buildToolPairIndex([first, second, result('dup')])
    expect((idx.calls.get('dup')!.data as Record<string, unknown>).tool_input).toEqual({ command: 'second' })
    expect(pairedToolHalf(result('dup'), idx)?.data.tool_input).toEqual({ command: 'second' })
  })
})
