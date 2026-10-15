import { confirmGraded } from '../components/ConfirmDialog'

// Shared confirmation for every project-switch surface. The old recording
// ends, while panes and their running jobs survive into an unrecorded picker
// or a new project recording. This is no longer irreversible shell loss.

type T = (key: string, vars?: Record<string, string | number>) => string

export interface LeaveProjectOpts {
  /** The project being left — named in the title, because "this project" is
   *  not what the operator is looking at when several are open in a day. */
  projectName: string
  /** The project being switched to, when this is a switch rather than a
   *  return to the picker. Switching stops the current recording the same way;
   *  what differs is only where the operator lands. */
  to?: string
}

/** Ask before the recording stops. False means the operator stayed. */
export async function confirmLeaveProject(t: T, opts: LeaveProjectOpts): Promise<boolean> {
  // Both reads are decoration on a decision the operator can make without
  // them, so neither may block it: a failed count shows the dialog with one
  // line fewer, not a dialog that never opens.
  const [panes, events] = await Promise.all([
    window.redlog.terminal.list().then((l: unknown) => Array.isArray(l) ? l.length : 0).catch(() => 0),
    window.redlog.events.getCount('all').catch(() => null)
  ])

  const consequences = [
    t('project.leaveNoCapture'),
    panes > 0 ? t('project.leaveTerminals', { count: panes }) : null
  ].filter((c): c is string => c !== null)

  return confirmGraded({
    title: opts.to
      ? t('project.switchTitle', { from: opts.projectName, to: opts.to })
      : t('project.leaveTitle', { name: opts.projectName }),
    message: events === null
      ? t('project.leaveMessage')
      : t('project.leaveMessageCounted', { count: events }),
    level: 'plain',
    consequences,
    confirmLabel: opts.to ? t('project.switchConfirm') : t('project.leaveConfirm'),
    cancelLabel: t('project.leaveCancel')
  })
}
