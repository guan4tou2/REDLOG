import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'
import { toast, UNDO_MS } from './Toast'

interface Tab {
  id: string
  label: string
  pid: number
  alive: boolean
  // cwd basename + last-command exit code — audit #16. Both come from the
  // shell hook via `redlog:` OSC 6 escapes that xterm.js dispatches; we set
  // them from TerminalPane so the tab bar shows where a shell is + whether
  // the last thing that ran failed.
  cwd?: string
  lastExit?: number
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
    const id = `term-${Date.now()}-${n}`
    // Monotonic counter — using tabs.length + 1 caused collisions after close
    // ("Shell 2" reused if tab 3 was closed before adding a new one). Audit P1 #16.
    const label = `${t('terminal.shell')} ${n}`
    const tab: Tab = { id, label, pid: 0, alive: true }
    setTabs((prev) => [...prev, tab])
    setActiveTab(id)
  }, [t])

  const closeTab = useCallback(async (id: string) => {
    // Terminal panes host live PTY sessions (with shell hook capturing every
    // command), so closing one kills a child process and loses interactive
    // state. That used to raise a confirm dialog on every close (audit P1
    // #17), which is the wrong grade for it: §5.5 puts a dialog on the
    // irreversible and this is not — the tab reopens in the same cwd. Close
    // it, say so, and offer the way back for eight seconds.
    const tab = tabs.find((t) => t.id === id)
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
      action: { label: t('toast.undo'), onClick: () => addTab() },
      duration: UNDO_MS
    })
  }, [activeTab, tabs, t, addTab])

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return   // StrictMode runs this twice in dev
    didInit.current = true
    if (tabs.length === 0) addTab()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watch shell events → update tab cwd + last exit code (audit #16). Every
  // command_end from a builtin terminal carries source + terminalId + exit +
  // cwd; we match by terminalId and stamp the label. Cheap because command_end
  // is at most one per prompt.
  useEffect(() => {
    return window.redlog.events.onNew((evt) => {
      if (evt.agentType !== 'shell') return
      const d = evt.data as { subtype?: string; source?: string; terminalId?: string; cwd?: string; exit_code?: number }
      if (d.source !== 'builtin-terminal' || d.subtype !== 'command_end' || !d.terminalId) return
      setTabs((prev) => prev.map((tab) => tab.id === d.terminalId
        // Split on either separator so a Windows `C:\Users\foo\proj` doesn't
        // render as one giant tab label. Audit P1-3 (WINDOWS_COMPAT_AUDIT.md).
        ? { ...tab, cwd: d.cwd?.split(/[\\/]/).pop() || tab.cwd, lastExit: d.exit_code }
        : tab))
    })
  }, [])

  // Tab-nav shortcuts scoped to the Terminal view. Audit finding #78: ⌘T new,
  // ⌘W close active, ⌘⇧] next, ⌘⇧[ prev. Bound at window scope but active
  // only while this component is mounted (view === 'terminal' in App.tsx).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const cmd = e.ctrlKey || e.metaKey
      if (!cmd) return
      if (e.key === 't' && !e.shiftKey && !e.altKey) { e.preventDefault(); addTab() }
      else if (e.key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (activeTab) closeTab(activeTab)
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
  }, [activeTab, addTab, closeTab])

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
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
            <span className={`truncate max-w-[100px] ${tab.alive ? '' : 'italic text-redlog-text-faint'}`}>{tab.label}</span>
            {tab.cwd && tab.alive && (
              <span className="text-xs font-mono text-redlog-text-dim truncate max-w-[80px]" title={tab.cwd}>~/{tab.cwd}</span>
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
            {!tab.alive && (
              <button
                onClick={(e) => {
                  // Restart in place: swap the tab's id for a fresh one — React
                  // unmounts the dead TerminalPane and mounts a new one at the
                  // same slot with a new pty session. Preserves label + tab
                  // order + active-tab focus. Audit finding #12.
                  e.stopPropagation()
                  const newId = `term-${Date.now()}-r${++tabCounter}`
                  setTabs((prev) => prev.map((tb) => tb.id === tab.id ? { ...tb, id: newId, pid: 0, alive: true } : tb))
                  if (activeTab === tab.id) setActiveTab(newId)
                  // Clean up the dead pane's search-addon ref
                  paneSearchRefs.current.delete(tab.id)
                }}
                className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-emerald-500/70 hover:text-emerald-400 hover:bg-emerald-950/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                title={t('terminal.restart')}
                aria-label={t('terminal.restart')}
              >↻</button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-redlog-elevated-hover opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim transition-opacity"
              title={t('terminal.closeTitle')}
              aria-label={t('terminal.closeTitle')}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={addTab}
          className="w-7 h-7 rounded-md flex items-center justify-center text-redlog-text-faint hover:text-redlog-text hover:bg-white/[0.03] transition-colors text-sm"
          title={t('terminal.newTab')}
          aria-label={t('terminal.newTab')}
        >
          +
        </button>

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
            title={t('terminal.searchToggle')}
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
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              const addon = activeTab ? paneSearchRefs.current.get(activeTab) : null
              if (!addon) return
              if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? addon.findPrevious(searchQuery) : addon.findNext(searchQuery) }
              if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); setSearchQuery('') }
            }}
            placeholder={t('terminal.searchPlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500/40"
          />
          <button
            onClick={() => { const a = activeTab ? paneSearchRefs.current.get(activeTab) : null; a?.findPrevious(searchQuery) }}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
            title={t('terminal.searchPrev')}
            aria-label={t('terminal.searchPrev')}
          >↑</button>
          <button
            onClick={() => { const a = activeTab ? paneSearchRefs.current.get(activeTab) : null; a?.findNext(searchQuery) }}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
            title={t('terminal.searchNext')}
            aria-label={t('terminal.searchNext')}
          >↓</button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery('') }}
            className="w-6 h-6 rounded text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05]"
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
            <TerminalPane
              id={tab.id}
              active={activeTab === tab.id}
              fontSize={fontSize}
              onSearch={() => setSearchOpen(true)}
              onPid={(pid) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, pid } : t))}
              onExit={() => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, alive: false } : t))}
              onSearchAddon={(addon) => { paneSearchRefs.current.set(tab.id, addon) }}
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <button
              onClick={addTab}
              className="px-4 py-2 rounded-lg bg-redlog-elevated text-redlog-text-dim text-sm hover:bg-redlog-elevated-hover hover:text-redlog-text transition-colors"
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
  const { t } = useI18n()

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
      if (hasSelection) navigator.clipboard.writeText(term.getSelection()).catch(() => {})
    } else if (picked === 'paste') {
      navigator.clipboard.readText().then((txt) => window.redlog.terminal.write(id, txt)).catch(() => {})
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

  return <div ref={containerRef} className="w-full h-full" onContextMenu={showContextMenu} />
}
