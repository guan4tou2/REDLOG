import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ingestEvent } from '../core/ingest'
import { getDB } from '../core/db/index'
import { eventBus } from '../core/event-bus'
import { noteDbError } from '../core/capture-health'
import { getProjectDir } from '../core/db/index'
import { shellAdapterFilename, shellFlavour } from '../core/shell-flavour'
import { buildShellCatalog, isHookable, type ShellOption } from '../core/shell-catalog'
import { listWslDistros, windowsPathToWsl } from '../core/wsl-manager'
import { indexCast } from '../core/cast-index'

// The shells this machine can open, discovered asynchronously and read
// synchronously by spawnTerminal. Probing is what must not happen on the main
// thread — listWslDistros() alone cost 2.1 s of blocking spawnSync before
// #100, and a pane opening is not the moment to pay it again.
let catalog: ShellOption[] = []

let managedProxyUrlProvider: () => string | null = () => null

export function configureTerminalProxy(provider: () => string | null): void {
  managedProxyUrlProvider = provider
}

export function withManagedProxyEnv(
  base: Record<string, string | undefined>,
  proxyUrl: string | null,
  enabled = false
): Record<string, string | undefined> {
  if (!enabled || !proxyUrl) return { ...base }
  return {
    ...base,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl
  }
}

export function cachedShells(): ShellOption[] { return catalog }

export async function discoverShells(): Promise<ShellOption[]> {
  const wslDistros = process.platform === 'win32'
    ? (await listWslDistros()).map((d) => d.name)
    : []
  catalog = buildShellCatalog({
    platform: process.platform,
    envShell: process.env.SHELL,
    exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
    wslDistros
  })
  return catalog
}

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
  cols: number
  rows: number
  /** What this pane is running, and whether its commands are being recorded.
   *  Kept on the session so a re-attaching renderer gets the same answer as
   *  the one that spawned it. */
  shell: string
  shellLabel: string
  hookSourced: boolean
  // v0.6.89 `_causes`: id of the shell.session_start event so finaliseSession
  // can stamp session_end with `_causes: [startEventId]`. Populated after the
  // session_start insertEvent returns. Null when the start insert failed.
  startEventId?: string | null
  // Audit 2026-09-18 P1: identity captured at spawn time so a project switch
  // mid-session doesn't silently re-attribute the close event.
  engagementId: string
  operatorId: string
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

  // Make the recording searchable now that it is closed and its bytes are
  // final (docs/DESIGN-core-and-capture.md §2.4). Indexing a live cast would
  // mean re-reading a growing file; indexing at close reads it once.
  //
  // Fire-and-forget on purpose. This runs on the pty exit path, which on app
  // quit is racing the DB close — blocking it to build a search index would
  // risk the session_end event above, and that one is evidence. A cast that
  // misses its index is picked up by the next backfill; a lost session_end is
  // lost.
  if (session.castPath) {
    const p = session.castPath
    void indexCast(p).catch(() => { /* index is rebuildable; never block the exit path */ })
  }

  try {
    const event = ingestEvent('shell', {
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
    }, { engagementId: session.engagementId, operatorId: session.operatorId })
  } catch (e) {
    // Session_end write is the recording integrity chain's signal that a
    // recording was closed cleanly — losing it means the cast SHA is missing
    // and the pane's timeline entry looks abandoned. Forward to capture-health
    // so a shutdown-time swallow is at least diagnosable (v0.6.86).
    noteDbError('terminal-session-end', e)
  }
}

function resolveShellHook(shell: string, innerShell?: string): string | null {
  const file = shellAdapterFilename(shell, innerShell)
  if (!file) return null
  const candidates = [
    path.join(__dirname, '../../../hooks'),
    path.join(__dirname, '../../hooks')
  ]
  const dir = candidates.find(d => fs.existsSync(d))
  if (!dir) return null
  const p = path.join(dir, file)
  return fs.existsSync(p) ? p : null
}

const sessions = new Map<string, TerminalSession>()

