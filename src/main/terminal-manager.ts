import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { insertEvent } from '../core/db/events'
import { eventBus } from '../core/event-bus'
import { getProjectDir } from '../core/db/index'

interface TerminalSession {
  id: string
  pty: pty.IPty
  buffer: string
  lastActivity: number
  castPath: string | null
  castStream: fs.WriteStream | null
  castStart: number
  castBytes: number
  castTruncated: boolean
}

const sessions = new Map<string, TerminalSession>()
let mainWindow: BrowserWindow | null = null
let engagementId = ''
let operatorId = ''
let maxCastBytes = 50 * 1024 * 1024

export function setTerminalWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function configureTerminal(opts: { engagementId: string; operatorId: string; maxCastBytes?: number }): void {
  engagementId = opts.engagementId
  operatorId = opts.operatorId
  if (typeof opts.maxCastBytes === 'number' && opts.maxCastBytes > 0) maxCastBytes = opts.maxCastBytes
}

export function spawnTerminal(id: string, cols: number, rows: number): { pid: number } {
  if (sessions.has(id)) {
    return { pid: sessions.get(id)!.pty.pid }
  }
  if (!operatorId) {
    throw new Error('Terminal cannot spawn before configureTerminal() sets an operator identity')
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

  let castPath: string | null = null
  let castStream: fs.WriteStream | null = null
  const castStart = Date.now()
  try {
    const dir = path.join(getProjectDir(), 'casts')
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date(castStart).toISOString().replace(/[:.]/g, '-')
    castPath = path.join(dir, `${ts}_${id}.cast`)
    castStream = fs.createWriteStream(castPath)
    const header = {
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(castStart / 1000),
      env: { SHELL: shell, TERM: 'xterm-256color' },
      title: `redlog terminal ${id}`
    }
    castStream.write(JSON.stringify(header) + '\n')
  } catch {
    castPath = null
    castStream = null
  }

  const session: TerminalSession = {
    id,
    pty: term,
    buffer: '',
    lastActivity: Date.now(),
    castPath,
    castStream,
    castStart,
    castBytes: 0,
    castTruncated: false
  }

  term.onData((data: string) => {
    session.lastActivity = Date.now()
    session.buffer += data
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096)
    }
    if (session.castStream && !session.castTruncated) {
      const encoded = JSON.stringify([(session.lastActivity - session.castStart) / 1000, 'o', data]) + '\n'
      const chunkBytes = Buffer.byteLength(encoded)
      if (session.castBytes + chunkBytes > maxCastBytes) {
        try {
          session.castStream.write(JSON.stringify([(session.lastActivity - session.castStart) / 1000, 'o', `\r\n[redlog: cast truncated at ${maxCastBytes} bytes]\r\n`]) + '\n')
          session.castStream.end()
        } catch { /* */ }
        session.castStream = null
        session.castTruncated = true
      } else {
        try {
          session.castStream.write(encoded)
          session.castBytes += chunkBytes
        } catch { /* stream closed */ }
      }
    }
    mainWindow?.webContents.send(`terminal:data:${id}`, data)
  })

  term.onExit(({ exitCode }) => {
    let castSha256: string | null = null
    if (session.castStream) {
      try { session.castStream.end() } catch { /* */ }
    }
    if (session.castPath) {
      try {
        const hasher = crypto.createHash('sha256')
        hasher.update(fs.readFileSync(session.castPath))
        castSha256 = hasher.digest('hex')
      } catch { castSha256 = null }
    }
    const event = insertEvent('shell', {
      subtype: 'session_end',
      source: 'builtin-terminal',
      terminalId: id,
      exitCode,
      pid: term.pid,
      castPath: session.castPath,
      castSha256,
      castBytes: session.castBytes,
      castTruncated: session.castTruncated,
      durationMs: Date.now() - session.castStart
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
    pid: term.pid,
    castPath
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
