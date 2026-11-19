import { useEffect } from 'react'
import { useReadState } from './readState'
import type { RedLogEvent } from '../../../core/db/events'

export const isCommandStreamChunk = (e: RedLogEvent): boolean =>
  e.agentType === 'shell' && e.data.subtype === 'command_output' && (e.data.late === true || e.data.streamed === true) && typeof e.data.command_id === 'string'

/** What a command printed after its prompt came back, folded from the
 *  follow-up `command_output` rows the relay sends. Both the detail pane and
 *  the transcript read it, so they cannot disagree about whether the output is
 *  complete. */
export interface LateOutputSummary {
  stdout: string
  stderr: string
  /** Output segments in sequence order. Null is an observed sequence gap. */
  segments: Array<string | null>
  /** `running`: no final row yet. `incomplete`: finished, but bytes were lost. */
  state: 'running' | 'done' | 'incomplete' | 'preview'
  lateBytes: number
  lostBytes: number
}

export function summarizeLateOutput(rows: Array<{ data: Record<string, unknown> }>, hasMore = false): LateOutputSummary {
  const text = (key: 'stdout' | 'stderr'): string =>
    rows.map((c) => (typeof c.data[key] === 'string' ? (c.data[key] as string) : '')).join('')
  const last = rows.find((c) => c.data.final === true)
  const segments: LateOutputSummary['segments'] = []
  let expected: number | undefined = 1
  for (const { data } of rows) {
    const seq = typeof data.seq === 'number' && Number.isSafeInteger(data.seq) && data.seq >= 1 ? data.seq : undefined
    if (seq !== undefined && expected !== undefined && seq > expected) segments.push(null)
    expected = seq === undefined ? undefined : seq + 1
    for (const key of ['stdout', 'stderr']) {
      const value = data[key]
      if (typeof value === 'string' && value) segments.push(value)
    }
  }
  const lostBytes = Number(last?.data.dropped_bytes ?? 0) + Number(last?.data.over_cap_bytes ?? 0)
  return {
    stdout: text('stdout'),
    stderr: text('stderr'),
    segments,
    state: hasMore ? 'preview' : !last ? 'running' : (last.data.truncated === true || lostBytes > 0 || segments.includes(null) ? 'incomplete' : 'done'),
    lateBytes: Number(last?.data.late_bytes ?? 0),
    lostBytes
  }
}

export async function readCommandStream(commandId: string): Promise<LateOutputSummary> {
  const rows = await window.redlog.events.commandOutput(commandId)
  return summarizeLateOutput(rows.items, rows.hasMore)
}

export function useCommandStream(commandId: string | undefined) {
  const read = useReadState(() => readCommandStream(commandId!), !!commandId, [commandId])
  useEffect(() => {
    if (!commandId) return
    return window.redlog.events.onNewBatch((events) => {
      if (events.some(event => isCommandStreamChunk(event)
        && event.data.command_id === commandId)) read.retry()
    })
  }, [commandId, read.retry])
  return read
}

export function commandStreamText(output: LateOutputSummary, gap: string, prefix = ''): string {
  return prefix + output.segments.map((text, index) => {
    if (text !== null) return text
    const previous = index === 0 ? prefix : output.segments[index - 1]
    const start = !previous || previous.endsWith('\n') ? '' : '\n'
    return `${start}${gap}\n`
  }).join('')
}
