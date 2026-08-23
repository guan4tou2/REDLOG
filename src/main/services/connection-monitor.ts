import { execFile } from 'child_process'
import { eventBus } from '../../core/event-bus'
import { insertEvent } from '../../core/db/events'
import { noteDbError } from '../../core/capture-health'
import {
  parseSs, parseNetstatBsd, parseNetstatWin,
  diffConns, indexConns, isCapturable,
  type Connection
} from '../../core/connection-table'

// Connection-level network capture (docs/DESIGN-core-and-capture.md §2.1).
//
// The same shape as process-monitor: poll a table the OS already keeps, diff
// against the last snapshot, emit on the change. Here the table is the socket
// table, and the change is a connection opening or closing. It records who
// connected to which IP:port over what protocol and for how long — no payload,
// no root — so the timeline stops going dark the moment a tool talks to a host
// mitmproxy is not proxying (SMB, RDP, a reverse shell, a C2 beacon).
//
// It emits two events per connection, not one per poll: `connection` when it
// first appears and `connection_end` when it is gone, the latter carrying the
// duration. A reverse shell held open across a hundred polls is therefore one
// open and one close — a single span (§3), not a hundred rows.
//
// Structural blind spot, surfaced once at start rather than hidden: an
// established-connection poll cannot see a SYN scan, which never completes a
// handshake. `nmap -sS` leaves a command on the timeline and no connections,
// and the honest thing is to say so, because a capture that silently misses a
// whole class of activity is worse than one that admits its edge.

export interface ConnectionMonitorConfig {
  enabled: boolean
  pollMs?: number
  engagementId: string
  operatorId: string
  /** Local listener ports that are RedLog itself, filtered out so the app does
   *  not record its own hooks POSTing to its API. */
  selfPorts?: number[]
}

const DEFAULT_POLL_MS = 2000
// A saturation backstop mirroring process-monitor. A wide `nmap -sT` against a
// /24 opens thousands of short connections; past this many changes in a poll
// we record the fact and the count rather than thousands of rows.
const EMIT_BUDGET_PER_POLL = 400

interface Tracked {
  conn: Connection
  openedAt: number
}

let cfg: ConnectionMonitorConfig = { enabled: false, engagementId: '', operatorId: '' }
let pollTimer: ReturnType<typeof setInterval> | null = null
let known = new Map<string, Tracked>()
let polling = false
let announcedLimit = false

