import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { TITLEBAR_CONTROL, TITLEBAR_ICON } from './components/Button'
import { ControlBoundary } from './components/ControlBoundary'
import Sidebar from './components/Sidebar'
import { Wordmark } from './components/Wordmark'
import StatusBar from './components/StatusBar'
import { ReplayDrawer } from './components/ReplayDrawer'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import ProjectPicker from './components/ProjectPicker'
import { TargetView } from './components/TargetView'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BookmarksView } from './components/BookmarksView'
import { ToastContainer } from './components/Toast'
import { CommandPalette } from './components/CommandPalette'
import { SearchPanel } from './components/SearchPanel'
import { ExportMenu } from './components/ExportMenu'
import { ConfirmDialogContainer } from './components/ConfirmDialog'
import { toast } from './components/Toast'

// Heavy views loaded lazily — keeps the initial bundle small.
// These are lazy so the first paint does not carry xterm and the settings
// tree. The fallback used to be `null` on the premise that "Electron-local
// loads are instant" — true of a packaged build reading a bundled chunk, and
// false in dev, where Vite transforms each module on demand. `null` means the
// pane renders nothing while it waits, which against a #121214 window is a
// black screen with no explanation.
const TerminalView = lazy(() => import('./components/TerminalView'))
const Settings = lazy(() => import('./components/Settings'))
const TranscriptView = lazy(() => import('./components/TranscriptView'))
const HttpHistoryPanel = lazy(() => import('./components/HttpHistoryPanel').then(m => ({ default: m.HttpHistoryPanel })))

import { useI18n } from './i18n'
import type { SidebarViewId } from './lib/sidebarOrder'
import { parseTarget } from './lib/navigation'
import type { SettingsPage } from './components/Settings'
import { isMac } from './lib/platform'
import { FilterProvider } from './lib/FilterContext'
import { onRunInTerminal } from './lib/terminalRunner'
import { closeProjectAfterSaves } from './lib/pendingSaves'
import { addArtifactsWithFeedback, addDroppedWithFeedback } from './lib/addArtifacts'
import { captureScreenshotWithFeedback } from './lib/captureScreenshot'
import { QUICK_SHOT_ACCELERATOR, formatAccelerator } from './lib/shortcuts'
import { Camera, FilePlus } from 'lucide-react'
import { FilterBar } from './components/FilterBar'

// Extracted components
import { DashboardView, LaunchBrowserButton } from './components/DashboardView'
import { ScreenshotsView } from './components/ScreenshotsView'

// Extracted hooks
import { useVisibility } from './hooks/useVisibility'
import { useAppShortcuts } from './hooks/useAppShortcuts'

type View = SidebarViewId | 'settings'


/** What a pane shows while its chunk arrives. Deliberately dim and still: it
 *  is a few hundred milliseconds in a packaged build, and a spinner that
 *  flashes is worse than a surface that is simply not filled in yet. */
