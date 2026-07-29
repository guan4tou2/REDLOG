import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'

interface Tab {
  id: string
  label: string
  pid: number
  alive: boolean
}

let tabCounter = 0

export default function TerminalView(): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const { t } = useI18n()

  const addTab = useCallback(() => {
    const id = `term-${Date.now()}-${++tabCounter}`
    const label = `${t('terminal.shell')} ${tabs.length + 1}`
    const tab: Tab = { id, label, pid: 0, alive: true }
    setTabs((prev) => [...prev, tab])
    setActiveTab(id)
  }, [tabs.length, t])

  const closeTab = useCallback((id: string) => {
    window.redlog.terminal.kill(id)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTab === id) {
        setActiveTab(next.length > 0 ? next[next.length - 1].id : null)
      }
      return next
    })
  }, [activeTab])

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return   // StrictMode runs this twice in dev
    didInit.current = true
    if (tabs.length === 0) addTab()
  }, [])

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Tab bar */}
      <div className="flex items-center h-9 bg-redlog-bg border-b border-redlog-border px-1 shrink-0 gap-0.5">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`group flex items-center gap-1.5 px-3 h-7 rounded-md text-[11px] cursor-pointer transition-colors ${
              activeTab === tab.id
                ? 'bg-[#1a1a1a] text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.alive ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
            <span className="truncate max-w-[100px]">{tab.label}</span>
            {tab.pid > 0 && (
              <span className="text-[9px] text-zinc-600 font-mono">{tab.pid}</span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={addTab}
          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors text-sm"
          title={t('terminal.newTab')}
        >
          +
        </button>
      </div>

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
              onPid={(pid) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, pid } : t))}
              onExit={() => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, alive: false } : t))}
            />
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

function TerminalPane({ id, active, onPid, onExit }: {
  id: string
  active: boolean
  onPid: (pid: number) => void
  onExit: () => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
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
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon

    // Subscribe to pty output BEFORE spawning, so the buffer the main process
    // replays for an existing session lands in this fresh term.
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
  }, [id])

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
