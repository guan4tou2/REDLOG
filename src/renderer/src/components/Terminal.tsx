import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TabInfo {
  id: string
  sessionId: string | null
  term: XTerm
  fit: FitAddon
  container: HTMLDivElement
  connected: boolean
}

const TERM_OPTS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  theme: {
    background: '#0a0a0a',
    foreground: '#e5e5e5',
    cursor: '#ef4444',
    selectionBackground: '#ef444440',
    black: '#171717',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#e5e5e5'
  },
  allowProposedApi: true
} as const

let tabCounter = 0

export default function TerminalPanel(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<Map<string, TabInfo>>(new Map())
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [tabList, setTabList] = useState<Array<{ id: string; connected: boolean }>>([])

  const syncTabList = useCallback(() => {
    const tabs = Array.from(tabsRef.current.values()).map((t) => ({
      id: t.id,
      connected: t.connected
    }))
    setTabList(tabs)
  }, [])

  const createTab = useCallback(() => {
    const host = hostRef.current
    if (!host) return

    const id = `tab-${++tabCounter}`
    const container = document.createElement('div')
    container.style.cssText = 'position:absolute;inset:0;display:none;'
    host.appendChild(container)

    const term = new XTerm(TERM_OPTS)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    const tab: TabInfo = { id, sessionId: null, term, fit, container, connected: false }
    tabsRef.current.set(id, tab)

    fit.fit()
    const { cols, rows } = term
    window.redlog.terminal.create(cols, rows).then((sessionId) => {
      tab.sessionId = sessionId
      tab.connected = true
      syncTabList()
      term.onData((data) => {
        if (tab.sessionId) window.redlog.terminal.write(tab.sessionId, data)
      })
    })

    setActiveTab(id)
    syncTabList()
  }, [syncTabList])

  const closeTab = useCallback((id: string) => {
    const tab = tabsRef.current.get(id)
    if (!tab) return
    if (tab.sessionId) window.redlog.terminal.destroy(tab.sessionId)
    tab.term.dispose()
    tab.container.remove()
    tabsRef.current.delete(id)

    if (activeTab === id) {
      const remaining = Array.from(tabsRef.current.keys())
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1] : null)
    }
    syncTabList()
  }, [activeTab, syncTabList])

  useEffect(() => {
    if (!activeTab) return
    tabsRef.current.forEach((tab) => {
      tab.container.style.display = tab.id === activeTab ? 'block' : 'none'
    })
    const active = tabsRef.current.get(activeTab)
    if (active) {
      requestAnimationFrame(() => {
        active.fit.fit()
        active.term.focus()
      })
    }
  }, [activeTab])

  useEffect(() => {
    const unsubData = window.redlog.terminal.onData((sessionId, data) => {
      tabsRef.current.forEach((tab) => {
        if (tab.sessionId === sessionId) tab.term.write(data)
      })
    })
    const unsubExit = window.redlog.terminal.onExit((sessionId) => {
      tabsRef.current.forEach((tab) => {
        if (tab.sessionId === sessionId) {
          tab.connected = false
          tab.term.writeln('\r\n\x1b[90m[Session ended]\x1b[0m')
          syncTabList()
        }
      })
    })
    return () => { unsubData(); unsubExit() }
  }, [syncTabList])

  useEffect(() => {
    if (tabsRef.current.size === 0) createTab()
  }, [createTab])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      if (!activeTab) return
      const tab = tabsRef.current.get(activeTab)
      if (!tab) return
      tab.fit.fit()
      if (tab.sessionId) window.redlog.terminal.resize(tab.sessionId, tab.term.cols, tab.term.rows)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [activeTab])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b border-redlog-border shrink-0 overflow-x-auto">
        {tabList.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-zinc-800 min-w-0 ${
              activeTab === t.id ? 'bg-zinc-800/50 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
            }`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.connected ? 'bg-green-500' : 'bg-zinc-600'}`} />
            <span className="truncate">{t.id.replace('tab-', 'Term ')}</span>
            {tabList.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}
                className="text-zinc-600 hover:text-red-400 ml-1 shrink-0"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          onClick={createTab}
          className="px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 shrink-0"
          title="New terminal tab"
        >
          +
        </button>
      </div>
      <div ref={hostRef} className="flex-1 relative px-1" />
    </div>
  )
}

export function getTerminalTabCount(): number {
  return tabCounter
}
