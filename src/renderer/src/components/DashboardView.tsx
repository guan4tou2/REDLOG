import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { TITLEBAR_CONTROL } from './Button'
import { SectionLabel } from './SectionLabel'
import IPStatusCard from './IPStatusCard'
import { FirstRunView } from './FirstRunView'
import { CaptureHealthCard } from './CaptureHealth'
import { DashboardIssues } from './DashboardIssues'
import { useI18n } from '../i18n'
import { appShortcuts } from '../lib/shortcuts'
import { isMac } from '../lib/platform'
import { toast } from './Toast'
import { currentShortcutOrder } from '../hooks/useAppShortcuts'
import { useAppCounts } from '../lib/useAppCounts'
import { eventTileStatus } from '../lib/eventTileStatus'
import { settingsTarget } from '../lib/navigation'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'

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
      <SectionLabel>{label}</SectionLabel>
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
  const { t } = useI18n()

  const readStatus = useCallback(() => {
    window.redlog.browser.status().then((s) => setRunning(s.running)).catch(() => {})
  }, [])

  useEffect(() => {
    readStatus()
    // The operator closing the browser window themselves is the ordinary way
    // a capture session ends, and it used to leave this control offering to
    // stop something that was already gone -- the status was read once, on
    // mount. Main knows the moment it happens, so it says so.
    return window.redlog.browser.onExited(() => setRunning(false))
  }, [readStatus])

  // Belt and braces for the case main cannot see: a launcher process that
  // exits while the browser it started lives on. Coming back to the RedLog
  // window is exactly when the answer gets looked at.
  useRevalidateOnFocus(readStatus)

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
          why: t('browser.failedWhy', { page: t('settings.pageBrowser') }),
          detail: r.error,
          action: { label: t('browser.openSettings'), onClick: () => onNavigate(settingsTarget('browser')) }
        })
      }
    }
    setBusy(false)
  }

  // The proxy toggle used to sit here too, in the most expensive strip in the
  // app, for an action taken at most a few times an engagement -- and it
  // already exists in the HTTP card and on Settings > Browser. Three places
  // for one switch (docs/UIUX-CONTROLS-AND-COPY.md §2, question 3).
  return (
    <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
    <button
      onClick={handleClick}
      disabled={busy}
      title={t('browser.hint', { page: t('settings.pageBrowser') })}
      className={`${TITLEBAR_CONTROL} ${
        running
          ? 'bg-redlog-safe/10 text-redlog-safe border-redlog-safe/25 hover:bg-redlog-safe/20'
          : 'bg-redlog-elevated/60 text-redlog-text-dim border-redlog-border/50 hover:bg-redlog-elevated-hover/60 hover:text-redlog-text'
      }`}
    >
      {busy ? '…' : running ? t('browser.stop') : t('browser.launch')}
    </button>
    </div>
  )
}

export function DashboardView({ onNavigate, firstRun = false, projectName }: { onNavigate: (v: string) => void; firstRun?: boolean; projectName: string }): JSX.Element {
  const { eventCount, loggedCount, chainLen, loading: countsLoading } = useAppCounts()
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
    // Dashboard-specific fetches — the shared counts (eventCount,
    // scopeViolations, scopeConfigured) come from useAppCounts.
    window.redlog.config.get()
      .then((c) => setConfig(c as Record<string, Record<string, unknown>>))
      .catch(() => {})
      .finally(() => setLocalLoading(false))

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
    // The shared counts (eventCount, chainLen, scopeViolations) are refreshed
    // by useAppCounts's own onNew subscription.
    const unsub = window.redlog.events.onNewBatch(() => { loadCapture(); loadAnchor() })
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
              />
            : <></>
        )}
      />
    )
  }

  return (
    <div className="p-4 space-y-3 overflow-auto h-full">
      {/* First, and above the capture card: what is wrong now outranks what is
          merely true now. Renders nothing when nothing is wrong. */}
      <DashboardIssues onNavigate={onNavigate} />

      {capture && (
        <CaptureHealthCard
          capture={capture}
          onNavigate={onNavigate}
          onRefresh={() => refreshCaptureRef.current()}
        />
      )}

      <section>
        <SectionLabel className="tracking-[0.15em] mb-3">
          {t('dashboard.networkStatus')}
        </SectionLabel>
        <IPStatusCard />
      </section>

      <section>
        <SectionLabel className="tracking-[0.15em] mb-3">
          {t('dashboard.sessionStats')}
        </SectionLabel>
        {/* No loot tile: the sidebar badge and the status bar already count
            it, and on the Dashboard it was a third box that read 0 for most
            of an engagement.

            No scope tile either, for the same reason and one more. Its four
            states were three different kinds of thing wearing one shape: a
            violation count, which the sidebar badge carries next to the page
            that opens it; a failed read and an undeclared scope, which are
            conditions and now sit in the panel above with somewhere to go and
            something to press; and "configured", a green box whose whole
            content was that there was nothing to say. A tile is for a number
            that moves. */}
        <div className="grid grid-cols-1 gap-3">
          {(() => {
            // The number shown is every recorded row — the same total the
            // status bar prints and the same set the Timeline scrolls at its
            // default tier: 'all'. It used to show the chained tier alone,
            // which disagreed with both and could only be read by someone who
            // already knew the two tiers existed.
            //
            // The drift check below still compares chainLen against the
            // *chained* count — that is the pair that must match, and feeding
            // it the total would fire a tamper signal on every project with a
            // logged row in it.
            const { sub, tone } = eventTileStatus({
              eventCount, chainLen, lastAnchor, sampleBroken: capture?.lastSampleBroken, now: Date.now()
            }, t)
            return <StatCard label={t('dashboard.events')} value={String(eventCount + loggedCount)} sub={sub} tone={tone} />
          })()}
        </div>
      </section>

      {config && (
        <section>
          <SectionLabel className="tracking-[0.15em] mb-3">
            {t('dashboard.engagement')}
          </SectionLabel>
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
              onClick={() => onNavigate(settingsTarget('scope'))}
              className="mt-3 text-xs text-red-400/80 hover:text-red-300 transition-colors"
            >
              {t('dashboard.editSettings')}
            </button>
          </div>
        </section>
      )}

      <section>
        <SectionLabel className="tracking-[0.15em] mb-3">
          {t('dashboard.shortcuts')}
        </SectionLabel>
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
