import type { ActivitySummary } from '../../../core/activity-contract'

type T = (key: string, vars?: Record<string, string | number>) => string

/** One line saying how a command Activity ended, for the list row. Null for
 * everything that is not a shell command, so other kinds keep their row as is.
 * No command_end is "running or unknown", never "failed" (Spec 069 FR-013). */
export function activityResultLabel(item: Pick<ActivitySummary, 'kind' | 'state' | 'result'>, t: T): { text: string; tone: 'ok' | 'fail' | 'neutral' } | null {
  if (item.kind !== 'command') return null
  if (item.result) {
    const code = item.result.exitCode
    if (code === 0) return { text: t('activity.result.success'), tone: 'ok' }
    if (code === null) return { text: t('activity.result.ended'), tone: 'neutral' }
    return { text: t('activity.result.failed', { code }), tone: 'fail' }
  }
  if (item.state === 'call-only') return { text: t('timeline.command.unfinished'), tone: 'neutral' }
  return null
}