export function configureConnectionMonitor(next: Partial<ConnectionMonitorConfig>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function stopConnectionMonitor(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  known = new Map()
  announcedLimit = false
}

function restart(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (!cfg.enabled) return
  if (!supportedPlatform()) return

  known = new Map()
  announcedLimit = false

  // Seed the current table so the first poll does not emit a `connection` for
  // every session already open when RedLog launched — those predate the
  // recording and were not caused by anything on the timeline.
  void snapshot().then((conns) => {
    const seed = new Map<string, Tracked>()
    const now = Date.now()
    for (const c of conns) if (capturable(c)) seed.set(keyOf(c), { conn: c, openedAt: now })
    known = seed
    announceLimit()
  }).catch(() => { /* first poll will retry */ })

  const interval = Math.max(1000, cfg.pollMs ?? DEFAULT_POLL_MS)
  pollTimer = setInterval(poll, interval)
}

function supportedPlatform(): boolean {
  return ['linux', 'darwin', 'win32'].includes(process.platform)
}

/** State the blind spot once, when capture starts, so it is on the record that
 *  SYN scans are not covered — not buried in docs the operator will not read
 *  mid-engagement. */
function announceLimit(): void {
  if (announcedLimit) return
  announcedLimit = true
  try {
    const ev = insertEvent('system', {
      subtype: 'connection_capture_started',
      description: 'Connection capture records established connections only; ' +
        'SYN scans (nmap -sS) complete no handshake and are not visible here.',
      poll_ms: Math.max(1000, cfg.pollMs ?? DEFAULT_POLL_MS)
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('connection-monitor', e) }
}

function keyOf(c: Connection): string {
  // connKey is the pure identity; kept local so callers here read cleanly.
  return `${c.proto.startsWith('udp') ? 'udp' : 'tcp'}|${c.localPort}|${c.remoteAddr}|${c.remotePort}`
}

function capturable(c: Connection): boolean {
  return isCapturable(c, new Set(cfg.selfPorts ?? []))
}

async function poll(): Promise<void> {
  if (polling) return
  if (eventBus.paused) return
  polling = true
  try {
    const conns = (await snapshot()).filter(capturable)
    const next = indexConns(conns)
    const { opened, closed } = diffConns(toConnMap(known), next)

    const total = opened.length + closed.length
    if (total > EMIT_BUDGET_PER_POLL) {
      emitSaturated(total)
      // Still advance the snapshot so the burst is not re-detected next tick.
      known = mergeKnown(known, next)
      return
    }

    const now = Date.now()
    for (const c of opened) {
      const t: Tracked = { conn: c, openedAt: now }
      known.set(keyOf(c), t)
      emitOpen(c)
    }
    for (const c of closed) {
      const k = keyOf(c)
      const t = known.get(k)
      known.delete(k)
      emitClose(c, t ? now - t.openedAt : 0)
    }
  } catch {
    /* table unavailable this tick — try again next poll */
  } finally {
    polling = false
  }
}

/** Reconcile the tracked map with a fresh index without emitting — used after a
 *  saturated poll, preserving openedAt for connections we already knew. */
function mergeKnown(prev: Map<string, Tracked>, next: Map<string, Connection>): Map<string, Tracked> {
  const now = Date.now()
  const out = new Map<string, Tracked>()
  for (const [k, c] of next) out.set(k, prev.get(k) ?? { conn: c, openedAt: now })
  return out
}

function toConnMap(m: Map<string, Tracked>): Map<string, Connection> {
  const out = new Map<string, Connection>()
  for (const [k, t] of m) out.set(k, t.conn)
  return out
}

function emitOpen(c: Connection): void {
  try {
    const ev = insertEvent('scanner', {
      subtype: 'connection',
      proto: c.proto,
      remote_addr: c.remoteAddr,
      remote_port: c.remotePort,
      local_port: c.localPort,
      detectedTarget: c.remoteAddr,
      ...(c.pid ? { pid: c.pid } : {})
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId, targetId: c.remoteAddr })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('connection-monitor', e) }
}

function emitClose(c: Connection, durationMs: number): void {
  try {
    const ev = insertEvent('scanner', {
      subtype: 'connection_end',
      proto: c.proto,
      remote_addr: c.remoteAddr,
      remote_port: c.remotePort,
      local_port: c.localPort,
      detectedTarget: c.remoteAddr,
      duration_sec: Math.max(0, Math.round(durationMs / 1000))
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId, targetId: c.remoteAddr })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('connection-monitor', e) }
}

function emitSaturated(count: number): void {
  try {
    const ev = insertEvent('system', {
      subtype: 'connection_monitor_saturated',
      count,
      description: `Connection monitor over budget: ${count} changes in one poll; ` +
        'recording the count, not each row (a wide scan opens thousands of short connections).'
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('connection-monitor', e) }
}

// ── Platform snapshot ───────────────────────────────────────────────────────

function snapshot(): Promise<Connection[]> {
  if (process.platform === 'linux') return run('ss', ['-tunpH', 'state', 'established'], parseSs)
  if (process.platform === 'darwin') {
    // Two calls: BSD netstat filters protocol, not state, so we take tcp and
    // udp and let the parser drop non-established rows.
    return Promise.all([
      run('netstat', ['-n', '-p', 'tcp'], parseNetstatBsd),
      run('netstat', ['-n', '-p', 'udp'], parseNetstatBsd)
    ]).then(([a, b]) => [...a, ...b])
  }
  if (process.platform === 'win32') return run('netstat', ['-no'], parseNetstatWin)
  return Promise.resolve([])
}

function run(cmd: string, args: string[], parse: (out: string) => Connection[]): Promise<Connection[]> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return }
      try { resolve(parse(stdout)) } catch (e) { reject(e as Error) }
    })
  })
}
