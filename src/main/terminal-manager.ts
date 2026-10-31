import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { configureIngest, ingestEvent } from '../core/ingest'
import type { RedLogEvent } from '../core/db/events'
import { TerminalRecording, type TerminalRecordingSegment } from './terminal-recording'
import { getDB } from '../core/db/index'
import { eventBus } from '../core/event-bus'
import { noteDbError, configureBuiltinTerminalHealth } from '../core/capture-health'
import { getProjectDir } from '../core/db/index'
import { shellAdapterFilename, shellFlavour } from '../core/shell-flavour'
import { ensurePtyHelperExecutable } from '../core/pty-helper'
import { buildShellCatalog, isHookable, type ShellOption } from '../core/shell-catalog'
import { listWslDistros, windowsPathToWsl } from '../core/wsl-manager'
import { indexCast } from '../core/cast-index'
import { beginTerminal, readTerminalEnrollment, writeTerminalEnrollment, removeTerminalEnrollment } from '../core/terminal-enrollment'

// Checked once per run, before the first shell is started. See core/pty-helper.ts.
let ptyHelperChecked = false
function ensurePtyHelperOnce(): void {
  if (ptyHelperChecked) return
  ptyHelperChecked = true
  try {
    const result = ensurePtyHelperExecutable(path.dirname(require.resolve('node-pty/package.json')))
    for (const file of result.fixed) console.warn('[terminal] restored the execute bit on', file)
    for (const file of result.failed) console.warn('[terminal] node-pty helper is not executable and could not be fixed:', file)
  } catch { /* node-pty could not be located; the spawn below reports its own error */ }
}


// The shells this machine can open, discovered asynchronously and read
// synchronously by spawnTerminal. Probing is what must not happen on the main
// thread — listWslDistros() alone cost 2.1 s of blocking spawnSync before
// #100, and a pane opening is not the moment to pay it again.
let catalog: ShellOption[] = []

let managedProxyUrlProvider: () => string | null = () => null

export function configureTerminalProxy(provider: () => string | null): void {
  managedProxyUrlProvider = provider
}

/** The variables a WSL pane needs on the Linux side, merged into whatever
 *  WSLENV the operator already has.
 *
 *  WSLENV is a colon-separated list of variable NAMES (with optional path
 *  translation flags, which none of these want - they are a flag, an opaque
 *  id and URLs). Anything not named here simply does not exist inside the
 *  distro, however it was set on the Windows side. */
export const WSL_FORWARDED_ENV = [
  'REDLOG_TERMINAL',
  'REDLOG_TERMINAL_ID',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy'
] as const

export function wslEnvFor(existing: string | undefined): string {
  const have = (existing ?? '').split(':').filter(Boolean)
  // Keep the operator's own entries, and their flags, exactly as they set
  // them: an entry is `NAME` or `NAME/flags`, so compare on the name.
  const names = new Set(have.map((e) => e.split('/')[0]))
  return [...have, ...WSL_FORWARDED_ENV.filter((n) => !names.has(n))].join(':')
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
  castStream: TerminalRecording | null
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
  // Audit 2026-09-18 P1: identity captured for this recording binding. Its close lands before
  // the project changes; the surviving pane gets a new binding afterwards.
  engagementId: string
  projectId: string
  operatorId: string
  recordingId: string
  projectDir: string
  previousRecording?: { projectId: string; recordingId: string }
  recordingReason?: 'no-project' | 'recording-failed'
  recordingError?: string
  operatorPaused: boolean
  consentBeforeSwitch?: boolean
  pendingCommands: Map<string, { projectId: string; recordingId: string; commandId: string; startEventId?: string }>
  /** The managed proxy this pane's environment points at, fixed at spawn: a
   *  running shell's environment cannot be changed from outside, so the pane
   *  keeps this URL after the proxy is stopped. */
  proxiedVia: string | null
}

/** Open panes whose environment names a proxy URL. Asked right after the
 *  managed proxy stops, when every one of them points at a dead port. */
export function countProxiedTerminals(): number {
  let n = 0
  for (const s of sessions.values()) if (s.proxiedVia && !s.finalised) n++
  return n
}

