// The Node side of spec 052's shell harness: find a zsh, drive it through
// test/helpers/zsh-pty.py, and give the test the events the adapter sent.
//
// Why a separate process at all is argued in zsh-pty.py. Why it may be a
// *Windows* process talking to a Linux one: this repository is developed on
// Windows, and the delivery target is Kali. `wsl -d kali-linux` is the target
// platform, locally, so the harness uses it rather than declaring the feature
// untestable on the machine it is being written on.
import { spawn, spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ZshStep { command: string; output: string }
export interface ZshReport {
  ok: boolean
  steps: ZshStep[]
  error?: string
  exit_code?: number
  transcript: string
  marker: string
}

export interface ShellTarget {
  /** How to run a Linux command: argv prefix, empty when we are already on Linux. */
  prefix: string[]
  /** Turns a path on this filesystem into one the shell can open. */
  toShellPath: (p: string) => string
  label: string
}

const WSL_DISTRO = 'kali-linux'

function wslHas(distro: string, cmd: string): boolean {
  const r = spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim().length > 0
}

/** The shell this machine can actually drive, or null — which is a skip, not
 *  a failure: the adapter is POSIX-only by FR-019, and saying so is honest. */
export function findShellTarget(): ShellTarget | null {
  if (process.platform !== 'win32') {
    const zsh = spawnSync('command', ['-v', 'zsh'], { encoding: 'utf8', shell: true })
    if (zsh.status !== 0 || !zsh.stdout.trim()) return null
    return { prefix: [], toShellPath: (p) => p, label: 'local zsh' }
  }
  if (!wslHas(WSL_DISTRO, 'zsh') || !wslHas(WSL_DISTRO, 'python3')) return null
  return {
    prefix: ['wsl', '-d', WSL_DISTRO, '--'],
    toShellPath: (p) => {
      const r = spawnSync('wsl', ['-d', WSL_DISTRO, '--', 'wslpath', '-a', p.replace(/\\/g, '/')], { encoding: 'utf8' })
      return r.stdout.trim()
    },
    label: `wsl ${WSL_DISTRO}`
  }
}

export interface CapturedEvent { agentType: string; data: Record<string, unknown>; receivedAt: number }

/** Stands in for the running app: the two endpoints `hooks/shell-common.sh`
 *  reaches for, and nothing else. Bound on every interface because under WSL
 *  the shell is on the other side of a virtual switch and resolves the host by
 *  the default gateway — the hook already does that, so the harness does not
 *  have to teach it anything. */
export async function startCollector(token: string): Promise<{
  port: number; events: CapturedEvent[]; close: () => Promise<void>
}> {
  const events: CapturedEvent[] = []
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return }
    if (req.url?.startsWith('/api/health')) { res.writeHead(200).end('{"ok":true}'); return }
    if (req.url?.startsWith('/api/events') && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { agent_type?: string; agentType?: string; data?: Record<string, unknown> }
          events.push({
            agentType: String(parsed.agent_type ?? parsed.agentType ?? ''),
            data: parsed.data ?? {},
            receivedAt: Date.now()
          })
          res.writeHead(201).end('{"ok":true}')
        } catch { res.writeHead(400).end('{}') }
      })
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export interface ZshRunOptions {
  /** Lines written into the generated .zshrc before the commands run. */
  rc?: string
  commands: string[]
  /** Written into <home>/.redlog so the adapter believes RedLog is running. */
  redlog?: { port: number; token: string }
  timeoutSeconds?: number
}

/** One throwaway HOME, one interactive zsh, one report.
 *
 *  The HOME is made by the driver, on the shell's own filesystem — not here.
 *  Handing a Windows path across `wsl` put it on the 9p mount, where the rc,
 *  `.redlog`, zsh's compdump and the adapter's spool all became network reads:
 *  one command took over thirty seconds that way and six when the same HOME
 *  was local, which reads as a hung adapter rather than as a slow mount. */
export async function runZsh(target: ShellTarget, opts: ZshRunOptions): Promise<ZshReport> {
  const driver = target.toShellPath(path.join(__dirname, 'zsh-pty.py'))
  const job = JSON.stringify({
    rc: opts.rc ?? '',
    redlog: opts.redlog,
    commands: opts.commands,
    timeout_s: opts.timeoutSeconds ?? 20
  })

  // Asynchronous on purpose. `spawnSync` blocks this process — including the
  // collector above, which lives in it — so the adapter's POST connects and
  // then waits for a reply that cannot come until the shell has exited. The
  // shell waits on curl, curl waits on us, we wait on the shell. It presents
  // as "no prompt after <command>" thirty seconds later, which looks like a
  // hung adapter and is not.
  const argv = [...target.prefix, 'python3', driver]
  const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), (opts.timeoutSeconds ?? 20) * 1000 + 10_000)
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }) })
    child.stdin.end(job)
  })
  if (run.status !== 0 || !run.stdout) {
    return {
      ok: false, steps: [], transcript: run.stderr, marker: '',
      error: `driver exited ${run.status}: ${run.stderr.slice(0, 400)}`
    }
  }
  return JSON.parse(run.stdout) as ZshReport
}

/** The repository's own hook files, as the shell sees them. */
export function hookPath(target: ShellTarget, file: string): string {
  return target.toShellPath(path.join(__dirname, '..', '..', 'hooks', file))
}
