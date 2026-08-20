import { useState, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TranscriptView from './components/TranscriptView'
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
import { computeCaptureReadiness } from './lib/captureReadiness'
import { useI18n } from './i18n'
import { loadSidebarOrder, onSidebarOrderChanged, type SidebarViewId } from './lib/sidebarOrder'
import { appShortcuts } from './lib/shortcuts'
import logoUrl from './assets/logo.svg'
import { Image } from 'lucide-react'
import { formatTime } from './lib/time'

type View = SidebarViewId | 'settings' | 'search'

// ⌘/Ctrl+1..8 map to the sidebar order (which the user can reorder); ⌘9 =
// Settings (pinned at the sidebar's bottom, not part of the reorderable list).
// Reads fresh on demand so a drag-reorder immediately updates the shortcuts.
// v0.11.2: Settings is pinned to ⌘9, and the sidebar takes 1..8.
//
// This used to be `[...sidebar, 'settings']`, which worked while the sidebar
// held eight entries. Adding Transcript made it nine, so the concatenated list
// ran to ten — and `parseInt(e.key)` only reaches 9, so Settings silently lost
// its shortcut to whatever the operator had dragged into ninth place. Settings
// is pinned separately in the sidebar and documented as ⌘9 in the `?` sheet,
// so it keeps the slot; the ninth sidebar entry has no number, which the
// operator controls by reordering.
const SETTINGS_SHORTCUT_INDEX = 9

function currentShortcutOrder(): View[] {
  return loadSidebarOrder().slice(0, SETTINGS_SHORTCUT_INDEX - 1) as View[]
}

function viewForShortcut(num: number): View | null {
  if (num === SETTINGS_SHORTCUT_INDEX) return 'settings' as View
  const order = currentShortcutOrder()
  return num >= 1 && num <= order.length ? order[num - 1] : null
}

// Read defensively — this runs at module load, before the preload bridge is
// guaranteed present (e.g. in tests). Default to mac styling.
const isMac = (window as { redlog?: { platform?: string } }).redlog?.platform !== 'win32'

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Event to focus when the Timeline opens (set when jumping from Loot); cleared
  // on plain sidebar navigation so a normal Timeline visit scrolls to "now".
  const [focusEvent, setFocusEvent] = useState<{ id: string; ts: number } | null>(null)
  const [showMarker, setShowMarker] = useState(false)
  const [markerAtTs, setMarkerAtTs] = useState<number | undefined>(undefined)
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
      // Dispatch off the one table (lib/shortcuts.ts) rather than a ladder of
      // hand-written conditions. The table is what the Dashboard cheatsheet
      // and the Timeline's `?` panel render, so a binding that works and a
      // binding that is documented are now the same fact — the cheatsheet had
      // drifted four bindings behind before this.
      const rows = appShortcuts(currentShortcutOrder(), isMac)
      const hit = rows.find((r) => r.match?.(e))
      if (!hit) return

      // Only the rows that ask for it yield to a focused text field. A blanket
      // guard here is what broke ⌘1..9 while the Terminal was open — xterm
      // keeps a hidden textarea focused for as long as that view is mounted.
      if (hit.guardTyping) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        const typing = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable
        if (typing) return
      }

      if (hit.scope === 'nav') {
        const target = hit.id === 'nav:settings' ? ('settings' as View) : viewForShortcut(parseInt(hit.keys.slice(-1)))
        if (!target) return
        e.preventDefault()
        setView(target)
        return
      }

      switch (hit.id) {
        case 'app:search':
        case 'app:palette': {
          e.preventDefault()
          // v0.6.91 W3: ⌘K inside the Timeline opens the local fuzzy palette
          // instead of jumping to the Search sidebar — it scopes to the
          // currently-loaded events, which is where the muscle memory points.
          // ⌘/ still routes to Search everywhere.
          if (hit.id === 'app:palette' && view === 'timeline') {
            window.dispatchEvent(new CustomEvent('redlog-timeline-palette'))
          } else {
            setView('search')
          }
          return
        }
        case 'app:toggleRecording': {
          e.preventDefault()
          window.redlog.recording.toggle().then((on) => {
            toast(on ? t('toast.recordingResumed') : t('toast.recordingPaused'), on ? 'success' : 'warning')
          }).catch(() => {})
          return
        }
        case 'app:hudCorner': {
          // Clockwise around the four corners: ↑ = TL, → = TR, ↓ = BR, ← = BL.
          // Reads as "pick the corner in that direction on a compass rose."
          // ⌘⇧⌥ rather than ⌘⌥ because macOS Sequoia's window tiling grabs
          // the latter before the app sees it (audit finding #53).
          const corner: 'tl' | 'tr' | 'bl' | 'br' =
            e.key === 'ArrowUp' ? 'tl'
              : e.key === 'ArrowRight' ? 'tr'
                : e.key === 'ArrowDown' ? 'br'
                  : 'bl'
          e.preventDefault()
          window.redlog.overlay.moveToCorner?.(corner)
        }
      }
    }
    // The status bar's fault counters live below the view switcher and cannot
    // reach `setView` directly, so they ask by event (§9 — an issue names the
    // view where it can be dealt with).
    const onNavigate = (e: Event): void => {
      const target = (e as CustomEvent<string>).detail
      if (target) setView(target as View)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('redlog:navigate', onNavigate)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('redlog:navigate', onNavigate)
    }
    // `view` is read inside the handler to route ⌘K in Timeline to the local
    // palette rather than the Search sidebar (v0.6.91 W3).
  }, [project, t, view])

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
    <div className="h-full flex flex-col">
      {/* Title bar */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0 border-b border-redlog-border bg-redlog-bg"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={`flex items-center gap-2 ${isMac ? 'pl-16' : ''}`}>
          <img src={logoUrl} alt="" className="w-4 h-4 rounded" />
          <span className="text-red-500 font-bold text-xs tracking-[0.2em]">{t('app.title')}</span>
          {/* Take the version out of the drag zone so users reporting bugs can
              actually copy it — audit finding P2 #36. */}
          <span
            className="text-redlog-text-dim text-xs font-mono select-text cursor-text"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t('app.copyVersionHint')}
          >v{__APP_VERSION__}</span>
        </div>
        <button
          className="ml-4 text-redlog-text-faint hover:text-redlog-text text-xs font-mono transition-colors flex items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={async () => {
            await window.redlog.project.close()
            setProject(null)
          }}
          title={t('app.closeProject')}
        >
          <span className="text-xs">&#9664;</span>
          {project.name}
        </button>
        <div className={`ml-auto flex gap-2 ${isMac ? '' : 'pr-36'}`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <LaunchBrowserButton onNavigate={(v) => setView(v as View)} />
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

        <div className="flex-1 min-w-0 select-text" data-testid="view-root" data-view={view}>
          <ErrorBoundary label={view} projectName={project.name} onGoHome={() => setView('dashboard')}>
            {view === 'dashboard' && <DashboardView onNavigate={(v) => setView(v as View)} />}
            {view === 'terminal' && <TerminalView />}
            {/* key on project.id: a project switch (e.g. project:open) must
                remount TimelinePanel — otherwise eventsMapRef keeps the prior
                project's rows and the initial useEffect doesn't re-fire.
                Latent today (no in-app switcher yet); guards the flow when one lands. */}
            {view === 'timeline' && <TimelinePanel key={project?.id ?? 'no-project'} focusEventId={focusEvent?.id} focusTs={focusEvent?.ts} onDropMarker={(ts) => { setMarkerAtTs(ts); setShowMarker(true) }} />}
            {/* v0.11.2 (design note T5): the same events read vertically. The
                Timeline answers "when did this happen and what did it cause";
                this answers "what did I type and what came back", which is the
                question an operator asks when writing an engagement up. */}
            {view === 'transcript' && (
              <TranscriptView
                key={project?.id ?? 'no-project'}
                onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); onNavigate('timeline') }}
              />
            )}
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
      {showMarker && <EventMarker onClose={() => { setShowMarker(false); setMarkerAtTs(undefined) }} atTimestamp={markerAtTs} />}
      <ToastContainer />
      <ConfirmDialogContainer />
    </div>
  )
}