// A binding closes while its own DB is still open; the PTY can outlive it.
function finaliseSession(session: TerminalSession, exitCode: number | null, reason: 'project-switched' | 'shell-exited' | 'pane-closed' | 'app-quit'): void {
  if (session.finalised) return
  session.finalised = true
  const closed = session.castStream?.close()
  session.castBytes = closed?.bytes ?? session.castBytes
  session.castTruncated = closed?.truncated ?? session.castTruncated
  session.castStream = null
  try {
    for (const pending of session.pendingCommands.values()) {
        ingestEvent('shell', {
          subtype: 'command_boundary', source: 'builtin-terminal', terminalId: session.id,
          recordingId: session.recordingId, command_id: pending.commandId,
          reason, ...(pending.recordingId === session.recordingId && pending.startEventId
            ? { _causes: [pending.startEventId] }
            : { boundary_from: { projectId: pending.projectId, recordingId: pending.recordingId, commandId: pending.commandId } })
      }, { engagementId: session.engagementId, operatorId: session.operatorId, bypassPause: true })
    }
    ingestEvent('shell', {
      subtype: 'session_end', source: 'builtin-terminal', terminalId: session.id,
      recordingId: session.recordingId, reason, continued: reason === 'project-switched',
      ...(reason === 'project-switched' ? { rotationPaneCount: sessions.size } : {}),
      exitCode, pid: session.pty.pid, castPath: session.castPath,
      castSha256: closed?.sha256 ?? null, castSegments: closed?.segments ?? [], castBytes: session.castBytes,
      castTruncated: session.castTruncated, durationMs: Date.now() - session.castStart,
      ...(closed?.error ? { recordingError: closed.error } : {}),
      ...(session.startEventId ? { _causes: [session.startEventId] } : {})
    }, { engagementId: session.engagementId, operatorId: session.operatorId, bypassPause: true })
  } catch (error) { noteDbError('terminal-session-end', error) }

  // Index only if the owning project is still open after the boundary. It is
  // rebuildable; hashing/re-reading a large cast must not hold up a switch.
  if (session.castPath && closed?.sha256) {
    const castPath = session.castPath, dir = session.projectDir
    void Promise.resolve().then(() => {
      if (getProjectDir() === dir) return Promise.all((closed.segments.length ? closed.segments.map(part => part.path) : [castPath]).map(part => indexCast(part, dir)))
      return undefined
    }).catch(() => { /* next project-open backfill rebuilds this index */ })
  }
}

function commandKey(data: Record<string, unknown>): string {
  return typeof data.command_id === 'string' && data.command_id
    ? data.command_id : `${data.pid ?? ''}|${data.command ?? ''}`
}

function prepareTerminalEvent(data: Record<string, unknown>, incomingEngagement: string): boolean {
  if (data.source !== 'builtin-terminal' || typeof data.terminalId !== 'string') return true
  const session = sessions.get(data.terminalId)
  if (!session) return true
  if (!['command_start', 'command_output', 'command_end'].includes(String(data.subtype))) return true
  refreshTerminalConsent(session)
  if (session.operatorPaused) {
    if (data.subtype === 'command_end') session.pendingCommands.delete(commandKey(data))
    return false
  }
  if (session.finalised || session.recordingReason || incomingEngagement !== session.engagementId) return false
  data.recordingId = session.recordingId
  const pending = session.pendingCommands.get(commandKey(data))
  if (pending && pending.recordingId !== session.recordingId && data.subtype !== 'command_start') {
    data.boundary_from = { projectId: pending.projectId, recordingId: pending.recordingId, commandId: pending.commandId }
    // Never import a foreign cause, byte range, or producer buffer that may
    // span both projects. The current project's cast is the available output.
    for (const key of ['_causes', 'io', 'stdout', 'stderr', 'output', 'stdout_ref', 'stderr_ref']) delete data[key]
    data.completeness = 'partial'
    data.output_disposition = 'project-boundary'
  }
  if (data.subtype === 'command_end') session.pendingCommands.delete(commandKey(data))
  return true
}

