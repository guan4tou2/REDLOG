import { useState, useEffect, lazy, Suspense } from 'react'
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
// Electron-local loads are instant so the Suspense fallback is null.
const TerminalView = lazy(() => import('./components/TerminalView'))
const Settings = lazy(() => import('./components/Settings'))
const TranscriptView = lazy(() => import('./components/TranscriptView'))
const HttpHistoryPanel = lazy(() => import('./components/HttpHistoryPanel').then(m => ({ default: m.HttpHistoryPanel })))

import { useI18n } from './i18n'
import type { SidebarViewId } from './lib/sidebarOrder'
import { isMac } from './lib/platform'

// Extracted components
import { DashboardView, LaunchBrowserButton } from './components/DashboardView'
import { ScreenshotsView } from './components/ScreenshotsView'

// Extracted hooks
import { useVisibility } from './hooks/useVisibility'
import { useAppShortcuts } from './hooks/useAppShortcuts'

type View = SidebarViewId | 'settings'


export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Event to focus when the Timeline opens (set when jumping from Loot); cleared
  // on plain sidebar navigation so a normal Timeline visit scrolls to "now".
  const [focusEvent, setFocusEvent] = useState<{ id: string; ts: number } | null>(null)
  // A target to scope the timeline to, set when arriving from the Targets
  // view. Cleared on any nav so it never silently narrows a later visit.
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  const [showMarker, setShowMarker] = useState(false)
  // Feeds the export menu's "N events · about X" line. Refreshed on view
  // changes rather than per event — the preview exists to catch "I meant the
  // slice, not all 28,000", and that answer does not move by one.
  const [exportableCount, setExportableCount] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [recordingOn, setRecordingOn] = useState(true)
  const [markerAtTs, setMarkerAtTs] = useState<number | undefined>(undefined)
  const { t } = useI18n()

  // Visibility / first-run state is fully managed by the extracted hook.
  const { visibility, firstRunActive } = useVisibility(project, view)

  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) setProject(p)
    })
  }, [])

  useEffect(() => {
    if (!project) return
    window.redlog.events.getCount().then(setExportableCount).catch(() => {})
  }, [project, view])

  // Global marker shortcut (Cmd/Ctrl+Shift+M) is registered in the main process
  // via Electron globalShortcut so it fires whether the window has focus or
  // not. Do NOT also listen for it in the renderer — audit finding P0 #5
  // pointed out the dialog would open twice when the RedLog window was in
  // front (both handlers ran). Renderer only handles Cmd/ and Cmd+1..N which
  // must be scoped to the app window.
  useEffect(() => {
    return window.redlog.marker.onShortcut(() => setShowMarker(true))
  }, [])

  // The palette shows "pause" or "resume" depending on the current state, so
  // it has to know it.
  useEffect(() => {
    window.redlog.recording.get().then(setRecordingOn).catch(() => {})
    return window.redlog.recording.onChange(setRecordingOn)
  }, [])

  // Cmd/Ctrl+1..N follow the sidebar's current (possibly user-reordered) order.
  // Also handles app-wide shortcuts (palette, find-in-page, recording toggle,
  // HUD corner). Extracted to hooks/useAppShortcuts.ts.
  useAppShortcuts(project, view, setView, setPaletteOpen, t)

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
          {/* Title-bar size is small, so the ring collapses to a solid dot
              (§4). Single wordmark — the old image + plain-text pair is gone. */}
          <Wordmark className="text-xs" dotOnly />
          {/* Take the version out of the drag zone so users reporting bugs can
              actually copy it — audit finding P2 #36. */}
          <span
            className="text-redlog-text-dim text-xs font-mono select-text cursor-text"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t('app.copyVersionHint')}
          >v{__APP_VERSION__}</span>
          {/* "Check for updates" was a Settings group, next to a copy of this
              same version string. It is an action about the version, so it
              belongs beside the version rather than in a page of settings —
              and nobody looks for it under Settings anyway. */}
          <button
            onClick={() => void window.redlog.app.checkForUpdates()}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t('settings.checkUpdateHint')}
            className="text-redlog-text-faint hover:text-redlog-text text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50 rounded px-1"
          >{t('settings.checkUpdate')}</button>
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
          {/* §10: one export control, in the shell rather than six places.
              Its scope is an option, not a location. */}
          <ExportMenu totalCount={exportableCount} />
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
        <Sidebar
          active={view}
          visibleViews={visibility.views}
          onNavigate={(v) => { setFocusEvent(null); setFocusTarget(null); setView(v as View) }}
        />

        <div className="flex-1 min-w-0 select-text" data-testid="view-root" data-view={view}>
          <ErrorBoundary label={view} projectName={project.name} onGoHome={() => setView('dashboard')}>
            {view === 'dashboard' && <DashboardView onNavigate={(v) => setView(v as View)} firstRun={firstRunActive} />}
            {view === 'terminal' && <Suspense fallback={null}><TerminalView /></Suspense>}
            {/* key on project.id: a project switch (e.g. project:open) must
                remount TimelinePanel — otherwise eventsMapRef keeps the prior
                project's rows and the initial useEffect doesn't re-fire.
                Latent today (no in-app switcher yet); guards the flow when one lands. */}
            {view === 'timeline' && <TimelinePanel key={project?.id ?? 'no-project'} focusEventId={focusEvent?.id} focusTs={focusEvent?.ts} focusTarget={focusTarget ?? undefined} tierChip={visibility.tierChip} onDropMarker={(ts) => { setMarkerAtTs(ts); setShowMarker(true) }} />}
            {/* v0.11.2 (design note T5): the same events read vertically. The
                Timeline answers "when did this happen and what did it cause";
                this answers "what did I type and what came back", which is the
                question an operator asks when writing an engagement up. */}
            {view === 'transcript' && (
              <Suspense fallback={null}>
                <TranscriptView
                  key={project?.id ?? 'no-project'}
                  // `onNavigate` is not in scope here — App switches views with
                  // `setView`. This threw a ReferenceError on every use of the
                  // transcript's arrow button, which is §7's transcript <-> timeline
                  // link and one of the five cross-view routes phase 3 is meant
                  // to be completing.
                  onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }}
                />
              </Suspense>
            )}
            {view === 'screenshots' && <ScreenshotsView onNavigate={(v) => setView(v as View)} />}
            {view === 'search' && <SearchPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} />}
            {view === 'targets' && <TargetView onOpenInTimeline={(ts, target) => { setFocusEvent({ id: '', ts }); setFocusTarget(target ?? null); setView('timeline') }} />}
            {view === 'scope' && <ScopeStatus onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} />}
            {view === 'loot' && <LootPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} />}
            {view === 'bookmarks' && <BookmarksView onOpenInTimeline={(ts) => { setFocusEvent({ id: '', ts }); setView('timeline') }} />}
            {view === 'http_history' && <Suspense fallback={null}><HttpHistoryPanel onOpenInTimeline={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }} /></Suspense>}
            {view === 'settings' && <Suspense fallback={null}><Settings /></Suspense>}
          </ErrorBoundary>
        </div>
      </div>

      {/* Above the status bar and outside the view-root: a session replay keeps
          playing here when the operator switches views (§14). */}
      <ReplayDrawer />
      <StatusBar />
      {showMarker && <EventMarker onClose={() => { setShowMarker(false); setMarkerAtTs(undefined) }} atTimestamp={markerAtTs} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(v) => setView(v as View)}
        onOpenEvent={(id, ts) => { setFocusEvent({ id, ts }); setView('timeline') }}
        recording={recordingOn}
      />
      <ToastContainer />
      <ConfirmDialogContainer />
    </div>
  )
}