// The dark/setup onboarding block: the three core sources as an ordered
// checklist, plus one primary CTA derived from readiness.nextStep. This is the
// answer to "the timeline is empty, what now" that the old single-sentence hint
// never gave. The checklist and the next-step choice come from the pure,
// unit-tested computeCaptureReadiness — this component only renders and wires
// the buttons to the actions the card already owns.
function CaptureOnboarding({ readiness, sources, busy, onInstall, onEnable, onNavigate }: {
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
    'builtin-terminal': t('capture.builtinTerminal')
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
      <ol className="space-y-1 mb-2.5">
        {readiness.steps.map((s, i) => {
          const g = glyph(s.status)
          return (
            <li key={s.id} className="flex items-center gap-2 text-xs">
              <span className={`shrink-0 ${g.cls}`}>{g.mark}</span>
              <span className="text-redlog-text-dim tabular-nums">{i + 1}.</span>
              <span className={s.status === 'active' ? 'text-redlog-text' : 'text-redlog-text-dim'}>
                {STEP_LABEL[s.id] ?? s.id}
              </span>
              <span className="text-xs font-mono text-redlog-text-faint">{t(`capture.step.${s.status}`)}</span>
            </li>
          )
        })}
      </ol>
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
    s.state === 'absent' || (s.state === 'idle' && (s.installed === true || s.lastEventAt !== null))
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
  // The ordered dark→recording onboarding model. Pure + unit-tested in
  // capture-readiness.ts; this card just renders it. Drives the checklist and
  // the single primary CTA below, replacing the old one-line "go to Settings"
  // hint that dropped a first-run operator into a 2600-line page with no order.
  const readiness = computeCaptureReadiness(capture)
  const barColor = dark ? 'bg-redlog-danger' : partial ? 'bg-amber-500' : 'bg-emerald-500'
  const headline = dark ? t('capture.dark') : partial ? t('capture.partial') : t('capture.healthy')

  return (
    <section>
      <div className={`rounded-lg border p-4 shadow-card relative overflow-hidden ${
        dark ? 'bg-red-950/30 border-red-900/50' : partial ? 'bg-amber-950/20 border-amber-900/40' : 'bg-redlog-surface border-redlog-border'
      }`}>
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${barColor}`} />
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
              <span title={SOURCE_LABEL[s.id] ?? s.id} className={`flex-1 truncate ${s.state === 'off' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>
                {SOURCE_LABEL[s.id] ?? s.id}
              </span>
              <span className="text-redlog-text-faint text-xs">
                {s.state === 'off'
                  ? t('capture.state.off')
                  : s.installed === false ? t('capture.notInstalled') : stateLabel(s.state)}
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
                  {s.configPath && (
                    <button
                      disabled={busy === s.id}
                      onClick={() => void setEnabled(s, s.enabled === false)}
                      className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                        s.enabled === false
                          ? 'border-redlog-border text-redlog-text-dim hover:text-redlog-text'
                          : 'border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/20'
                      }`}
                    >
                      {s.enabled === false ? t('capture.turnOn') : t('capture.turnOff')}
                    </button>
                  )}
                  {s.hookId && (
                    <button
                      disabled={busy === s.id}
                      onClick={() => void setInstalled(s, s.installed !== true)}
                      className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                        s.installed === true
                          ? 'border-redlog-border text-redlog-text-dim hover:text-red-400'
                          : 'border-cyan-700/50 text-cyan-400 hover:bg-cyan-900/20'
                      }`}
                    >
                      {s.installed === true ? t('capture.uninstall') : t('capture.install')}
                    </button>
                  )}
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
              <span className="text-redlog-muted">·</span>
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

function LaunchBrowserButton({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
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
  )
}

function DashboardView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
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
    // v0.9.7: let the card re-poll right after an install / toggle instead of
    // waiting out the 5s cycle — the button would otherwise look inert.
    refreshCaptureRef.current = loadCapture
    loadCapture()
    // Anchor age poll — same guarded pattern as capture health.
    const loadAnchor = (): void => {
      try {
        window.redlog.chain?.anchors?.()?.then((list) => {
          const first = list?.[0]
          if (first) setLastAnchor({ createdAt: first.createdAt, status: first.status })
        }).catch(() => {})
      } catch { /* older preload */ }
    }
    loadAnchor()
    // v0.7.5 G3: refresh the event-count tile on every incoming event.
    // Dogfood found the tile stuck at its mount-time snapshot after the
    // transcript tailer ingested ~10K events post-open. `getCount()` is
    // cheap thanks to v0.6.97 C's in-memory count cache, so re-calling
    // per event just reads the cached value + rerenders one number.
    // Loot count updated too — same class of stale-after-batch bug for
    // the tile even though loot events are lower-rate.
    //
    // v0.7.6 H2: chainLen was ALSO stuck at mount snapshot — the
    // v0.7.5 dogfood surfaced the "⚠ 證據鏈 10396 ≠ 事件 28338" scary
    // Dashboard warning as a direct consequence. Both queries look at
    // the same table (`WHERE hash IS NOT NULL` for chainLen, `COUNT(*)`
    // for events); with the tailer hashing every insert, they always
    // match on-disk. Refreshing chainLen here closes the drift.
    const refreshCounts = (): void => {
      window.redlog.events.getCount().then(setEventCount).catch(() => {})
      window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {})
      window.redlog.events.getLatestLoggedTs?.().then(setLatestLoggedTs).catch(() => {})
      window.redlog.loot.getCount().then(setLootCount).catch(() => {})
      window.redlog.chain.length().then(setChainLen).catch(() => {})
    }
    // Seed the tier split on first paint so the card doesn't wait for
    // the first onNew tick to fill in.
    window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {})
    window.redlog.events.getLatestLoggedTs?.().then(setLatestLoggedTs).catch(() => {})
    const unsub = window.redlog.events.onNew(() => { loadCapture(); loadAnchor(); refreshCounts() })
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em]">
            {t('dashboard.sessionStats')}
          </h2>
          <button
            onClick={async () => {
              const path = await window.redlog.data.exportJson()
              if (path) toast(t('toast.exported'), 'success')
              else toast(t('toast.exportFailed'), { type: 'error', why: t('toast.exportFailedWhy') })
            }}
            className="px-2.5 py-1 text-xs bg-redlog-elevated text-redlog-text-dim rounded hover:bg-redlog-elevated-hover hover:text-redlog-text transition-colors"
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
            // v0.6.89 P1-A: append last-sample-verify age. A broken sample
            // shows "sample BROKEN" in the same sub-line and forces the tile
            // red — the CaptureHealthCard also flips to dark, so the operator
            // gets two independent signals.
            if (capture?.lastSampleBroken) {
              // v0.7.6 H3: append the broken row's own age so the operator
              // can tell a stale historical row (pre-v0.7.x) from a fresh
              // regression. If eventTimestamp is missing (older callsite)
              // the message degrades to the pre-v0.7.6 "sample BROKEN".
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
            value={scopeViolations > 0 ? String(scopeViolations) : t('dashboard.scopeOk')}
            tone={scopeViolations > 0 ? 'red' : 'green'}
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
                <p className="text-redlog-text text-sm mt-0.5">{config.engagement?.name as string}</p>
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

type HudTone = 'red' | 'green' | 'amber' | 'cyan' | 'neutral'

function StatCard({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: HudTone
}): JSX.Element {
  const bar = tone === 'red' ? 'bg-red-500' : tone === 'green' ? 'bg-emerald-500'
    : tone === 'amber' ? 'bg-amber-500' : tone === 'cyan' ? 'bg-cyan-500' : 'bg-redlog-elevated-hover'
  const valueColor = tone === 'red' ? 'text-red-400' : tone === 'green' ? 'text-emerald-400'
    : tone === 'amber' ? 'text-amber-400' : tone === 'cyan' ? 'text-cyan-400' : 'text-redlog-text'
  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card transition-shadow hover:shadow-card-hover relative overflow-hidden">
      <span className={`absolute top-0 left-0 right-0 h-[2px] ${bar}`} />
      <p className="text-xs text-redlog-text-dim uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-lg font-mono mt-1.5 font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-redlog-text-faint mt-0.5">{sub}</p>}
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
        // v0.6.96 Clean-4: read _causes[0] instead of legacy source_event.
        // Both are still written today but this is the last renderer read of
        // source_event — after v0.7.x we can drop the dual-write in main.
        const causes = event.data?._causes as string[] | undefined
        const src = causes?.[0] || (event.data?.source_event as string | undefined)
        if (src) setDeletedIds((prev) => { const n = new Set(prev); n.add(src); return n })
      }
    })
  }, [])

  useEffect(() => {
    // v0.6.97 B: pull thumbs directly via `redlog-screenshot://` scheme
    // (main-process protocol.handle registered at whenReady). No IPC round-
    // trip and no 33% base64 inflation — Chromium streams the JPEG from disk.
    // The filename basename is all we send; the main handler resolves it
    // against the project's screenshots dir with an isInsideDir guard.
    screenshots.forEach((s) => {
      if (thumbs[s.id]) return
      const filePath = s.data.filePath as string | undefined
      if (!filePath) return
      const basename = filePath.split(/[\\/]/).pop() || ''
      if (!basename) return
      setThumbs((prev) => ({ ...prev, [s.id]: `redlog-screenshot://local/${encodeURIComponent(basename)}` }))
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
        <h2 className="text-base font-semibold text-redlog-text-dim uppercase tracking-wider">
          {t('screenshots.title', { count: screenshots.length })}
        </h2>
        <button
          onClick={() => window.redlog.screenshot.capture()}
          className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover"
        >
          {t('screenshots.captureNow')}
        </button>
      </div>
      {screenshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-16 h-16 rounded-full bg-redlog-surface border border-redlog-border flex items-center justify-center">
            <Image size={24} strokeWidth={1.5} aria-hidden className="text-redlog-muted" />
          </div>
          <p className="text-redlog-text-dim text-sm">{t('screenshots.empty')}</p>
          <p className="text-redlog-muted text-xs">{t('screenshots.emptyDesc')}</p>
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
                  triggerFilter === trigger ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                }`}
              >{trigger} <span className="text-redlog-text-faint">·{count}</span></button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {visibleShots.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              aria-label={`Screenshot at ${formatTime(s.timestamp, { seconds: true })}`}
              className="group relative rounded border border-redlog-border overflow-hidden bg-redlog-surface cursor-pointer hover:border-redlog-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"
              onClick={() => !deletedIds.has(s.id) && setExpanded(expanded === s.id ? null : s.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !deletedIds.has(s.id)) { e.preventDefault(); setExpanded(expanded === s.id ? null : s.id) } }}
            >
              <div className="aspect-video bg-redlog-surface flex items-center justify-center overflow-hidden">
                {deletedIds.has(s.id) ? (
                  <span className="text-redlog-muted text-xs italic">{t('screenshots.deleted')}</span>
                ) : thumbs[s.id] ? (
                  // v0.6.98 A: `loading="lazy"` defers the JPEG fetch/decode
                  // until the tile nears the viewport (Chromium native, works
                  // on the `redlog-screenshot://` scheme). `decoding="async"`
                  // keeps decode off the main thread. With 500 shots in the
                  // grid this drops steady-state RAM by ~150MB and gets rid
                  // of the paint stall when opening the panel cold.
                  <img
                    src={thumbs[s.id]}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-redlog-muted text-xs">{(s.data.filename as string) ?? '...'}</span>
                )}
              </div>
              <div className="px-2 py-1 flex items-center justify-between gap-1">
                <p title={`${formatTime(s.timestamp, { seconds: true })} — ${String(s.data.trigger ?? '')}`} className="text-xs text-redlog-text-dim flex-1 min-w-0 truncate">
                  {formatTime(s.timestamp, { seconds: true })} — {s.data.trigger as string}
                  {s.data.diffPercent !== undefined && (
                    <span className="ml-1 text-redlog-text-faint">({t('screenshots.diff', { pct: (s.data.diffPercent as number).toFixed(1) })})</span>
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
                        toast(t('screenshots.deleteFailed'), {
                          type: 'error',
                          why: t('screenshots.deleteFailedWhy'),
                          detail: res.error
                        })
                      }
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-xs text-redlog-text-faint hover:text-red-400 focus-visible:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded transition-opacity"
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
