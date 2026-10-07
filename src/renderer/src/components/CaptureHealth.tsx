import { useState, useEffect } from 'react'
import { SectionLabel } from './SectionLabel'
import { computeCaptureReadiness, primaryCaptureAction, type CaptureAction } from '../lib/captureReadiness'
import { httpCaptureState, type HttpCaptureState } from '../lib/httpCaptureState'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { useTick } from '../lib/useTick'
import { settingsTarget } from '../lib/navigation'
import { removeHookWithUndo } from '../lib/hookRemoval'
import { formatTime } from '../lib/time'


/** Both core captures, always named, each with its own state. Commands is
 *  complete when a command source is active; HTTP(S) speaks the single HTTP
 *  vocabulary from httpCaptureState, and carries what the mitmproxy row used
 *  to say beneath it — that row is not repeated while this line is shown. */
function CoreCaptureLine({ readiness, http, source, sources, proxyError, age, t }: {
  readiness: ReturnType<typeof computeCaptureReadiness>
  http: HttpCaptureState
  source: CaptureSourceInfo | undefined
  sources: CaptureSourceInfo[]
  proxyError: string | undefined
  /** "8m ago" for a timestamp, or an empty string for a source that has never
   *  recorded. Freshness is reported here as data, in its own column — it is
   *  what the removed `idle` state was a bad way of saying. */
  age: (ts: number | null) => string
  t: (key: string) => string
}): JSX.Element {
  const commands = readiness.groups.find((g) => g.id === 'commands')
  // Can commands be recorded — the same question, and the same four words, as
  // every row in the inventory below. The core line used to speak its own
  // vocabulary (記錄中 / 已設定，還沒有指令), which made an operator compare two
  // descriptions of one thing and work out whether they agreed.
  const cmdSources = (commands?.steps ?? [])
    .map((s) => sources.find((x) => x.id === s.id))
    .filter((s): s is CaptureSourceInfo => s !== undefined)
  const cmd: CaptureSourceInfo['state'] =
    cmdSources.some((s) => s.state === 'ready') ? 'ready'
      : cmdSources.some((s) => s.state === 'error') ? 'error'
        : cmdSources.some((s) => s.state === 'off') ? 'off' : 'unset'
  // The age of the last command, beside the state. The state says whether the
  // terminal CAN record; this says when it last did — and the two are
  // deliberately separate, because an operator who has not typed for an hour
  // has nothing wrong with their capture and should not be coloured as if
  // they did.
  const cmdLast = commands?.steps.reduce<number | null>((acc, s) => {
    const at = sources.find((x) => x.id === s.id)?.lastEventAt ?? null
    return at !== null && (acc === null || at > acc) ? at : acc
  }, null) ?? null
  const mark = (state: 'done' | 'partial' | 'missing' | 'failed'): { mark: string; cls: string } =>
    state === 'done' ? { mark: '●', cls: 'text-emerald-500' }
      : state === 'partial' ? { mark: '◐', cls: 'text-amber-500' }
        : state === 'failed' ? { mark: '!', cls: 'text-red-400' }
          : { mark: '!', cls: 'text-amber-500' }
  const cmdMark = mark(cmd === 'ready' ? 'done' : cmd === 'error' ? 'failed' : 'missing')
  const httpMark = mark(
    http === 'ready' ? 'done'
      : http === 'starting' ? 'partial'
        : http === 'failed' ? 'failed' : 'missing'
  )
  return (
    <div data-testid="capture-core" className="mb-3">
      <SectionLabel className="mb-1">{t('capture.core.heading')}</SectionLabel>
      <ul className="space-y-1 text-xs">
        <li data-testid="capture-core-commands" data-state={cmd} className="flex items-center gap-2">
          <span aria-hidden className={`w-3 text-center shrink-0 ${cmdMark.cls}`}>{cmdMark.mark}</span>
          <span className="flex-1 text-redlog-text">{t('capture.group.commands')}</span>
          {/* The word only when the light is not green. A green dot beside
              "記錄中" says one thing twice and asks the reader to check that
              the two agree; what the word is FOR is the cases a coloured dot
              cannot carry — what is missing, and what to do about it. */}
          {cmd !== 'ready' && (
            <span className="text-redlog-text-faint">{t(`capture.state.${cmd}`)}</span>
          )}
          <span data-testid="capture-core-commands-age" className="w-16 text-right font-mono tabular-nums text-redlog-text-faint">
            {age(cmdLast)}
          </span>
        </li>
        <li data-testid="capture-core-http" data-state={http} className="flex items-start gap-2">
          <span aria-hidden className={`w-3 text-center shrink-0 ${httpMark.cls}`}>{httpMark.mark}</span>
          <span className="flex-1 min-w-0 text-redlog-text">
            {t('capture.group.http')}
            {/* What it buys, because "mitmproxy" alone does not say — and only
                while HTTP capture is not running. Once it is, the line above is
                the whole story. */}
            {(http === 'unset' || http === 'stopped') && (
              <span className="block text-xs text-redlog-text-faint">{t('capture.mitmproxyCapability')}</span>
            )}
            {proxyError && <span className="block text-red-400">{proxyError}</span>}
            {source?.lastError && (
              <span className="block text-red-400" title={source.lastError.message}>{source.lastError.message}</span>
            )}
          </span>
          {http !== 'ready' && <span className="text-redlog-text-faint">{t(`capture.http.${http}`)}</span>}
          <span data-testid="capture-core-http-age" className="w-16 text-right font-mono tabular-nums text-redlog-text-faint">
            {age(source?.lastEventAt ?? null)}
          </span>
        </li>
      </ul>
    </div>
  )
}

