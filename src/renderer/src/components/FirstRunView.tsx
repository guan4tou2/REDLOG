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
//
// Spec 037: proving the built-in terminal records is the first step, not the
// last. Once it has, the primary action becomes connecting the terminal the
// operator actually works in (RecordTerminalFlow, verified by a nonce command),
// with the timeline demoted to a text link and HTTP offered as an optional,
// dismissable step. And when the built-in terminal is silent, preflight says
// which dependency is missing instead of a timer guessing at it.

import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { isEvidence } from '../lib/housekeeping'
import { eventTitle } from '../lib/eventTitle'
import { EmptyState } from './EmptyState'
import { Button } from './Button'
import { RecordTerminalFlow, MissingList, type RecordTarget } from './RecordTerminalFlow'
import { HttpCaptureStep } from './HttpCaptureStep'
import { missingDependencies, shellLabel } from '../lib/terminalActivation'
import { ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import type { RedLogEvent } from '../../../core/db/events'

const TerminalView = lazy(() => import('./TerminalView'))

/** How long to wait after the operator starts typing before admitting that
 *  nothing is arriving — used only once preflight has found every dependency,
 *  so the message can no longer be "python3 or curl" by guesswork. Long enough
 *  that a slow first command is not called a failure. */
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
  const [preflight, setPreflight] = useState<RuntimePreflight | null>(null)
  const [wsl, setWsl] = useState<WslDistro | null>(null)
  const [recording, setRecording] = useState<RecordTarget | null>(null)

  // "The check failed" is not "everything is fine". Swallowing the rejection
  // left `preflight` null, and a null preflight reports no missing
  // dependencies — so a failed environment check looked exactly like a clean
  // one, on the screen whose whole job is to tell the operator whether RedLog
  // can record.
  const [preflightFailed, setPreflightFailed] = useState(false)
  const checkRuntime = (): void => {
    setPreflightFailed(false)
    window.redlog.runtime.preflight()
      .then((p) => { setPreflight(p); setPreflightFailed(false) })
      .catch(() => setPreflightFailed(true))
  }
  useEffect(checkRuntime, [])

  // WSL is its own terminal with its own install path (the one Settings'
  // WslPanel uses); offer it beside the host shell, never instead of it.
  useEffect(() => {
    if (preflight?.platform !== 'win32') return
    window.redlog.wsl.listDistros()
      .then((ds) => setWsl(ds.find((d) => d.isDefault) ?? ds[0] ?? null))
      .catch(() => setWsl(null))
  }, [preflight?.platform])

  // A failed read must never be shown as "nothing has been recorded". That is
  // the one claim this screen cannot get wrong: an operator who is told
  // capture is silent will go looking for a capture problem that does not
  // exist, or worse, conclude the opposite once events appear later.
  const [rowsFailed, setRowsFailed] = useState(false)
  const loadRows = useCallback((): void => {
    void window.redlog.events.query({ limit: 20, excludeHousekeeping: true })
      // `isEvidence`, not `!isHousekeeping`: an IP verdict lands within
      // seconds of opening any project and would light this strip before the
      // operator had done anything.
      .then((r: RedLogEvent[]) => { setRows((r ?? []).filter(isEvidence).slice(0, 8)); setRowsFailed(false) })
      .catch(() => setRowsFailed(true))
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = loadRows
    load()
    const unsub = window.redlog.events.onNewBatch(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 300)
    })
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [loadRows])

  // "Nothing has arrived" and "capture is broken" look identical for the first
  // few seconds and completely different after ten. A missing dependency is
  // known up front from preflight and shown without waiting; this timer only
  // covers what preflight cannot see.
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
  const missing = missingDependencies(preflight)
  const hostTarget: RecordTarget | null = preflight?.shell
    ? { kind: 'host', hookId: preflight.shell.hookId, label: shellLabel(preflight.shell.name) }
    : null
  const wslTarget: RecordTarget | null = wsl
    ? { kind: 'wsl', distro: wsl.name, shell: wsl.hookStatus.zsh !== 'no-shell' ? 'zsh' : 'bash', label: `WSL ${wsl.name}` }
    : null

  return (
    <div className="h-full flex flex-col p-4 gap-3 overflow-auto">
      <div>
        <h2 className="text-lg font-semibold text-redlog-text">{t('firstRun.title')}</h2>
        <p className="text-xs text-redlog-text-dim mt-1">{t('firstRun.hint')}</p>
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-w-0 border border-redlog-border rounded-lg overflow-hidden">
          <Suspense fallback={<div className="h-full bg-redlog-surface animate-pulse" />}>
            <TerminalView />
          </Suspense>
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
                    <span className="text-redlog-text-dim truncate" title={eventTitle(e, t)}>{eventTitle(e, t)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-redlog-text mb-2">{t('firstRun.recordedOk')}</p>
              <div className="flex flex-wrap gap-2">
                {hostTarget && (
                  <Button level="primary" onClick={() => setRecording(hostTarget)} data-testid="first-run-record-terminal">
                    {t('firstRun.recordMyTerminal', { shell: hostTarget.label })}
                  </Button>
                )}
                {wslTarget && (
                  <Button level="secondary" onClick={() => setRecording(wslTarget)} data-testid="first-run-record-wsl">
                    {t('firstRun.recordMyWsl', { distro: wsl?.name ?? '' })}
                  </Button>
                )}
              </div>
              <button
                onClick={() => onNavigate('timeline')}
                data-testid="first-run-builtin-only"
                className="mt-2 text-xs text-redlog-text-dim hover:text-redlog-text underline"
              >
                {t('firstRun.builtinOnly')}
              </button>
              {recording && <RecordTerminalFlow key={recording.label} target={recording} />}
              <div className="mt-3"><HttpCaptureStep /></div>
            </>
          ) : rowsFailed ? (
            // Read failure, not silence. Saying "nothing recorded" here would
            // send the operator hunting a capture problem that does not exist.
            <div data-testid="first-run-read-failed" role="status" className="text-xs space-y-2">
              <p className="font-semibold text-redlog-text">{t('firstRun.readFailedTitle')}</p>
              <p className="text-redlog-text-dim">{t('firstRun.readFailedWhy')}</p>
              <Button level="secondary" onClick={loadRows}>{t('firstRun.recheck')}</Button>
            </div>
          ) : preflightFailed ? (
            <div data-testid="first-run-preflight-failed" role="status" className="text-xs space-y-2">
              <p className="font-semibold text-redlog-text">{t('firstRun.preflightFailedTitle')}</p>
              <p className="text-redlog-text-dim">{t('firstRun.preflightFailedWhy')}</p>
              <Button level="secondary" onClick={checkRuntime}>{t('firstRun.recheck')}</Button>
            </div>
          ) : missing.length > 0 ? (
            <div data-testid="first-run-missing-deps" className="text-xs space-y-2">
              <p className="font-semibold text-redlog-text">{t('firstRun.missingTitle')}</p>
              <p className="text-redlog-text-dim">{t('firstRun.missingWhy', { names: missing.map((c) => c.id).join(', ') })}</p>
              <MissingList missing={missing} />
              <Button level="secondary" onClick={checkRuntime}>{t('firstRun.recheck')}</Button>
            </div>
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
