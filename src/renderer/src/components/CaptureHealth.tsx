import { useState, useEffect } from 'react'
import { computeCaptureReadiness, primaryCaptureAction, type CaptureAction } from '../lib/captureReadiness'
import { useI18n } from '../i18n'
import { toast } from './Toast'

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
          what each source captures, which is the choice actually being made. */}
      <div className="space-y-2.5 mb-2.5">
        {readiness.groups.map((group) => (
          <div key={group.id}>
            <p className="text-xs font-semibold text-redlog-text-faint uppercase tracking-wider mb-1">
              {t(`capture.group.${group.id}`)}
            </p>
            <ul className="space-y-1">
              {group.steps.map((s) => {
                const g = glyph(s.status)
                return (
                  <li key={s.id} className="flex items-center gap-2 text-xs">
                    <span className={`shrink-0 ${g.cls}`} aria-hidden>{g.mark}</span>
                    <span className={s.status === 'active' ? 'text-redlog-text' : 'text-redlog-text-dim'}>
                      {STEP_LABEL[s.id] ?? s.id}
                    </span>
                    <span className="ml-auto text-xs font-mono text-redlog-text-faint">
                      {t(`capture.step.${s.status}`)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
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
        <button onClick={() => onNavigate('settings')} className="text-xs text-redlog-text-dim hover:text-redlog-text underline">
          {t('capture.openHooks')}
        </button>
      </div>
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
    s === 'active' ? 'bg-emerald-500' : s === 'idle' ? 'bg-amber-500' : 'bg-redlog-elevated-hover'

  // v0.9.7: this card is an exception report, not an inventory. It used to
  // list all eight sources unconditionally, so the healthy majority pushed the
  // one broken row out of a glance — the opposite of what a "is anything
  // wrong?" panel is for. Default view now shows ONLY sources that the
  // operator switched on but that are not delivering; everything working, and
  // everything deliberately off, collapses into a one-line summary. `manage`
  // opens the full inventory with the controls.
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // "On but not delivering." A source switched off is a choice, not a fault;
  // a hook that was never installed is a setup step, and the banner above
  // already covers the nothing-is-wired case.
  const isProblem = (s: CaptureSourceInfo): boolean =>
    // E3: plugin producers are optional/manual — an idle or unrun one is never
    // a fault to nag about, so they stay out of the compact "problems" view
    // (they're still listed in `manage`, read-only, with honest live state).
    !s.informational &&
    (s.state === 'absent' || (s.state === 'idle' && (s.installed === true || s.lastEventAt !== null)))
  const problems = capture.sources.filter(isProblem)
  const healthy = capture.sources.filter((s) => s.state === 'active')
  const shown = manage ? capture.sources : problems
  const hiddenCount = capture.sources.length - problems.length

  const setEnabled = async (s: CaptureSourceInfo, on: boolean): Promise<void> => {
    if (!s.configPath) return
    setBusy(s.id)
    try {
      const cfg = await window.redlog.config.get() as Record<string, unknown>
      const parts = s.configPath.split('.')
      // Clone only the branch we touch — config:save replaces the whole doc,
      // so mutating the fetched object in place would be fine, but a copy
      // keeps this honest if the bridge ever starts caching.
      const next = { ...cfg }
      let cur = next as Record<string, unknown>
      for (const p of parts.slice(0, -1)) {
        cur[p] = { ...(cur[p] as Record<string, unknown> ?? {}) }
        cur = cur[p] as Record<string, unknown>
      }
      cur[parts[parts.length - 1]] = on
      await window.redlog.config.save(next)
      onRefresh()
    } finally { setBusy(null) }
  }

  const setInstalled = async (s: CaptureSourceInfo, install: boolean): Promise<void> => {
    if (!s.hookId) return
    setBusy(s.id)
    try {
      const api = window.redlog.hooks
      const r = install ? await api?.install(s.hookId) : await api?.uninstall(s.hookId)
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
  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
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
  const readiness = computeCaptureReadiness(capture)
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
              onClick={() => setManage((m) => !m)}
              className="text-xs font-mono text-redlog-text-dim hover:text-redlog-text transition-colors"
              title={t('capture.manageHint')}
            >
              {manage ? t('capture.done') : t('capture.manageWithHidden', { count: capture.sources.length })}
            </button>
            <span className={`text-xs font-medium ${dark ? 'text-red-300' : partial ? 'text-amber-300' : 'text-emerald-400'}`}>{headline}</span>
          </div>
        </div>
        {readiness.level !== 'recording' && (
          <CaptureOnboarding
            readiness={readiness}
            sources={capture.sources}
            busy={busy}
            onInstall={setInstalled}
            onEnable={setEnabled}
            onNavigate={onNavigate}
          />
        )}
        <div className={manage ? 'grid grid-cols-1 gap-y-1' : 'grid grid-cols-2 gap-x-6 gap-y-1.5'}>
          {shown.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(s.state)}`} />
              <span title={s.label ?? SOURCE_LABEL[s.id] ?? s.id} className={`flex-1 truncate ${s.state === 'off' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>
                {s.label ?? SOURCE_LABEL[s.id] ?? s.id}
                {s.informational && <span className="ml-1.5 text-redlog-text-faint text-xs uppercase tracking-wide">{t('capture.pluginTag')}</span>}
              </span>
              <span className="text-redlog-text-faint text-xs">
                {s.state === 'off'
                  ? t('capture.state.off')
                  // A plugin producer isn't "installed" in the hook sense — it's
                  // run on demand — so report its live state, not "not installed".
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
        {/* v0.14.3 §9.5: two-tier chain-health footer. Renders only when
         *  the logged tier has at least one row — mirrors the StatusBar
         *  behaviour so pre-v0.13 projects and empty engagements stay
         *  visually identical to before. Chained is the brighter number
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
      </div>
    </section>
  )
}
