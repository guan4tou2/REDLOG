/** What a command printed after its prompt came back, folded from the
 *  follow-up `command_output` rows the relay sends. Both the detail pane and
 *  the transcript read it, so they cannot disagree about whether the output is
 *  complete. */
export interface LateOutputSummary {
  stdout: string
  stderr: string
  /** `running`: no final row yet. `incomplete`: finished, but bytes were lost. */
  state: 'running' | 'done' | 'incomplete'
  lateBytes: number
  lostBytes: number
}

export function summarizeLateOutput(rows: Array<{ data: Record<string, unknown> }>): LateOutputSummary {
  const text = (key: 'stdout' | 'stderr'): string =>
    rows.map((c) => (typeof c.data[key] === 'string' ? (c.data[key] as string) : '')).join('')
  const last = rows.find((c) => c.data.final === true)
  const lostBytes = Number(last?.data.dropped_bytes ?? 0) + Number(last?.data.over_cap_bytes ?? 0)
  return {
    stdout: text('stdout'),
    stderr: text('stderr'),
    state: !last ? 'running' : (last.data.truncated === true || lostBytes > 0 ? 'incomplete' : 'done'),
    lateBytes: Number(last?.data.late_bytes ?? 0),
    lostBytes
  }
}
