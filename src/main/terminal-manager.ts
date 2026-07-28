import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'os'
import { insertEvent } from '../core/db/events'
import { eventBus } from '../core/event-bus'

interface TerminalSession {
  id: string
  pty: pty.IPty
  buffer: string
  lastActivity: number
}

const sessions = new Map<string, TerminalSession>()
let mainWindow: BrowserWindow | null = null
let engagementId = ''
let operatorId = ''

export function setTerminalWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function configureTerminal(opts: { engagementId: string; operatorId: string }): void {
  engagementId = opts.engagementId
  operatorId = opts.operatorId
}

export function spawnTerminal(id: string, cols: number, rows: number): { pid: number } {
  if (sessions.has(id)) {
    return { pid: sessions.get(id)!.pty.pid }
  }

  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
  const cwd = process.env.HOME || os.homedir()

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      REDLOG_TERMINAL: '1'
    } as Record<string, string>
  })

  const session: TerminalSession = {
    id,
    pty: term,
    buffer: '',
    lastActivity: Date.now()
  }

  term.onData((data: string) => {
    session.lastActivity = Date.now()
    session.buffer += data
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096)
    }
    mainWindow?.webContents.send(`terminal:data:${id}`, data)
  })

  term.onExit(({ exitCode }) => {
    const event = insertEvent('shell', {
      subtype: 'session_end',
      source: 'builtin-terminal',
      terminalId: id,
      exitCode,
      pid: term.pid
    }, { engagementId, operatorId })
    if (event) eventBus.publish(event)
    sessions.delete(id)
    mainWindow?.webContents.send(`terminal:exit:${id}`, exitCode)
  })

  sessions.set(id, session)

  const event = insertEvent('shell', {
    subtype: 'session_start',
    source: 'builtin-terminal',
    terminalId: id,
    shell,
    pid: term.pid
  }, { engagementId, operatorId })
  if (event) eventBus.publish(event)

  return { pid: term.pid }
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try {
    sessions.get(id)?.pty.resize(cols, rows)
  } catch {}
}

export function killTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  try {
    session.pty.kill()
  } catch {}
  sessions.delete(id)
}

export function listTerminals(): Array<{ id: string; pid: number; lastActivity: number }> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    pid: s.pty.pid,
    lastActivity: s.lastActivity
  }))
}

export function killAllTerminals(): void {
  for (const session of sessions.values()) {
    try { session.pty.kill() } catch {}
  }
  sessions.clear()
}
