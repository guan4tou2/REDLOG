import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const run = promisify(execFile)

// Who is already on the capture port, in words the operator can act on.
//
// mitmdump's own answer is a multi-line startup dump ending in a localised
// winsock error and a suggestion to pass `--mode regular@8082` — a mitmproxy
// flag, not a RedLog setting. So the operator learned neither what had taken
// the port nor that the port is theirs to change. The likeliest holder is
// Burp Suite, which listens on 8080 by default; that was RedLog's default
// too, so the first click of "Start HTTP capture" failed on most machines
// this product is installed on.

export interface PortProbe {
  /** Can we bind host:port right now? */
  free: (host: string, port: number) => Promise<boolean>
  /** Best-effort name of the process holding it, or null. */
  holder: (port: number) => Promise<string | null>
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    try { server.listen(port, host) } catch { resolve(false) }
  })
}

/** Best effort and never fatal: if we cannot name the holder we still say the
 *  port is taken, which is the part that matters. */
async function findHolder(port: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 4_000, windowsHide: true })
      const line = stdout.split(/\r?\n/).find((l) => /LISTENING/i.test(l) && new RegExp(`:${port}\\s`).test(l))
      const pid = line?.trim().split(/\s+/).pop()
      if (!pid || !/^\d+$/.test(pid)) return null
      const { stdout: tasks } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { timeout: 4_000, windowsHide: true })
      const name = tasks.split('","')[0]?.replace(/^"/, '').trim()
      return name && name !== 'INFO:' ? `${name} (PID ${pid})` : `PID ${pid}`
    }
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fcp'], { timeout: 4_000 })
    const pid = /^p(\d+)/m.exec(stdout)?.[1]
    const name = /^c(.+)$/m.exec(stdout)?.[1]
    if (!pid) return null
    return name ? `${name} (PID ${pid})` : `PID ${pid}`
  } catch {
    return null
  }
}

export const DEFAULT_PORT_PROBE: PortProbe = { free: canBind, holder: findHolder }

/**
 * A ready-to-show reason the capture proxy cannot start here, or null when the
 * endpoint is free.
 */
export async function whoHoldsPort(
  endpoint: { host: string; port: number },
  probe: PortProbe = DEFAULT_PORT_PROBE
): Promise<string | null> {
  if (await probe.free(endpoint.host, endpoint.port)) return null
  const holder = await probe.holder(endpoint.port)
  const who = holder ? ` by ${holder}` : ''
  return `${endpoint.host}:${endpoint.port} is already in use${who}. ` +
    'Change the HTTP capture port in Settings → Browser, or stop what is using it.'
}

// ── RedLog's own leftover ───────────────────────────────────────────────────
//
// mitmdump is RedLog's child. When RedLog is force-quit, crashes or is killed
// with SIGKILL, the child outlives it, is re-parented to init (ppid 1) and
// keeps the capture port, so the next launch could not start HTTP capture
// until the operator found it with lsof and killed it by hand.
//
// What is reclaimed is narrow on purpose, and the proof is RedLog's own record,
// not the look of the process. When RedLog starts its mitmdump it writes down
// the pid, the endpoint, the exact addon path and when that process started.
// A process on the port is stopped only if every one of those still matches,
// it has no parent, and it is `mitmdump`. A command line alone is not proof: a
// mitmdump the operator started with `-s /elsewhere/mitmproxy-addon.py` has the
// same shape as ours, and a pid can be reused by a stranger after a reboot.
// No record means no reclaim — the holder is reported and the operator decides.
// POSIX only: a parent id means nothing on Windows.

export interface ProxyOwner {
  pid: number
  host: string
  port: number
  /** Exactly as it was passed to `-s`. */
  addonPath: string
  /** `ps -o lstart=` of the process when RedLog recorded it. */
  startedAt: string
}

export interface OrphanDeps {
  platform: NodeJS.Platform
  /** What RedLog wrote when it started the proxy, or null. */
  owner: () => Promise<ProxyOwner | null>
  /** When that pid started, in the same form the record holds. */
  startedAt: (pid: number) => Promise<string | null>
  clearOwner: () => void
  pidOnPort: (port: number) => Promise<number | null>
  inspect: (pid: number) => Promise<{ ppid: number; command: string } | null>
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  portFree: (host: string, port: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

async function pidOnPort(port: number): Promise<number | null> {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 4_000 })
    const pid = /^p(\d+)/m.exec(stdout)?.[1]
    return pid ? Number(pid) : null
  } catch { return null }
}

