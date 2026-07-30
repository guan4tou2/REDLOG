import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import IPStatusCard from './components/IPStatusCard'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import Settings from './components/Settings'
import ProjectPicker from './components/ProjectPicker'
import { TargetView } from './components/TargetView'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { SearchPanel } from './components/SearchPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QuickMarksView } from './components/FindingsView'
import TerminalView from './components/TerminalView'
import { ToastContainer } from './components/Toast'
import { LoadingSpinner } from './components/Feedback'
import { ConfirmDialogContainer, confirm as confirmDialog } from './components/ConfirmDialog'
import { toast } from './components/Toast'
import { useI18n } from './i18n'
import { loadSidebarOrder, onSidebarOrderChanged, type SidebarViewId } from './lib/sidebarOrder'
import logoUrl from './assets/logo.svg'

type View = SidebarViewId | 'settings' | 'search'

// ⌘/Ctrl+1..8 map to the sidebar order (which the user can reorder); ⌘9 =
// Settings (pinned at the sidebar's bottom, not part of the reorderable list).
// Reads fresh on demand so a drag-reorder immediately updates the shortcuts.
function currentShortcutOrder(): View[] {
  return [...loadSidebarOrder(), 'settings'] as View[]
}

// Read defensively — this runs at module load, before the preload bridge is
// guaranteed present (e.g. in tests). Default to mac styling.
const isMac = (window as { redlog?: { platform?: string } }).redlog?.platform !== 'win32'
const modKey = isMac ? '⌘' : 'Ctrl+'

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Event to focus when the Timeline opens (set when jumping from Loot); cleared
  // on plain sidebar navigation so a normal Timeline visit scrolls to "now".
  const [focusEvent, setFocusEvent] = useState<{ id: string; ts: number } | null>(null)
  const [showMarker, setShowMarker] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) setProject(p)
    })
  }, [])

  // Global marker shortcut (⌘/Ctrl+Shift+M) is registered in the main process
  // via Electron globalShortcut so it fires whether the window has focus or
  // not. Do NOT also listen for it in the renderer — audit finding P0 #5
  // pointed out the dialog would open twice when the RedLog window was in
  // front (both handlers ran). Renderer only handles ⌘/ and ⌘1..N which
  // must be scoped to the app window.
  useEffect(() => {
    return window.redlog.marker.onShortcut(() => setShowMarker(true))
  }, [])

  // ⌘/Ctrl+1..N follow the sidebar's current (possibly user-reordered) order.
  // Re-read fresh inside the handler so a drag-reorder in the sidebar takes
  // effect immediately, without needing to re-attach the listener.
  //
  // Also handles a few app-wide shortcuts that don't fit the numeric-nav bucket.
  // Audit finding #78 batched here; per-view shortcuts (⌘T new tab, ⌘W close
  // tab) are handled inside the terminal view where they can hit the right
  // handler without conflicting with system shortcuts elsewhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!project) return
      const cmd = e.ctrlKey || e.metaKey
      // Search: ⌘/ was the original shortcut but macOS sends `Unidentified`
      // as e.key for that combo (system-level Help-menu grab), so it never
      // matched. Fall back to `e.code === 'Slash'` which stays 'Slash'
      // regardless of layout/system grab, and also accept ⌘K (common command-
      // palette pattern in Slack/Notion/Linear so muscle memory works).
      if (cmd && (e.key === '/' || e.code === 'Slash' || e.key === 'k' || e.key === 'K')) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
        e.preventDefault()
        setView('search')
        return
      }
      // ⌘/Ctrl+. pause/resume recording — matches the "period = pause"
      // convention macOS uses for stop-download / stop-loading.
      if (cmd && e.key === '.') {
        e.preventDefault()
        window.redlog.recording.toggle().then((on) => {
          toast(on ? t('toast.recordingResumed') : t('toast.recordingPaused'), on ? 'success' : 'warning')
        }).catch(() => {})
        return
      }
      // ⌘⇧⌥ + arrow snaps the HUD to a corner of the display it's currently
      // on (audit finding #53). Was ⌘⌥ initially but macOS Sequoia's built-in
      // window tiling grabs that combo before the app sees it, so add Shift
      // as a third modifier — nothing on stock macOS uses ⌘⇧⌥ + Arrow. Skip
      // when a text field has focus so arrow keys still move the caret.
      // Mapping is symmetric: Up/Left → top-left, Up+Right → top-right,
      // Down/Left → bottom-left, Down+Right → bottom-right — but with a
      // single arrow we pick ↑=tl, ↓=bl, ←=tl, →=br so every combo maps.
      if (cmd && e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
        // Clockwise around the four corners: ↑ = TL, → = TR, ↓ = BR, ← = BL.
        // Reads as "pick the corner in that direction on a compass rose."
        const corner: 'tl' | 'tr' | 'bl' | 'br' =
          e.key === 'ArrowUp' ? 'tl'
          : e.key === 'ArrowRight' ? 'tr'
          : e.key === 'ArrowDown' ? 'br'
          : 'bl'
        e.preventDefault()
        window.redlog.overlay.moveToCorner?.(corner)
        return
      }
      if (cmd && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key)
        if (Number.isNaN(num)) return
        const order = currentShortcutOrder()
        if (num >= 1 && num <= order.length) {
          e.preventDefault()
          setView(order[num - 1])
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [project, t])

  if (!project) {
    return (
      <>
        <ProjectPicker onProjectOpen={(p) => { setProject(p); setView('dashboard') }} />
        <ToastContainer />
        <ConfirmDialogContainer />
      </>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Title bar */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0 border-b border-redlog-border bg-redlog-bg"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={`flex items-center gap-2 ${isMac ? 'pl-16' : ''}`}>
          <img src={logoUrl} alt="" className="w-4 h-4 rounded" />
          <span className="text-red-500 font-bold text-[13px] tracking-[0.2em]">{t('app.title')}</span>
          {/* Take the version out of the drag zone so users reporting bugs can
              actually copy it — audit finding P2 #36. */}
          <span
            className="text-zinc-800 text-xs font-mono select-text cursor-text"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t('app.copyVersionHint')}
          >v{__APP_VERSION__}</span>
        </div>
        <span className="text-zinc-600 text-[11px] ml-4 font-mono">{project.name}</span>
        <div className={`ml-auto flex gap-2 ${isMac ? '' : 'pr-36'}`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <LaunchBrowserButton />
          <button
            onClick={() => setShowMarker(true)}
            className="px-2.5 py-1 text-xs font-medium bg-red-500/10 text-red-400 rounded-md hover:bg-red-500/20 border border-red-500/15 transition-colors"
            title={isMac ? '⌘⇧M' : 'Ctrl+Shift+M'}
          >
            {t('app.mark')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <Sidebar active={view} onNavigate={(v) => { setFocusEvent(null); setView(v as View) }} />

        <div className="flex-1 min-w-0">
          <ErrorBoundary label={view}>
            {view === 'dashboard' && <DashboardView onNavigate={(v) => setView(v as View)} />}
            {view === 'terminal' && <TerminalView />}
            {view === 'timeline' && <TimelinePanel focusEventId={focusEvent?.id} focusTs={focusEvent?.ts} />}
            {view === 'screenshots' && <ScreenshotsView />}
            {view === 'targets' && <TargetView />}
            {view === 'scope' && <ScopeStatus onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} />}
            {view === 'loot' && <LootPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} />}
            {view === 'marks' && <QuickMarksView onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} />}
            {view === 'settings' && <Settings />}
            {view === 'search' && <SearchPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} />}
          </ErrorBoundary>
        </div>
      </div>

      <StatusBar />
      {showMarker && <EventMarker onClose={() => setShowMarker(false)} />}
      <ToastContainer />
      <ConfirmDialogContainer />
    </div>
  )
}

