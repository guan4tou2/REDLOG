// Output verification for an external shell (#218).
//
// A connected shell hook records the command, its exit code, duration and
// working directory — never its output. The nonce check proves the hook, not
// that anything the command printed was kept. Output reaches RedLog only
// through `redlog-run <cmd>` or a `redlog-session` shell, and the operator
// needs to know which of the two situations they are in before relying on it.
//
// The canary is a command whose OUTPUT contains a string its command line does
// not: `printf '%s-%s\n' redlog-out <nonce>` prints `redlog-out-<nonce>`, and
// that exact text appears nowhere in what was typed. So an event carrying it
// in `stdout` proves output was recorded; the same nonce only in a command
// line proves only the metadata was.

type CanaryEvent = { agentType: string; data: Record<string, unknown> }

export interface OutputCanary {
  nonce: string
  /** what the operator runs, as-is or behind redlog-run / inside redlog-session */
  command: string
  /** the text only the output contains */
  marker: string
}

export function outputCanary(nonce: string): OutputCanary {
  return { nonce, command: `printf '%s-%s\\n' redlog-out ${nonce}`, marker: `redlog-out-${nonce}` }
}

export type CanaryResult =
  /** output carrying the marker was recorded */
  | { kind: 'output'; capturedBy: string }
  /** the command arrived, its output did not */
  | { kind: 'metadata-only' }

export function classifyCanaryEvent(ev: CanaryEvent, canary: OutputCanary): CanaryResult | null {
  if (ev.agentType !== 'shell') return null
  const d = ev.data
  const stdout = typeof d.stdout === 'string' ? d.stdout : ''
  if (stdout.includes(canary.marker)) {
    return { kind: 'output', capturedBy: typeof d.captured_by === 'string' ? d.captured_by : 'unknown' }
  }
  const command = typeof d.command === 'string' ? d.command : ''
  if (d.subtype === 'command_end' && command.includes(canary.nonce) && !command.includes(canary.marker)) {
    return { kind: 'metadata-only' }
  }
  return null
}

/** Output beats metadata: once output is seen, a later metadata-only row
 *  (the plain hook firing for the same line) does not downgrade it. */
export function mergeCanary(prev: CanaryResult | null, next: CanaryResult | null): CanaryResult | null {
  if (!next) return prev
  if (prev?.kind === 'output') return prev
  return next
}
