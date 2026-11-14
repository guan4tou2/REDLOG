// Traffic has been seen and the command join has resolved none of it — a
// capability this host does not have, not a fact about the engagement. Without
// saying so, a host that cannot answer who owns a socket looks exactly like an
// engagement where every request stood alone, which is how the join sat broken
// for a year. It is a compact warning in the Timeline toolbar; 詳情 opens the
// full explanation and the platform's remedy. Not dismissible: the condition is
// still true until the host can answer.

import { TriangleAlert } from 'lucide-react'
import { isMac, isWindows } from '../../lib/platform'
import { ToolbarPopover } from './ToolbarPopover'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Why this host answers nothing, in its own terms. The three platforms fail
 *  at different points and the remedy is not the same, so a line that lists
 *  all three tells two operators out of three to go install something they do
 *  not need — and said nothing at all to the Windows one, which is how this
 *  was reported. `netstat -no` is always present, so on Windows the socket's
 *  owner is never the missing half: the pid → command link is. */
const blindCauseKey = isWindows
  ? 'timeline.fold.blind.win32'
  : isMac ? 'timeline.fold.blind.darwin' : 'timeline.fold.blind.linux'

export function AttributionStatus({ blind, t }: { blind: boolean; t: Translate }): JSX.Element | null {
  if (!blind) return null
  return (
    <div
      role="status"
      data-testid="timeline-attribution-status"
      className="shrink-0 flex items-center gap-1.5 pl-2 pr-0.5 rounded border border-redlog-warn/50 bg-redlog-warn/12 text-xs text-redlog-warn whitespace-nowrap"
    >
      <TriangleAlert size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
      <span>{t('timeline.attribution.status')}</span>
      <ToolbarPopover
        label={t('timeline.attribution.details')}
        buttonTestId="timeline-attribution-details"
        panelTestId="timeline-attribution-panel"
        panelLabel={t('timeline.attribution.status')}
        buttonClassName="h-7 px-1.5 rounded underline decoration-dotted hover:bg-redlog-warn/12 focus-visible:outline focus-visible:outline-red-400"
        panelClassName="w-80 px-3 py-2 whitespace-normal"
      >
        <p data-testid="log-attribution-blind" className="text-xs text-redlog-warn">
          {t('timeline.fold.blind')} {t(blindCauseKey)}
        </p>
      </ToolbarPopover>
    </div>
  )
}
