import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { insertEvent } from '../core/db/events'
import { eventBus } from '../core/event-bus'
import { noteDbError } from '../core/capture-health'
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
  // v0.6.89 `_causes`: id of the shell.session_start event so finaliseSession
  // can stamp session_end with `_causes: [startEventId]`. Populated after the
  // session_start insertEvent returns. Null when the start insert failed.
  startEventId?: string | null
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
      durationMs: Date.now() - session.castStart,
      // v0.6.89: point at the session_start we captured above.
      ...(session.startEventId ? { _causes: [session.startEventId] } : {})
    }, { engagementId, operatorId })
    if (event) eventBus.publish(event)
  } catch (e) {
    // Session_end write is the recording integrity chain's signal that a
    // recording was closed cleanly — losing it means the cast SHA is missing
    // and the pane's timeline entry looks abandoned. Forward to capture-health
    // so a shutdown-time swallow is at least diagnosable (v0.6.86).
    noteDbError('terminal-session-end', e)
  }
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

// v0.6.86: on project open, scan for any `shell.session_start` (source=
// builtin-terminal) rows without a matching `session_end` for the same
// terminalId. That's an orphaned session — the previous app run either
// crashed or was force-killed before finaliseSession could land, so the
// timeline shows a terminal that "never closed" and there's no cast SHA
// tying the recording to the audit chain. Write a synthetic session_end
// tagged `recovered=true` so operators can distinguish it from a normal
// close and the chain gets its close signal.
export function recoverOrphanSessions(): number {
  if (!operatorId) return 0
  let recovered = 0
  try {
    // Lazy import to avoid pulling db into modules that get pulled by tests.
    const { getDB } = require('../core/db/index') as typeof import('../core/db/index')
    const { insertEvent } = require('../core/db/events') as typeof import('../core/db/events')
    // v0.6.87 A5: paginated scan via SQL (previous impl loaded up to 5000 rows
    // twice into memory then diffed in JS — big engagements with many terminal
    // sessions would silently miss orphans past the 5000 cap). SQL LEFT JOIN
    // finds every session_start without a matching session_end for the same
    // terminalId, regardless of row count.
    const db = getDB()
    const rows = db.prepare(`
      SELECT s.data AS start_data
      FROM events s
      WHERE s.agent_type = 'shell'
        AND json_extract(s.data,'$.subtype') = 'session_start'
        AND json_extract(s.data,'$.source') = 'builtin-terminal'
        AND json_extract(s.data,'$.terminalId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.agent_type = 'shell'
            AND json_extract(e.data,'$.subtype') = 'session_end'
            AND json_extract(e.data,'$.source') = 'builtin-terminal'
            AND json_extract(e.data,'$.terminalId') = json_extract(s.data,'$.terminalId')
        )
    `).all() as Array<{ start_data: string }>
    for (const row of rows) {
      let tid = ''
      try { tid = String(JSON.parse(row.start_data)?.terminalId ?? '') } catch { continue }
      if (!tid) continue
      try {
        const ev = insertEvent('shell', {
          subtype: 'session_end',
          source: 'builtin-terminal',
          terminalId: tid,
          exitCode: null,
          castSha256: null,
          recovered: true,
          description: 'orphan session recovered on app start'
        }, { engagementId, operatorId })
        if (ev) { eventBus.publish(ev); recovered++ }
      } catch (e) { noteDbError('orphan-session-recovery', e) }
    }
  } catch (e) { noteDbError('orphan-session-recovery', e) }
  return recovered
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
  const isPowerShell = /powershell|pwsh/i.test(shell)
  const shellArgs = isPowerShell ? ['-ExecutionPolicy', 'Bypass', '-NoLogo'] : []
  // Use os.homedir() only — it resolves via USERPROFILE on Windows. Reading
  // process.env.HOME first bit Git Bash / MSYS2 users where HOME is a
  // POSIX-shaped `/c/Users/foo` that pty.spawn rejects as invalid Win32.
  // Audit P0-2 (docs/WINDOWS_COMPAT_AUDIT.md).
  const cwd = os.homedir()

  const term = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      REDLOG_TERMINAL: '1',
      // Terminal id in env so the hook can round-trip it back on command_end
      // events. The api-server needs it to look up which session's stdout
      // buffer to attach (see /api/events terminalCaptureRef.takeCommandOutput).
      REDLOG_TERMINAL_ID: id
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
    finalised: false
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
  if (event) {
    eventBus.publish(event)
    session.startEventId = event.id
  }

  // Auto-source the shell hook so individual commands appear in the timeline
  const hookPath = resolveShellHook(shell)
  if (hookPath) {
    // Source the hook quietly: a leading space keeps it out of shell history,
    // output is discarded, and the screen is cleared so the operator sees a clean
    // prompt instead of the `source …` line and the hook's banner.
    // POSIX branch converts backslashes → slashes for `source`; on Windows a
    // native bash (git-bash / cygwin) would still need `cygpath -u` to accept
    // the drive-lettered path, so we skip the auto-source there. If someone
    // ever wants that, wire cygpath conversion here. Audit P1-6.
    const canAutoSource = isPowerShell || process.platform !== 'win32'
    if (canAutoSource) {
      const sourceCmd = isPowerShell
        ? ` . "${hookPath}" *> $null; Clear-Host\r`
        : ` source "${hookPath.replace(/\\/g, '/')}" >/dev/null 2>&1; clear\r`
      setTimeout(() => {
        if (!session.finalised) term.write(sourceCmd)
      }, 600)
    }
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
