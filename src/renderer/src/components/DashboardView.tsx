import { PAGE_COLUMN } from '../lib/pageColumn'
import { useState, useEffect, useCallback } from 'react'
import { Globe } from 'lucide-react'
import { Button, TITLEBAR_CONTROL, TITLEBAR_ICON } from './Button'
import { useNarrowViewport } from '../hooks/useNarrowViewport'
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
import { formatFreshness } from '../lib/time'
import { useAppCounts } from '../lib/useAppCounts'
import { eventTileStatus } from '../lib/eventTileStatus'
import { settingsTarget } from '../lib/navigation'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'
import { useCaptureHealthState } from '../lib/useCaptureHealth'
import { captureUnknownLine } from '../lib/captureUnknown'

type HudTone = 'red' | 'amber' | 'cyan'

const ANCHOR_KEY: Record<string, string> = {
  complete: 'dashboard.anchor.complete', pending: 'dashboard.anchor.pending',
  partial: 'dashboard.anchor.partial', failed: 'dashboard.anchor.failed'
}

/** The project's recorded total and where it stands: how many rows are in the
 *  hash chain, how many are kept locally outside it, and the anchor's own
 *  state. A pending anchor is "submitted", never "anchored". Anything wrong
 *  (drift, a stale or failed anchor, a broken sample) rides underneath. */
function RecordSummary({ chained, localOnly, lastAnchor, sub, tone, onOpenActivity }: {
  chained: number; localOnly: number; lastAnchor: { createdAt: number; status: string } | null
  sub: string | undefined; tone: HudTone; onOpenActivity: () => void
}): JSX.Element {
  const { t } = useI18n()
  const anchor = lastAnchor
    ? t(ANCHOR_KEY[lastAnchor.status] ?? 'dashboard.anchor.unknown', { when: formatFreshness(lastAnchor.createdAt, t) })
    : t('dashboard.anchor.none')
  const note = tone === 'red' ? 'text-red-400' : 'text-amber-400'
  return (
    <div data-testid="dashboard-record-summary" className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span data-testid="dashboard-record-total" className="text-xl font-mono font-semibold tabular-nums text-redlog-text">{(chained + localOnly).toLocaleString()}</span>
            <span className="text-sm text-redlog-text-dim">{t('dashboard.recordedEvents')}</span>
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-redlog-text-dim">
            <div><dt className="inline">{t('dashboard.chained')} </dt><dd className="inline font-mono text-redlog-text">{chained.toLocaleString()}</dd></div>
            <div><dt className="inline">{t('dashboard.localOnly')} </dt><dd className="inline font-mono text-redlog-text">{localOnly.toLocaleString()}</dd></div>
            <div><dt className="inline">{t('dashboard.anchorLabel')} </dt><dd data-testid="dashboard-anchor" className="inline font-mono text-redlog-text">{anchor}</dd></div>
          </dl>
        </div>
        <Button data-testid="dashboard-open-activity" onClick={onOpenActivity}>{t('dashboard.openActivity')}</Button>
      </div>
      {sub && <p data-testid="dashboard-record-warning" className={`mt-3 text-xs ${note}`}>{sub}</p>}
    </div>
  )
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-xs text-redlog-text-dim">{label}</dt>
      <dd className="m-0 flex items-center">{children}</dd>
    </div>
  )
}