// 2b per-pane 記錄中/未記錄 chip (§5b/§2). A pane is recording only while a
// cast stream is open and has not hit the size cap; a null stream means the
// cast never opened (e.g. casts/ unwritable) and the pane runs unrecorded — a
// state the operator must be able to see, not a silent gap. While recording is
// paused no frame is written (appendCastFrame), so an open cast reads as paused.
export function castState(s: Pick<TerminalSession, 'castStream' | 'castTruncated'>): {
  recording: boolean; castTruncated: boolean; paused: boolean
} {
  const open = s.castStream !== null && !s.castTruncated
  return { recording: open && !eventBus.paused, castTruncated: s.castTruncated, paused: open && eventBus.paused }
}

eventBus.on('recording', () => {
  for (const s of sessions.values()) sendToWindow(`terminal:castState:${s.id}`, castState(s))
})

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

/** Append one asciicast v2 frame under the session's recording policy.
 * Output and resize frames share this path so byte accounting, pause and
 * truncation cannot drift. The live PTY remains usable if the cast fails. */
function appendCastFrame(session: TerminalSession, type: 'o' | 'r', data: string): boolean {
  if (eventBus.paused || !session.castStream || session.castTruncated) return false
  const encoded = JSON.stringify([(Date.now() - session.castStart) / 1000, type, data]) + '\n'
  const chunkBytes = Buffer.byteLength(encoded)
  if (session.castBytes + chunkBytes > maxCastBytes) {
    try {
      const marker = JSON.stringify([(Date.now() - session.castStart) / 1000, 'o', `\r\n[redlog: cast truncated at ${maxCastBytes} bytes]\r\n`]) + '\n'
      session.castStream.write(marker)
      session.castBytes += Buffer.byteLength(marker)
      session.castStream.end()
    } catch { /* live terminal must survive a recording failure */ }
    session.castStream = null
    session.castTruncated = true
    sendToWindow(`terminal:castState:${session.id}`, castState(session))
    return false
  }
  try {
    session.castStream.write(encoded)
    session.castBytes += chunkBytes
    return true
  } catch {
    return false
  }
}

/** v0.9.6 (T2): current write position in a live session's .cast, so a
 *  command_start / command_end pair can bracket its own output by byte range.
 *  `session.castBytes` is already maintained by the write path, so this is
 *  O(1) — the alternative, re-slicing the cast by time window on every
 *  command_end, re-streams a growing prefix and is O(n^2) over a session. */
