import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'
import { takePendingCommand, onRunInTerminal } from '../lib/terminalRunner'
import { readClipboard, writeClipboard } from '../lib/clipboard'
import { toast, UNDO_MS } from './Toast'
import { castHistory, endedRecording, type CastHistory } from '../lib/terminalRecordingSummary'
import { usePersistentState } from '../lib/usePersistentState'
import { DEFAULT_FONT_SIZE, FONT_MIN, FONT_MAX, clampFontSize } from '../lib/terminalFont'
import { Modal } from './Modal'
import { Button } from './Button'
import { isMac } from '../lib/platform'

interface Tab {
  id: string
  label: string
  pid: number
  alive: boolean
  /** Catalog id the pane was opened with, or undefined for "whatever the
   *  old inherited-$SHELL rule picks". Kept per tab so a remount respawns
   *  the same shell rather than silently switching under the operator. */
  shellId?: string
  // cwd basename + last-command exit code — audit #16. Both come from the
  // shell hook via `redlog:` OSC 6 escapes that xterm.js dispatches; we set
  // them from TerminalPane so the tab bar shows where a shell is + whether
  // the last thing that ran failed.
  cwd?: string
  /** The directory as the shell reported it; `cwd` is only its last segment. */
  cwdFull?: string
  lastExit?: number
  /** The shell this pane runs when it takes no hook (its commands are not
   *  recorded), else null. Undefined until the pane has been spawned. */
  unhooked?: string | null
  castRecording?: boolean
  castTruncated?: boolean
  castPaused?: boolean
  recordingReason?: 'no-project' | 'recording-failed'
  recordingError?: string
  castHistory?: CastHistory
}

interface PaneRuntime {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  alive: boolean
  pid: number
  castState: TerminalCastState | null
  unhookedShell: string | null
  handlers: { pid: (pid: number) => void; state: (state: TerminalCastState) => void; exit: () => void; unhooked: (shell: string | null) => void } | null
  dispose: () => void
}

// Xterm owns its bounded 5,000-line screen/scrollback. Navigation can detach
// its DOM without destroying that model, or replacing it with a short IPC tail.
const paneRuntimes = new Map<string, PaneRuntime>()
// [badge, tooltip] for an ended pane, by what its recording went through.
const ENDED_LABELS: Record<NonNullable<ReturnType<typeof endedRecording>>, [string, string]> = {
  'failed': ['terminal.ended.failedShort', 'terminal.ended.failed'],
  'not-recorded': ['terminal.castNotRecordingShort', 'terminal.castNotRecording'],
  'partly-unrecorded': ['terminal.ended.partlyUnrecordedShort', 'terminal.ended.partlyUnrecorded'],
  'partly-paused': ['terminal.ended.partlyPausedShort', 'terminal.ended.partlyPaused']
}

// Kept at module scope like the runtimes, so a remount after navigation does
// not forget a pause or failure the pane went through before it.
const castHistories = new Map<string, CastHistory>()
function recordCastState(id: string, state: TerminalCastState): CastHistory {
  const next = castHistory(castHistories.get(id) ?? {}, state)
  castHistories.set(id, next)
  return next
}

function disposePaneRuntime(id: string): void {
  castHistories.delete(id)
  const runtime = paneRuntimes.get(id)
  if (!runtime) return
  paneRuntimes.delete(id)
  runtime.dispose()
}

let tabCounter = 0

const FONT_SIZE_KEY = 'redlog-terminal-fontsize'
const SHELL_KEY = 'redlog-terminal-shell'
// Decorations make the addon report match counts. Colours must be #RRGGBB.
const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: '#3f3f46', matchOverviewRuler: '#71717a',
    activeMatchBackground: '#ef4444', activeMatchColorOverviewRuler: '#ef4444'
  }
}
// The addon stops counting at its highlight limit (1000 by default).
const SEARCH_COUNT_CAP = 1000

interface ShellOption {
  id: string
  label: string
  flavour: 'powershell' | 'posix' | 'none'
}