function terminalEventRecorded(event: RedLogEvent): void {
  const data = event.data
  if (data.source !== 'builtin-terminal' || typeof data.terminalId !== 'string') return
  const session = sessions.get(data.terminalId)
  if (!session || event.engagementId !== session.engagementId) return
  if (data.subtype === 'capture_stopped' || data.subtype === 'capture_resumed') refreshTerminalConsent(session)
  const key = commandKey(data)
  if (data.subtype === 'command_start') {
    // Foreground shell commands are sequential. A new start also retires a
    // command that completed while the picker had no record to receive it.
    session.pendingCommands.clear()
    session.pendingCommands.set(key, { projectId: session.projectId, recordingId: session.recordingId,
      commandId: typeof data.command_id === 'string' ? data.command_id : key, startEventId: event.id })
  } else if (data.subtype === 'command_end') session.pendingCommands.delete(key)
}

function beginRecording(session: TerminalSession): void {
  session.engagementId = engagementId
  session.projectId = projectId
  session.operatorId = operatorId
  session.projectDir = getProjectDir()
  session.recordingId = crypto.randomUUID()
  session.castStart = Date.now()
  session.castBytes = 0
  session.castTruncated = false
  session.finalised = false
  session.startEventId = null
  session.castPath = null
  session.castStream = null
  session.recordingReason = undefined
  session.recordingError = undefined
  try {
    const dir = path.join(session.projectDir, 'casts')
    fs.mkdirSync(dir, { recursive: true })
    session.castPath = path.join(dir, `${session.recordingId}.cast`)
    session.castStream = new TerminalRecording(session.castPath, {
      version: 2, width: session.cols, height: session.rows,
      timestamp: Math.floor(session.castStart / 1000),
      env: { SHELL: session.shell, TERM: 'xterm-256color' }, title: `redlog terminal ${session.id}`
    }, maxCastBytes)
    session.castBytes = session.castStream.bytes
    const event = ingestEvent('shell', {
      subtype: 'session_start', source: 'builtin-terminal', terminalId: session.id,
      recordingId: session.recordingId, shell: session.shell, shellLabel: session.shellLabel,
      pid: session.pty.pid, castPath: session.castPath, hookSourced: session.hookSourced,
      ...(session.previousRecording ? { continues: session.previousRecording } : {}),
      ...(session.previousRecording ? { rotationPaneCount: sessions.size } : {}),
      ...(session.hookSourced ? {} : { hookMissing: 'no-hook-for-shell' })
    }, { engagementId, operatorId, bypassPause: true })
    if (!event) throw new Error('Recording start was not stored')
    session.startEventId = event.id
  } catch (error) {
    session.castStream?.close()
    session.castStream = null
    session.recordingReason = 'recording-failed'
    session.recordingError = error instanceof Error ? error.message : String(error)
    noteDbError('terminal-session-start', error)
  }
  try {
    const old = readTerminalEnrollment(os.homedir(), session.id)
    const state = beginTerminal({ sessionId: session.id, mode: old?.mode ?? 'auto', engagementId, operatorId, now: session.castStart })
    if (session.previousRecording) state.recording = old?.recording === true || (old?.stoppedReason === 'project-switched' && session.consentBeforeSwitch === true)
    if (old?.stoppedReason === 'operator' || session.recordingReason) state.recording = false
    if (old?.stoppedReason === 'operator') state.stoppedReason = 'operator'
    writeTerminalEnrollment(os.homedir(), state)
    session.operatorPaused = !state.recording
  } catch (error) {
    session.castStream?.close()
    session.recordingReason = 'recording-failed'
    session.recordingError = error instanceof Error ? error.message : String(error)
    noteDbError('terminal-enrollment', error)
  }
  sendToWindow(`terminal:castState:${session.id}`, castState(session))
}

/** Shared project-close path. It does not terminate any process. */
export function detachTerminalRecordings(): number {
  for (const session of sessions.values()) {
    refreshTerminalConsent(session)
    session.consentBeforeSwitch = !session.operatorPaused
    finaliseSession(session, null, 'project-switched')
    session.previousRecording = { projectId: session.projectId, recordingId: session.recordingId }
    session.castPath = null
    session.recordingReason = 'no-project'
    try {
      const state = readTerminalEnrollment(os.homedir(), session.id)
      if (state) writeTerminalEnrollment(os.homedir(), { ...state, recording: false, stoppedReason: state.stoppedReason === 'operator' ? 'operator' : 'project-switched' })
    } catch (error) { noteDbError('terminal-enrollment', error) }
    sendToWindow(`terminal:castState:${session.id}`, castState(session))
  }
  engagementId = ''
  operatorId = ''
  return sessions.size
}