async function inspectProcess(pid: number): Promise<{ ppid: number; command: string } | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { timeout: 4_000 })
    const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim())
    return m ? { ppid: Number(m[1]), command: m[2] } : null
  } catch { return null }
}

async function processStartedAt(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 4_000 })
    return stdout.trim() || null
  } catch { return null }
}

/** Where the record lives: machine-wide, like the port it is about. */
export function proxyOwnerFile(homeDir: string): string {
  return path.join(homeDir, '.redlog', 'managed-proxy-owner.json')
}

/** Write down what RedLog just started. Best effort: without a record the
 *  worst outcome is that a later orphan is reported instead of reclaimed. */
export async function recordProxyOwner(
  file: string,
  owner: { pid: number; host: string; port: number; addonPath: string },
  startedAtOf: (pid: number) => Promise<string | null> = processStartedAt
): Promise<void> {
  try {
    const startedAt = await startedAtOf(owner.pid)
    if (!startedAt) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...owner, startedAt } satisfies ProxyOwner), { mode: 0o600 })
  } catch { /* best-effort */ }
}

function readProxyOwner(file: string): ProxyOwner | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProxyOwner>
    return typeof o.pid === 'number' && typeof o.port === 'number' && typeof o.host === 'string'
      && typeof o.addonPath === 'string' && typeof o.startedAt === 'string' ? o as ProxyOwner : null
  } catch { return null }
}

export function orphanDepsFor(file: string): OrphanDeps {
  return {
    ...DEFAULT_ORPHAN_DEPS,
    owner: async () => readProxyOwner(file),
    clearOwner: () => { try { fs.rmSync(file, { force: true }) } catch { /* nothing to clear */ } }
  }
}

export const DEFAULT_ORPHAN_DEPS: OrphanDeps = {
  platform: process.platform,
  owner: async () => null,
  startedAt: processStartedAt,
  clearOwner: () => {},
  pidOnPort,
  inspect: inspectProcess,
  kill: (pid, signal) => { try { process.kill(pid, signal) } catch { /* already gone */ } },
  portFree: canBind,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** The command is mitmdump on this port running exactly the addon RedLog
 *  recorded. `-s <path>` is last in RedLog's argument list and the path may
 *  hold spaces, so it is everything after the flag. */
function isRecordedProxy(command: string, owner: ProxyOwner, port: number): boolean {
  const args = command.split(/\s+/)
  const exe = (args[0] ?? '').split('/').pop() ?? ''
  if (exe !== 'mitmdump') return false
  const at = args.indexOf('--listen-port')
  if (at < 0 || args[at + 1] !== String(port)) return false
  const flag = command.lastIndexOf(' -s ')
  return flag >= 0 && command.slice(flag + 4).trim() === owner.addonPath
}

/** Stop RedLog's own leftover mitmdump on this endpoint. Returns the pid it
 *  stopped, or null when there was nothing provably ours to stop (or it would
 *  not stop). Never throws. */
export async function reclaimOrphanProxy(
  endpoint: { host: string; port: number },
  deps: OrphanDeps = DEFAULT_ORPHAN_DEPS
): Promise<{ pid: number } | null> {
  if (deps.platform === 'win32') return null
  try {
    const pid = await deps.pidOnPort(endpoint.port)
    if (!pid) return null
    const owner = await deps.owner()
    if (!owner || owner.pid !== pid || owner.port !== endpoint.port || owner.host !== endpoint.host) return null
    const info = await deps.inspect(pid)
    if (!info || info.ppid !== 1 || !isRecordedProxy(info.command, owner, endpoint.port)) return null
    // The pid is the same; is it the same process? A reboot hands pids to
    // strangers, and the command line of a stranger can be made to match.
    if ((await deps.startedAt(pid)) !== owner.startedAt) return null
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      deps.kill(pid, signal)
      for (let i = 0; i < 10; i++) {
        await deps.sleep(250)
        if (await deps.portFree(endpoint.host, endpoint.port)) { deps.clearOwner(); return { pid } }
      }
    }
    return null
  } catch { return null }
}