export default function TerminalView({ allowNew = true }: { allowNew?: boolean }): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  // Persist font-size across sessions; ⌘+ / ⌘− step it and ⌘0 resets it.
  // These move xterm's fontSize, not the window's zoom.
  const [fontSize, setFontSize] = usePersistentState<number>(FONT_SIZE_KEY, DEFAULT_FONT_SIZE, {
    parse: (raw) => {
      const saved = parseInt(raw || '')
      return Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX ? saved : DEFAULT_FONT_SIZE
    }
  })
  // In-buffer search (per active pane): the input toggles + a small state
  // holds the current query. Enter → next match, Shift+Enter → previous.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // The shells this machine offers, and the one the operator last chose.
  // Discovery is async in the main process (it enumerates WSL), so the menu
  // fills in after mount rather than blocking anything.
  const [shells, setShells] = useState<ShellOption[]>([])
  const [shellMenuOpen, setShellMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [preferredShell, setPreferredShell] = usePersistentState<string>(SHELL_KEY, '')
  const paneSearchRefs = useRef<Map<string, SearchAddon>>(new Map())
  // Match count for the current query, as reported by the addon. It only
  // reports while decorations are on, so every find passes SEARCH_OPTIONS.
  const [searchResult, setSearchResult] = useState<{ index: number; count: number } | null>(null)
  const queued = useRef<string | null>(null)
  const { t } = useI18n()

  const runSearch = useCallback((query: string, direction: 'next' | 'prev' | 'type'): void => {
    const addon = activeTab ? paneSearchRefs.current.get(activeTab) : null
    if (!addon) return
    if (!query) { addon.clearDecorations(); setSearchResult(null); return }
    const found = direction === 'prev'
      ? addon.findPrevious(query, SEARCH_OPTIONS)
      : addon.findNext(query, direction === 'type' ? { ...SEARCH_OPTIONS, incremental: true } : SEARCH_OPTIONS)
    // A failed find may not fire a change event; say 0 rather than keep an old count.
    if (!found) setSearchResult({ index: -1, count: 0 })
  }, [activeTab])

  const closeSearch = (): void => {
    const addon = activeTab ? paneSearchRefs.current.get(activeTab) : null
    addon?.clearDecorations()
    setSearchOpen(false); setSearchQuery(''); setSearchResult(null)
  }

  // Follow the active pane's result count; a different pane starts with none.
  useEffect(() => {
    setSearchResult(null)
    const addon = activeTab ? paneSearchRefs.current.get(activeTab) : null
    if (!addon || !searchOpen) return
    const sub = addon.onDidChangeResults((e) => setSearchResult({ index: e.resultIndex, count: e.resultCount }))
    return () => sub.dispose()
  }, [activeTab, searchOpen])

  // A setup command sent here from Settings. It is typed into the pane, not
  // executed: some of these start long-running processes and some kill them by
  // PID, so the operator reads the line and presses Enter. The shell hook then
  // records it like any other command — which is the point, since setting
  // capture up used to be the one part of an engagement that left no trace.
  const deliver = useCallback((command: string) => {
    const target = activeTab ?? tabs[0]?.id
    if (!target) return false
    window.redlog.terminal.write(target, command)
    setActiveTab(target)
    return true
  }, [activeTab, tabs])

  useEffect(() => {
    const pendingCmd = takePendingCommand()
    if (pendingCmd && deliver(pendingCmd)) return
    // Arrived before a pane existed: hold it until one does.
    if (pendingCmd) queued.current = pendingCmd
  }, [deliver])

  useEffect(() => onRunInTerminal((command) => { if (!deliver(command)) queued.current = command }), [deliver])

  useEffect(() => {
    if (!queued.current) return
    if (deliver(queued.current)) queued.current = null
  }, [deliver, tabs, activeTab])

  const addTab = useCallback((shellId?: string) => {
    if (!allowNew) return
    const n = ++tabCounter
    const id = `term-${Date.now()}-${n}`
    // Monotonic counter — using tabs.length + 1 caused collisions after close
    // ("Shell 2" reused if tab 3 was closed before adding a new one). Audit P1 #16.
    const label = `${t('terminal.shell')} ${n}`
    const tab: Tab = { id, label, pid: 0, alive: true, shellId: shellId || preferredShell || undefined }
    setTabs((prev) => [...prev, tab])
    setActiveTab(id)
  }, [t, preferredShell, allowNew])

  const closeTab = useCallback(async (id: string) => {
    // Terminal panes host live PTY sessions (with shell hook capturing every
    // command), so closing one kills a child process and loses interactive
    // state. That used to raise a confirm dialog on every close (audit P1
    // #17), which is the wrong grade for it: §5.5 puts a dialog on the
    // irreversible and this is not — the tab reopens in the same cwd. Close
    // it, say so, and offer the way back for eight seconds.
    const tab = tabs.find((t) => t.id === id)
    disposePaneRuntime(id)
    window.redlog.terminal.kill(id)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTab === id) {
        setActiveTab(next.length > 0 ? next[next.length - 1].id : null)
      }
      return next
    })
    // The PTY is gone either way; undo opens a fresh shell in its place,
    // which is what "undo" can honestly mean here. Scrollback does not come
    // back, and the second line of the toast says so rather than letting the
    // operator find out.
    toast(t('terminal.tabClosed', { label: tab?.label ?? '' }), {
      why: t('terminal.tabClosedWhy'),
      ...(allowNew ? { action: { label: t('toast.undo'), onClick: () => addTab() } } : {}),
      duration: UNDO_MS
    })
  }, [activeTab, tabs, t, addTab, allowNew])

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return   // StrictMode runs this twice in dev
    didInit.current = true
    if (tabs.length > 0) return
    // Adopt the shells that are already running before starting a new one.
    // This component keeps its tab list in local state, so navigating away and
    // back used to mount with an empty list and spawn a second pty while the
    // first went on running with nothing attached to it — one orphaned shell
    // per visit. `terminal:spawn` is idempotent per id and replays the
    // scrollback, so re-attaching is exactly what the operator wants: the
    // session they left, with its history.
    void (window.redlog.terminal.list() ?? Promise.resolve([]))
      .then((live) => {
        if (!Array.isArray(live) || live.length === 0) { addTab(); return }
        setTabs(live.map((s, i) => ({
          id: s.id, label: `${t('terminal.shell')} ${i + 1}`, pid: s.pid, alive: true,
          castRecording: s.recording, castTruncated: s.castTruncated, castPaused: s.paused,
          recordingReason: s.recordingReason, recordingError: s.recordingError, castHistory: recordCastState(s.id, s)
        })))
        setActiveTab(live[0].id)
        tabCounter = Math.max(tabCounter, live.length)
      })
      .catch(() => addTab())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ask the main process which shells this machine has. Cached there, so
  // reopening the view is free; the first call on Windows enumerates WSL.
  useEffect(() => {
    void (window.redlog.terminal.shells?.() ?? Promise.resolve([]))
      .then((list) => { if (Array.isArray(list)) setShells(list) })
      .catch(() => { /* picker falls back to the single + button */ })
  }, [])

  // Watch shell events → update tab cwd + last exit code (audit #16). Every
  // command_end from a builtin terminal carries source + terminalId + exit +
  // cwd; we match by terminalId and stamp the label. Cheap because command_end
  // is at most one per prompt.
  useEffect(() => {
    return window.redlog.events.onNewBatch((events) => {
      const updates = events.flatMap((evt) => {
        if (evt.agentType !== 'shell') return []
        const d = evt.data as { subtype?: string; source?: string; terminalId?: string; cwd?: string; exit_code?: number }
        return d.source === 'builtin-terminal' && d.subtype === 'command_end' && d.terminalId ? [d] : []
      })
      if (!updates.length) return
      setTabs((prev) => prev.map((tab) => {
        const d = updates.slice().reverse().find((update) => update.terminalId === tab.id)
        return d
        // Split on either separator so a Windows `C:\Users\foo\proj` doesn't
        // render as one giant tab label. Audit P1-3 (WINDOWS_COMPAT_AUDIT.md).
        ? { ...tab, cwd: d.cwd?.split(/[\\/]/).pop() || tab.cwd, cwdFull: d.cwd || tab.cwdFull, lastExit: d.exit_code }
        : tab
      }))
    })
  }, [])

  // Tab-nav shortcuts scoped to the Terminal view. Audit finding #78: ⌘T new,
  // ⌘W close active, ⌘⇧] next, ⌘⇧[ prev. Bound at window scope but active
  // only while this component is mounted (view === 'terminal' in App.tsx).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const cmd = e.ctrlKey || e.metaKey
      if (!cmd || e.defaultPrevented || e.isComposing) return
      // xterm's textarea owns terminal shortcuts; ordinary fields retain their
      // editing/browser commands (including the terminal search input).
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, select, textarea, [contenteditable="true"]') && !target.closest('.xterm')) return
      if (e.key === 't' && !e.shiftKey && !e.altKey) { e.preventDefault(); addTab() }
      else if (e.key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (activeTab) closeTab(activeTab)
      }
      // Find works from anywhere on the page, not only while xterm has focus.
      else if (e.key === 'f' && !e.shiftKey && !e.altKey && activeTab) { e.preventDefault(); setSearchOpen(true) }
      else if (e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault()
        setTabs((prev) => { const i = prev.findIndex((t) => t.id === activeTab); if (i >= 0 && prev.length > 1) setActiveTab(prev[(i + 1) % prev.length].id); return prev })
      }
      else if (e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault()
        setTabs((prev) => { const i = prev.findIndex((t) => t.id === activeTab); if (i >= 0 && prev.length > 1) setActiveTab(prev[(i - 1 + prev.length) % prev.length].id); return prev })
      }
      // Terminal font size, not window zoom: this is xterm's fontSize option,
      // not Chromium's page zoom. `=` covers ⌘= on a US layout and `+` covers
      // layouts and keyboards that send the shifted character.
      else if (!e.altKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setFontSize((size) => clampFontSize(size + 1))
      }
      else if (!e.altKey && e.key === '-') {
        e.preventDefault()
        setFontSize((size) => clampFontSize(size - 1))
      }
      else if (!e.altKey && e.key === '0') {
        e.preventDefault()
        setFontSize(DEFAULT_FONT_SIZE)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, addTab, closeTab])

  const current = tabs.find((tb) => tb.id === activeTab) ?? null
  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <TerminalHeader onAbout={() => setAboutOpen(true)} onSearch={() => setSearchOpen(true)} />
      {/* Tab bar */}
      <div className="flex items-center h-9 bg-redlog-bg border-b border-redlog-border px-1 shrink-0 gap-0.5">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`group flex items-center gap-1.5 px-3 h-7 rounded-md text-xs cursor-pointer transition-colors ${
              activeTab === tab.id
                ? 'bg-[#1a1a1a] text-redlog-text'
                : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.alive ? 'bg-emerald-500' : 'bg-redlog-elevated-hover'}`} />
            <span title={tab.label} className={`truncate max-w-[100px] ${tab.alive ? '' : 'italic text-redlog-text-faint'}`}>{tab.label}</span>
            {tab.alive && tab.castRecording === true && (
              <span className="text-xs font-mono text-red-400/70 bg-red-500/10 px-1 rounded" title={t('terminal.castRecording')}>{t('terminal.castRecordingShort')}</span>
            )}
            {tab.alive && tab.castTruncated === true && (
              <span className="text-xs font-mono text-amber-400/70 bg-amber-500/10 px-1 rounded" title={t('terminal.castTruncated')}>{t('terminal.castTruncatedShort')}</span>
            )}
            {tab.alive && tab.castPaused === true && (
              <span className="text-xs font-mono text-redlog-text-dim bg-redlog-elevated px-1 rounded" title={t('terminal.castPaused')}>{t('terminal.castPausedShort')}</span>
            )}
            {tab.alive && tab.castRecording === false && tab.castTruncated !== true && tab.castPaused !== true && (
              <span className="text-xs font-mono text-redlog-text-faint bg-redlog-elevated px-1 rounded" title={t('terminal.castNotRecording')}>{t('terminal.castNotRecordingShort')}</span>
            )}
            {!tab.alive && (() => {
              const ended = endedRecording(tab.castHistory ?? {})
              return ended && (
                <span data-testid="terminal-ended-recording" data-state={ended} className={`text-xs font-mono px-1 rounded ${ended === 'failed' ? 'text-red-400 bg-red-500/10' : 'text-amber-400/70 bg-amber-500/10'}`} title={t(ENDED_LABELS[ended][1])}>{t(ENDED_LABELS[ended][0])}</span>
              )
            })()}
            {tab.cwd && tab.alive && (
              <span className="text-xs font-mono text-redlog-text-dim truncate max-w-[80px]" title={tab.cwdFull ?? tab.cwd}>{tab.cwd}</span>
            )}
            {tab.alive && tab.lastExit !== undefined && tab.lastExit !== 0 && (
              <span
                className="text-xs font-mono text-red-400 bg-red-500/10 px-1 rounded"
                title={t('terminal.lastExit', { code: tab.lastExit })}
              >✕{tab.lastExit}</span>
            )}
            {tab.pid > 0 && tab.alive && (
              <span className="text-xs text-redlog-text-faint font-mono">{tab.pid}</span>
            )}
            {!tab.alive && allowNew && (
              <button
                onClick={(e) => {
                  // Restart in place: swap the tab's id for a fresh one — React
                  // unmounts the dead TerminalPane and mounts a new one at the
                  // same slot with a new pty session. Preserves label + tab
                  // order + active-tab focus. Audit finding #12.
                  e.stopPropagation()
                  const newId = `term-${Date.now()}-r${++tabCounter}`
                  // A new session starts with nothing of the old one: its recording
                  // history, hook state, directory and exit code belong to the
                  // shell that ended, and would otherwise be read as the new one's.
                  setTabs((prev) => prev.map((tb) => tb.id === tab.id
                    ? { id: newId, label: tb.label, shellId: tb.shellId, pid: 0, alive: true }
                    : tb))
                  if (activeTab === tab.id) setActiveTab(newId)
                  // Clean up the dead pane's search-addon ref
                  paneSearchRefs.current.delete(tab.id)
                }}
                className="ml-0.5 w-6 h-6 rounded flex items-center justify-center text-emerald-500/70 hover:text-emerald-400 hover:bg-emerald-950/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                title={t('terminal.restart')}
                aria-label={t('terminal.restart')}
              >↻</button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              className="ml-0.5 w-6 h-6 rounded flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-redlog-elevated-hover opacity-60 hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim transition-opacity"
              title={t('terminal.closeTitle')}
              aria-label={t('terminal.closeTitle')}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => addTab()}
          disabled={!allowNew}
          className="h-7 px-2 rounded-md flex items-center gap-1 justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-white/[0.03] transition-colors text-xs"
          title={`${t('terminal.newTab')} (${isMac ? '⌘T' : 'Ctrl+T'})`}
          aria-label={t('terminal.newTab')}
        >
          <span aria-hidden className="text-sm">+</span>{t('terminal.tabWord')}
        </button>

        {/* Which shell the next pane opens with. Hidden when the machine only
            offers one — a menu with a single entry is a decision the operator
            does not have. */}
        {allowNew && shells.length > 1 && (
          <div className="relative">
            <button
              onClick={() => setShellMenuOpen((v) => !v)}
              data-testid="terminal-shell-menu"
              aria-haspopup="menu"
              aria-expanded={shellMenuOpen}
              className="w-6 h-7 rounded-md flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-white/[0.03] transition-colors text-xs"
              title={t('terminal.pickShell')}
              aria-label={t('terminal.pickShell')}
            >
              ▾
            </button>
            {shellMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShellMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute left-0 top-8 z-50 min-w-[210px] rounded-md border border-redlog-border bg-redlog-elevated py-1 shadow-lg"
                >
                  {shells.map((sh) => (
                    <button
                      key={sh.id}
                      role="menuitem"
                      onClick={() => {
                        setPreferredShell(sh.id)
                        setShellMenuOpen(false)
                        addTab(sh.id)
                      }}
                      className="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:bg-redlog-elevated-hover"
                    >
                      <span className="w-3 shrink-0 text-redlog-accent">{preferredShell === sh.id ? '•' : ''}</span>
                      <span className="flex-1 truncate" title={sh.label}>{sh.label}</span>
                      {/* The point of the picker: an unhookable shell is
                          labelled as such before it is chosen, not after. */}
                      {sh.flavour === 'none'
                        ? <span className="shrink-0 text-xs text-amber-400">{t('terminal.ptyOnly')} · {t('terminal.notRecorded')}</span>
                        : <span data-testid="terminal-shell-hooked" className="shrink-0 text-xs text-redlog-text-faint">{t('terminal.hookSupported')}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Font-size + search on the right — audit findings #14 (SearchAddon)
            and #15 (font size adjustable). */}
        <div className="ml-auto flex items-center gap-1 pr-1">
          <button
            onClick={() => setFontSize((s) => Math.max(8, s - 1))}
            className="w-6 h-6 rounded flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('terminal.fontSmaller')}
            aria-label={t('terminal.fontSmaller')}
          >A−</button>
          <span className="text-xs text-redlog-text-faint font-mono tabular-nums w-6 text-center">{fontSize}</span>
          <button
            onClick={() => setFontSize((s) => Math.min(32, s + 1))}
            className="w-6 h-6 rounded flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('terminal.fontLarger')}
            aria-label={t('terminal.fontLarger')}
          >A+</button>
          <button
            onClick={() => setSearchOpen((s) => !s)}
            className={`w-6 h-6 rounded flex items-center justify-center hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim ${searchOpen ? 'text-redlog-text bg-white/[0.05]' : 'text-redlog-text-faint hover:text-redlog-text'}`}
            title={`${t('terminal.searchToggle')} (${isMac ? '⌘F' : 'Ctrl+F'})`}
            aria-label={t('terminal.searchToggle')}
          >⌕</button>
        </div>
      </div>

      {/* Search bar (visible when toggled) */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-2 py-1 border-b border-redlog-border bg-[#0f0f0f]">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); runSearch(e.target.value, 'type') }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runSearch(searchQuery, e.shiftKey ? 'prev' : 'next') }
              if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
            }}
            placeholder={t('terminal.searchPlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500/40"
          />
          {searchQuery && searchResult && (
            <span data-testid="terminal-search-count" role="status" className="shrink-0 text-xs font-mono tabular-nums text-redlog-text-dim">
              {searchResult.count === 0
                ? t('terminal.searchNone')
                : searchResult.count >= SEARCH_COUNT_CAP
                  ? t('terminal.searchTotal', { total: `${SEARCH_COUNT_CAP}+` })
                  : searchResult.index >= 0
                    ? t('terminal.searchPosition', { index: searchResult.index + 1, total: searchResult.count })
                    : t('terminal.searchTotal', { total: searchResult.count })}
            </span>
          )}
          <span className="shrink-0 text-xs text-redlog-text-faint">{t('terminal.escToClose')}</span>
          <button
            onClick={() => runSearch(searchQuery, 'prev')}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
            title={t('terminal.searchPrev')}
            aria-label={t('terminal.searchPrev')}
          >↑</button>
          <button
            onClick={() => runSearch(searchQuery, 'next')}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
            title={t('terminal.searchNext')}
            aria-label={t('terminal.searchNext')}
          >↓</button>
          <button
            onClick={closeSearch}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
            title={t('terminal.searchClose')}
            aria-label={t('terminal.searchClose')}
          >×</button>
        </div>
      )}

      {current && <SessionMeta tab={current} shellName={shells.find((s) => s.id === current.shellId)?.label} />}
      <Modal open={aboutOpen} onClose={() => setAboutOpen(false)} label={t('terminal.aboutTitle')} testId="terminal-about"
        panelClassName="w-[520px] max-w-[95vw] rounded-lg border border-redlog-border bg-redlog-surface p-4 shadow-xl">
        <h2 className="text-sm font-semibold text-redlog-text">{t('terminal.aboutTitle')}</h2>
        <div className="mt-3 space-y-3 text-xs text-redlog-text-dim">
          <section className="rounded border border-redlog-border bg-redlog-elevated p-3">
            <h3 className="font-medium text-redlog-text">{t('terminal.aboutCastTitle')}</h3>
            <p className="mt-1">{t('terminal.aboutCastBody')}</p>
          </section>
          <section className="rounded border border-redlog-border bg-redlog-elevated p-3">
            <h3 className="font-medium text-redlog-text">{t('terminal.aboutHookTitle')}</h3>
            <p className="mt-1">{t('terminal.aboutHookBody')}</p>
          </section>
          <p>{t('terminal.aboutIndependent')}</p>
          <p data-testid="terminal-about-boundary">{t('terminal.aboutBoundary')}</p>
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={() => setAboutOpen(false)}>{t('common.close')}</Button></div>
      </Modal>

      {/* Terminal panes */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: activeTab === tab.id ? 'block' : 'none' }}
          >
            <TerminalPane
              id={tab.id}
              active={activeTab === tab.id}
              fontSize={fontSize}
              onSearch={() => setSearchOpen(true)}
              shellId={tab.shellId}
              onPid={(pid) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, pid } : t))}
              onCastState={(state) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, castRecording: state.recording, castTruncated: state.castTruncated, castPaused: state.paused, recordingReason: state.recordingReason, recordingError: state.recordingError, castHistory: recordCastState(tab.id, state) } : t))}
              onExit={() => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, alive: false } : t))}
              onUnhooked={(shell) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, unhooked: shell } : t))}
              onSearchAddon={(addon) => { paneSearchRefs.current.set(tab.id, addon) }}
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div data-testid="terminal-empty" className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-sm font-medium text-redlog-text">{t('terminal.emptyTitle')}</p>
            <p className="max-w-md text-xs text-redlog-text-dim">{t('terminal.emptyBody')}</p>
            <Button level="primary" disabled={!allowNew} onClick={() => addTab()}>
              {(() => { const sh = shells.find((s) => s.id === preferredShell) ?? shells[0]; return sh ? t('terminal.newSessionWith', { shell: sh.label }) : t('terminal.newTab') })()}
            </Button>
            <p className="max-w-md text-xs text-redlog-text-faint">{t('terminal.aboutBoundary')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Heading with the one thing the page cannot show by itself: how capture
 *  works here. The hint gives way on a short window — the terminal needs the room. */
function TerminalHeader({ onAbout, onSearch }: { onAbout: () => void; onSearch: () => void }): JSX.Element {
  const { t } = useI18n()
  return (
    <div data-testid="terminal-header" className="flex shrink-0 items-center justify-between gap-3 border-b border-redlog-border px-3 py-1.5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="text-sm font-semibold text-redlog-text">{t('terminal.title')}</h1>
        <p className="hidden text-xs text-redlog-text-dim [@media(min-height:640px)]:block">{t('terminal.hint')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="compact" level="quiet" data-testid="terminal-search-open" onClick={onSearch}>{t('terminal.searchToggle')} ({isMac ? '⌘F' : 'Ctrl+F'})</Button>
        <Button size="compact" data-testid="terminal-about-open" onClick={onAbout}>{t('terminal.about')}</Button>
      </div>
    </div>
  )
}

const BADGE = 'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs'
const TONE = {
  good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  bad: 'border-red-500/30 bg-red-500/10 text-red-300',
  quiet: 'border-redlog-border bg-redlog-elevated text-redlog-text-dim'
} as const

/** What the active pane's recording and hook are doing, and where it is. Each
 *  line is that pane's own: a state is never carried over from another pane or
 *  from the session this one replaced. */
function SessionMeta({ tab, shellName }: { tab: Tab; shellName?: string }): JSX.Element {
  const { t } = useI18n()
  const ended = endedRecording(tab.castHistory ?? {})
  let screen: { tone: keyof typeof TONE; text: string; title?: string } | null = null
  if (!tab.alive) {
    screen = ended
      ? { tone: ended === 'failed' ? 'bad' : 'warn', text: `${t('terminal.meta.ended')} · ${t(ENDED_LABELS[ended][0])}`, title: t(ENDED_LABELS[ended][1]) }
      : { tone: 'quiet', text: `${t('terminal.meta.ended')} · ${t('terminal.meta.endedNoGap')}` }
  } else if (tab.recordingReason === 'recording-failed') {
    screen = { tone: 'bad', text: t('terminal.ended.failedShort'), title: t('terminal.recordingFailed', { reason: tab.recordingError ?? '' }) }
  } else if (tab.castPaused) screen = { tone: 'warn', text: t('terminal.castPausedShort'), title: t('terminal.castPaused') }
  else if (tab.castTruncated) screen = { tone: 'warn', text: t('terminal.castTruncatedShort'), title: t('terminal.castTruncated') }
  else if (tab.castRecording === true) screen = { tone: 'good', text: t('terminal.castRecordingShort'), title: t('terminal.castRecording') }
  else if (tab.castRecording === false) screen = { tone: 'quiet', text: t('terminal.castNotRecordingShort'), title: t('terminal.castNotRecording') }
  // Hook: known only once the pane has a process; before that, say nothing.
  const hook = tab.alive && tab.pid > 0 && tab.unhooked !== undefined
    ? tab.unhooked
      ? { tone: 'warn' as const, text: t('terminal.meta.hookOff'), title: t('terminal.noHook', { shell: tab.unhooked.split(/[\\/]/).pop() ?? tab.unhooked }) }
      : { tone: 'good' as const, text: shellName ? `${t('terminal.meta.hookOn')} (${shellName})` : t('terminal.meta.hookOn') }
    : null
  return (
    <div data-testid="terminal-session-meta" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-redlog-border bg-redlog-bg px-3 py-1">
      <div className="flex flex-wrap items-center gap-2">
        {screen && <span data-testid="terminal-meta-screen" className={`${BADGE} ${TONE[screen.tone]}`} title={screen.title}><span className="text-redlog-text-faint">{t('terminal.meta.screenLabel')}</span>{screen.text}</span>}
        {hook && <span data-testid="terminal-meta-hook" className={`${BADGE} ${TONE[hook.tone]}`} title={hook.title}><span className="text-redlog-text-faint">{t('terminal.meta.hookLabel')}</span>{hook.text}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-redlog-text-dim">
        {tab.cwd && <span title={tab.cwdFull ?? tab.cwd}>{t('terminal.meta.cwd')} <span className="font-mono text-redlog-text">{tab.cwdFull ?? tab.cwd}</span></span>}
        {tab.alive && tab.pid > 0 && <span data-testid="terminal-meta-pid">PID <span className="font-mono text-redlog-text">{tab.pid}</span></span>}
        {tab.lastExit !== undefined && <span>{t('terminal.meta.exit')} <span className={`font-mono ${tab.lastExit === 0 ? 'text-emerald-400' : 'text-red-400'}`}>{tab.lastExit}</span></span>}
      </div>
    </div>
  )
}

function TerminalPane({ id, active, shellId, onPid, onCastState, onExit, onUnhooked, fontSize, onSearch, onSearchAddon }: {
  id: string
  active: boolean
  shellId?: string
  onPid: (pid: number) => void
  onCastState: (state: TerminalCastState) => void
  onExit: () => void
  onUnhooked: (shell: string | null) => void
  fontSize: number
  onSearch: () => void
  onSearchAddon: (addon: SearchAddon) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const { t } = useI18n()
  // Set only when this pane's shell takes no hook, i.e. its commands are not
  // being recorded. A capture gap has to be visible where the operator is
  // working, not just inferable from an empty timeline later.
  const [unhookedShell, setUnhookedShell] = useState<string | null>(null)
  const [recordingState, setRecordingState] = useState<TerminalCastState | null>(null)

  // Right-click menu. xterm keeps its selection in its own model rather than the
  // DOM, so Chromium's context-menu event fires with an empty selection here and
  // the main-process handler deliberately shows nothing — this pane asks for its
  // own menu instead. Same four actions the ⌘/Ctrl keybindings already expose,
  // now discoverable for operators who reach for the mouse.
  const showContextMenu = useCallback(async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    const term = termRef.current
    if (!term) return
    const hasSelection = term.hasSelection()
    const picked = await window.redlog.ui.contextMenu([
      { id: 'copy', label: t('terminal.ctxCopy'), enabled: hasSelection },
      { id: 'paste', label: t('terminal.ctxPaste') },
      { type: 'separator' },
      { id: 'selectAll', label: t('terminal.ctxSelectAll') },
      { id: 'clear', label: t('terminal.ctxClear') }
    ])
    if (picked === 'copy') {
      if (hasSelection) void writeClipboard(term.getSelection())
    } else if (picked === 'paste') {
      void readClipboard().then((txt) => { if (txt) window.redlog.terminal.write(id, txt) })
    } else if (picked === 'selectAll') {
      term.selectAll()
    } else if (picked === 'clear') {
      // Drops the scrollback and keeps the current prompt line, matching
      // Terminal.app's ⌘K rather than sending `clear` down the pty (which would
      // land in the log as a command the operator never ran).
      term.clear()
    }
  }, [id, t])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const retained = paneRuntimes.get(id)
    const term = retained?.term ?? new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize,
      // Prefer a Nerd Font if the operator has one installed, so powerline
      // separators and prompt glyphs render instead of showing as tofu.
      fontFamily: "'MesloLGS NF', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      lineHeight: 1.3,
      theme: {
        background: '#0a0a0a',
        foreground: '#d4d4d4',
        cursor: '#ef4444',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#ef444430',
        black: '#171717',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#d4d4d4',
        brightBlack: '#525252',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f5f5f5'
      },
      allowProposedApi: true,
      scrollback: 5000
    })

    const fitAddon = retained?.fit ?? new FitAddon()
    const searchAddon = retained?.search ?? new SearchAddon()
    if (!retained) { term.loadAddon(fitAddon); term.loadAddon(searchAddon) }

    // Native-feeling clipboard on macOS: ⌘C copies the selection when there
    // IS one, else falls through to xterm's default (which sends SIGINT).
    // ⌘V pastes clipboard text as if typed. Without this handler xterm on
    // macOS captures ⌘C as SIGINT unconditionally — audit finding #13.
    term.attachCustomKeyEventHandler((e) => {
      if (!(e.metaKey || e.ctrlKey) || e.type !== 'keydown') return true
      if (e.key === 'c' && term.hasSelection()) {
        void writeClipboard(term.getSelection())
        e.preventDefault()
        return false
      }
      if (e.key === 'v') {
        void readClipboard().then((txt) => { if (txt) window.redlog.terminal.write(id, txt) })
        e.preventDefault()
        return false
      }
      if (e.key === 'f') {
        // Trigger the shared search input at the top of the pane.
        onSearch()
        e.preventDefault()
        return false
      }
      return true
    })

    if (term.element) el.appendChild(term.element)
    else term.open(el)

    termRef.current = term
    fitRef.current = fitAddon
    searchRef.current = searchAddon
    onSearchAddon(searchAddon)

    const updateCastState = (state: TerminalCastState): void => { setRecordingState(state); onCastState(state) }
    const runtime: PaneRuntime = retained ?? {
      term, fit: fitAddon, search: searchAddon, alive: true, pid: 0,
      castState: null, unhookedShell: null, handlers: null, dispose: () => {}
    }
    runtime.handlers = { pid: onPid, state: updateCastState, exit: onExit, unhooked: (shell) => { setUnhookedShell(shell); onUnhooked(shell) } }
    if (!retained) {
      paneRuntimes.set(id, runtime)
      // Keep receiving output while detached. Only pane close/process exit
      // ends these subscriptions; remounting must not replay the IPC tail twice.
      const unsubData = window.redlog.terminal.onData(id, data => term.write(data))
      const unsubExit = window.redlog.terminal.onExit(id, () => {
        runtime.alive = false
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
        if (runtime.handlers) runtime.handlers.exit()
        else disposePaneRuntime(id)
      })
      const unsubCast = window.redlog.terminal.onCastState(id, state => {
        runtime.castState = state
        runtime.handlers?.state(state)
      })
      const input = term.onData(data => window.redlog.terminal.write(id, data))
      const resize = term.onResize(({ cols, rows }) => window.redlog.terminal.resize(id, cols, rows))
      runtime.dispose = () => { unsubData(); unsubExit(); unsubCast?.(); input.dispose(); resize.dispose(); term.dispose() }
    } else {
      onPid(runtime.pid)
      if (runtime.castState) updateCastState(runtime.castState)
      setUnhookedShell(runtime.unhookedShell)
      onUnhooked(runtime.unhookedShell)
      if (!runtime.alive) onExit()
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddon.fit() } catch {}
      })
    })
    resizeObserver.observe(el)

    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch {}
      if (retained) return
      window.redlog.terminal.spawn(id, term.cols || 80, term.rows || 24, shellId)
        .then(r => {
          runtime.pid = r.pid
          runtime.castState = r
          runtime.unhookedShell = r.hookSourced ? null : r.shell
          runtime.handlers?.pid(r.pid)
          runtime.handlers?.state(r)
          runtime.handlers?.unhooked(runtime.unhookedShell)
        })
        .catch(error => {
          runtime.alive = false
          runtime.castState = { recording: false, castTruncated: false, paused: false, recordingReason: 'recording-failed', recordingError: String(error) }
          runtime.handlers?.state(runtime.castState)
          runtime.handlers?.exit()
          if (!runtime.handlers) disposePaneRuntime(id)
        })
    })

    return () => {
      resizeObserver.disconnect()
      runtime.handlers = null
      if (!runtime.alive) disposePaneRuntime(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Live-apply font-size changes without recreating the terminal.
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    fitRef.current?.fit()
  }, [fontSize])

  useEffect(() => {
    if (active && fitRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          termRef.current?.focus()
        } catch {}
      })
    }
  }, [active])

  return (
    <div className="w-full h-full flex flex-col">
      {recordingState?.recordingReason && (
        <div role="status" data-testid="terminal-recording-gap" className="shrink-0 px-3 py-2 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
          {recordingState.recordingReason === 'no-project' ? t('terminal.noProjectRecording') : t('terminal.recordingFailed', { reason: recordingState.recordingError ?? '' })}
        </div>
      )}
      {unhookedShell && (
        <div
          role="status"
          data-testid="terminal-no-hook"
          className="shrink-0 flex items-start gap-2 px-3 py-1.5 border-b border-redlog-border bg-amber-500/12 text-xs text-redlog-text-dim"
        >
          <span className="text-amber-400 shrink-0" aria-hidden="true">⚠</span>
          <span>{t('terminal.noHook', { shell: unhookedShell.split(/[\\/]/).pop() ?? unhookedShell })}</span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0" onContextMenu={showContextMenu} />
    </div>
  )
}
