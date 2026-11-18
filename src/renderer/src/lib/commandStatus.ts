import type { ActivitySummary } from '../../../core/activity-contract'

type T = (key: string, vars?: Record<string, string | number>) => string

/** How a command Activity ended, for the list row's result position. Null for
 * everything that is not a shell command, so other kinds keep their row as is.
 * No command_end is "running or unknown", never "failed" (Spec 069 FR-013).
 * Success is the bare code "0"; it is only ever said for a recorded exit 0,
 * and a pairing state that is not known says nothing, so the two cannot be
 * mistaken for each other. A failure keeps a word beside its code.
 * `text` is one short word that fits the row's result column on one line;
 * `title` is the full sentence, for the tooltip and the accessible name. */
export function activityResultLabel(item: Pick<ActivitySummary, 'kind' | 'state' | 'result'>, t: T): { text: string; title?: string; tone: 'ok' | 'fail' | 'neutral' } | null {
  if (item.kind !== 'command') return null
  if (item.result) {
    const code = item.result.exitCode
    if (code === 0) return { text: '0', tone: 'ok' }
    if (code === null) return { text: t('activity.result.endedShort'), title: t('activity.result.ended'), tone: 'neutral' }
    const failed = t('activity.result.failed', { code })
    return { text: failed, title: failed, tone: 'fail' }
  }
  if (item.state === 'call-only') return { text: t('activity.result.unfinished'), title: t('timeline.command.unfinished'), tone: 'neutral' }
  return null
}
