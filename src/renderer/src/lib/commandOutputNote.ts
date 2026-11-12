import { commandOutputState, type CommandOutputState } from '../../../core/content-contract'

/** What each reader says about a command whose output it cannot show inline.
 *  One table, so the Timeline note, the transcript and the saved-content
 *  reader give the same answer (#591). `inline` and `saved` show the output
 *  itself and have no note. */
export const OUTPUT_NOTE_KEY: Partial<Record<CommandOutputState, string>> = {
  recorded: 'timeline.detail.ioOnDisk',
  empty: 'content.empty',
  unbracketed: 'timeline.detail.ioUnbracketed',
  'not-captured': 'timeline.detail.ioNotCaptured',
  redirected: 'content.output.redirected',
  interactive: 'content.output.interactive',
  incomplete: 'content.output.incomplete',
  unknown: 'content.output.unknown'
}

/** The output state of a finished shell command, or undefined for any other row. */
export function commandOutputOf(event: { agentType: string; data?: Record<string, unknown> }): CommandOutputState | undefined {
  return event.agentType === 'shell' && event.data?.subtype === 'command_end'
    ? commandOutputState(event.data as Record<string, unknown>)
    : undefined
}
