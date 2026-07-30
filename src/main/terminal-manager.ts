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
  finalised: boolean
  // Per-command output buffer (audit — record full stdout so post-mortem can
  // trace what actually printed, not just exit code). Starts fresh on
  // command_start and gets attached to the matching command_end event; the
  // API server pulls it out via takeCommandOutput() and runs it through
  // redaction/spans just like external hook-sent output.
  cmdBuffer: string
  cmdBufferBytes: number
}

// Writes the session_end event (with the cast's SHA-256) exactly once.
// pty.kill() delivers onExit asynchronously, so on app quit this must be
// called while the DB is still open — otherwise the event, and with it the
// recording's integrity hash, is lost and insertEvent throws into the void.
function finaliseSession(session: TerminalSession, exitCode: number): void {
  if (session.finalised) return
  session.finalised = true

  if (session.castStream) {
    try { session.castStream.end() } catch { /* already closed */ }
    session.castStream = null
  }

  let castSha256: string | null = null
  if (session.castPath) {
    try {
      castSha256 = crypto.createHash('sha256').update(fs.readFileSync(session.castPath)).digest('hex')
    } catch { castSha256 = null }
  }

  try {
    const event = insertEvent('shell', {
      subtype: 'session_end',
      source: 'builtin-terminal',
      terminalId: session.id,
      exitCode,
      pid: session.pty.pid,
      castPath: session.castPath,
      castSha256,
      castBytes: session.castBytes,
      castTruncated: session.castTruncated,
      durationMs: Date.now() - session.castStart
    }, { engagementId, operatorId })
    if (event) eventBus.publish(event)
  } catch { /* project already closed — nothing left to record into */ }
}

function resolveShellHook(shell: string): string | null {
  const candidates = [
    path.join(__dirname, '../../../hooks'),
    path.join(__dirname, '../../hooks')
  ]
  const dir = candidates.find(d => fs.existsSync(d))
  if (!dir) return null
  const file = /powershell|pwsh/i.test(shell) ? 'shell-hook.ps1' : 'shell-preexec-hook.sh'
  const p = path.join(dir, file)
  return fs.existsSync(p) ? p : null
}

const sessions = new Map<string, TerminalSession>()
let mainWindow: BrowserWindow | null = null
let engagementId = ''
let operatorId = ''
let maxCastBytes = 50 * 1024 * 1024
// Per-command stdout cap. 256 KB is a compromise: enough to keep the tail of a
// full `id`/`whoami`/exploit run, small enough that a runaway `tail -f` won't
// bloat the event row. Truncation is flagged on the event so the operator
// knows to look at the .cast if they need the missing bytes.
let maxCommandOutputBytes = 256 * 1024

export function setTerminalWindow(win: BrowserWindow): void {
  mainWindow = win
}

// pty callbacks can fire after the window is gone (app quit), and a destroyed
// BrowserWindow is non-null — `mainWindow?.` alone doesn't protect us.
function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try { mainWindow.webContents.send(channel, payload) } catch { /* window tearing down */ }
}

export function configureTerminal(opts: { engagementId: string; operatorId: string; maxCastBytes?: number }): void {
  engagementId = opts.engagementId
  operatorId = opts.operatorId
  if (typeof opts.maxCastBytes === 'number' && opts.maxCastBytes > 0) maxCastBytes = opts.maxCastBytes
}

export function spawnTerminal(id: string, cols: number, rows: number): { pid: number } {
  const existing = sessions.get(id)
  if (existing) {
    // A re-attaching renderer (StrictMode remount, tab re-render) gets a brand
    // new xterm that missed everything printed so far — replay the buffer so it
    // shows the current prompt/scrollback instead of a blank screen.
    if (existing.buffer) {
      const buf = existing.buffer
      setTimeout(() => sendToWindow(`terminal:data:${id}`, buf), 0)
    }
    return { pid: existing.pty.pid }
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
    castTruncated: false,
    finalised: false,
    cmdBuffer: '',
    cmdBufferBytes: 0
  }

  term.onData((data: string) => {
    session.lastActivity = Date.now()
    session.buffer += data
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096)
    }
    // Grow the current-command output buffer. Capped at maxCommandOutputBytes
    // to keep runaway commands (tail -f, cat huge file) from blowing up the DB
    // row — anything past the cap is silently dropped and marked truncated on
    // the command_end event.
    if (session.cmdBufferBytes < maxCommandOutputBytes) {
      const room = maxCommandOutputBytes - session.cmdBufferBytes
      const chunk = data.length > room ? data.slice(0, room) : data
      session.cmdBuffer += chunk
      session.cmdBufferBytes += chunk.length
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
    sendToWindow(`terminal:data:${id}`, data)
  })

  term.onExit(({ exitCode }) => {
    finaliseSession(session, exitCode)
    sessions.delete(id)
    sendToWindow(`terminal:exit:${id}`, exitCode)
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

  // Auto-source the shell hook so individual commands appear in the timeline
  const hookPath = resolveShellHook(shell)
  if (hookPath) {
    const isPowerShell = /powershell|pwsh/i.test(shell)
    // Source the hook quietly: a leading space keeps it out of shell history,
    // output is discarded, and the screen is cleared so the operator sees a clean
    // prompt instead of the `source …` line and the hook's banner.
    const sourceCmd = isPowerShell
      ? ` . "${hookPath}" *> $null; Clear-Host\r`
      : ` source "${hookPath.replace(/\\/g, '/')}" >/dev/null 2>&1; clear\r`
    setTimeout(() => {
      if (!session.finalised) term.write(sourceCmd)
    }, 600)
  }

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
  finaliseSession(session, 0)
  try {
    session.pty.kill()
  } catch {}
  sessions.delete(id)
}

// Reset the current-command output buffer for a terminal session. Called by
// the API server on command_start events with source: 'builtin-terminal' so
// the prompt/echo that arrived before the hook fired isn't attributed to the
// command that just started.
export function beginCommandCapture(terminalId: string): void {
  const s = sessions.get(terminalId)
  if (!s) return
  s.cmdBuffer = ''
  s.cmdBufferBytes = 0
}

// Return + clear the accumulated stdout for a terminal session. Called by
// the API server on command_end events; returns null if the session is gone
// or capture never started.
export function takeCommandOutput(terminalId: string): { output: string; truncated: boolean; bytes: number } | null {
  const s = sessions.get(terminalId)
  if (!s) return null
  const output = s.cmdBuffer
  const truncated = s.cmdBufferBytes >= maxCommandOutputBytes
  const bytes = s.cmdBufferBytes
  s.cmdBuffer = ''
  s.cmdBufferBytes = 0
  return { output, truncated, bytes }
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
    finaliseSession(session, 0)
    try { session.pty.kill() } catch {}
  }
  sessions.clear()
}
