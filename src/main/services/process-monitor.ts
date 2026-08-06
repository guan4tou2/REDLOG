import { execFile } from 'child_process'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { noteDbError } from '../../core/capture-health'

// ─────────────────────────────────────────────────────────────────────────────
// Process monitor (v0.6.92)
//
// Polls `ps -eo pid,ppid,etime,command` every N ms (default 500ms) on macOS /
// Linux and emits `process` events for spawned/exited processes. Best-effort:
// a process that both spawns AND exits inside the poll interval will be
// missed — that's a known trade-off for polling vs. dtrace/audit (which
// requires elevated perms + platform-specific glue).
//
// Correlation to shell commands: builtin-terminal session_start events set
// REDLOG_TERMINAL_ID on the pty; we surface it here via the `_causes` field
// when a spawned process's ppid maps back to a shell session we know about.
// The mapping is best-effort (there's no reliable way to get REDLOG_TERMINAL_ID
// out of ps' env on macOS without SIP-elevated ptrace), so we fall back to
// matching by ppid alone: if a shell.session_start event's terminalId
// process is our pid's grandparent, we point `_causes` at that session_start.
//
// Emit budget: cap 1000 events/minute; over that, we drop the excess and
// emit a single `system.process_monitor_saturated` event with the count.
// This prevents a fork bomb or a build script from wedging the log.
//
// Ignore list: default ignores match Electron's own subprocess names and
// whatever ignoreCommands the operator adds via config. Prevents the app
// from watching itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessMonitorConfig {
  enabled: boolean
  pollMs?: number
  ignoreCommands?: string[]
  engagementId: string
  operatorId: string
}

interface PsRow {
  pid: number
  ppid: number
  etime: string
  command: string
}

interface TrackedProc {
  pid: number
  ppid: number
  command: string
  startedAt: number
}

const DEFAULT_POLL_MS = 500
const EMIT_BUDGET_PER_MINUTE = 1000
const DEFAULT_IGNORES = [
  'Electron',
  'RedLog',
  'redlog',
  'redlog Helper',
  'ps',           // our own poll
  'ps -eo',
]

let cfg: ProcessMonitorConfig = { enabled: false, engagementId: '', operatorId: '' }
let pollTimer: ReturnType<typeof setInterval> | null = null
let knownProcs = new Map<number, TrackedProc>()
let ownPid = process.pid
let emitBucket = { count: 0, windowStart: 0 }
// v0.6.96 Clean-2: removed sessionCache — was only fed to findCauseSession
// which always returned undefined (see comment above emitSpawn).