export function LaunchBrowserButton({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const { t } = useI18n()
  const narrow = useNarrowViewport()

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
  const label = running ? t('browser.stop') : t('browser.launch')
  return (
    <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
    {/* Narrow, this is the widest thing on the strip and it is the one the
        operator touches least, so it gives way first: the icon, with the
        action — which flips between start and stop — as its accessible name
        and tooltip (#298). */}
    <button
      onClick={handleClick}
      disabled={busy}
      aria-label={narrow ? label : undefined}
      title={narrow ? `${label} — ${t('browser.hint', { page: t('settings.pageBrowser') })}` : t('browser.hint', { page: t('settings.pageBrowser') })}
      className={`${narrow ? TITLEBAR_ICON : TITLEBAR_CONTROL} ${
        running
          ? 'bg-redlog-safe/10 text-redlog-safe border-redlog-safe/25 hover:bg-redlog-safe/20'
          : 'bg-redlog-elevated/60 text-redlog-text-dim border-redlog-border/50 hover:bg-redlog-elevated-hover/60 hover:text-redlog-text'
      }`}
    >
      {narrow ? <Globe size={14} strokeWidth={1.75} aria-hidden /> : busy ? '…' : label}
    </button>
    </div>
  )
}

export function DashboardView({ onNavigate, firstRun = false }: { onNavigate: (v: string) => void; firstRun?: boolean; projectName: string }): JSX.Element {
  const { eventCount, loggedCount, chainLen, loading: countsLoading } = useAppCounts()
  const [config, setConfig] = useState<Record<string, Record<string, unknown>> | null>(null)
  // The store's snapshot, shared with the status bar. After a failed read
  // `capture` is the last good one, kept to date it and never drawn as current.
  const { health: capture, status: captureStatus, lastOkAt, refresh: refreshCapture } = useCaptureHealthState()
  // v0.6.88 P2-B: dashboard shows most-recent anchor age so operators can spot
  // a stalled OTS submission at a glance (e.g. "last anchor: 3h ago" vs "26h ago").
  const [lastAnchor, setLastAnchor] = useState<{ createdAt: number; status: string } | null>(null)
  const [localLoading, setLocalLoading] = useState(true)
  // Fixed since §5.3 — no state, no subscription. It was both when the
  // sidebar could be dragged.
  const shortcutOrder = currentShortcutOrder()

  const loading = countsLoading || localLoading
  const scopeCount = ((config?.scope?.targets as string[] | undefined) ?? []).length
  const excludeCount = ((config?.scope?.excludeTargets as string[] | undefined) ?? []).length

  const { t } = useI18n()
  const unknown = captureStatus === 'unknown' ? captureUnknownLine(t, capture, lastOkAt) : undefined

  useEffect(() => {
    // Dashboard-specific fetches — the shared counts (eventCount,
    // scopeObservations, scopeConfigured) come from useAppCounts.
    window.redlog.config.get()
      .then((c) => setConfig(c as Record<string, Record<string, unknown>>))
      .catch(() => {})
      .finally(() => setLocalLoading(false))

    // Anchor age poll — same non-blocking pattern as capture health.
    const loadAnchor = (): void => {
      void window.redlog.chain.anchors().then((list) => {
        const first = list[0]
        if (first) setLastAnchor({ createdAt: first.createdAt, status: first.status })
      }).catch(() => {})
    }
    loadAnchor()
    // The shared counts (eventCount, chainLen, scopeObservations) are refreshed
    // by useAppCounts's own onNew subscription.
    const unsub = window.redlog.events.onNewBatch(() => { refreshCapture(); loadAnchor() })
    const anchorTimer = setInterval(loadAnchor, 60_000)
    return () => { unsub(); clearInterval(anchorTimer) }
  }, [refreshCapture])

  if (loading) {
    return (
      <div role="status" aria-label={t('common.loading')} data-testid="dashboard-loading" className="p-pad overflow-auto h-full"><div className={`${PAGE_COLUMN} space-y-section`}>
        {[40, 32, 20].map((height) => (
          <div key={height} aria-hidden="true" className="rounded-lg bg-redlog-surface border border-redlog-border p-pad animate-pulse" style={{ minHeight: `${height / 4}rem` }}>
            <div className="h-3 w-32 max-w-full bg-redlog-elevated rounded mb-3" />
            <div className="h-5 w-1/2 bg-redlog-elevated rounded" />
          </div>
        ))}
      </div></div>
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
                unknown={unknown}
                onNavigate={onNavigate}
                onRefresh={refreshCapture}
              />
            : <></>
        )}
      />
    )
  }

  return (
    <div className="p-pad overflow-auto h-full"><div className={`${PAGE_COLUMN} space-y-section`}>
      <div data-testid="dashboard-header" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {/* The small label and the hint give way when the window is short, as on the evidence page. */}
          <p className="hidden text-xs font-semibold tracking-[0.15em] text-redlog-accent [@media(min-height:640px)]:block">{t('dashboard.eyebrow')}</p>
          <h1 className="text-lg font-semibold text-redlog-text">{t('sidebar.dashboard')}</h1>
          <p className="mt-1 hidden text-xs text-redlog-text-dim [@media(min-height:640px)]:block">{t('dashboard.hint')}</p>
        </div>
        {/* Says how to read every status on the page; carries no status itself. */}
        <p data-testid="dashboard-freshness-note" className="rounded border border-redlog-border px-2 py-1 text-xs text-redlog-text-dim">{t('dashboard.freshnessNote')}</p>
      </div>
      {/* First, and above the capture card: what is wrong now outranks what is
          merely true now. Renders nothing when nothing is wrong. */}
      <DashboardIssues onNavigate={onNavigate} />

      {capture && (
        <CaptureHealthCard
          capture={capture}
          unknown={unknown}
          onNavigate={onNavigate}
          onRefresh={refreshCapture}
          onSetup={() => onNavigate(settingsTarget('hooks'))}
        />
      )}
      {!capture && (
        <>
          {/* The first read failed: there is no card to put the line in. */}
          {unknown && <p data-testid="capture-unknown" className="text-xs text-redlog-text-dim">{unknown}</p>}
          <Button level="secondary" data-testid="capture-open-setup" onClick={() => onNavigate(settingsTarget('hooks'))}>
            {t('capture.openSetup')}
          </Button>
        </>
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
            observation count, which the sidebar badge carries next to the page
            that opens it; a failed read and an undeclared scope, which are
            conditions and now sit in the panel above with somewhere to go and
            something to press; and "configured", a green box whose whole
            content was that there was nothing to say. A tile is for a number
            that moves. */}
        <RecordSummary
          chained={eventCount}
          localOnly={loggedCount}
          lastAnchor={lastAnchor}
          onOpenActivity={() => onNavigate('search')}
          {...eventTileStatus({
            // The drift check compares the chain length with the *chained* count; the
            // total shown above it is every recorded row (see RecordSummary).
            eventCount, chainLen, lastAnchor, sampleBroken: captureStatus === 'ok' ? capture?.lastSampleBroken : undefined, now: Date.now()
          }, t)}
        />
      </section>

      {config && (
        <section>
          <SectionLabel className="tracking-[0.15em] mb-3">
            {t('dashboard.engagement')}
          </SectionLabel>
          <div className="rounded-lg bg-redlog-surface border border-redlog-border px-4 py-1 shadow-card">
            <dl className="divide-y divide-redlog-border-subtle text-sm [overflow-wrap:anywhere]">
              <SummaryRow label={t('dashboard.id')}><span className="font-mono text-redlog-text">{config.engagement?.id as string}</span></SummaryRow>
              <SummaryRow label={t('dashboard.operator')}><span className="text-redlog-text">{config.operator?.name as string}</span>
                {(config.operator?.id as string | undefined) ? <span className="ml-1.5 font-mono text-xs text-redlog-text-dim">({config.operator?.id as string})</span> : null}</SummaryRow>
              <SummaryRow label={t('dashboard.scopeLabel')}>
                <span data-testid="dashboard-scope-state" className={scopeCount === 0 ? 'text-amber-400' : 'text-emerald-400'}>
                  {scopeCount === 0
                    ? t('dashboard.scopeNotSet')
                    : t(excludeCount > 0 ? 'dashboard.targetsExcluding' : 'dashboard.targets', { count: scopeCount, excluded: excludeCount })}
                </span>
                <Button size="compact" className="ml-3" data-testid="dashboard-view-scope" onClick={() => onNavigate('targets')}>{t('dashboard.viewScope')}</Button>
              </SummaryRow>
            </dl>
          </div>
        </section>
      )}

      <details data-testid="dashboard-shortcuts" className="group">
        <summary className="cursor-pointer select-none text-xs text-redlog-text-dim hover:text-redlog-text">
          {t('dashboard.shortcuts')}
        </summary>
        <div className="mt-3 rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
          <div className="grid grid-cols-2 gap-2.5 text-sm">
            {appShortcuts(shortcutOrder, isMac).map((row) => (
              <div key={row.keys} className="flex items-center gap-2.5">
                <kbd className="bg-redlog-elevated/80 text-redlog-text-dim px-2 py-0.5 rounded text-xs font-mono border border-redlog-border/50">{row.keys}</kbd>
                <span className="text-redlog-text-dim text-xs">{t(row.label)}</span>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div></div>
  )
}
