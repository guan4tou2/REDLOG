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
import { createServer as netCreateServer, type Socket } from 'net'
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

// Only when the shell is on the other side of `wsl.exe`.
//
// Vitest runs test FILES in parallel, and there are now five of them driving a
// shell. On Linux that is five zsh processes and nothing notices. Through WSL
// interop it is five concurrent `wsl.exe` sessions, and the service starts
// refusing them: `Wsl/Service/0x8007274c` (a timeout), returned as an error
// message on stdout in the console code page, which then arrives spliced into
// the next command line as mojibake. It presents as a python3 that cannot open
// a garbled path — a failure that names everything except what went wrong.
//
// So the WSL work is serialised across processes by a directory, which is
// atomic to create. CI is unaffected: on ubuntu `prefix` is empty, no lock is
// taken, and the files run in parallel as before.
const WSL_LOCK = path.join(os.tmpdir(), 'redlog-wsl-harness.lock')
const LOCK_STALE_MS = 5 * 60_000

async function withWslLock<T>(target: ShellTarget, fn: () => Promise<T>): Promise<T> {
  if (target.prefix.length === 0) return fn()
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    try {
      fs.mkdirSync(WSL_LOCK)
      break
    } catch {
      // A holder that died takes its lock with it, eventually: a worker killed
      // mid-run would otherwise wedge every later file.
      try {
        if (Date.now() - fs.statSync(WSL_LOCK).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(WSL_LOCK, { recursive: true, force: true })
          continue
        }
      } catch { continue }
      if (Date.now() > deadline) throw new Error('WSL harness lock never freed')
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150))
    }
  }
  try {
    return await fn()
  } finally {
    try { fs.rmSync(WSL_LOCK, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}

/** One `wsl.exe` for the whole probe, retried.
 *
 *  It used to be one per command, run at module load, in five test files that
 *  vitest starts at the same moment — ten concurrent interop sessions before
 *  a single test had run. A refused probe does not fail: it makes
 *  `findShellTarget` return null and the file SKIP, which reads as green.
 *  That is the worst outcome available here, so it retries rather than
 *  concluding the machine has no zsh. */
function wslProbe(distro: string, commands: string[]): boolean {
  const script = commands.map((c) => `command -v ${c} >/dev/null`).join(' && ')
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', script], { encoding: 'utf8' })
    if (r.status === 0) return true
    // `wsl.exe` reports its own failures (`Wsl/Service/0x8007274c`) on stdout
    // in the console code page, with a non-zero status — indistinguishable
    // from "the command is not installed" except by trying again.
    spawnSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak'], { stdio: 'ignore' })
  }
  return false
}

/** `C:\x\y` → `/mnt/c/x/y`, in process.
 *
 *  This was `wsl.exe wslpath`, one interop session per path, several per test
 *  file and none of them under the lock below — the storm that the lock was
 *  added to stop was mostly these. The translation is fixed and documented;
 *  spawning a Linux process to perform it was never buying anything. */
function toWslPath(p: string): string {
  const win = path.resolve(p).replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(win)
  return drive ? `/mnt/${drive[1].toLowerCase()}/${win.slice(3)}` : win
}

/** The shell this machine can actually drive, or null — which is a skip, not
 *  a failure: the adapter is POSIX-only by FR-019, and saying so is honest. */
export function findShellTarget(): ShellTarget | null {
  if (process.platform !== 'win32') {
    const zsh = spawnSync('command', ['-v', 'zsh'], { encoding: 'utf8', shell: true })
    if (zsh.status !== 0 || !zsh.stdout.trim()) return null
    return { prefix: [], toShellPath: (p) => p, label: 'local zsh' }
  }
  if (!wslProbe(WSL_DISTRO, ['zsh', 'python3'])) return null
  return {
    prefix: ['wsl', '-d', WSL_DISTRO, '--'],
    toShellPath: toWslPath,
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

/** A port that accepts and then says nothing, forever.
 *
 *  This is not a hypothetical: it is how the harness itself behaved while
 *  `runZsh` still used `spawnSync` — the collector was in a blocked event
 *  loop, so it completed the TCP handshake and never replied. `curl
 *  --connect-timeout` is satisfied by the handshake, so an unbounded probe
 *  waits on this for as long as the socket stays open. Any RedLog that is
 *  mid-crash, swapped out, or whose port has been inherited looks exactly
 *  like this from the shell's side. */
export async function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const held: Socket[] = []
  const server = netCreateServer((socket) => { held.push(socket) })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of held) socket.destroy()
      server.close(() => resolve())
    })
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
  const run = await withWslLock(target, () => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), (opts.timeoutSeconds ?? 20) * 1000 + 10_000)
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }) })
    child.stdin.end(job)
  }))
  if (run.status !== 0 || !run.stdout) {
    return {
      ok: false, steps: [], transcript: run.stderr, marker: '',
      error: `driver exited ${run.status}: ${run.stderr.slice(0, 400)}`
    }
  }
  return JSON.parse(run.stdout) as ZshReport
}

export interface ShellRun {
  status: number | null
  stdout: string
  stderr: string
  /** When the first byte of stdout arrived, or null if none did. Streaming is
   *  part of the relay's contract — the operator watches a long command run —
   *  and only a timestamp can tell "streamed" from "flushed at exit". */
  firstStdoutAt: number | null
  startedAt: number
  endedAt: number
}

/** Run one bash script on the target shell. No pty: this is for the pieces
 *  that do not depend on an interactive shell, where a pty only adds echo and
 *  line discipline to reason about. Temp files the script makes belong on the
 *  shell's own filesystem — see the note in zsh-pty.py about the 9p mount.
 *
 *  The script travels as a FILE, never as `bash -c <string>`. Between Node's
 *  Windows argument quoting and `wsl.exe` re-parsing the command line, a
 *  script passed that way arrives subtly altered: `$?` and `"$var"` came
 *  through emptied, which reads as a shell that returns 0 for everything.
 *  `runZsh` hands its job over stdin for the same reason. */
export async function runInShell(
  target: ShellTarget,
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ShellRun> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-script-')), 'run.sh')
  fs.writeFileSync(file, script.replace(/\r\n/g, '\n'), 'utf8')
  const argv = [...target.prefix, 'bash', target.toShellPath(file)]
  // Inside the lock, so `startedAt` measures the shell and not the queue —
  // the streaming assertions compare against it.
  return withWslLock(target, () => new Promise<ShellRun>((resolve) => {
    const startedAt = Date.now()
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env }
    })
    let stdout = ''
    let stderr = ''
    let firstStdoutAt: number | null = null
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000)
    child.stdout.on('data', (c) => { firstStdoutAt ??= Date.now(); stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (status) => {
      clearTimeout(killer)
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
      resolve({ status, stdout, stderr, firstStdoutAt, startedAt, endedAt: Date.now() })
    })
  }))
}

/** The repository's own hook files, as the shell sees them. */
export function hookPath(target: ShellTarget, file: string): string {
  return target.toShellPath(path.join(__dirname, '..', '..', 'hooks', file))
}