/** Called only once the incoming project's ingest and DB are ready. */
export function resumeTerminalRecordings(): number {
  if (!engagementId || !operatorId) return 0
  for (const session of sessions.values()) if (session.finalised) beginRecording(session)
  return sessions.size
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
export function castState(s: { castStream: { open: boolean } | null; castTruncated: boolean; recordingReason?: 'no-project' | 'recording-failed'; recordingError?: string; operatorPaused?: boolean }): {
  recording: boolean; castTruncated: boolean; paused: boolean; recordingReason?: 'no-project' | 'recording-failed'; recordingError?: string
} {
  const open = s.castStream?.open === true && !s.castTruncated
  const paused = open && (eventBus.paused || s.operatorPaused === true)
  return { recording: open && !paused, castTruncated: s.castTruncated, paused,
    ...(s.recordingReason ? { recordingReason: s.recordingReason } : {}),
    ...(s.recordingError ? { recordingError: s.recordingError } : {}) }
}

eventBus.on('recording', () => {
  for (const s of sessions.values()) sendToWindow(`terminal:castState:${s.id}`, castState(s))
})

let mainWindow: BrowserWindow | null = null
let engagementId = ''
let projectId = ''
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
  refreshTerminalConsent(session)
  if (eventBus.paused || session.operatorPaused || !session.castStream?.open) return false
  const written = session.castStream.append([(Date.now() - session.castStart) / 1000, type, data])
  session.castBytes = session.castStream.bytes
  session.castTruncated = session.castStream.truncated
  if (!written && !session.castTruncated) {
    session.recordingReason = 'recording-failed'
    session.recordingError = session.castStream.close().error ?? 'Recording write failed'
  }
  if (!written) sendToWindow(`terminal:castState:${session.id}`, castState(session))
  return written
}

/** The hook's durable stop is authoritative for the raw recording too. Read
 * before every frame: a control-event POST can lag behind the operator's input. */
function refreshTerminalConsent(session: TerminalSession): void {
  const state = readTerminalEnrollment(os.homedir(), session.id)
  const paused = state?.recording === false
  if (paused === session.operatorPaused) return
  session.operatorPaused = paused
  sendToWindow(`terminal:castState:${session.id}`, castState(session))
}

/** v0.9.6 (T2): current write position in a live session's .cast, so a
 *  command_start / command_end pair can bracket its own output by byte range.
 *  `session.castBytes` is already maintained by the write path, so this is
 *  O(1) — the alternative, re-slicing the cast by time window on every
 *  command_end, re-streams a growing prefix and is O(n^2) over a session. */
export function getCastPosition(terminalId: string): { castPath: string; offset: number; truncated: boolean } | null {
  const session = sessions.get(terminalId)
  if (!session?.castPath || session.finalised || session.recordingReason) return null
  return { castPath: session.castPath, offset: session.castBytes, truncated: session.castTruncated }
}

