import { useState, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TranscriptView from './components/TranscriptView'
import StatusBar from './components/StatusBar'
import IPStatusCard from './components/IPStatusCard'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import Settings from './components/Settings'
import ProjectPicker from './components/ProjectPicker'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { SearchPanel } from './components/SearchPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QuickMarksView } from './components/FindingsView'
import TerminalView from './components/TerminalView'
import { ToastContainer } from './components/Toast'
import { LoadingSpinner, EmptyState } from './components/Feedback'
import { ConfirmDialogContainer, confirm as confirmDialog } from './components/ConfirmDialog'
import { toast } from './components/Toast'
import { computeCaptureReadiness } from './lib/captureReadiness'
import { emptyStateFor } from './lib/emptyState'
import { shortcutsForScope, MOD_TOKEN } from './lib/shortcuts'
import { useI18n } from './i18n'
import { loadSidebarOrder, onSidebarOrderChanged, type SidebarViewId } from './lib/sidebarOrder'
import { ICON } from './lib/icons'
import logoUrl from './assets/logo.svg'

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
const modKey = isMac ? '⌘' : 'Ctrl+'

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Event to focus when the Timeline opens (set when jumping from Loot); cleared
  // on plain sidebar navigation so a normal Timeline visit scrolls to "now".
  const [focusEvent, setFocusEvent] = useState<{ id: string; ts: number } | null>(null)
  const [showMarker, setShowMarker] = useState(false)
  const [markerAtTs, setMarkerAtTs] = useState<number | undefined>(undefined)
  const { t } = useI18n()

  // F4: turns an empty view's CTA target (from emptyStateFor) into an app-level
  // action. Threaded to the empty views so their "nothing here" screens have a
  // way forward instead of being dead ends. 'doc' has no in-app destination yet,
  // so those CTAs are suppressed at the view rather than wired to a no-op.
  const handleEmptyAction = (target: string): void => {
    if (target === 'dashboard') setView('dashboard')
    else if (target === 'marker') setShowMarker(true)
    else if (target === 'screenshot') window.redlog.screenshot.capture().catch(() => {})
  }

  // Navigation. Phase C step 5 (O3): the standalone TargetView is gone — the
  // timeline's target lane axis subsumes it — so the "Targets" entry deep-links
  // into the Timeline with the target axis switched on (persisted + a live event
  // in case the panel is already mounted).
  const goTo = (v: View): void => {
    setFocusEvent(null)
    if (v === 'targets') {
      try { localStorage.setItem('redlog-timeline-lane-axis', 'target') } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('redlog-timeline-set-axis', { detail: 'target' }))
      setView('timeline')
      return
    }
    setView(v)
  }

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
        // v0.6.91 W3: ⌘K inside the Timeline view opens the local fuzzy
        // palette instead of jumping to the Search sidebar — palette scopes
        // to the currently-loaded events, which is where operators want to
        // muscle-memory ⌘K. ⌘/ still routes to Search everywhere. Anywhere
        // outside Timeline both shortcuts keep the old Search behaviour.
        const isPalette = view === 'timeline' && (e.key === 'k' || e.key === 'K')
        if (isPalette) {
          window.dispatchEvent(new CustomEvent('redlog-timeline-palette'))
          return
        }
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
      // ⌘/Ctrl+B toggles the sidebar collapse (VS Code convention). The Sidebar
      // owns the state + persistence; we just fire the event it listens for.
      if (cmd && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('redlog:toggle-sidebar'))
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
        const target = viewForShortcut(num)
        if (target) {
          e.preventDefault()
          goTo(target)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
          {/* F6: a persistent pointer entry to the Search view. It was only
              reachable via ⌘/ (or ⌘K) before, so a newcomer couldn't find the
              headline full-text search by looking. Kept out of the sidebar to
              leave DEFAULT_ORDER length + the ⌘1..N numbering untouched. */}
          <button
            onClick={() => setView('search')}
            className={`px-2 py-1 rounded-md border transition-colors ${
              view === 'search'
                ? 'text-red-400 bg-red-500/10 border-red-500/15'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] border-transparent'
            }`}
            title={t('app.search')}
            aria-label={t('app.search')}
          >
            <span aria-hidden className="text-[13px] leading-none">{ICON.search}</span>
          </button>
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
        <Sidebar active={view} onNavigate={(v) => goTo(v as View)} />

        <div className="flex-1 min-w-0" data-testid="view-root" data-view={view}>
          <ErrorBoundary label={view}>
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
                onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }}
                onEmptyAction={handleEmptyAction}
              />
            )}
            {view === 'screenshots' && <ScreenshotsView onEmptyAction={handleEmptyAction} />}
            {/* Phase C step 5 (O3): TargetView removed — the "Targets" sidebar
                entry deep-links into the Timeline's target axis via goTo(). */}
            {view === 'scope' && <ScopeStatus onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} />}
            {view === 'loot' && <LootPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} onEmptyAction={handleEmptyAction} />}
            {view === 'marks' && <QuickMarksView onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} onEmptyAction={handleEmptyAction} />}
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
        : { mark: '○', cls: 'text-zinc-600' }

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
      <p className="text-[11px] text-zinc-400 mb-2">
        {readiness.level === 'dark' ? t('capture.setupIntro') : t('capture.setupAlmost')}
      </p>
      <ol className="space-y-1 mb-2.5">
        {readiness.steps.map((s, i) => {
          const g = glyph(s.status)
          return (
            <li key={s.id} className="flex items-center gap-2 text-[11px]">
              <span className={`shrink-0 ${g.cls}`}>{g.mark}</span>
              <span className="text-zinc-500 tabular-nums">{i + 1}.</span>
              <span className={s.status === 'active' ? 'text-zinc-300' : 'text-zinc-400'}>
                {STEP_LABEL[s.id] ?? s.id}
              </span>
              <span className="text-2xs font-mono text-zinc-600">{t(`capture.step.${s.status}`)}</span>
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-3">
        {cta && (
          <button
            disabled={busy !== null}
            onClick={cta.run}
            className="text-[11px] font-medium px-2.5 py-1 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30 transition-colors disabled:opacity-40"
          >
            {cta.label}
          </button>
        )}
        <button onClick={() => onNavigate('settings')} className="text-[11px] text-zinc-500 hover:text-zinc-300 underline">
          {t('capture.openHooks')}
        </button>
      </div>
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
    s === 'active' ? 'bg-emerald-500' : s === 'idle' ? 'bg-amber-500' : 'bg-zinc-700'

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
      if (r && r.success === false) toast(r.message || t('capture.actionFailed'), 'error')
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
    if (!ts) return 'text-zinc-600'
    const sec = (now - ts) / 1000
    if (sec < 60) return 'text-emerald-500/80'
    if (sec < 300) return 'text-amber-500/80'
    return 'text-zinc-600'
  }

  const dark = capture.verdict === 'dark'
  const partial = capture.verdict === 'partial'
  // The ordered dark→recording onboarding model. Pure + unit-tested in
  // capture-readiness.ts; this card just renders it. Drives the checklist and
  // the single primary CTA below, replacing the old one-line "go to Settings"
  // hint that dropped a first-run operator into a 2600-line page with no order.
  const readiness = computeCaptureReadiness(capture)
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
          <div className="flex items-center gap-3">
            <button
              onClick={() => setManage((m) => !m)}
              className="text-2xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
              title={t('capture.manageHint')}
            >
              {manage ? t('capture.done') : t('capture.manageWithHidden', { count: capture.sources.length })}
            </button>
            <span className={`text-[11px] font-medium ${dark ? 'text-red-300' : partial ? 'text-amber-300' : 'text-emerald-400'}`}>{headline}</span>
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
              <span className={`flex-1 truncate ${s.state === 'off' ? 'text-zinc-500' : 'text-zinc-300'}`}>
                {SOURCE_LABEL[s.id] ?? s.id}
              </span>
              <span className="text-zinc-600 text-xs">
                {s.state === 'off'
                  ? t('capture.state.off')
                  : s.installed === false ? t('capture.notInstalled') : stateLabel(s.state)}
              </span>
              {!manage && s.installed !== false && s.state !== 'off' && (
                <span className={`text-2xs font-mono tabular-nums shrink-0 ${ageColor(s.lastEventAt, nowTick)}`}>
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
                      className={`text-2xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                        s.enabled === false
                          ? 'border-zinc-700 text-zinc-500 hover:text-zinc-300'
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
                      className={`text-2xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                        s.installed === true
                          ? 'border-zinc-700 text-zinc-500 hover:text-red-400'
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
                    <span className="text-2xs font-mono text-zinc-700">{t('capture.passive')}</span>
                  )}
                </span>
              )}
            </div>
          ))}
          {!manage && shown.length === 0 && (
            <p className="text-[11px] text-zinc-500 col-span-2">
              {healthy.length > 0
                ? t('capture.allGood', { active: healthy.length })
                : t('capture.noneEnabled')}
            </p>
          )}
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
      window.redlog.loot.getCount().then(setLootCount).catch(() => {})
      window.redlog.chain.length().then(setChainLen).catch(() => {})
    }
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
      {capture && (
        <CaptureHealthCard
          capture={capture}
          onNavigate={onNavigate}
          onRefresh={() => refreshCaptureRef.current()}
        />
      )}

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
              // Settings is pinned to ⌘9 rather than carried by shortcutOrder,
              // so it has to be listed explicitly (v0.11.2).
              [`${modKey}9`, t('sidebar.settings')] as [string, string],
              // Non-view global shortcuts come from the single shortcut registry
              // (lib/shortcuts.ts) so this card and the Timeline `?` cheatsheet
              // stay in sync — adding a global shortcut there surfaces it here,
              // and it picks up ones this card used to omit (e.g. ⌘. pause).
              // switch-view is rendered dynamically above (per reorderable order).
              ...shortcutsForScope('global')
                .filter((s) => s.id !== 'switch-view')
                .map((s) => [s.keys.replaceAll(MOD_TOKEN, isMac ? '⌘' : 'Ctrl+'), t(s.labelKey)] as [string, string])
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

function ScreenshotsView({ onEmptyAction }: { onEmptyAction?: (target: string) => void }): JSX.Element {
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
      {screenshots.length === 0 ? (() => {
        // F4: the shared EmptyState with a working CTA, driven by the pure
        // emptyStateFor map, instead of a hand-rolled dead end.
        const es = emptyStateFor('screenshots', { captureDark: false })
        return (
          <EmptyState
            icon={ICON.screenshots}
            title={t(es.titleKey)}
            subtitle={t(es.subtitleKey)}
            action={es.action && es.action.target !== 'doc'
              ? { label: t(es.action.labelKey), onClick: () => onEmptyAction?.(es.action!.target) }
              : undefined}
          />
        )
      })() : (() => {
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
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-xs text-zinc-600 hover:text-red-400 focus-visible:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded transition-opacity hit-target"
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