function PaneLoading(): JSX.Element {
  return <div className="h-full w-full bg-redlog-surface/30 animate-pulse" aria-hidden />
}

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')

  // A setup command sent from Settings needs the terminal on screen to
  // receive it. The command itself is held by lib/terminalRunner until the
  // view mounts, so this only has to do the navigating.
  useEffect(() => onRunInTerminal(() => setView('terminal')), [])
  // Event to focus when the Timeline opens (set when jumping from Loot); cleared
  // on plain sidebar navigation so a normal Timeline visit scrolls to "now".
  const [focusEvent, setFocusEvent] = useState<{ id: string; ts: number } | null>(null)
  // Where a jump to the Timeline came from, so the operator can go back to the
  // target, finding or search they were reading (UI/UX audit F19, §7). One
  // level: the Timeline is where these routes lead, not a place to chain from.
  const [returnTo, setReturnTo] = useState<View | null>(null)
  // A target picked on the Targets page is the shared filter's (spec 038),
  // set there and shown as the FilterBar chip on every view that honours it.
  const [showMarker, setShowMarker] = useState(false)
  // Feeds the export menu's "N events · about X" line. Refreshed on view
  // changes rather than per event — the preview exists to catch "I meant the
  // slice, not all 28,000", and that answer does not move by one.
  const [exportableCount, setExportableCount] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [recordingOn, setRecordingOn] = useState(true)
  const [markerAtTs, setMarkerAtTs] = useState<number | undefined>(undefined)
  const [markerHeldFrame, setMarkerHeldFrame] = useState<string | undefined>(undefined)
  const [dropping, setDropping] = useState(false)
  // The Settings page a link asked for; see lib/navigation.ts.
  const [settingsRequest, setSettingsRequest] = useState<{ page: SettingsPage } | null>(null)
  const { t } = useI18n()

  // Every link, the palette, the sidebar and the status bar go through here,
  // so a target that names a Settings page opens that page.
  const navigate = useCallback((target: string): void => {
    const { view: next, settingsPage } = parseTarget(target)
    setSettingsRequest(settingsPage ? { page: settingsPage } : null)
    setReturnTo(null)
    setView(next as View)
  }, [])

  const openInTimeline = useCallback((id: string, ts: number): void => {
    setReturnTo(view === 'timeline' ? null : view)
    setFocusEvent({ id, ts })
    setView('timeline')
  }, [view])

  const goBack = useCallback((): void => {
    if (!returnTo) return
    setFocusEvent(null)
    setView(returnTo)
    setReturnTo(null)
  }, [returnTo])

  // Cmd+[ / Alt+Left goes back, as in a browser: only while there is somewhere
  // to go back to, and never while the operator is typing.
  useEffect(() => {
    if (!returnTo || view !== 'timeline') return
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      const back = isMac ? (e.metaKey && e.key === '[') : (e.altKey && e.key === 'ArrowLeft')
      if (!back) return
      e.preventDefault()
      goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [returnTo, view, goBack])

  // Visibility / first-run state is fully managed by the extracted hook.
  const { visibility, firstRunActive } = useVisibility(project, view)

  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) setProject(p)
    })
  }, [])

  // Settings renames the project; the title bar reads this state.
  useEffect(() => {
    const onRenamed = (e: Event): void => {
      const name = (e as CustomEvent<string>).detail
      setProject((p) => (p ? { ...p, name } : p))
    }
    window.addEventListener('redlog:project-renamed', onRenamed)
    return () => window.removeEventListener('redlog:project-renamed', onRenamed)
  }, [])

  useEffect(() => {
    if (!project) return
    window.redlog.events.getCount('all').then(setExportableCount).catch(() => {})
  }, [project, view])

  // Global marker shortcut (Cmd/Ctrl+Shift+M) is registered in the main process
  // via Electron globalShortcut so it fires whether the window has focus or
  // not. Do NOT also listen for it in the renderer — audit finding P0 #5
  // pointed out the dialog would open twice when the RedLog window was in
  // front (both handlers ran). Renderer only handles Cmd/ and Cmd+1..N which
  // must be scoped to the app window.
  useEffect(() => {
    return window.redlog.marker.onShortcut((info) => { setMarkerHeldFrame(info?.heldFrame); setShowMarker(true) })
  }, [])
  // The global screenshot chord fires while RedLog is in the background; its
  // result waits here as a toast for when the operator comes back.
  useEffect(() => {
    return window.redlog.screenshot.onShortcutResult?.((r) => r.ok
      ? toast(t('palette.screenshotTaken'), 'success')
      : toast(t('palette.screenshotNotSaved'), { type: 'warning', why: t('palette.screenshotNotSavedWhy') }))
  },[t])

  // The palette shows "pause" or "resume" depending on the current state, so
  // it has to know it.
  useEffect(() => {
    window.redlog.recording.get().then(setRecordingOn).catch(() => {})
    return window.redlog.recording.onChange(setRecordingOn)
  }, [])

  // Cmd/Ctrl+1..N follow the sidebar's current (possibly user-reordered) order.
  // Also handles app-wide shortcuts (palette, find-in-page, recording toggle,
  // HUD corner). Extracted to hooks/useAppShortcuts.ts.
  useAppShortcuts(project, view, navigate, setPaletteOpen, t)

  if (!project) {
    return (
      <>
        <ProjectPicker onProjectOpen={(p) => { setProject(p); setView('dashboard') }} />
        <ToastContainer />
        <ConfirmDialogContainer />
      </>
    )
  }

  const showFilterBar = ['search', 'transcript', 'http_history', 'timeline', 'loot'].includes(view)

  return (
    <FilterProvider>
    <div
      className="h-full flex flex-col relative"
      // Files dropped anywhere on the window are offered as evidence; the
      // main process lists them and asks before anything is copied.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.relatedTarget) setDropping(false) }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDropping(false)
        void addDroppedWithFeedback([...e.dataTransfer.files], t)
      }}
    >
      {dropping && (
        <div data-testid="evidence-drop-overlay" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-redlog-accent/60 bg-redlog-bg/80 text-sm text-redlog-text">
          {t('artifacts.dropHere')}
        </div>
      )}
      {/* Title bar */}
      <div
        className="h-10 flex items-center gap-2 px-4 select-none shrink-0 overflow-hidden border-b border-redlog-border bg-redlog-bg whitespace-nowrap"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={`flex items-center gap-2 shrink-0 ${isMac ? 'pl-16' : ''}`}>
          {/* Title-bar size is small, so the ring collapses to a solid dot
              (§4). Single wordmark — the old image + plain-text pair is gone. */}
          <Wordmark className="text-xs" dotOnly />
        </div>
        {/* The one control on this strip that had no outline — it leaned on a
            50% elevated tint, and `elevated` is 1.17:1 from `bg`, so there was
            nothing there to see. §3.5: every control has a visible boundary,
            and this one closes a project. */}
        <ControlBoundary name={t('app.closeProject')}>
          <button
            className={`${TITLEBAR_CONTROL} ml-2 min-w-0 font-mono bg-redlog-elevated/50 border-redlog-border text-redlog-text-dim hover:bg-redlog-elevated hover:text-redlog-text focus-visible:ring-redlog-text-dim/40`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={async () => {
              // Pending settings go to THIS project before it closes (#223).
              // Closing first let the flush arrive with no project open, where
              // it was refused and nothing said so. A failed save keeps the
              // project open, with the change still on screen to retry.
              if (!(await closeProjectAfterSaves())) {
                toast(t('app.closeSaveFailed'), 'error')
                return
              }
              setProject(null)
            }}
            title={t('app.closeProject')}
          >
            <span className="text-xs shrink-0">&#9664;</span>
            {/* The button's own title names the action; the name needs its own
                route to the full value once it can be cut short (§9). */}
            <span className="truncate" title={project.name}>{project.name}</span>
          </button>
        </ControlBoundary>
        {/* The outer net. Anything unforeseen in this strip costs the strip,
            not the window: the title bar sits outside the view's ErrorBoundary
            (below), so until now a throw here unmounted the app root and left
            a black window -- with the shortcuts still working and nothing on
            screen to say what had happened. */}
        <div className={`ml-auto flex gap-2 shrink-0 ${isMac ? '' : 'pr-36'}`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <ControlBoundary name={t('control.titlebar')}>
            {/* Each of the two stateful controls gets its own barrier, so one
                failing leaves the other four working. These are the two that
                hold hooks and talk to main, which is the class of failure that
                reaches a boundary at all; the three below are inline markup. */}
            {/* §10: one export control, in the shell rather than six places.
                Its scope is an option, not a location. */}
            <ControlBoundary name={t('export.title')}>
              <ExportMenu totalCount={exportableCount} />
            </ControlBoundary>
            <ControlBoundary name={t('browser.launch')}>
              <LaunchBrowserButton onNavigate={navigate} />
            </ControlBoundary>
            {/* The evidence verbs sit together (UI/UX audit F8): screenshot and
                add-file used to be reachable only from ⌘K. */}
            <button
              type="button"
              data-testid="titlebar-screenshot"
              onClick={() => { void captureScreenshotWithFeedback(t) }}
              aria-label={t('app.evidenceShot')}
              title={`${t('app.evidenceShot')} · ${formatAccelerator(QUICK_SHOT_ACCELERATOR, isMac)}`}
              className={`${TITLEBAR_ICON} border-transparent text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated hover:border-redlog-border focus-visible:ring-redlog-text-dim/40`}
            >
              <Camera size={14} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              data-testid="titlebar-add-file"
              onClick={() => { void addArtifactsWithFeedback(t) }}
              aria-label={t('app.evidenceFile')}
              title={t('app.evidenceFile')}
              className={`${TITLEBAR_ICON} border-transparent text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated hover:border-redlog-border focus-visible:ring-redlog-text-dim/40`}
            >
              <FilePlus size={14} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              onClick={() => setShowMarker(true)}
              /* A command button, so it carries the brand accent rather than a
                 raw red the palette has no token for (§1: brand red fills a verb
                 you can press; danger red reports a state). */
              className={`${TITLEBAR_CONTROL} bg-redlog-accent/10 text-redlog-accent border-redlog-accent/25 hover:bg-redlog-accent/20 focus-visible:ring-redlog-accent/40`}
              title={isMac ? '⌘⇧M' : 'Ctrl+Shift+M'}
            >
              {t('app.mark')}
            </button>
          </ControlBoundary>
        </div>
      </div>

      {/* Spec 036: re-checked each time a project opens (key), since an
          operator may have edited their profile while the picker was up. */}

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <Sidebar
          active={view}
          visibleViews={visibility.views}
          projectId={project.id}
          onNavigate={(v) => { setFocusEvent(null); navigate(v) }}
        />

        <div className="flex-1 min-w-0 select-text flex flex-col" data-testid="view-root" data-view={view}>
          {showFilterBar && <FilterBar />}
          <div className="flex-1 min-h-0">
          <ErrorBoundary label={view} projectName={project.name} onGoHome={() => setView('dashboard')}>
            {view === 'dashboard' && <DashboardView onNavigate={navigate} firstRun={firstRunActive} projectName={project.name} />}
            {view === 'terminal' && <Suspense fallback={<PaneLoading />}><TerminalView /></Suspense>}
            {/* key on project.id: a project switch (e.g. project:open) must
                remount TimelinePanel — otherwise eventsMapRef keeps the prior
                project's rows and the initial useEffect doesn't re-fire.
                Latent today (no in-app switcher yet); guards the flow when one lands. */}
            {view === 'timeline' && returnTo && (
              <div data-testid="timeline-return" className="flex items-center gap-2 px-4 py-1.5 border-b border-redlog-border/60 bg-redlog-surface/60 text-xs">
                <button
                  type="button"
                  onClick={goBack}
                  className="text-cyan-400 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50 rounded px-1"
                >
                  ← {t('nav.backTo', { view: t(`sidebar.${returnTo === 'screenshots' ? 'screens' : returnTo}`) })}
                </button>
                <span className="text-redlog-text-faint">{isMac ? '⌘[' : 'Alt+←'}</span>
              </div>
            )}
            {view === 'timeline' && <TimelinePanel key={project?.id ?? 'no-project'} focusEventId={focusEvent?.id} focusTs={focusEvent?.ts} tierChip={visibility.tierChip} onDropMarker={(ts) => { setMarkerAtTs(ts); setShowMarker(true) }} />}
            {/* v0.11.2 (design note T5): the same events read vertically. The
                Timeline answers "when did this happen and what did it cause";
                this answers "what did I type and what came back", which is the
                question an operator asks when writing an engagement up. */}
            {view === 'transcript' && (
              <Suspense fallback={<PaneLoading />}>
                <TranscriptView
                  key={project?.id ?? 'no-project'}
                  // `onNavigate` is not in scope here — App switches views with
                  // `setView`. This threw a ReferenceError on every use of the
                  // transcript's arrow button, which is §7's transcript <-> timeline
                  // link and one of the five cross-view routes phase 3 is meant
                  // to be completing.
                  onOpenInTimeline={openInTimeline}
                />
              </Suspense>
            )}
            {view === 'screenshots' && <ScreenshotsView onNavigate={navigate} />}
            {view === 'search' && <SearchPanel onOpenInTimeline={openInTimeline} />}
            {view === 'targets' && <TargetView onOpenInTimeline={(ts) => openInTimeline('', ts)} />}
            {view === 'scope' && <ScopeStatus onOpenInTimeline={(ts) => openInTimeline('', ts)} />}
            {view === 'loot' && <LootPanel onOpenInTimeline={openInTimeline} />}
            {view === 'bookmarks' && <BookmarksView onOpenInTimeline={(ts) => openInTimeline('', ts)} />}
            {view === 'http_history' && <Suspense fallback={<PaneLoading />}><HttpHistoryPanel onOpenInTimeline={openInTimeline} /></Suspense>}
            {view === 'settings' && <Suspense fallback={<PaneLoading />}><Settings request={settingsRequest} /></Suspense>}
          </ErrorBoundary>
          </div>
        </div>
      </div>

      {/* Above the status bar and outside the view-root: a session replay keeps
          playing here when the operator switches views (§14). */}
      <ReplayDrawer />
      <StatusBar />
      {showMarker && <EventMarker onClose={() => { setShowMarker(false); setMarkerAtTs(undefined); setMarkerHeldFrame(undefined) }} atTimestamp={markerAtTs} heldFrame={markerHeldFrame} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onOpenEvent={openInTimeline}
        recording={recordingOn}
      />
      <ToastContainer />
      <ConfirmDialogContainer />
    </div>
    </FilterProvider>
  )
}
