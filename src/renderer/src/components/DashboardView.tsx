import { useState, useEffect, useRef, memo } from 'react'
import IPStatusCard from './IPStatusCard'
import { FirstRunView } from './FirstRunView'
import { CaptureHealthCard } from './CaptureHealth'
import { computeCaptureReadiness } from '../lib/captureReadiness'
import { useI18n } from '../i18n'
import { appShortcuts } from '../lib/shortcuts'
import { isMac } from '../lib/platform'
import { toast } from './Toast'
import { currentShortcutOrder } from '../hooks/useAppShortcuts'
import { useAppCounts } from '../lib/useAppCounts'

export type HudTone = 'red' | 'green' | 'amber' | 'cyan' | 'neutral'

export const StatCard = memo(function StatCard({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: HudTone
}): JSX.Element {
  const bar = tone === 'red' ? 'bg-red-500' : tone === 'green' ? 'bg-emerald-500'
    : tone === 'amber' ? 'bg-amber-500' : tone === 'cyan' ? 'bg-cyan-500' : 'bg-redlog-elevated-hover'
  const valueColor = tone === 'red' ? 'text-red-400' : tone === 'green' ? 'text-emerald-400'
    : tone === 'amber' ? 'text-amber-400' : tone === 'cyan' ? 'text-cyan-400' : 'text-redlog-text'
  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 pl-5 shadow-card transition-shadow hover:shadow-card-hover relative overflow-hidden">
      {/* §4: state rides a left colour block, not a top bar; the card ground
          stays surface regardless of tone. */}
      <span className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${bar}`} />
      <p className="text-xs text-redlog-text-dim uppercase tracking-wider font-medium">{label}</p>
      {/* §4/PHASE1-TOKENS: the StatCard headline number is the "value size"
          (xl = 22px), not a heading (lg = 19px) — it was on text-lg. */}
      <p className={`text-xl font-mono mt-1.5 font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-redlog-text-faint mt-0.5">{sub}</p>}
    </div>
  )
})

export function LaunchBrowserButton({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [proxy, setProxy] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })
  const [proxyBusy, setProxyBusy] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.browser.status().then((s) => setRunning(s.running)).catch(() => {})
    const refresh = (): void => { window.redlog.httpCapture.status().then(setProxy).catch(() => {}) }
    refresh()
    const timer = setInterval(refresh, 3_000)
    return () => clearInterval(timer)
  }, [])

  const toggleProxy = async (): Promise<void> => {
    setProxyBusy(true)
    const next = proxy.state === 'running'
      ? await window.redlog.httpCapture.stop()
      : await window.redlog.httpCapture.start()
    setProxy(next)
    if (next.state === 'running') toast(t('httpCapture.started'), 'success')
    else if (next.state === 'stopped') toast(t('httpCapture.stopped'), 'info')
    else toast(next.error || t('httpCapture.failed'), 'error')
    setProxyBusy(false)
  }

  const handleClick = async (): Promise<void> => {
    setBusy(true)
    if (running) {
      await window.redlog.browser.stop()
      setRunning(false)
      toast(t('browser.stopped'), 'info')
    } else {
      const r = await window.redlog.browser.launch()
      if (r.ok) {
        setRunning(true)
        toast(t('browser.launched'), 'success')
      } else {
        toast(t('browser.failed'), {
          type: 'error',
          why: t('browser.failedWhy'),
          detail: r.error,
          action: { label: t('browser.openSettings'), onClick: () => onNavigate('settings') }
        })
      }
    }
    setBusy(false)
  }

  return (
    <div className="flex items-center gap-1.5">
    <button
      onClick={toggleProxy}
      disabled={proxyBusy || proxy.state === 'starting'}
      title={proxy.error || t('httpCapture.hint')}
      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
        proxy.state === 'running'
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
          : proxy.state === 'failed' || proxy.state === 'unavailable'
            ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
            : 'bg-redlog-elevated/60 text-redlog-text-dim border-redlog-border/50 hover:bg-redlog-elevated-hover/60'
      }`}
    >
      {proxyBusy || proxy.state === 'starting' ? t('httpCapture.starting')
        : proxy.state === 'running' ? t('httpCapture.stop')
          : t('httpCapture.start')}
    </button>
    <button
      onClick={handleClick}
      disabled={busy}
      title={t('browser.hint')}
      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
        running
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
          : 'bg-redlog-elevated/60 text-redlog-text-dim border-redlog-border/50 hover:bg-redlog-elevated-hover/60 hover:text-redlog-text'
      }`}
    >
      {busy ? '…' : running ? t('browser.stop') : t('browser.launch')}
    </button>
    </div>
  )
}

