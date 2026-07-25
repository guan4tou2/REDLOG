import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalPanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
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
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const { cols, rows } = term
    window.redlog.terminal.create(cols, rows).then((id) => {
      sessionRef.current = id
      setConnected(true)

      term.onData((data) => {
        window.redlog.terminal.write(id, data)
      })
    })

    const unsubData = window.redlog.terminal.onData((_id, data) => {
      term.write(data)
    })

    const unsubExit = window.redlog.terminal.onExit((_id, _code) => {
      setConnected(false)
      term.writeln('\r\n\x1b[90m[Session ended]\x1b[0m')
    })

    const onResize = () => {
      fit.fit()
      if (sessionRef.current) {
        window.redlog.terminal.resize(sessionRef.current, term.cols, term.rows)
      }
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)

    return () => {
      unsubData()
      unsubExit()
      resizeObserver.disconnect()
      if (sessionRef.current) {
        window.redlog.terminal.destroy(sessionRef.current)
      }
      term.dispose()
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-redlog-border shrink-0">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-neutral-600'}`} />
        <span className="text-xs text-neutral-400">Terminal</span>
        {!connected && (
          <button
            onClick={() => {
              const term = termRef.current
              if (!term) return
              const fit = fitRef.current
              fit?.fit()
              window.redlog.terminal.create(term.cols, term.rows).then((id) => {
                sessionRef.current = id
                setConnected(true)
                term.clear()
                term.onData((data) => {
                  window.redlog.terminal.write(id, data)
                })
              })
            }}
            className="text-xs text-redlog-accent hover:text-red-300 ml-auto"
          >
            New Session
          </button>
        )}
      </div>
      <div ref={containerRef} className="flex-1 px-1" />
    </div>
  )
}