export function configureProcessMonitor(next: Partial<ProcessMonitorConfig>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function startProcessMonitor(next?: Partial<ProcessMonitorConfig>): void {
  if (next) cfg = { ...cfg, ...next }
  restart()
}

export function stopProcessMonitor(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  knownProcs.clear()
  emitBucket = { count: 0, windowStart: 0 }
}

function restart(): void {
  stopProcessMonitor()
  if (!cfg.enabled) return
  if (!cfg.engagementId || !cfg.operatorId) return
  if (process.platform === 'win32') {
    // Windows: PowerShell Get-Process + Get-CimInstance Win32_Process would
    // fit here; not implemented in v0.6.92 to keep the surface small. Emit
    // a one-shot advisory so the operator sees why the lane stays empty.
    try {
      const ev = insertEvent('system', {
        subtype: 'process_monitor_unsupported',
        platform: process.platform,
        description: 'Process monitor is not implemented on Windows yet'
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      if (ev) eventBus.publish(ev)
    } catch { /* additive */ }
    console.warn('[process-monitor] Windows support not yet implemented')
    return
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const interval = Math.max(200, cfg.pollMs ?? DEFAULT_POLL_MS)
  // Seed known pids so the first poll doesn't emit "spawn" for every existing
  // process on the box — a fresh RedLog startup would insert thousands of
  // events. From here on, only real deltas fire.
  runPs().then((rows) => {
    knownProcs = new Map(rows.map((r) => [r.pid, { pid: r.pid, ppid: r.ppid, command: r.command, startedAt: Date.now() }]))
  }).catch((err) => {
    // v0.6.96 CP-2: Alpine / BusyBox `ps` doesn't accept the procps
    // `-eo pid=,ppid=,etime=,command=` syntax and errors immediately —
    // pre-v0.6.96 that swallowed silently and the lane looked broken with
    // no reason. Emit a one-shot advisory mirroring the Windows path so
    // the operator sees why nothing shows up.
    try {
      const ev = insertEvent('system', {
        subtype: 'process_monitor_ps_unavailable',
        platform: process.platform,
        error: (err as Error)?.message?.slice(0, 200) || 'unknown',
        description: 'Process monitor: system `ps` not usable (BusyBox / minimal container?). Install procps-ng.'
      }, { engagementId: cfg.engagementId!, operatorId: cfg.operatorId! })
      if (ev) eventBus.publish(ev)
    } catch { /* additive */ }
    console.warn('[process-monitor] ps unavailable:', (err as Error)?.message)
  })
  pollTimer = setInterval(poll, interval)
}

async function poll(): Promise<void> {
  if (eventBus.paused) return
  let rows: PsRow[]
  try { rows = await runPs() } catch { return }
  const nowMap = new Map<number, PsRow>()
  for (const r of rows) nowMap.set(r.pid, r)
  const { spawns, exits } = diffProcs(knownProcs, nowMap, cfg.ignoreCommands ?? [])
  // Ignore RedLog's own pid + its descendants; capping the traversal at 32
  // ancestors so a cycle (should never happen) can't hang the poll.
  const ownDescendants = collectDescendants(ownPid, nowMap)
  const filteredSpawns = spawns.filter((r) => !ownDescendants.has(r.pid) && r.pid !== ownPid)
  const filteredExits = exits.filter((p) => !ownDescendants.has(p.pid) && p.pid !== ownPid)

  const total = filteredSpawns.length + filteredExits.length
  if (!withinBudget(total)) {
    // Over cap — emit a saturation notice ONCE for the window and drop the rest.
    try {
      const ev = insertEvent('system', {
        subtype: 'process_monitor_saturated',
        count: total,
        window_ms: 60_000,
        description: `Process monitor over budget: ${total} events in the last minute; dropping`
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      if (ev) eventBus.publish(ev)
    } catch { /* additive */ }
    // Still update knownProcs so we don't re-detect these next tick.
    knownProcs = new Map(rows.map((r) => [r.pid, {
      pid: r.pid, ppid: r.ppid, command: r.command,
      startedAt: knownProcs.get(r.pid)?.startedAt ?? Date.now()
    }]))
    return
  }

  for (const r of filteredSpawns) {
    emitSpawn(r)
  }
  for (const p of filteredExits) {
    emitExit(p)
  }
  // Update knownProcs snapshot for next diff.
  knownProcs = new Map(rows.map((r) => [r.pid, {
    pid: r.pid, ppid: r.ppid, command: r.command,
    startedAt: knownProcs.get(r.pid)?.startedAt ?? Date.now()
  }]))
}

// Exported for unit tests — the diff algorithm is pure and testable in
// isolation without shelling out to ps.
export function diffProcs(
  prev: Map<number, TrackedProc>,
  next: Map<number, PsRow>,
  ignoreCommands: string[]
): { spawns: PsRow[]; exits: TrackedProc[] } {
  const ignores = [...DEFAULT_IGNORES, ...ignoreCommands]
  const isIgnored = (cmd: string): boolean => {
    for (const ig of ignores) {
      if (!ig) continue
      if (cmd === ig) return true
      if (cmd.startsWith(ig + ' ')) return true
      // substring match on the leading token (path/basename)
      const first = cmd.split(/\s+/)[0]
      if (first === ig) return true
      if (first.endsWith('/' + ig)) return true
    }
    return false
  }
  const spawns: PsRow[] = []
  for (const [pid, row] of next) {
    if (prev.has(pid)) continue
    if (isIgnored(row.command)) continue
    spawns.push(row)
  }
  const exits: TrackedProc[] = []
  for (const [pid, tp] of prev) {
    if (next.has(pid)) continue
    if (isIgnored(tp.command)) continue
    exits.push(tp)
  }
  return { spawns, exits }
}

function collectDescendants(rootPid: number, nowMap: Map<number, PsRow>): Set<number> {
  const desc = new Set<number>([rootPid])
  // BFS by ppid — capped at 32 iterations against a runaway loop.
  for (let i = 0; i < 32; i++) {
    let grew = false
    for (const [pid, row] of nowMap) {
      if (desc.has(row.ppid) && !desc.has(pid)) {
        desc.add(pid)
        grew = true
      }
    }
    if (!grew) break
  }
  return desc
}

function withinBudget(add: number): boolean {
  const now = Date.now()
  if (now - emitBucket.windowStart > 60_000) {
    emitBucket = { count: 0, windowStart: now }
  }
  if (emitBucket.count + add > EMIT_BUDGET_PER_MINUTE) return false
  emitBucket.count += add
  return true
}

// v0.6.96 Clean-2: removed findCauseSession() — always returned undefined
// (ppid → terminalId correlation needs env-var access ps doesn't give).
// Kept the wall-clock proximity fallback in Timeline; when a proper mapping
// path (macOS EndpointSecurity / Linux eBPF / Windows Sysmon) lands, wire
// _causes directly here. sessionCache warm-up dropped along with it — it
// was only feeding the stub.

function emitSpawn(r: PsRow): void {
  try {
    const argv = r.command.split(/\s+/)
    const ev = insertEvent('process', {
      subtype: 'process_spawn',
      pid: r.pid,
      ppid: r.ppid,
      command: r.command.slice(0, 500),
      argv: argv.slice(0, 20),
      started_at: Date.now()
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) {
    noteDbError('process-monitor', e)
  }
}

function emitExit(p: TrackedProc): void {
  try {
    const duration_sec = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))
    const ev = insertEvent('process', {
      subtype: 'process_exit',
      pid: p.pid,
      ppid: p.ppid,
      command: p.command.slice(0, 500),
      exit_code: null,   // ps -eo doesn't expose exit; caller can join to shell events
      duration_sec
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) {
    noteDbError('process-monitor', e)
  }
}

// Runs `ps -eo pid,ppid,etime,command` and parses the fixed-width-ish output.
// The command column is the tail of the line, so we split off the first three
// whitespace-separated columns and keep the rest as `command`.
export function runPs(): Promise<PsRow[]> {
  return new Promise((resolve, reject) => {
    // v0.6.97 E: on Linux procps truncates the command column at the terminal
    // width (default 80 cols in an inherited-env spawn — argv gets sliced),
    // which loses the args we need for scope matching. Double `-w` disables
    // truncation entirely (`-w` once bumps to unlimited, twice is a belt-
    // and-suspenders for procps < 3.3). macOS BSD ps ignores unknown flags,
    // so `-w -w` still parses correctly there. Alpine BusyBox errors on
    // both — that path is already covered by the CP-2 advisory event.
    const args = process.platform === 'linux'
      ? ['-w', '-w', '-eo', 'pid=,ppid=,etime=,command=']
      : ['-eo', 'pid=,ppid=,etime=,command=']
    execFile('ps', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return }
      const rows: PsRow[] = []
      for (const line of stdout.split('\n')) {
        const parsed = parsePsLine(line)
        if (parsed) rows.push(parsed)
      }
      resolve(rows)
    })
  })
}

// Exported for unit tests — line parsing is a tiny grammar and easier to
// exercise directly than by shelling out to ps in the test.
export function parsePsLine(line: string): PsRow | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // pid ppid etime command…
  const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
  if (!m) return null
  const pid = parseInt(m[1], 10)
  const ppid = parseInt(m[2], 10)
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null
  return { pid, ppid, etime: m[3], command: m[4] }
}
