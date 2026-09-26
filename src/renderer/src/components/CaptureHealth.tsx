import { useState, useEffect } from 'react'
import { computeCaptureReadiness, primaryCaptureAction, type CaptureAction } from '../lib/captureReadiness'
import { httpCaptureState, type HttpCaptureState } from '../lib/httpCaptureState'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { useTick } from '../lib/useTick'
import { settingsTarget } from '../lib/navigation'
import { removeHookWithUndo } from '../lib/hookRemoval'
import { openRuntimeReadiness } from '../lib/runtimeReadiness'

// The dark/setup onboarding block: the three core sources as an ordered
// checklist, plus one primary CTA derived from readiness.nextStep. This is the
// answer to "the timeline is empty, what now" that the old single-sentence hint
// never gave. The checklist and the next-step choice come from the pure,
// unit-tested computeCaptureReadiness — this component only renders and wires
// the buttons to the actions the card already owns.
export function CaptureOnboarding({ readiness, sources, busy, onInstall, onEnable, onNavigate }: {
  readiness: ReturnType<typeof computeCaptureReadiness>
  sources: CaptureSourceInfo[]
  busy: string | null
  onInstall: (s: CaptureSourceInfo, install: boolean) => Promise<void>
  onEnable: (s: CaptureSourceInfo, on: boolean) => Promise<void>
  onNavigate: (v: string) => void
}): JSX.Element {
  const { t } = useI18n()
  const STEP_LABEL: Record<string, string> = {
    'shell-hook': t('capture.shellHook'),
    'agent-tailer': t('capture.agentTailer'),
    'builtin-terminal': t('capture.builtinTerminal'),
    'mitmproxy': t('capture.mitmproxy'),
    'browser-console': t('capture.browserConsole'),
    'screenshot': t('capture.screenshot'),
    'clipboard': t('capture.clipboard'),
    'file-watcher': t('capture.fileWatcher'),
    'process-monitor': t('capture.processMonitor'),
    'connection-monitor': t('capture.connectionMonitor')
  }
  const glyph = (status: string): { mark: string; cls: string } =>
    status === 'active' ? { mark: '●', cls: 'text-emerald-500' }
      : status === 'wired' ? { mark: '◐', cls: 'text-amber-500' }
        : { mark: '○', cls: 'text-redlog-text-faint' }

  const core = readiness.groups.filter((g) => g.core)
  const extra = readiness.groups.filter((g) => !g.core)

  const next = readiness.nextStep
  const nextSource = next ? sources.find((s) => s.id === next.id) : undefined

  // One CTA, chosen by which core source is next and whether it needs setup or
  // just activity. Each maps to an action the card already implements.
  let cta: { label: string; run: () => void } | null = null
  if (next && nextSource) {
    if (next.status === 'todo' && nextSource.hookId) {
      cta = { label: t('capture.ctaInstallHook'), run: () => void onInstall(nextSource, true) }
    } else if (next.status === 'todo' && nextSource.configPath) {
      cta = { label: t('capture.ctaEnableTailer'), run: () => void onEnable(nextSource, true) }
    } else if (next.status === 'todo') {
      cta = { label: t('capture.ctaOpenTerminal'), run: () => onNavigate('terminal') }
    } else {
      // wired but quiet — the setup is done, it just needs a command to fire.
      cta = { label: t('capture.ctaRunCommand'), run: () => onNavigate('terminal') }
    }
  }

  return (
    <div className="mb-3">
      <p className="text-xs text-redlog-text-dim mb-2">
        {readiness.level === 'dark' ? t('capture.setupIntro') : t('capture.setupAlmost')}
      </p>
      {/* Grouped, and no longer numbered. The numbers described a sequence
          that does not exist — an operator on a proxied assessment starts with
          traffic and may never install a shell hook. What the groups say is
          what each source captures, which is the choice actually being made.

          The two core groups sit at the first level and the rest fold under one
          heading below them. A flat list of four headings said Commands and
          HTTP(S) were worth the same as the clipboard watcher, and the operator
          who skims it takes the top of the list as the important part — which
          is how a web assessment ends up recorded with its requests missing. */}
      <div className="space-y-2.5 mb-2.5">
        {core.map((group) => (
          <Group key={group.id} group={group} glyph={glyph} t={t} STEP_LABEL={STEP_LABEL} />
        ))}
        {extra.length > 0 && (
          <div className="pt-2 border-t border-redlog-border/50 space-y-2.5">
            <p className="text-xs text-redlog-text-faint uppercase tracking-wider">
              {t('capture.group.additional')}
            </p>
            {extra.map((group) => (
              <Group key={group.id} group={group} glyph={glyph} t={t} STEP_LABEL={STEP_LABEL} />
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
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
    </div>
  )
}

/** Both core captures, always named, each with its own state. Commands is
 *  complete when a command source is active; HTTP(S) speaks the single HTTP
 *  vocabulary from httpCaptureState. */
function CoreCaptureLine({ readiness, http, t }: {
  readiness: ReturnType<typeof computeCaptureReadiness>
  http: HttpCaptureState
  t: (key: string) => string
}): JSX.Element {
  const commands = readiness.groups.find((g) => g.id === 'commands')
  const cmd: 'active' | 'wired' | 'todo' = !commands ? 'todo'
    : commands.activeCount > 0 ? 'active'
      : commands.steps.some((s) => s.status === 'wired') ? 'wired' : 'todo'
  const mark = (state: 'done' | 'partial' | 'missing' | 'failed'): { mark: string; cls: string } =>
    state === 'done' ? { mark: '●', cls: 'text-emerald-500' }
      : state === 'partial' ? { mark: '◐', cls: 'text-amber-500' }
        : state === 'failed' ? { mark: '!', cls: 'text-red-400' }
          : { mark: '!', cls: 'text-amber-500' }
  const cmdMark = mark(cmd === 'active' ? 'done' : cmd === 'wired' ? 'partial' : 'missing')
  const httpMark = mark(
    http === 'active' ? 'done'
      : http === 'idle' || http === 'listening' || http === 'starting' ? 'partial'
        : http === 'failed' ? 'failed' : 'missing'
  )
  return (
    <div data-testid="capture-core" className="mb-3">
      <p className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider mb-1">{t('capture.core.heading')}</p>
      <ul className="space-y-1 text-xs">
        <li data-testid="capture-core-commands" data-state={cmd} className="flex items-center gap-2">
          <span aria-hidden className={`w-3 text-center shrink-0 ${cmdMark.cls}`}>{cmdMark.mark}</span>
          <span className="flex-1 text-redlog-text">{t('capture.group.commands')}</span>
          <span className="text-redlog-text-faint">{t(`capture.core.commands.${cmd}`)}</span>
        </li>
        <li data-testid="capture-core-http" data-state={http} className="flex items-center gap-2">
          <span aria-hidden className={`w-3 text-center shrink-0 ${httpMark.cls}`}>{httpMark.mark}</span>
          <span className="flex-1 text-redlog-text">{t('capture.group.http')}</span>
          <span className="text-redlog-text-faint">{t(`capture.http.${http}`)}</span>
        </li>
      </ul>
    </div>
  )
}

function Group({ group, glyph, t, STEP_LABEL }: {
  group: ReturnType<typeof computeCaptureReadiness>['groups'][number]
  glyph: (status: string) => { mark: string; cls: string }
  t: (key: string) => string
  STEP_LABEL: Record<string, string>
}): JSX.Element {
  return (
    <div>
      <p className={`text-xs uppercase tracking-wider mb-1 ${
        group.core ? 'font-semibold text-redlog-text-dim' : 'text-redlog-text-faint'
      }`}>
        {t(`capture.group.${group.id}`)}
      </p>
      <ul className="space-y-1">
        {group.steps.map((s) => {
          const g = glyph(s.status)
          return (
            <li key={s.id} className="flex items-center gap-2 text-xs">
              <span className={`shrink-0 ${g.cls}`} aria-hidden>{g.mark}</span>
              <span className={`min-w-0 ${s.status === 'active' ? 'text-redlog-text' : 'text-redlog-text-dim'}`}>
                <span>{STEP_LABEL[s.id] ?? s.id}</span>
                {s.id === 'shell-hook' && (
                  <span className="block text-xs text-redlog-text-faint">
                    {t('capture.shellHookCapability')}
                  </span>
                )}
                {s.id === 'mitmproxy' && (
                  <span className="block text-xs text-redlog-text-faint">
                    {t('capture.mitmproxyCapability')}
                  </span>
                )}
              </span>
              <span className="ml-auto text-xs font-mono text-redlog-text-faint">
                {t(`capture.step.${s.status}`)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function CaptureHealthCard({ capture, onNavigate, onRefresh, tierSplit }: {
  capture: CaptureHealthInfo
  onNavigate: (v: string) => void
  onRefresh: () => void
  // v0.14.3 §9.5: chained·logged split for the card footer. Optional so
  // callers that don't care (tests, older Dashboard mounts) keep working;
  // when omitted the tier line just doesn't render.
  tierSplit?: { chained: number; logged: number; lastLoggedTs: number | null }
}): JSX.Element {
  const { t } = useI18n()

  const SOURCE_LABEL: Record<string, string> = {
    'shell-hook': t('capture.shellHook'),
    'mitmproxy': t('capture.mitmproxy'),   // HTTP + DNS — one addon, one row
    'builtin-terminal': t('capture.builtinTerminal'),
    'agent-tailer': t('capture.agentTailer'),
    'screenshot': t('capture.screenshot'),
    'clipboard': t('capture.clipboard'),
    // v0.6.92 W-project producers.
    'browser-console': t('capture.browserConsole'),
    'process-monitor': t('capture.processMonitor'),
    'connection-monitor': t('capture.connectionMonitor'),
    'file-watcher': t('capture.fileWatcher')
  }
  const dot = (s: string): string =>
    s === 'active' ? 'bg-emerald-500'
      : s === 'error' ? 'bg-red-500'
        : s === 'idle' ? 'bg-amber-500' : 'bg-redlog-elevated-hover'

  // `listening` is amber, not green: the proxy is up, which is the part that
  // tempts a green dot, and nothing has ever come through it, which is the
  // part that matters.
  const httpDot = (s: HttpCaptureState): string =>
    s === 'active' ? 'bg-emerald-500'
      : s === 'failed' ? 'bg-red-500'
        : s === 'listening' || s === 'idle' ? 'bg-amber-500' : 'bg-redlog-elevated-hover'

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

  // "On but not delivering." A source switched off is a choice, not a fault;
  // a hook that was never installed is a setup step, and the banner above
  // already covers the nothing-is-wired case.
  const isProblem = (s: CaptureSourceInfo): boolean =>
    // E3: plugin producers are optional/manual — an idle or unrun one is never
    // a fault to nag about, so they stay out of the compact "problems" view
    // (they're still listed in `manage`, read-only, with honest live state).
    !s.informational &&
    (s.state === 'error' || s.state === 'absent'
      || (s.state === 'idle' && (s.installed === true || s.lastEventAt !== null)))
  const problems = sources.filter(isProblem)
  const healthy = sources.filter((s) => s.state === 'active')
  const shown = manage ? sources : problems
  const hiddenCount = sources.length - problems.length

  // HTTP capture had two vocabularies on this card: the mitmproxy row's
  // active/idle/absent, and a separate line above it saying the managed proxy
  // was running. Both could be true at once and neither answered "is HTTP
  // being recorded". One derived state now drives the row's dot, its word and
  // its explanation, and the separate line is gone.
  const http = httpCaptureState(
    sources.find((s) => s.id === 'mitmproxy'),
    capture.managedHttpProxy
  )

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
  const ageColor = (ts: number | null, now: number): string => {
    if (!ts) return 'text-redlog-text-faint'
    const sec = (now - ts) / 1000
    if (sec < 60) return 'text-emerald-500/80'
    if (sec < 300) return 'text-amber-500/80'
    return 'text-redlog-text-faint'
  }

  const dark = capture.verdict === 'dark'
  const partial = capture.verdict === 'partial'
  // The ordered dark->recording onboarding model. Pure + unit-tested in
  // capture-readiness.ts; this card just renders it. Drives the checklist and
  // the single primary CTA below, replacing the old one-line "go to Settings"
  // hint that dropped a first-run operator into a 2600-line page with no order.
  const readiness = computeCaptureReadiness({ ...capture, sources })
  const barColor = dark ? 'bg-redlog-danger' : partial ? 'bg-amber-500' : 'bg-emerald-500'
  const headline = dark ? t('capture.dark') : partial ? t('capture.partial') : t('capture.healthy')

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
          <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em]">{t('capture.title')}</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={openRuntimeReadiness}
              className="text-xs font-mono text-redlog-text-dim hover:text-redlog-text transition-colors"
            >
              {t('readiness.reopen')}
            </button>
            <button
              onClick={() => setManage((m) => !m)}
              className="text-xs font-mono text-redlog-text-dim hover:text-redlog-text transition-colors"
              title={t('capture.manageHint')}
            >
              {manage ? t('capture.done') : t('capture.manageWithHidden', { count: capture.sources.length })}
            </button>
            <span className={`text-xs font-medium ${dark ? 'text-red-300' : partial ? 'text-amber-300' : 'text-emerald-400'}`}>{headline}</span>
          </div>
        </div>
        {/* #217: once anything is recording, the onboarding block below goes
            away — and with it the only place the two core captures were
            named. An operator who left first-run with Commands verified and
            HTTP(S) not set up must keep seeing that, not have it fold into an
            exception list that only shows sources which were switched on. */}
        {readiness.level === 'recording' && (
          <CoreCaptureLine readiness={readiness} http={http} t={t} />
        )}
        {readiness.level !== 'recording' && (
          <CaptureOnboarding
            readiness={readiness}
            sources={sources}
            busy={busy}
            onInstall={setInstalled}
            onEnable={setEnabled}
            onNavigate={onNavigate}
          />
        )}
        <div className={manage ? 'grid grid-cols-1 gap-y-1' : 'grid grid-cols-2 gap-x-6 gap-y-1.5'}>
          {shown.map((s) => (
            <div key={s.id} data-testid={`capture-row-${s.id}`} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.id === 'mitmproxy' ? httpDot(http) : dot(s.state)}`} />
              <span title={s.label ?? SOURCE_LABEL[s.id] ?? s.id} className={`flex-1 min-w-0 ${s.state === 'off' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>
                <span className="block truncate" title={s.label ?? SOURCE_LABEL[s.id] ?? s.id}>
                  {s.label ?? SOURCE_LABEL[s.id] ?? s.id}
                </span>
                {s.id === 'shell-hook' && (
                  <span className="block text-xs text-redlog-text-faint">
                    {t('capture.shellHookCapability')}
                  </span>
                )}
                {/* A proxy that is up and has never had one request routed
                    through it is the normal way HTTP capture fails: nothing in
                    RedLog is misconfigured, the operator's browser or tool is
                    simply not using it. It used to be indistinguishable from a
                    healthy quiet proxy. */}
                {s.id === 'mitmproxy' && http === 'listening' && (
                  <span data-testid="capture-http-listening" className="block text-amber-400">
                    {t('capture.http.listeningWhy')}
                  </span>
                )}
                {s.id === 'mitmproxy' && capture.managedHttpProxy?.error && (
                  <span className="block text-red-400">{capture.managedHttpProxy.error}</span>
                )}
                {s.informational && <span className="ml-1.5 text-redlog-text-faint text-xs uppercase tracking-wide">{t('capture.pluginTag')}</span>}
                {/* Why it failed, not just that it did — the operator cannot
                    act on a red dot alone. */}
                {s.lastError && <span className="block text-red-400" title={s.lastError.message}>{s.lastError.message}</span>}

                {/* Which streams this row is actually carrying. `mitmproxy`
                    covers HTTP and DNS, and they are two processes: an
                    operator who started the proxy assumes DNS came with it. */}
                {s.streams && (s.streams.http || s.streams.dns) && (
                  <span data-testid={`capture-streams-${s.id}`} className="block text-redlog-text-faint">
                    {s.streams.http && s.streams.dns
                      ? t('capture.streamsBoth')
                      : s.streams.http ? t('capture.streamsHttpOnly') : t('capture.streamsDnsOnly')}
                  </span>
                )}
              </span>
              <span data-testid={`capture-state-${s.id}`} className="text-redlog-text-faint text-xs">
                {s.id === 'mitmproxy'
                  ? t(`capture.http.${http}`)
                  : s.state === 'off'
                    ? t('capture.state.off')
                    // A plugin producer isn't "installed" in the hook sense — it's
                    // run on demand — so report its live state, not "not installed".
                    : s.state === 'error' ? stateLabel('error')
                      : (!s.informational && s.installed === false) ? t('capture.notInstalled') : stateLabel(s.state)}
              </span>
              {!manage && s.installed !== false && s.state !== 'off' && (
                <span className={`text-xs font-mono tabular-nums shrink-0 ${ageColor(s.lastEventAt, nowTick)}`}>
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
                    <span className="text-xs font-mono text-redlog-muted">{t('capture.passive')}</span>
                  )}
                </span>
              )}
            </div>
          ))}
          {!manage && shown.length === 0 && (
            <p className="text-xs text-redlog-text-dim col-span-2">
              {healthy.length > 0
                ? t('capture.allGood', { active: healthy.length })
                : t('capture.noneEnabled')}
            </p>
          )}
        </div>
        {/* Two-tier chain-health footer. Renders only when the logged tier
         *  has at least one row. Chained is the brighter number
         *  (audit chain); logged renders muted (supporting evidence).
         *  "Last fed" is the newest logged-row age — a slow tick is fine
         *  because it uses the same 1s nowTick as the source-row ages. */}
        {tierSplit && tierSplit.logged > 0 && (
          <div className="mt-2 pt-2 border-t border-redlog-border/70 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-redlog-text-dim uppercase tracking-[0.1em]">{t('capture.tierChain')}</span>
              <span className="text-redlog-text tabular-nums">{tierSplit.chained.toLocaleString()}</span>
              <span className="text-redlog-muted">&middot;</span>
              <span className="text-redlog-text-dim uppercase tracking-[0.1em]">{t('capture.tierLogged')}</span>
              <span className="text-redlog-text-dim tabular-nums">{tierSplit.logged.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-redlog-text-faint">{t('capture.tierLastFed')}</span>
              <span className={`tabular-nums ${ageColor(tierSplit.lastLoggedTs, nowTick)}`}>
                {fmtAge(tierSplit.lastLoggedTs, nowTick)}
              </span>
            </div>
          </div>
        )}
        {capture.proxyEnv && (
          <div className="mt-2 pt-2 border-t border-redlog-border/70 flex items-center gap-2 text-xs font-mono">
            <span className="text-emerald-500/80">●</span>
            <span className="text-redlog-text-dim uppercase tracking-[0.1em]">{t('capture.proxyDetected')}</span>
            <span className="text-redlog-text-faint truncate" title={capture.proxyEnv.httpsProxy ?? capture.proxyEnv.httpProxy}>
              {capture.proxyEnv.httpsProxy ?? capture.proxyEnv.httpProxy}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