function CaptureHealthCard({ capture, onNavigate }: {
  capture: CaptureHealthInfo
  onNavigate: (v: string) => void
}): JSX.Element {
  const { t } = useI18n()

  const SOURCE_LABEL: Record<string, string> = {
    'shell-hook': t('capture.shellHook'),
    'claude-code': t('capture.claudeCode'),
    'mitmproxy': t('capture.mitmproxy'),
    'builtin-terminal': t('capture.builtinTerminal')
  }
  const dot = (s: string): string =>
    s === 'active' ? 'bg-emerald-500' : s === 'idle' ? 'bg-amber-500' : 'bg-zinc-700'
  const stateLabel = (s: string): string => t(`capture.state.${s}`)

  const dark = capture.verdict === 'dark'
  const partial = capture.verdict === 'partial'
  const barColor = dark ? 'bg-red-500' : partial ? 'bg-amber-500' : 'bg-emerald-500'
  const headline = dark ? t('capture.dark') : partial ? t('capture.partial') : t('capture.healthy')

  return (
    <section>
      <div className={`rounded-lg border p-4 shadow-card relative overflow-hidden ${
        dark ? 'bg-red-950/30 border-red-900/50' : partial ? 'bg-amber-950/20 border-amber-900/40' : 'bg-redlog-surface border-redlog-border'
      }`}>
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${barColor}`} />
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.15em]">{t('capture.title')}</h2>
          <span className={`text-[11px] font-medium ${dark ? 'text-red-300' : partial ? 'text-amber-300' : 'text-emerald-400'}`}>{headline}</span>
        </div>
        {(dark || partial) && (
          <p className="text-[11px] text-zinc-400 mb-3">
            {dark ? t('capture.darkHint') : t('capture.partialHint')}
            {' '}
            <button onClick={() => onNavigate('settings')} className="text-red-400/90 hover:text-red-300 underline">
              {t('capture.openHooks')}
            </button>
          </p>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {capture.sources.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(s.state)}`} />
              <span className="text-zinc-300 flex-1 truncate">{SOURCE_LABEL[s.id] ?? s.id}</span>
              <span className="text-zinc-600 text-xs">
                {s.installed === false ? t('capture.notInstalled') : stateLabel(s.state)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function LaunchBrowserButton(): JSX.Element {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.browser.status().then((s) => setRunning(s.running)).catch(() => {})
  }, [])

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
        toast(r.error || t('browser.failed'), 'error')
      }
    }
    setBusy(false)
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={t('browser.hint')}
      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
        running
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
          : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700/60 hover:text-zinc-200'
      }`}
    >
      {busy ? '…' : running ? t('browser.stop') : t('browser.launch')}
    </button>
  )
}

function DashboardView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [config, setConfig] = useState<Record<string, Record<string, unknown>> | null>(null)
  const [capture, setCapture] = useState<CaptureHealthInfo | null>(null)
  const [loading, setLoading] = useState(true)
  // Shortcut order — kept in state + subscribed so a drag-reorder in the sidebar
  // updates the cheatsheet immediately, no view switch required.
  const [shortcutOrder, setShortcutOrder] = useState(currentShortcutOrder)
  useEffect(() => onSidebarOrderChanged(() => setShortcutOrder(currentShortcutOrder())), [])
  const { t } = useI18n()

  useEffect(() => {
    // Core cards — the dashboard's "loading" resolves on these only, so a
    // failing/missing add-on API can never wedge it on the loading skeleton.
    Promise.all([
      window.redlog.events.getCount().then(setEventCount).catch(() => {}),
      window.redlog.loot.getCount().then(setLootCount).catch(() => {}),
      window.redlog.chain.length().then(setChainLen).catch(() => {}),
      window.redlog.scope.getViolationCount().then(setScopeViolations).catch(() => {}),
      window.redlog.config.get().then((c) => setConfig(c as Record<string, Record<string, unknown>>)).catch(() => {})
    ]).then(() => setLoading(false))

    // Capture health is non-critical and loaded separately + guarded, so a
    // stale preload (missing the namespace) or a slow check never blocks load.
    const loadCapture = (): void => {
      try { window.redlog.capture?.health?.()?.then(setCapture).catch(() => {}) } catch { /* older preload */ }
    }
    loadCapture()
    const unsub = window.redlog.events.onNew(() => loadCapture())
    return unsub
  }, [])

  if (loading) {
    return (
      <div className="p-5 space-y-5 overflow-auto h-full">
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg bg-redlog-surface border border-redlog-border p-4 h-20 animate-pulse">
              <div className="h-3 w-12 bg-zinc-800 rounded mb-3" />
              <div className="h-5 w-8 bg-zinc-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3 overflow-auto h-full">
      {capture && <CaptureHealthCard capture={capture} onNavigate={onNavigate} />}

      <section>
        <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
          {t('dashboard.networkStatus')}
        </h2>
        <IPStatusCard />
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em]">
            {t('dashboard.sessionStats')}
          </h2>
          <button
            onClick={async () => {
              const path = await window.redlog.data.exportJson()
              if (path) toast(t('toast.exported'), 'success')
              else toast(t('toast.exportFailed'), 'error')
            }}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
          >
            {t('dashboard.exportData')}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {/* Events + chain length were two cards showing the same number —
              every event is one chain entry so they moved in lockstep. Merged
              here: the big number is events, the sub-line calls out that the
              chain covers the same count (or flags a drift if it ever
              differs, which would itself be a tamper signal). */}
          <StatCard
            label={t('dashboard.events')}
            value={String(eventCount)}
            sub={chainLen === eventCount
              ? t('dashboard.chainMatches', { n: chainLen })
              : t('dashboard.chainDrift', { chain: chainLen, events: eventCount })}
            tone={chainLen === eventCount ? 'cyan' : 'red'}
          />
          <StatCard label={t('dashboard.loot')} value={String(lootCount)} tone={lootCount > 0 ? 'red' : 'neutral'} />
          <StatCard
            label={t('dashboard.scope')}
            value={scopeViolations > 0 ? String(scopeViolations) : t('dashboard.scopeOk')}
            tone={scopeViolations > 0 ? 'red' : 'green'}
          />
        </div>
      </section>

      {config && (
        <section>
          <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
            {t('dashboard.engagement')}
          </h2>
          <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.id')}</span>
                <p className="text-zinc-200 font-mono text-sm mt-0.5">{config.engagement?.id as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.name')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">{config.engagement?.name as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.operator')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">{config.operator?.name as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.scopeLabel')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">
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
        <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
          {t('dashboard.shortcuts')}
        </h2>
        <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
          <div className="grid grid-cols-2 gap-2.5 text-sm">
            {[
              ...shortcutOrder.map((v, i) => [`${modKey}${i + 1}`, t(`sidebar.${v === 'screenshots' ? 'screens' : v}`)] as [string, string]),
              [isMac ? '⌘⇧M' : 'Ctrl+Shift+M', t('dashboard.addMarker')] as [string, string],
              [`${modKey}/`, t('dashboard.search')] as [string, string]
            ].map(([key, label]) => (
              <div key={key} className="flex items-center gap-2.5">
                <kbd className="bg-zinc-800/80 text-zinc-400 px-2 py-0.5 rounded text-xs font-mono border border-zinc-700/50">{key}</kbd>
                <span className="text-zinc-500 text-xs">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

type HudTone = 'red' | 'green' | 'amber' | 'cyan' | 'neutral'

function StatCard({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: HudTone
}): JSX.Element {
  const bar = tone === 'red' ? 'bg-red-500' : tone === 'green' ? 'bg-emerald-500'
    : tone === 'amber' ? 'bg-amber-500' : tone === 'cyan' ? 'bg-cyan-500' : 'bg-zinc-700'
  const valueColor = tone === 'red' ? 'text-red-400' : tone === 'green' ? 'text-emerald-400'
    : tone === 'amber' ? 'text-amber-400' : tone === 'cyan' ? 'text-cyan-400' : 'text-zinc-200'
  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card transition-shadow hover:shadow-card-hover relative overflow-hidden">
      <span className={`absolute top-0 left-0 right-0 h-[2px] ${bar}`} />
      <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-lg font-mono mt-1.5 font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function ScreenshotsView(): JSX.Element {
  const [screenshots, setScreenshots] = useState<RedLogEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Track which screenshots have had their file purged in this session so the
  // grid shows a placeholder + a "(deleted)" hint even before the next reload.
  // The event STAYS in the DB — we only unlink the JPEG, and a system.
  // screenshot_deleted audit event is appended (see main:screenshot:deleteFile).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [triggerFilter, setTriggerFilter] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    // Cap of 50 was hardcoded (audit finding #30). Bumped to 500 — matches the
    // default limit used elsewhere in the app; for engagements with thousands
    // of shots we'd want pagination but 500 covers the common case cleanly.
    window.redlog.events.query({ agentType: 'screenshot', limit: 500 }).then((s) => {
      setScreenshots(s)
      setLoading(false)
    })
    return window.redlog.events.onNew((event) => {
      if (event.agentType === 'screenshot') {
        setScreenshots((prev) => [event, ...prev].slice(0, 500))
      }
      // Someone else (e.g. the CLI) deleted a shot's file → mark it locally too.
      if (event.agentType === 'system' && event.data?.subtype === 'screenshot_deleted') {
        const src = event.data?.source_event as string | undefined
        if (src) setDeletedIds((prev) => { const n = new Set(prev); n.add(src); return n })
      }
    })
  }, [])

  useEffect(() => {
    screenshots.forEach((s) => {
      if (thumbs[s.id]) return
      const filePath = s.data.filePath as string | undefined
      if (!filePath) return
      window.redlog.screenshot.read(filePath).then((dataUri) => {
        if (dataUri) setThumbs((prev) => ({ ...prev, [s.id]: dataUri }))
      })
    })
  }, [screenshots, thumbs])

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-neutral-400 uppercase tracking-wider">
          {t('screenshots.title', { count: screenshots.length })}
        </h2>
        <button
          onClick={() => window.redlog.screenshot.capture()}
          className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700"
        >
          {t('screenshots.captureNow')}
        </button>
      </div>
      {screenshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <span className="text-2xl text-zinc-700">◻</span>
          </div>
          <p className="text-zinc-500 text-sm">{t('screenshots.empty')}</p>
          <p className="text-zinc-700 text-xs">{t('screenshots.emptyDesc')}</p>
        </div>
      ) : (() => {
        // Trigger filter (audit #32) — all captures land in one grid mixing
        // periodic / manual / mark-triggered. Chip toggles narrow the view.
        const triggerCounts = new Map<string, number>()
        for (const s of screenshots) triggerCounts.set(s.data.trigger as string, (triggerCounts.get(s.data.trigger as string) ?? 0) + 1)
        const triggers = [...triggerCounts.entries()].sort((a, b) => b[1] - a[1])
        const visibleShots = triggerFilter ? screenshots.filter((s) => s.data.trigger === triggerFilter) : screenshots
        return (
        <>
        {triggers.length > 1 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {triggers.map(([trigger, count]) => (
              <button
                key={trigger}
                onClick={() => setTriggerFilter(triggerFilter === trigger ? null : trigger)}
                className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                  triggerFilter === trigger ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700'
                }`}
              >{trigger} <span className="text-zinc-600">·{count}</span></button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {visibleShots.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              aria-label={`Screenshot at ${new Date(s.timestamp).toLocaleTimeString()}`}
              className="group relative rounded border border-redlog-border overflow-hidden bg-redlog-surface cursor-pointer hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"
              onClick={() => !deletedIds.has(s.id) && setExpanded(expanded === s.id ? null : s.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !deletedIds.has(s.id)) { e.preventDefault(); setExpanded(expanded === s.id ? null : s.id) } }}
            >
              <div className="aspect-video bg-neutral-900 flex items-center justify-center overflow-hidden">
                {deletedIds.has(s.id) ? (
                  <span className="text-zinc-700 text-xs italic">{t('screenshots.deleted')}</span>
                ) : thumbs[s.id] ? (
                  <img src={thumbs[s.id]} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-neutral-700 text-xs">{(s.data.filename as string) ?? '...'}</span>
                )}
              </div>
              <div className="px-2 py-1 flex items-center justify-between gap-1">
                <p className="text-xs text-neutral-500 flex-1 min-w-0 truncate">
                  {new Date(s.timestamp).toLocaleTimeString()} — {s.data.trigger as string}
                  {s.data.diffPercent !== undefined && (
                    <span className="ml-1 text-zinc-600">({t('screenshots.diff', { pct: (s.data.diffPercent as number).toFixed(1) })})</span>
                  )}
                </p>
                {!deletedIds.has(s.id) && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      const ok = await confirmDialog(t('screenshots.deleteTitle'), t('screenshots.deleteConfirm'), true)
                      if (!ok) return
                      const fp = s.data.filePath as string | undefined
                      if (!fp) return
                      const res = await (window.redlog.screenshot as unknown as { deleteFile: (id: string, p: string) => Promise<{ ok: boolean; error?: string }> }).deleteFile(s.id, fp)
                      if (res.ok) {
                        setDeletedIds((prev) => { const n = new Set(prev); n.add(s.id); return n })
                        toast(t('screenshots.deletedToast'), 'success')
                      } else {
                        toast(res.error || 'Delete failed', 'error')
                      }
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-xs text-zinc-600 hover:text-red-400 focus-visible:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded transition-opacity"
                    title={t('screenshots.deleteTitle')}
                    aria-label={t('screenshots.deleteTitle')}
                  >×</button>
                )}
              </div>
            </div>
          ))}
        </div>
        </>
        )
      })()}
      {expanded && thumbs[expanded] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot preview"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center cursor-pointer outline-none"
          onClick={() => setExpanded(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setExpanded(null) }}
        >
          <img src={thumbs[expanded]} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}
    </div>
  )
}