export function configureTerminal(opts: { engagementId: string; projectId: string; operatorId: string; maxCastBytes?: number }): void {
  engagementId = opts.engagementId
  projectId = opts.projectId
  operatorId = opts.operatorId
  configureIngest({ terminalLifecycle: { prepare: prepareTerminalEvent, recorded: terminalEventRecorded } })
  configureBuiltinTerminalHealth(() => {
    const failed = Array.from(sessions.values()).find(session => session.recordingReason === 'recording-failed')
    return failed ? { at: failed.castStart, message: failed.recordingError ?? 'Terminal recording failed' } : undefined
  })
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
//
// #290: the parts already written are the evidence of a crashed recording, so
// the recovered end lists them, as a normal close does. Their hashes are taken
// now and say so (`castSegmentsHashedAt: 'recovery'`): they prove what is on
// disk today, not what was written before the crash, and the aggregate
// `castSha256` stays null. `lastFrameSeconds` is where the recording stops;
// `castTornBytes` is a last frame the crash cut mid-write.
function recoveredCast(castPath: unknown): {
  castSegments: TerminalRecordingSegment[]; castBytes: number; castSegmentsHashedAt?: 'recovery'; lastFrameSeconds?: number; castTornBytes?: number
} {
  const castSegments: TerminalRecordingSegment[] = []
  if (typeof castPath !== 'string' || !castPath) return { castSegments, castBytes: 0 }
  const ext = path.extname(castPath)
  const stem = ext ? castPath.slice(0, -ext.length) : castPath
  const chunk = Buffer.alloc(1 << 20)
  for (let n = 1; ; n++) {
    // Same names TerminalRecording gives its parts: the first keeps castPath.
    const part = n === 1 ? castPath : `${stem}.part${String(n).padStart(6, '0')}${ext}`
    let fd: number
    try { fd = fs.openSync(part, 'r') } catch { break }
    try {
      const hash = crypto.createHash('sha256')
      let bytes = 0
      for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, bytes)) > 0; bytes += read) hash.update(chunk.subarray(0, read))
      castSegments.push({ path: part, bytes, sha256: hash.digest('hex') })
    } finally { fs.closeSync(fd) }
  }
  const castBytes = castSegments.reduce((sum, part) => sum + part.bytes, 0)
  if (!castSegments.length) return { castSegments, castBytes }
  const out: ReturnType<typeof recoveredCast> = { castSegments, castBytes, castSegmentsHashedAt: 'recovery' }
  // The tail of the last part holds the last complete frame and any torn one.
  const last = castSegments[castSegments.length - 1]
  const tailBytes = Math.min(last.bytes, chunk.length)
  const fd = fs.openSync(last.path, 'r')
  try { fs.readSync(fd, chunk, 0, tailBytes, last.bytes - tailBytes) } finally { fs.closeSync(fd) }
  const tail = chunk.subarray(0, tailBytes)
  const end = tail.lastIndexOf(0x0a)
  if (end < tail.length - 1) out.castTornBytes = tail.length - end - 1
  if (end >= 0) {
    try {
      const frame = JSON.parse(tail.subarray(tail.lastIndexOf(0x0a, end - 1) + 1, end).toString('utf8'))
      if (Array.isArray(frame) && typeof frame[0] === 'number') out.lastFrameSeconds = frame[0]
    } catch { /* header only, or a line longer than the tail: no frame time to report */ }
  }
  return out
}

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
      SELECT s.id AS start_id, s.data AS start_data
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
            AND EXISTS (SELECT 1 FROM json_each(e.data, '$._causes') c WHERE c.value = s.id)
        )
    `).all() as Array<{ start_id: string; start_data: string }>
    // Commands of that recording that neither ended nor were closed at a boundary.
    const openCommands = db.prepare(`
      SELECT c.id, json_extract(c.data,'$.command_id') AS command_id
      FROM events c
      WHERE c.agent_type = 'shell'
        AND c.subtype = 'command_start'
        AND json_extract(c.data,'$.source') = 'builtin-terminal'
        AND json_extract(c.data,'$.recordingId') = ?
        AND json_extract(c.data,'$.command_id') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.agent_type = 'shell'
            AND e.subtype IN ('command_end', 'command_boundary')
            AND json_extract(e.data,'$.recordingId') = json_extract(c.data,'$.recordingId')
            AND json_extract(e.data,'$.command_id') = json_extract(c.data,'$.command_id')
        )
      ORDER BY c.rowid
    `)
    for (const row of rows) {
      let start: Record<string, unknown>
      try { start = JSON.parse(row.start_data) } catch { continue }
      const tid = String(start.terminalId ?? '')
      if (!tid) continue
      try {
        if (typeof start.recordingId === 'string' && start.recordingId) {
          for (const command of openCommands.all(start.recordingId) as Array<{ id: string; command_id: string }>) {
            ingestEvent('shell', {
              subtype: 'command_boundary', source: 'builtin-terminal', terminalId: tid,
              recordingId: start.recordingId, command_id: command.command_id,
              reason: 'recovered-orphan', _causes: [command.id]
            }, { engagementId, operatorId })
          }
        }
        const ev = ingestEvent('shell', {
          subtype: 'session_end',
          source: 'builtin-terminal',
          terminalId: tid,
          recordingId: start.recordingId,
          _causes: [row.start_id],
          reason: 'recovered-orphan',
          exitCode: null,
          castSha256: null,
          castPath: typeof start.castPath === 'string' ? start.castPath : null,
          ...recoveredCast(start.castPath),
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
  recordingReason?: 'no-project' | 'recording-failed'
  recordingError?: string
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

  ensurePtyHelperOnce()
  const proxiedVia = managedProxyUrlProvider()
  const term = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...withManagedProxyEnv(process.env, proxiedVia, true),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      REDLOG_TERMINAL: '1',
      // Terminal id in env so the hook can round-trip it back on command_end
      // events. The api-server needs it to look up which session's stdout
      // buffer to attach (see /api/events terminalCaptureRef.takeCommandOutput).
      REDLOG_TERMINAL_ID: id,
      // A WSL pane starts `wsl.exe`, and Windows environment variables do NOT
      // cross that boundary unless they are named in WSLENV. Without it the
      // adapter inside the distro saw neither REDLOG_TERMINAL - so its events
      // were never tagged `source: 'builtin-terminal'` and the pane read as
      // silent on the capture panel - nor REDLOG_TERMINAL_ID, so a command_end
      // could not be matched to the pane whose stdout it belongs to. The
      // managed proxy variables have the same problem, which is why a tool
      // run inside WSL was never proxied.
      ...(wslDistro ? { WSLENV: wslEnvFor(process.env.WSLENV) } : {})
    } as Record<string, string>
  })

  const session: TerminalSession = {
    id,
    pty: term,
    buffer: '',
    lastActivity: Date.now(),
    castPath: null,
    castStream: null,
    castStart: Date.now(),
    castBytes: 0,
    castTruncated: false,
    finalised: false,
    cols,
    rows,
    engagementId,
    projectId,
    operatorId,
    shell,
    shellLabel,
    hookSourced: false,
    recordingId: '', projectDir: '', pendingCommands: new Map(), operatorPaused: false,
    proxiedVia
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
    finaliseSession(session, exitCode, 'shell-exited')
    removeTerminalEnrollment(os.homedir(), id)
    sessions.delete(id)
    sendToWindow(`terminal:exit:${id}`, exitCode)
  })

  sessions.set(id, session)

  // Resolved before the event is written so `session_start` carries the
  // answer: reading the timeline later, "this pane logged no commands" and
  // "this pane could not log commands" must not look the same.
  const hookPath = resolveShellHook(shell, wslDistro ? '/bin/bash' : undefined)
  session.hookSourced = hookPath !== null

  beginRecording(session)

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
    // Queue setup before returning the pane to the renderer. A timed delay
    // exposed a real prompt first: a fast operator's first command ran before
    // the hook and silently had no command event. The PTY preserves input order
    // while its shell starts, so later operator input follows this source line.
    term.write(sourceCmd)
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
    ...castState(session)
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
  finaliseSession(session, null, 'pane-closed')
  removeTerminalEnrollment(os.homedir(), id)
  try {
    session.pty.kill()
  } catch {}
  sessions.delete(id)
}

export function listTerminals(): Array<{
  id: string; pid: number; lastActivity: number
  recording: boolean; castBytes: number; castTruncated: boolean; paused: boolean; castStartedAt: number | null
  recordingReason?: 'no-project' | 'recording-failed'; recordingError?: string
}> {
  return Array.from(sessions.values()).map((s) => {
    refreshTerminalConsent(s)
    return {
    id: s.id,
    pid: s.pty.pid,
    lastActivity: s.lastActivity,
    ...castState(s),
    castBytes: s.castBytes,
    castStartedAt: s.castPath ? s.castStart : null
    }
  })
}

export function killAllTerminals(): void {
  for (const session of sessions.values()) {
    finaliseSession(session, null, 'app-quit')
    removeTerminalEnrollment(os.homedir(), session.id)
    try { session.pty.kill() } catch {}
  }
  sessions.clear()
}