export function CaptureHealthCard({ capture, onNavigate, onRefresh }: {
  capture: CaptureHealthInfo
  onNavigate: (v: string) => void
  onRefresh: () => void
}): JSX.Element {
  const { t } = useI18n()

  const SOURCE_LABEL: Record<string, string> = {
    'terminal': t('capture.terminal'),     // RedLog's panes + the operator's own shell
    'mitmproxy': t('capture.mitmproxy'),   // HTTP + DNS — one addon, one row
    'agent-tailer': t('capture.agentTailer'),
    'screenshot': t('capture.screenshot'),
    'clipboard': t('capture.clipboard'),
    // v0.6.92 W-project producers.
    'browser-console': t('capture.browserConsole'),
    'process-monitor': t('capture.processMonitor'),
    'connection-monitor': t('capture.connectionMonitor'),
    'file-watcher': t('capture.fileWatcher')
  }
  // Green means it can record, red means it tried and failed, grey means it is
  // not set up or is switched off. No amber: amber used to mean "set up and
  // quiet", which is what a capture source looks like whenever its operator is
  // reading rather than typing.
  const dot = (s: string): string =>
    s === 'ready' ? 'bg-emerald-500'
      : s === 'error' ? 'bg-red-500' : 'bg-redlog-elevated-hover'

  // Same three colours as every other row: running, failed, or neither.
  const httpDot = (s: HttpCaptureState): string =>
    s === 'ready' ? 'bg-emerald-500'
      : s === 'failed' ? 'bg-red-500' : 'bg-redlog-elevated-hover'

  // v0.9.7: this card is an exception report, not an inventory. It used to
  // list all eight sources unconditionally, so the healthy majority pushed the
  // one broken row out of a glance — the opposite of what a "is anything
  // wrong?" panel is for. Default view now shows ONLY sources that the
  // operator switched on but that are not delivering; everything working, and
  // everything deliberately off, collapses into a one-line summary. `manage`
  // opens the full inventory with the controls.
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Hooks whose removal is waiting out its undo window, shown removed until
  // the health poll reports them gone (lib/hookRemoval.ts).
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const markRemoving = (hookId: string, on: boolean): void => setRemoving((prev) => {
    const next = new Set(prev)
    if (on) next.add(hookId)
    else next.delete(hookId)
    return next
  })
  useEffect(() => {
    setRemoving((prev) => {
      const still = [...prev].filter((id) => capture.sources.some((s) => s.hookId === id && s.installed === true))
      return still.length === prev.size ? prev : new Set(still)
    })
  }, [capture.sources])
  const sources = capture.sources.map((s) => (s.hookId && removing.has(s.hookId) ? { ...s, installed: false } : s))

  // "Switched off, and still writing to the record."
  //
  // The one combination that answers this card's audit question — is anything
  // capturing that I did not put there — with a yes. These producers run
  // outside RedLog under the operator's own sudo, so switching them off inside
  // RedLog never stopped them; it stopped RedLog mentioning them. Filed under
  // `informational` it was invisible by construction, because informational
  // rows are excluded from the compact view. It is not informational. It is
  // the fault.
  // Live, here, is about the PRODUCER, not the operator: a producer that is
  // heartbeating, or whose event landed moments ago, is writing to the record
  // right now. That is the one place a clock still belongs on this card, and
  // it is why removing `idle` costs nothing — "nobody typed for ten minutes"
  // and "something is writing that nobody authorised" are different questions.
  const ROGUE_WINDOW_MS = 10 * 60 * 1000
  const isRogue = (s: CaptureSourceInfo): boolean =>
    s.disabled === true &&
    (s.running === true || (s.lastEventAt !== null && capture.checkedAt - s.lastEventAt <= ROGUE_WINDOW_MS))

  // HTTP capture had two vocabularies on this card: the mitmproxy row's
  // active/idle/absent, and a separate line above it saying the managed proxy
  // was running. Both could be true at once and neither answered "is HTTP
  // being recorded". One derived state now drives the row's dot, its word and
  // its explanation, and the separate line is gone.
  const http = httpCaptureState(
    sources.find((s) => s.id === 'mitmproxy'),
    capture.managedHttpProxy
  )

  // "Something is wrong", and nothing else. A source that is switched off is a
  // choice; one that is not set up is a setup step the core line names; one
  // that is set up and quiet is an operator who is reading rather than typing,
  // which this card has no opinion about. What is left is what an exception
  // report is for: it tried and failed, or it is writing without authorisation.
  // A proxy that could not start is on the core line, with its reason.
  const isProblem = (s: CaptureSourceInfo): boolean =>
    isRogue(s) || (!s.informational && s.state === 'error')
  const problems = sources.filter(isProblem)
  const healthy = sources.filter((s) => s.state === 'ready')

  const setEnabled = async (s: CaptureSourceInfo, on: boolean): Promise<void> => {
    if (!s.configPath) return
    setBusy(s.id)
    try {
      const cfg = await window.redlog.config.get() as Record<string, unknown>
      // config:save replaces the whole doc, so mutating the fetched object in
      // place would be fine — a copy of only the branch we touch keeps this
      // honest if the bridge ever starts caching.
      const next = { ...cfg }
      const writeFlag = (path: string, value: boolean): void => {
        const parts = path.split('.')
        let cur = next as Record<string, unknown>
        for (const p of parts.slice(0, -1)) {
          cur[p] = { ...(cur[p] as Record<string, unknown> ?? {}) }
          cur = cur[p] as Record<string, unknown>
        }
        cur[parts[parts.length - 1]] = value
      }
      writeFlag(s.configPath, on)
      // A pack member is only on when its pack is too. Writing the member
      // alone would leave the operator flipping a switch and watching the row
      // stay `off` — a control reporting the opposite of what it just did.
      // Turning one OFF never touches the pack: the other members are not the
      // operator's to lose.
      if (on && s.packPath) writeFlag(s.packPath, true)
      await window.redlog.config.save(next)
      onRefresh()
    } finally { setBusy(null) }
  }

  const setInstalled = async (s: CaptureSourceInfo, install: boolean): Promise<void> => {
    if (!s.hookId) return
    if (!install) {
      const hookId = s.hookId
      removeHookWithUndo(hookId, t, {
        hide: () => markRemoving(hookId, true),
        restore: () => markRemoving(hookId, false),
        refresh: onRefresh
      })
      return
    }
    setBusy(s.id)
    try {
      const api = window.redlog.hooks
      const r = await api?.install(s.hookId)
      if (r && r.success === false) {
        toast(t('capture.actionFailed'), {
          type: 'error',
          why: t('capture.actionFailedWhy'),
          detail: r.message,
          action: { label: t('common.retry'), onClick: () => { void setInstalled(s, install) } }
        })
      }
      onRefresh()
    } finally { setBusy(null) }
  }
  const stateLabel = (s: string): string => t(`capture.state.${s}`)

  // v0.6.98 C: freshness stripe. Pre-v0.6.98 the state chip said only
  // "active / idle / absent" — an active source that hadn't fired in 45s
  // looked identical to one that fired 200ms ago. Now every source shows
  // "Ns ago" and the chip colour scales with age (green <60s, amber <5min,
  // zinc otherwise). Absent sources still show "—" — no lastEventAt to
  // format.
  // v0.6.99 B: tick every 1s so the ages advance smoothly. Pre-v0.6.99
  // the ages were computed against `capture.checkedAt` which only
  // refreshes on the 5s health poll — visually the label sat at "5s ago"
  // for 5 real seconds then jumped to "10s ago", which read as broken.
  // Now we compute against Date.now() at render time and force a rerender
  // once a second. Under-1-second precision doesn't matter for a
  // capture-freshness readout so cadence stays cheap.
  const nowTick = useTick()
  const fmtAge = (ts: number | null, now: number): string => {
    if (!ts) return '—'
    const sec = Math.max(0, Math.round((now - ts) / 1000))
    if (sec < 60) return `${sec}s ${t('capture.ago')}`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ${t('capture.ago')}`
    const hr = Math.round(min / 60)
    return `${hr}h ${t('capture.ago')}`
  }

  // A rogue source cannot leave the headline saying 健康. The core verdict
  // grades whether capture is WORKING; this grades whether it is AUTHORISED,
  // and a card that reports both has to let the worse one win, or it prints a
  // reassurance directly above the row that contradicts it.
  const rogue = sources.filter(isRogue)
  const dark = capture.verdict === 'dark' || rogue.length > 0
  const partial = capture.verdict === 'partial'
  // Pure + unit-tested in capture-readiness.ts; this card just renders it.
  // All that is left of it is the one next action — the checklist it used to
  // drive said the same two things as the core line above, in a third set of
  // words, and only while nothing had been recorded yet.
  const readiness = computeCaptureReadiness({ ...capture, sources })
  // One of the two core captures is named above and is not able to record.
  // The summary line below the rows must not then say everything is fine.
  const coreGap = http !== 'ready' || sources.find((s) => s.id === 'terminal')?.state !== 'ready'
  // The core line always carries HTTP(S), so a mitmproxy row beneath it would
  // say the same thing twice. A rogue one stays: the core line has no word for
  // "switched off and still writing".
  const shown = manage ? sources : problems.filter((s) => s.id !== 'mitmproxy' || isRogue(s))

  // One action, when there is one: the operator has not recorded a command yet
  // and the terminal is the way to. Installing the shell hook is deliberately
  // not it — RedLog's own pane records with nothing installed.
  const cta = readiness.nextStep === null ? null
    : readiness.nextStep.status === 'todo'
      ? { label: t('capture.ctaOpenTerminal'), run: () => onNavigate('terminal') }
      : { label: t('capture.ctaRunCommand'), run: () => onNavigate('terminal') }
  const mitmSource = sources.find((s) => s.id === 'mitmproxy')
  const barColor = dark ? 'bg-redlog-danger' : partial ? 'bg-amber-500' : 'bg-emerald-500'
  const headline = rogue.length > 0 ? t('capture.rogueHeadline', { count: rogue.length })
    : dark ? t('capture.dark') : partial ? t('capture.partial') : t('capture.healthy')

  return (
    <section>
      {/* §4: card ground is always surface — state is carried by the left
          colour block, the headline, and (for the danger 'dark' verdict only,
          which §1 lets fill/accent with danger) a red-tinted border. The old
          amber/red background washes broke §4 and, for amber, §1. */}
      <div className={`rounded-lg border p-4 pl-5 shadow-card relative overflow-hidden bg-redlog-surface ${
        dark ? 'border-red-900/60' : 'border-redlog-border'
      }`}>
        <span className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${barColor}`} />
        <div className="flex items-center justify-between mb-2">
          <SectionLabel className="tracking-[0.15em]">{t('capture.title')}</SectionLabel>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setManage((m) => !m)}
              className="text-xs font-mono text-redlog-text-dim hover:text-redlog-text transition-colors"
              title={t('capture.auditHint')}
            >
              {manage ? t('capture.done') : t('capture.manageWithHidden', { count: sources.length })}
            </button>
            <span className={`text-xs font-medium ${dark ? 'text-red-300' : partial ? 'text-amber-300' : 'text-emerald-400'}`}>{headline}</span>
          </div>
        </div>
        {/* #217: both core captures, always named. The checklist that used to
            appear instead, while nothing had been recorded, said the same two
            things in different words — and an operator who left first run with
            Commands working and HTTP(S) not set up has to keep seeing that. */}
        <CoreCaptureLine
          readiness={readiness}
          http={http}
          source={mitmSource}
          sources={sources}
          proxyError={capture.managedHttpProxy?.error}
          age={(ts) => (ts === null ? '' : fmtAge(ts, nowTick))}
          t={t}
        />
        {(cta || coreGap) && (
          <div className="flex items-center gap-3 mb-3">
            {cta && (
              <button
                disabled={busy !== null}
                onClick={cta.run}
                className="text-xs font-medium px-2.5 py-1 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30 transition-colors disabled:opacity-40"
              >
                {cta.label}
              </button>
            )}
            <button onClick={() => onNavigate(settingsTarget('hooks'))} className="text-xs text-redlog-text-dim hover:text-redlog-text underline">
              {t('capture.openHooks')}
            </button>
          </div>
        )}
        <div className={manage ? 'grid grid-cols-1 gap-y-1' : 'grid grid-cols-2 gap-x-6 gap-y-1.5'}>
          {shown.map((s) => {
            // The core line already says this about mitmproxy; the inventory
            // row keeps its state word and controls, not a second copy.
            const detail = s.id !== 'mitmproxy'
            return (
            <div key={s.id} data-testid={`capture-row-${s.id}`} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.id === 'mitmproxy' ? httpDot(http) : dot(s.state)}`} />
              <span title={s.label ?? SOURCE_LABEL[s.id] ?? s.id} className={`flex-1 min-w-0 ${s.state === 'off' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>
                <span className="block truncate" title={s.label ?? SOURCE_LABEL[s.id] ?? s.id}>
                  {s.label ?? SOURCE_LABEL[s.id] ?? s.id}
                </span>
                {/* The row says the capability; this says how far it reaches.
                    RedLog's panes always record, so the only open question on
                    this row is whether the operator's OWN terminal is in the
                    record too — which is what the hook does, and the one thing
                    here they can act on. */}
                {s.id === 'terminal' && (
                  <span className="block text-xs text-redlog-text-faint">
                    {t(s.installed === true ? 'capture.terminalOwnShellIncluded' : 'capture.terminalOwnShellMissing')}
                  </span>
                )}
                {detail && s.id === 'mitmproxy' && capture.managedHttpProxy?.error && (
                  <span className="block text-red-400">{capture.managedHttpProxy.error}</span>
                )}
                {s.informational && <span className="ml-1.5 text-redlog-text-faint text-xs uppercase tracking-wide">{t('capture.pluginTag')}</span>}
                {/* The operator believes they stopped this. They stopped
                    RedLog talking about it; the producer is theirs, running
                    under their own sudo, and only they can end it. Say where
                    the teardown lives rather than leaving a red dot. */}
                {isRogue(s) && (
                  <span data-testid={`capture-rogue-${s.id}`} className="block text-redlog-danger">
                    {t('capture.rogueWhy')}
                  </span>
                )}
                {/* Why it failed, not just that it did — the operator cannot
                    act on a red dot alone. */}
                {detail && s.lastError && <span className="block text-red-400" title={s.lastError.message}>{s.lastError.message}</span>}

              </span>
              <span data-testid={`capture-state-${s.id}`} className="text-redlog-text-faint text-xs">
                {s.id === 'mitmproxy' ? t(`capture.http.${http}`) : stateLabel(s.state)}
              </span>
              {/* No colour on the age. It is a fact about the operator's last
                  command, not a grade on the capture: a green "4s ago" that
                  turns amber at five minutes is the quiet-is-a-fault idea
                  coming back in through the stylesheet. */}
              {!manage && s.state !== 'unset' && s.state !== 'off' && (
                <span className="text-xs font-mono tabular-nums shrink-0 text-redlog-text-faint">
                  {fmtAge(s.lastEventAt, nowTick)}
                </span>
              )}
              {manage && (
                <span className="flex items-center gap-1.5 shrink-0">
                  {/* Two independent axes, so two controls. A hook can be
                      installed but switched off, or switched on but not yet
                      installed — collapsing them into one button would hide
                      which half is missing. */}
                  {(() => {
                    // §17: both axes stay visible, but exactly one control is
                    // drawn as the primary — the operator should not have to
                    // work out which button moves them forward when the state
                    // already determines it.
                    const primary = primaryCaptureAction(s)
                    const emphasis = (mine: CaptureAction): string =>
                      primary === mine
                        ? 'border-redlog-accent/60 text-redlog-accent hover:bg-redlog-accent/10'
                        : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text'
                    return (
                      <>
                        {s.configPath && (
                          <button
                            disabled={busy === s.id}
                            onClick={() => void setEnabled(s, s.enabled === false)}
                            className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${emphasis('enable')}`}
                          >
                            {s.enabled === false ? t('capture.turnOn') : t('capture.turnOff')}
                          </button>
                        )}
                        {s.hookId && (
                          <button
                            disabled={busy === s.id}
                            onClick={() => void setInstalled(s, s.installed !== true)}
                            className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${emphasis('install')}`}
                          >
                            {s.installed === true ? t('capture.uninstall') : t('capture.install')}
                          </button>
                        )}
                      </>
                    )
                  })()}
                  {/* No switch and nothing to install: these turn on when
                      their upstream does (mitmproxy in DNS mode, the launched
                      browser, a terminal pane). Claiming "always on" would
                      overstate it, so the state column speaks for itself. */}
                  {!s.configPath && !s.hookId && (
                    <span className="text-xs font-mono text-redlog-text-faint">{t('capture.passive')}</span>
                  )}
                </span>
              )}
            </div>
            )
          })}
          {/* Never under a core line that says otherwise: 一切正常 directly
              beneath "! HTTP(S) 未安裝 mitmproxy" is the card contradicting
              itself one row apart. An empty exception list means nothing is
              broken, which is not the same as nothing is missing. */}
          {!manage && shown.length === 0 && problems.length === 0 && !coreGap && (
            <p className="text-xs text-redlog-text-dim col-span-2">
              {t('capture.allGood', { active: healthy.length })}
            </p>
          )}
        </div>
        {/* No chain/logged footer. It restated the status bar's tier count,
            and its drift warning was a third copy of one the event tile and
            the issues list already raise. */}
        {/* The record had write gaps earlier in this session.
            `lastDbError` expires after a minute so the verdict can recover on
            its own, which is right for "is writing broken NOW" and wrong for
            an audit tool: an engagement that lost rows at 14:02 still lost
            them at 18:00. The counter is the one thing on this card that
            never clears. */}
        {capture.dbErrorTotal > 0 && (
          <div data-testid="capture-db-gaps" className="mt-2 pt-2 border-t border-redlog-border/70 flex items-center gap-2 text-xs">
            <span className="text-redlog-danger">!</span>
            <span className="text-redlog-text-dim">
              {t('capture.dbGaps', {
                count: capture.dbErrorTotal,
                since: capture.dbErrorFirstAt ? formatTime(capture.dbErrorFirstAt) : ''
              })}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