export function getCastPosition(terminalId: string): { castPath: string; offset: number; truncated: boolean } | null {
  const session = sessions.get(terminalId)
  if (!session?.castPath) return null
  return { castPath: session.castPath, offset: session.castBytes, truncated: session.castTruncated }
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
        AND s.subtype = 'session_start'
        AND json_extract(s.data,'$.source') = 'builtin-terminal'
        AND json_extract(s.data,'$.terminalId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.agent_type = 'shell'
            AND e.subtype = 'session_end'
            AND json_extract(e.data,'$.source') = 'builtin-terminal'
            AND json_extract(e.data,'$.terminalId') = json_extract(s.data,'$.terminalId')
        )
    `).all() as Array<{ start_data: string }>
    for (const row of rows) {
      let tid = ''
      try { tid = String(JSON.parse(row.start_data)?.terminalId ?? '') } catch { continue }
      if (!tid) continue
      try {
        const ev = ingestEvent('shell', {
          subtype: 'session_end',
          source: 'builtin-terminal',
          terminalId: tid,
          exitCode: null,
          castSha256: null,
          recovered: true,
          description: 'orphan session recovered on app start'
        }, { engagementId, operatorId })
        if (ev) recovered++
      } catch (e) { noteDbError('orphan-session-recovery', e) }
    }
  } catch (e) { noteDbError('orphan-session-recovery', e) }
  return recovered
}

export interface SpawnResult {
  pid: number
  /** The shell actually launched, so the UI can name it when it warns. */
  shell: string
  /** Catalog label when the operator picked one ("Git Bash", "WSL · Ubuntu"),
   *  else the executable's own name. */
  shellLabel: string
  /** False when this pane records no commands: its shell has no hook, or the
   *  hook file is missing from the install. */
  hookSourced: boolean
  /** Whether this pane's screen recording is running, whether it has hit the
   *  cast size cap, and whether it is held by a recording pause. */
  recording: boolean
  castTruncated: boolean
  paused: boolean
}

export function spawnTerminal(id: string, cols: number, rows: number, shellId?: string): SpawnResult {
  const existing = sessions.get(id)
  if (existing) {
    // A re-attaching renderer (StrictMode remount, tab re-render) gets a brand
    // new xterm that missed everything printed so far — replay the buffer so it
    // shows the current prompt/scrollback instead of a blank screen.
    if (existing.buffer) {
      const buf = existing.buffer
      setTimeout(() => sendToWindow(`terminal:data:${id}`, buf), 0)
    }
    return {
      pid: existing.pty.pid,
      shell: existing.shell,
      shellLabel: existing.shellLabel,
      hookSourced: existing.hookSourced,
      ...castState(existing)
    }
  }
  if (!operatorId) {
    throw new Error('Terminal cannot spawn before configureTerminal() sets an operator identity')
  }

  // The operator's pick, when the picker has one and the catalog still has it.
  // Falls back to the inherited-$SHELL rule below, which is what every pane
  // used before the catalog existed.
  //
  // v0.6.96 CP-1: on Windows, ignore inherited POSIX-shaped SHELL (Git Bash
  // sets `SHELL=/usr/bin/bash` — pty.spawn rejects it with an inscrutable
  // error). Only accept SHELL when it looks like a Win32 path or ends in .exe.
  // Same class as the v0.6.82 cwd-from-HOME fix, but for SHELL — that audit
  // didn't touch this line.
  const picked = shellId ? cachedShells().find((s) => s.id === shellId) : undefined
  const isWin32Path = (p: string): boolean => /^[A-Z]:[\\/]/i.test(p) || /\.exe$/i.test(p)
  const envShell = process.env.SHELL
  const shell = picked?.command ?? ((envShell && (os.platform() !== 'win32' || isWin32Path(envShell)))
    ? envShell
    : (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh'))
  const flavour = picked?.flavour ?? shellFlavour(shell)
  const shellArgs = picked?.args ?? (flavour === 'powershell' ? ['-ExecutionPolicy', 'Bypass', '-NoLogo'] : [])
  const wslDistro = picked?.wslDistro
  const shellLabel = picked?.label ?? (shell.split(/[\/]/).pop() ?? shell)
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
      ...withManagedProxyEnv(process.env, managedProxyUrlProvider(), true),
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

  let castHeaderBytes = 0
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
    const headerLine = JSON.stringify(header) + '\n'
    castStream.write(headerLine)
    // Counted, because `castBytes` is a file offset, not an output total.
    // v0.9.6's byte-range bracket (`io: {off, len}` on command_end) reads the
    // cast with `fs.createReadStream({start: off})`, so an offset that omits
    // the header is short by its length and every range lands mid-line —
    // yielding zero parseable events and a replay that reports 0 bytes.
    castHeaderBytes = Buffer.byteLength(headerLine)
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
    castBytes: castHeaderBytes,
    castTruncated: false,
    finalised: false,
    cols,
    rows,
    engagementId,
    operatorId,
    shell,
    shellLabel,
    hookSourced: false
  }

  term.onData((data: string) => {
    session.lastActivity = Date.now()
    session.buffer += data
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096)
    }
    // Audit 2026-09-18 P1: skip cast writing while recording is paused.
    // Terminal display keeps working; only the .cast file stops growing.
    if (eventBus.paused) {
      sendToWindow(`terminal:data:${id}`, data)
      return
    }
    appendCastFrame(session, 'o', data)
    sendToWindow(`terminal:data:${id}`, data)
  })

  term.onExit(({ exitCode }) => {
    finaliseSession(session, exitCode)
    sessions.delete(id)
    sendToWindow(`terminal:exit:${id}`, exitCode)
  })

  sessions.set(id, session)

  // Resolved before the event is written so `session_start` carries the
  // answer: reading the timeline later, "this pane logged no commands" and
  // "this pane could not log commands" must not look the same.
  const hookPath = resolveShellHook(shell, wslDistro ? '/bin/bash' : undefined)
  session.hookSourced = hookPath !== null

  const event = ingestEvent('shell', {
    subtype: 'session_start',
    source: 'builtin-terminal',
    terminalId: id,
    shell,
    shellLabel,
    ...(picked ? { shellId: picked.id } : {}),
    pid: term.pid,
    castPath,
    hookSourced: session.hookSourced,
    ...(session.hookSourced ? {} : { hookMissing: isHookable(flavour) ? 'hook-file-not-found' : 'no-hook-for-shell' })
    // Identity from the session, not the module: #114 captures it at spawn so
    // a project switch mid-session cannot re-attribute this row.
  }, { engagementId: session.engagementId, operatorId: session.operatorId })
  if (event) {
    session.startEventId = event.id
  }

  // Auto-source the shell hook so individual commands appear in the timeline
  if (hookPath) {
    // Source the hook quietly: a leading space keeps it out of shell history,
    // output is discarded, and the screen is cleared so the operator sees a clean
    // prompt instead of the `source …` line and the hook's banner.
    //
    // The POSIX branch now runs on Windows too. It used to be skipped there on
    // the belief that a native bash "would still need `cygpath -u` to accept
    // the drive-lettered path" (Audit P1-6). That premise is wrong: Git Bash
    // and MSYS2 accept the mixed form this produces —
    // `source "C:/…/hooks/shell-bash-hook.sh"` sources cleanly and defines
    // the hook's functions. Verified on Windows 11 / Git for Windows before
    // removing the guard.
    //
    // The cost of the old guard was not a missing convenience: a pane whose
    // `SHELL` pointed at Git Bash — which is every pane launched from a Git
    // Bash shell, since the value is inherited — recorded `session_start` and
    // a `.cast` and **not one command**, with nothing on screen to say so.
    // A WSL pane is a Linux shell looking at the Windows disk through /mnt,
    // so the hook has to be named the way that shell can reach it — the same
    // conversion `wsl-manager` does when it installs the hook into a distro's
    // rc file.
    const posixPath = wslDistro ? windowsPathToWsl(hookPath) : hookPath.replace(/\\/g, '/')
    const sourceCmd = flavour === 'powershell'
      ? ` . "${hookPath}" *> $null; Clear-Host\r`
      : ` source "${posixPath}" >/dev/null 2>&1; clear\r`
    setTimeout(() => {
      if (!session.finalised) term.write(sourceCmd)
    }, 600)
  }

  // `hookSourced: false` is the pane saying "my commands are not being
  // recorded". The renderer shows it, because a capture gap the operator
  // cannot see is the one failure mode the product does not allow
  // (constitution II, Surface Truthfulness).
  return {
    pid: term.pid,
    shell,
    shellLabel,
    hookSourced: hookPath !== null,
    ...castState({ castStream, castTruncated: false })
  }
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
  const session = sessions.get(id)
  if (!session || (session.cols === cols && session.rows === rows)) return
  try {
    session.pty.resize(cols, rows)
    session.cols = cols
    session.rows = rows
    appendCastFrame(session, 'r', `${cols}x${rows}`)
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

export function listTerminals(): Array<{
  id: string; pid: number; lastActivity: number
  recording: boolean; castBytes: number; castTruncated: boolean; paused: boolean; castStartedAt: number | null
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    pid: s.pty.pid,
    lastActivity: s.lastActivity,
    ...castState(s),
    castBytes: s.castBytes,
    castStartedAt: s.castPath ? s.castStart : null
  }))
}

export function killAllTerminals(): void {
  for (const session of sessions.values()) {
    finaliseSession(session, 0)
    try { session.pty.kill() } catch {}
  }
  sessions.clear()
}
