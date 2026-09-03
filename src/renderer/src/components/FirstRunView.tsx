// The first screen of a new engagement (docs/UIUX-STANDARD.md §22, design turn
// 9a).
//
// What it replaced was a checklist of ten capture sources above three empty
// stat cards — an accurate description of everything RedLog can do, shown to
// someone who has not yet done anything, and therefore a screen that asks the
// operator to make ten decisions before making one. This asks for one thing:
// type a command. The timeline strip beside the terminal lights up when the
// first row lands, which is the only claim that actually needs proving on day
// one — that what you type here is being recorded.
//
// The ten sources are not deleted, only demoted: the same CaptureHealthCard,
// unchanged, sits behind a disclosure below.

import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { isHousekeeping } from '../lib/housekeeping'
import { eventTitle } from './Timeline'
import { EmptyState } from './EmptyState'
import { Button } from './Button'
import { ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import TerminalView from './TerminalView'
import type { RedLogEvent } from '../../../core/db/events'

/** How long to wait after the operator starts typing before admitting that
 *  nothing is arriving. Long enough that a slow first command is not called a
 *  failure; short enough that they are not left reading "nothing yet" while the
 *  hook is silently broken. */
const STUCK_AFTER_MS = 10_000

export function FirstRunView({ onNavigate, renderCaptureCard }: {
  onNavigate: (view: string) => void
  /** The existing capture card, injected so this file does not have to know how
   *  the dashboard builds it — and so it stays exactly the component the
   *  capture tests already cover. */
  renderCaptureCard: () => JSX.Element
}): JSX.Element {
  const { t } = useI18n()
  const [rows, setRows] = useState<RedLogEvent[]>([])
  const [showSources, setShowSources] = useState(false)
  const [stuck, setStuck] = useState(false)
  const waitingSince = useRef<number | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void window.redlog.events.query({ limit: 20, excludeHousekeeping: true })
        .then((r: RedLogEvent[]) => setRows((r ?? []).filter((e) => !isHousekeeping(e)).slice(0, 8)))
        .catch(() => { /* the strip simply stays empty */ })
    }
    load()
    const unsub = window.redlog.events.onNewBatch?.(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 300)
    }) ?? window.redlog.events.onNew(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 300)
    })
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [])

  // "Nothing has arrived" and "capture is broken" look identical for the first
  // few seconds and completely different after ten. The hook this screen relies
  // on needs python3 and curl; without them the operator would otherwise run a
  // command and go on reading an empty-state that says nothing has run yet.
  useEffect(() => {
    if (rows.length > 0) { setStuck(false); return }
    const onKey = (): void => { if (waitingSince.current === null) waitingSince.current = Date.now() }
    window.addEventListener('keydown', onKey)
    const iv = setInterval(() => {
      if (waitingSince.current !== null && Date.now() - waitingSince.current > STUCK_AFTER_MS) setStuck(true)
    }, 1000)
    return () => { window.removeEventListener('keydown', onKey); clearInterval(iv) }
  }, [rows.length])

  const lit = rows.length > 0

  return (
    <div className="h-full flex flex-col p-4 gap-3 overflow-auto">
      <div>
        <h2 className="text-lg font-semibold text-redlog-text">{t('firstRun.title')}</h2>
        <p className="text-xs text-redlog-text-dim mt-1">{t('firstRun.hint')}</p>
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-w-0 border border-redlog-border rounded-lg overflow-hidden">
          <TerminalView />
        </div>

        <div
          className="w-[340px] shrink-0 border border-redlog-border rounded-lg p-3 overflow-auto"
          data-testid="first-run-strip"
          data-first-run-lit={lit ? 'true' : 'false'}
        >
          {lit ? (
            <>
              <p className="text-xs font-semibold text-redlog-accent uppercase tracking-wider mb-2">
                {t('firstRun.recording')}
              </p>
              <ul className="space-y-1 mb-3">
                {rows.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-xs">
                    <span className="text-redlog-text-faint font-mono tabular-nums shrink-0">
                      {formatTime(e.timestamp, { seconds: true })}
                    </span>
                    <span className="text-redlog-text-dim truncate" title={eventTitle(e)}>{eventTitle(e)}</span>
                  </li>
                ))}
              </ul>
              <Button level="primary" onClick={() => onNavigate('timeline')} data-testid="first-run-open-timeline">
                {t('firstRun.openTimeline')}
              </Button>
            </>
          ) : stuck ? (
            <EmptyState
              icon={TerminalIcon}
              title={t('firstRun.stuckTitle')}
              reason={t('firstRun.stuckWhy')}
              action={{ label: t('firstRun.stuckAction'), onClick: () => setShowSources(true) }}
            />
          ) : (
            <EmptyState
              icon={TerminalIcon}
              title={t('firstRun.waitingTitle')}
              reason={t('firstRun.waitingHint')}
            />
          )}
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowSources((v) => !v)}
          data-testid="first-run-more-sources"
          aria-expanded={showSources}
          className="flex items-center gap-1 text-xs text-redlog-text-dim hover:text-redlog-text"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`transition-transform ${showSources ? 'rotate-90' : ''}`}
          />
          {t('firstRun.moreSources')}
        </button>
        {showSources && <div className="mt-2">{renderCaptureCard()}</div>}
      </div>
    </div>
  )
}

export default FirstRunView
