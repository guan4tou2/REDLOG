import type { RedLogEvent } from '../core/db/events'

/** What the last active-pivot answer was, and for which project. */
export interface LastPivotAnswer { projectId: string | null; count: number }

// The HUD's pivot list is read back from the database (see active-pivots.ts):
// the last 40 pivot rows, parsed, for one answer. It used
// to be recomputed on every shell command_end, because one of them may be the
// end of a foreground tunnel. With no pivot open that is a query for nothing,
// and it ran once per command for the whole of a recording: in a soak of one
// command every 400 ms it was two thirds of the main process's growth (#290).
//
// A command_end can only take a pivot off the list, never put one on, so with
// nothing on the list it cannot change the answer. A pivot event can, and so
// can an answer that belongs to another project or that was never computed.
export function pivotsMayChange(event: Pick<RedLogEvent, 'agentType' | 'data'>, last: LastPivotAnswer | null, projectId: string | null): boolean {
  if (event.agentType === 'pivot') return true
  if (event.agentType !== 'shell' || (event.data as { subtype?: unknown } | undefined)?.subtype !== 'command_end') return false
  return last === null || last.projectId !== projectId || last.count > 0
}
