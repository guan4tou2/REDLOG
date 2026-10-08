import { confirmGraded } from '../components/ConfirmDialog'

// Leaving a project is not navigation, and it was shaped like navigation.
//
// `project:close` runs `stopProject()` in main, and stopProject() ends a good
// deal more than the recording. `killAllTerminals()` finalises and kills every
// open pane — each one's `session_end` is written with its cast's SHA-256
// first, so the record stays whole, but whatever was running in the pane does
// not. The cast streams close, the monitors stop, and `clearSpoolIdentity()`
// means a shell outside RedLog has nothing to attribute its events to until a
// project is open again.
//
// Until now the title-bar button did all of that on one click with nothing on
// screen naming any of it, and the ⌘K project list did the same without even
// the button's tooltip. Both go through here instead.
//
// The grade follows what is actually at stake (§5.5) rather than the verb.
// With panes open there is something that cannot be undone — a running job, a
// shell's state — so the operator ticks the box. With none, leaving really is
// cheap to redo, and a checkbox on it would be the friction §5.5 exists to
// ration: trained away by the fiftieth time, and gone on the one that mattered.

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
    level: panes > 0 ? 'irreversible' : 'plain',
    consequences,
    ackLabel: t('project.leaveAck', { count: panes }),
    confirmLabel: opts.to ? t('project.switchConfirm') : t('project.leaveConfirm'),
    cancelLabel: t('project.leaveCancel')
  })
}