export function DashboardView({ onNavigate, firstRun = false, projectName }: { onNavigate: (v: string) => void; firstRun?: boolean; projectName: string }): JSX.Element {
  const { eventCount, lootCount, scopeViolations, scopeConfigured, loading: countsLoading } = useAppCounts()
  const [chainLen, setChainLen] = useState(0)
  // v0.14.3 §9.5: tier split for the CaptureHealthCard footer. Both
  // start at 0 / null so the card doesn't flash a spurious "no logged
  // rows" line while the initial fetch is in flight.
  const [loggedCount, setLoggedCount] = useState(0)
  const [latestLoggedTs, setLatestLoggedTs] = useState<number | null>(null)
  const [config, setConfig] = useState<Record<string, Record<string, unknown>> | null>(null)
  const [capture, setCapture] = useState<CaptureHealthInfo | null>(null)
  const refreshCaptureRef = useRef<() => void>(() => {})
  // v0.6.88 P2-B: dashboard shows most-recent anchor age so operators can spot
  // a stalled OTS submission at a glance (e.g. "last anchor: 3h ago" vs "26h ago").
  const [lastAnchor, setLastAnchor] = useState<{ createdAt: number; status: string } | null>(null)
  const [localLoading, setLocalLoading] = useState(true)
  // Fixed since §5.3 — no state, no subscription. It was both when the
  // sidebar could be dragged.
  const shortcutOrder = currentShortcutOrder()

  const loading = countsLoading || localLoading

  const { t } = useI18n()

  useEffect(() => {
    // Dashboard-specific fetches — the shared counts (eventCount, lootCount,
    // scopeViolations, scopeConfigured) come from useAppCounts.
    Promise.all([
      window.redlog.chain.length().then(setChainLen).catch(() => {}),
      window.redlog.config.get().then((c) => setConfig(c as Record<string, Record<string, unknown>>)).catch(() => {})
    ]).then(() => setLocalLoading(false))

    // Capture health is non-critical and loaded separately so a slow check
    // never blocks the dashboard.
    const loadCapture = (): void => {
      void window.redlog.capture.health().then(setCapture).catch(() => {})
    }
    // v0.9.7: let the card re-poll right after an install / toggle instead of
    // waiting out the 5s cycle — the button would otherwise look inert.
    refreshCaptureRef.current = loadCapture
    loadCapture()
    // Anchor age poll — same non-blocking pattern as capture health.
    const loadAnchor = (): void => {
      void window.redlog.chain.anchors().then((list) => {
        const first = list[0]
        if (first) setLastAnchor({ createdAt: first.createdAt, status: first.status })
      }).catch(() => {})
    }
    loadAnchor()
    // v0.7.5 G3: refresh dashboard-specific counts on every incoming event.
    // The shared counts (eventCount, lootCount, scopeViolations) are refreshed
    // by useAppCounts's own onNew subscription.
    //
    // v0.7.6 H2: chainLen was ALSO stuck at mount snapshot — the
    // v0.7.5 dogfood surfaced the "⚠ 證據鏈 10396 ≠ 事件 28338" scary
    // Dashboard warning as a direct consequence. Both queries look at
    // the same table (`WHERE hash IS NOT NULL` for chainLen, `COUNT(*)`
    // for events); with the tailer hashing every insert, they always
    // match on-disk. Refreshing chainLen here closes the drift.
    const refreshLocalCounts = (): void => {
      window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {})
      window.redlog.events.getLatestLoggedTs().then(setLatestLoggedTs).catch(() => {})
      window.redlog.chain.length().then(setChainLen).catch(() => {})
    }
    // Seed the tier split on first paint so the card doesn't wait for
    // the first onNew tick to fill in.
    window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {})
    window.redlog.events.getLatestLoggedTs().then(setLatestLoggedTs).catch(() => {})
    const unsub = window.redlog.events.onNewBatch(() => { loadCapture(); loadAnchor(); refreshLocalCounts() })
    const anchorTimer = setInterval(loadAnchor, 60_000)
    return () => { unsub(); clearInterval(anchorTimer) }
  }, [])

  if (loading) {
    return (
      <div className="p-5 space-y-5 overflow-auto h-full">
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg bg-redlog-surface border border-redlog-border p-4 h-20 animate-pulse">
              <div className="h-3 w-12 bg-redlog-elevated rounded mb-3" />
              <div className="h-5 w-8 bg-redlog-elevated rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // §22 / turn 9a. Nothing has been captured yet, so the dashboard's three
  // empty stat cards and ten-source checklist have nothing to describe. Same
  // view id, so every route and every spec that says `dashboard` still works.
  if (firstRun) {
    return (
      <FirstRunView
        onNavigate={onNavigate}
        renderCaptureCard={() => (
          capture
            ? <CaptureHealthCard
                capture={capture}
                onNavigate={onNavigate}
                onRefresh={() => refreshCaptureRef.current()}
                tierSplit={{ chained: eventCount, logged: loggedCount, lastLoggedTs: latestLoggedTs }}
              />
            : <></>
        )}
      />
    )
  }

  return (
    <div className="p-4 space-y-3 overflow-auto h-full">
      {capture && (
        <CaptureHealthCard
          capture={capture}
          onNavigate={onNavigate}
          onRefresh={() => refreshCaptureRef.current()}
          tierSplit={{ chained: eventCount, logged: loggedCount, lastLoggedTs: latestLoggedTs }}
        />
      )}

      <section>
        <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em] mb-3">
          {t('dashboard.networkStatus')}
        </h2>
        <IPStatusCard />
      </section>

      <section>
        <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em] mb-3">
          {t('dashboard.sessionStats')}
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {/* Events + chain length were two cards showing the same number —
              every event is one chain entry so they moved in lockstep. Merged
              here: the big number is events, the sub-line calls out that the
              chain covers the same count (or flags a drift if it ever
              differs, which would itself be a tamper signal). */}
          {(() => {
            // v0.6.88 P2-B: last-anchor age surface. <2h green, <24h amber,
            // 24h+ red (matches the OTS calendar hourly cadence — anything
            // beyond a day means the anchor loop has been broken for a while).
            let anchorSub = ''
            let anchorTone: HudTone = chainLen === eventCount ? 'cyan' : 'red'
            const baseSub = chainLen === eventCount
              ? t('dashboard.chainMatches', { n: chainLen })
              : t('dashboard.chainDrift', { chain: chainLen, events: eventCount })
            if (lastAnchor) {
              const ageMin = Math.floor((Date.now() - lastAnchor.createdAt) / 60000)
              const ageHr = Math.floor(ageMin / 60)
              const ageLabel = ageHr < 1 ? `${ageMin}m` : ageHr < 24 ? `${ageHr}h` : `${Math.floor(ageHr / 24)}d`
              anchorSub = `${baseSub} · ⚓ ${ageLabel}`
              if (lastAnchor.status === 'failed') anchorTone = 'red'
              else if (ageHr >= 24) anchorTone = 'red'
              else if (ageHr >= 2) anchorTone = 'amber'
            } else {
              anchorSub = baseSub
            }
            // Append last-sample-verify age. A broken sample
            // shows "sample BROKEN" in the same sub-line and forces the tile
            // red — the CaptureHealthCard also flips to dark, so the operator
            // gets two independent signals.
            if (capture?.lastSampleBroken) {
              // Append the broken row's own age so the operator can tell a
              // stale historical row from a fresh regression.
              const ets = capture.lastSampleBroken.eventTimestamp
              let ageLabel = ''
              if (typeof ets === 'number' && ets > 0) {
                const days = Math.floor((Date.now() - ets) / 86400000)
                if (days >= 1) ageLabel = ` (${days}d old)`
                else {
                  const hrs = Math.floor((Date.now() - ets) / 3600000)
                  ageLabel = hrs > 0 ? ` (${hrs}h old)` : ' (fresh)'
                }
              }
              anchorSub = `${anchorSub} · sample BROKEN${ageLabel}`
              anchorTone = 'red'
            } else if (capture?.lastSampleOkAt) {
              const sMin = Math.floor((Date.now() - capture.lastSampleOkAt) / 60000)
              const sLabel = sMin < 1 ? '<1m' : sMin < 60 ? `${sMin}m` : `${Math.floor(sMin / 60)}h`
              anchorSub = `${anchorSub} · sampled ${sLabel}`
            }
            return (
              <StatCard
                label={t('dashboard.events')}
                value={String(eventCount)}
                sub={anchorSub}
                tone={anchorTone}
              />
            )
          })()}
          <StatCard label={t('dashboard.loot')} value={String(lootCount)} tone={lootCount > 0 ? 'red' : 'neutral'} />
          <StatCard
            label={t('dashboard.scope')}
            value={scopeViolations > 0 ? String(scopeViolations) : scopeConfigured ? t('dashboard.scopeOk') : t('dashboard.scopeNotConfigured')}
            tone={scopeViolations > 0 ? 'red' : scopeConfigured ? 'green' : 'neutral'}
          />
        </div>
      </section>

      {config && (
        <section>
          <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em] mb-3">
            {t('dashboard.engagement')}
          </h2>
          <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <div>
                <span className="text-redlog-text-dim text-xs">{t('dashboard.id')}</span>
                <p className="text-redlog-text font-mono text-sm mt-0.5">{config.engagement?.id as string}</p>
              </div>
              <div>
                <span className="text-redlog-text-dim text-xs">{t('dashboard.name')}</span>
                <p className="text-redlog-text text-sm mt-0.5">{projectName}</p>
              </div>
              <div>
                <span className="text-redlog-text-dim text-xs">{t('dashboard.operator')}</span>
                <p className="text-redlog-text text-sm mt-0.5">{config.operator?.name as string}</p>
              </div>
              <div>
                <span className="text-redlog-text-dim text-xs">{t('dashboard.scopeLabel')}</span>
                <p className="text-redlog-text text-sm mt-0.5">
                  {t('dashboard.targets', {
                    count: (config.scope?.targets as string[])?.length || 0,
                    mode: (config.scope?.warnOnViolation as boolean | undefined) !== false ? t('dashboard.warningsOn') : t('dashboard.warningsOff')
                  })}
                </p>
              </div>
            </div>
            <button
              onClick={() => onNavigate('settings')}
              className="mt-3 text-xs text-red-400/80 hover:text-red-300 transition-colors"
            >
              {t('dashboard.editSettings')}
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em] mb-3">
          {t('dashboard.shortcuts')}
        </h2>
        <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
          <div className="grid grid-cols-2 gap-2.5 text-sm">
            {appShortcuts(shortcutOrder, isMac).map((row) => (
              <div key={row.keys} className="flex items-center gap-2.5">
                <kbd className="bg-redlog-elevated/80 text-redlog-text-dim px-2 py-0.5 rounded text-xs font-mono border border-redlog-border/50">{row.keys}</kbd>
                <span className="text-redlog-text-dim text-xs">{t(row.label)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
