import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'
import { confirm } from './ConfirmDialog'
import { ICON } from '../lib/icons'
import { SplitPane } from './SplitPane'

// A single shell = one pty session (id) + its live state. cwd basename +
// last-command exit code come from the shell hook via `redlog:` OSC 6 escapes
// that xterm.js dispatches (audit #16).
interface Pane {
  id: string
  pid: number
  alive: boolean
  cwd?: string
  lastExit?: number
}

// A tab holds 1..N panes shown side by side (horizontal split). The tab's `id`
// is a stable identity separate from any pty, so restarting a dead pane (which
// swaps the pty id) never reshuffles tabs. `activePaneId` is the pane that
// search / font-size / focus act on.
interface Tab {
  id: string
  label: string
  panes: Pane[]
  activePaneId: string
}

let tabCounter = 0

const FONT_SIZE_KEY = 'redlog-terminal-fontsize'
const DEFAULT_FONT_SIZE = 13

export default function TerminalView(): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  // Persist font-size across sessions; ⌘+ / ⌘- adjust it live.
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '')
    return Number.isFinite(saved) && saved >= 8 && saved <= 32 ? saved : DEFAULT_FONT_SIZE
  })
  useEffect(() => { localStorage.setItem(FONT_SIZE_KEY, String(fontSize)) }, [fontSize])
  // In-buffer search (per active pane): the input toggles + a small state
  // holds the current query. Enter → next match, Shift+Enter → previous.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const paneSearchRefs = useRef<Map<string, SearchAddon>>(new Map())
  const { t } = useI18n()

  const addTab = useCallback(() => {
    const n = ++tabCounter
    // Monotonic counter — using tabs.length + 1 caused collisions after close
    // ("Shell 2" reused if tab 3 was closed before adding a new one). Audit P1 #16.
    const paneId = `term-${Date.now()}-${n}`
    const label = `${t('terminal.shell')} ${n}`
    const tab: Tab = { id: `tab-${Date.now()}-${n}`, label, panes: [{ id: paneId, pid: 0, alive: true }], activePaneId: paneId }
    setTabs((prev) => [...prev, tab])
    setActiveTab(tab.id)
  }, [t])

  // Split the active tab horizontally: add a second pane with its own pty.
  // Capped at 2 — enough to "watch one shell while driving another"; more panes
  // would need nested SplitPanes.
  const splitActive = useCallback(() => {
    setTabs((prev) => prev.map((tb) => {
      if (tb.id !== activeTab || tb.panes.length >= 2) return tb
      const paneId = `term-${Date.now()}-${++tabCounter}`
      return { ...tb, panes: [...tb.panes, { id: paneId, pid: 0, alive: true }], activePaneId: paneId }
    }))
  }, [activeTab])

  // Terminal panes host live PTY sessions (shell hook capturing every command);
  // closing kills the child process and loses interactive state, so confirm a
  // live pane (audit P1 #17). Closing a tab's last pane drops the tab.
  const closePane = useCallback(async (tabId: string, paneId: string) => {
    const tab = tabs.find((tb) => tb.id === tabId)
    if (!tab) return
    const pane = tab.panes.find((p) => p.id === paneId)
    if (pane?.alive) {
      const ok = await confirm(t('terminal.closeTitle'), t('terminal.closeConfirm', { label: tab.label }), true)
      if (!ok) return
    }
    window.redlog.terminal.kill(paneId)
    paneSearchRefs.current.delete(paneId)
    setTabs((prev) => {
      const next = prev.flatMap((tb) => {
        if (tb.id !== tabId) return [tb]
        const panes = tb.panes.filter((p) => p.id !== paneId)
        if (panes.length === 0) return []
        return [{ ...tb, panes, activePaneId: tb.activePaneId === paneId ? panes[panes.length - 1].id : tb.activePaneId }]
      })
      if (!next.some((tb) => tb.id === activeTab)) setActiveTab(next.length ? next[next.length - 1].id : null)
      return next
    })
  }, [tabs, activeTab, t])

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((tb) => tb.id === tabId)
    if (!tab) return
    if (tab.panes.some((p) => p.alive)) {
      const ok = await confirm(t('terminal.closeTitle'), t('terminal.closeConfirm', { label: tab.label }), true)
      if (!ok) return
    }
    tab.panes.forEach((p) => { window.redlog.terminal.kill(p.id); paneSearchRefs.current.delete(p.id) })
    setTabs((prev) => {
      const next = prev.filter((tb) => tb.id !== tabId)
      if (activeTab === tabId) setActiveTab(next.length ? next[next.length - 1].id : null)
      return next
    })
  }, [tabs, activeTab, t])

  // Restart a dead pane in place: swap its pty id for a fresh one so React
  // remounts a new TerminalPane at the same slot (audit #12), keeping tab order.
  const restartPane = useCallback((tabId: string, paneId: string) => {
    const newId = `term-${Date.now()}-r${++tabCounter}`
    paneSearchRefs.current.delete(paneId)
    setTabs((prev) => prev.map((tb) => tb.id !== tabId ? tb : {
      ...tb,
      panes: tb.panes.map((p) => p.id === paneId ? { id: newId, pid: 0, alive: true } : p),
      activePaneId: tb.activePaneId === paneId ? newId : tb.activePaneId
    }))
  }, [])

  const setActivePane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) => prev.map((tb) => tb.id === tabId && tb.activePaneId !== paneId ? { ...tb, activePaneId: paneId } : tb))
  }, [])

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return   // StrictMode runs this twice in dev
    didInit.current = true
    if (tabs.length === 0) addTab()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watch shell events → update the matching pane's cwd + last exit code
  // (audit #16). Every command_end from a builtin terminal carries source +
  // terminalId + exit + cwd; match the pane by terminalId across all tabs.
  useEffect(() => {
    return window.redlog.events.onNew((evt) => {
      if (evt.agentType !== 'shell') return
      const d = evt.data as { subtype?: string; source?: string; terminalId?: string; cwd?: string; exit_code?: number }
      if (d.source !== 'builtin-terminal' || d.subtype !== 'command_end' || !d.terminalId) return
      setTabs((prev) => prev.map((tab) => ({
        ...tab,
        panes: tab.panes.map((p) => p.id === d.terminalId
          // Split on either separator so a Windows `C:\Users\foo\proj` doesn't
          // render as one giant label. Audit P1-3 (WINDOWS_COMPAT_AUDIT.md).
          ? { ...p, cwd: d.cwd?.split(/[\\/]/).pop() || p.cwd, lastExit: d.exit_code }
          : p)
      })))
    })
  }, [])

  // Tab/pane shortcuts scoped to the Terminal view. ⌘T new tab, ⌘D split,
  // ⌘W close active pane (drops the tab if last), ⌘⇧] / ⌘⇧[ next/prev tab.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const cmd = e.ctrlKey || e.metaKey
      if (!cmd) return
      if (e.key === 't' && !e.shiftKey && !e.altKey) { e.preventDefault(); addTab() }
      else if (e.key === 'd' && !e.shiftKey && !e.altKey) { e.preventDefault(); splitActive() }
      else if (e.key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        const tab = tabs.find((tb) => tb.id === activeTab)
        if (tab) closePane(tab.id, tab.activePaneId)
      }
      else if (e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault()
        setTabs((prev) => { const i = prev.findIndex((t) => t.id === activeTab); if (i >= 0 && prev.length > 1) setActiveTab(prev[(i + 1) % prev.length].id); return prev })
      }
      else if (e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault()
        setTabs((prev) => { const i = prev.findIndex((t) => t.id === activeTab); if (i >= 0 && prev.length > 1) setActiveTab(prev[(i - 1 + prev.length) % prev.length].id); return prev })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, addTab, splitActive, closePane, tabs])

  const activeTabObj = tabs.find((tb) => tb.id === activeTab)
  const activePaneId = activeTabObj?.activePaneId ?? null
  const canSplit = (activeTabObj?.panes.length ?? 0) === 1

  // One pane slot: the xterm, kept mounted even when dead (so its final output
  // stays readable) with a restart overlay; plus a close-pane control and an
  // active-pane ring when the tab is split. A mousedown makes this the pane that
  // search / font-size act on.
  const renderPaneSlot = (tab: Tab, pane: Pane, isSplit: boolean): JSX.Element => {
    const isActivePane = activeTab === tab.id && tab.activePaneId === pane.id
    return (
      <div
        className={`group relative h-full w-full ${isSplit && isActivePane ? 'ring-1 ring-inset ring-cyan-500/25' : ''}`}
        onMouseDown={() => setActivePane(tab.id, pane.id)}
      >
        <TerminalPane
          key={pane.id}
          id={pane.id}
          active={isActivePane}
          fontSize={fontSize}
          onSearch={() => setSearchOpen(true)}
          onPid={(pid) => setTabs((prev) => prev.map((tb) => tb.id === tab.id ? { ...tb, panes: tb.panes.map((p) => p.id === pane.id ? { ...p, pid } : p) } : tb))}
          onExit={() => setTabs((prev) => prev.map((tb) => tb.id === tab.id ? { ...tb, panes: tb.panes.map((p) => p.id === pane.id ? { ...p, alive: false } : p) } : tb))}
          onSearchAddon={(addon) => { paneSearchRefs.current.set(pane.id, addon) }}
        />
        {!pane.alive && (
          <button
            onClick={(e) => { e.stopPropagation(); restartPane(tab.id, pane.id) }}
            className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded bg-zinc-800/90 text-emerald-400/90 text-xs hover:bg-zinc-700 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
            title={t('terminal.restart')}
          >↻ {t('terminal.restart')}</button>
        )}
        {isSplit && (
          <button
            onClick={(e) => { e.stopPropagation(); closePane(tab.id, pane.id) }}
            className="absolute top-1 right-1 z-10 w-4 h-4 rounded flex items-center justify-center bg-zinc-900/70 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 transition-opacity hit-target"
            title={t('terminal.closePane')}
            aria-label={t('terminal.closePane')}
          >×</button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Tab bar */}
      <div className="flex items-center h-9 bg-redlog-bg border-b border-redlog-border px-1 shrink-0 gap-0.5">
        {tabs.map((tab) => {
          // The tab bar reads the ACTIVE pane's live state; the dot is green if
          // ANY pane is alive. A ◫N badge shows a split tab's pane count.
          const activePane = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
          const tabAlive = tab.panes.some((p) => p.alive)
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`group flex items-center gap-1.5 px-3 h-7 rounded-md text-[11px] cursor-pointer transition-colors ${
                activeTab === tab.id
                  ? 'bg-[#1a1a1a] text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tabAlive ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
              <span className={`truncate max-w-[100px] ${tabAlive ? '' : 'italic text-zinc-600'}`}>{tab.label}</span>
              {tab.panes.length > 1 && (
                <span className="text-2xs font-mono text-zinc-500 shrink-0" title={t('terminal.split')}>◫{tab.panes.length}</span>
              )}
              {activePane?.cwd && activePane.alive && (
                <span className="text-xs font-mono text-zinc-500 truncate max-w-[80px]" title={activePane.cwd}>~/{activePane.cwd}</span>
              )}
              {activePane?.alive && activePane.lastExit !== undefined && activePane.lastExit !== 0 && (
                <span
                  className="text-[11px] font-mono text-red-400 bg-red-500/10 px-1 rounded"
                  title={t('terminal.lastExit', { code: activePane.lastExit })}
                >✕{activePane.lastExit}</span>
              )}
              {activePane && activePane.pid > 0 && activePane.alive && (
                <span className="text-[11px] text-zinc-600 font-mono">{activePane.pid}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 transition-opacity hit-target"
                title={t('terminal.closeTitle')}
                aria-label={t('terminal.closeTitle')}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          onClick={addTab}
          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors text-sm"
          title={t('terminal.newTab')}
          aria-label={t('terminal.newTab')}
        >
          +
        </button>
        <button
          onClick={splitActive}
          disabled={!canSplit}
          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors text-sm disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-600"
          title={`${t('terminal.split')} · ${navigator.platform?.includes('Mac') ? '⌘D' : 'Ctrl+D'}`}
          aria-label={t('terminal.split')}
        >
          ◫
        </button>

        {/* Font-size + search on the right — audit findings #14 (SearchAddon)
            and #15 (font size adjustable). */}
        <div className="ml-auto flex items-center gap-1 pr-1">
          <button
            onClick={() => setFontSize((s) => Math.max(8, s - 1))}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('terminal.fontSmaller')}
            aria-label={t('terminal.fontSmaller')}
          >A−</button>
          <span className="text-xs text-zinc-600 font-mono tabular-nums w-6 text-center">{fontSize}</span>
          <button
            onClick={() => setFontSize((s) => Math.min(32, s + 1))}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('terminal.fontLarger')}
            aria-label={t('terminal.fontLarger')}
          >A+</button>
          <button
            onClick={() => setSearchOpen((s) => !s)}
            className={`w-6 h-6 rounded flex items-center justify-center hover:bg-white/[0.03] text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${searchOpen ? 'text-zinc-200 bg-white/[0.05]' : 'text-zinc-600 hover:text-zinc-300'}`}
            title={t('terminal.searchToggle')}
            aria-label={t('terminal.searchToggle')}
          >{ICON.search}</button>
        </div>
      </div>

      {/* Search bar (visible when toggled) */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-2 py-1 border-b border-redlog-border bg-[#0f0f0f]">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              const addon = activePaneId ? paneSearchRefs.current.get(activePaneId) : null
              if (!addon) return
              if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? addon.findPrevious(searchQuery) : addon.findNext(searchQuery) }
              if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); setSearchQuery('') }
            }}
            placeholder={t('terminal.searchPlaceholder')}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500/40"
          />
          <button
            onClick={() => { const a = activePaneId ? paneSearchRefs.current.get(activePaneId) : null; a?.findPrevious(searchQuery) }}
            className="w-6 h-6 rounded text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] hit-target"
            title={t('terminal.searchPrev')}
            aria-label={t('terminal.searchPrev')}
          >↑</button>
          <button
            onClick={() => { const a = activePaneId ? paneSearchRefs.current.get(activePaneId) : null; a?.findNext(searchQuery) }}
            className="w-6 h-6 rounded text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] hit-target"
            title={t('terminal.searchNext')}
            aria-label={t('terminal.searchNext')}
          >↓</button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery('') }}
            className="w-6 h-6 rounded text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] hit-target"
            title={t('terminal.searchClose')}
            aria-label={t('terminal.searchClose')}
          >×</button>
        </div>
      )}

      {/* Terminal panes */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: activeTab === tab.id ? 'block' : 'none' }}
          >
            {tab.panes.length === 1 ? (
              renderPaneSlot(tab, tab.panes[0], false)
            ) : (
              <SplitPane id={`terminal-split-${tab.id}`} direction="horizontal" defaultSize={0.5} min={200} max={5000} otherMin={200}>
                {renderPaneSlot(tab, tab.panes[0], true)}
                {renderPaneSlot(tab, tab.panes[1], true)}
              </SplitPane>
            )}
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <button
              onClick={addTab}
              className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-sm hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
            >
              {t('terminal.newTab')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TerminalPane({ id, active, onPid, onExit, fontSize, onSearch, onSearchAddon }: {
  id: string
  active: boolean
  onPid: (pid: number) => void
  onExit: () => void
  fontSize: number
  onSearch: () => void
  onSearchAddon: (addon: SearchAddon) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // Recreate the xterm on every mount. StrictMode (dev) mounts→unmounts→
    // mounts; the cleanup disposes the term, so we must rebuild it — a guard
    // that skipped recreation left a disposed, blank terminal. The pty side is
    // idempotent: spawnTerminal returns the existing session and replays its
    // buffer, so the fresh term catches up on the shell prompt.
    const term = new Terminal({
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

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)

    // Native-feeling clipboard on macOS: ⌘C copies the selection when there
    // IS one, else falls through to xterm's default (which sends SIGINT).
    // ⌘V pastes clipboard text as if typed. Without this handler xterm on
    // macOS captures ⌘C as SIGINT unconditionally — audit finding #13.
    term.attachCustomKeyEventHandler((e) => {
      if (!(e.metaKey || e.ctrlKey) || e.type !== 'keydown') return true
      if (e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        e.preventDefault()
        return false
      }
      if (e.key === 'v') {
        navigator.clipboard.readText().then((t) => window.redlog.terminal.write(id, t)).catch(() => {})
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

    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon
    searchRef.current = searchAddon
    onSearchAddon(searchAddon)

    // Subscribe to pty output BEFORE spawning, so the buffer the main process
    // replays for an existing session lands in this fresh term. Per-command
    // logging is handled by the shell hook (command_start/command_end) — the
    // full session is also recorded to the tamper-evident .cast.
    const unsubData = window.redlog.terminal.onData(id, (data) => {
      term.write(data)
    })
    const unsubExit = window.redlog.terminal.onExit(id, () => {
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
      onExit()
    })
    const dispInput = term.onData((data) => {
      window.redlog.terminal.write(id, data)
    })
    const dispResize = term.onResize(({ cols, rows }) => {
      window.redlog.terminal.resize(id, cols, rows)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddon.fit() } catch {}
      })
    })
    resizeObserver.observe(el)

    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch {}
      window.redlog.terminal.spawn(id, term.cols || 80, term.rows || 24)
        .then(({ pid }) => onPid(pid))
        .catch(() => {})
    })

    return () => {
      resizeObserver.disconnect()
      unsubData()
      unsubExit()
      dispInput.dispose()
      dispResize.dispose()
      term.dispose()
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

  return <div ref={containerRef} className="w-full h-full" />
}
