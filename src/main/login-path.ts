// The operator's PATH, for an app started from the Dock / Finder / a desktop
// launcher. Those inherit launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so `mitmdump` from `uv tool install` (~/.local/bin) or Homebrew
// (/opt/homebrew/bin) is invisible: the managed proxy reports "unavailable" and
// capture health reports tools missing that the operator did install.
//
// Resolved once at startup, asynchronously: ask the login shell for its PATH
// (between markers, so rc-file output is ignored), then append well-known tool
// directories that exist. Entries are only ever added, never removed or
// reordered. Any failure — no $SHELL, a slow rc file, a broken shell — leaves
// PATH as it was. Windows GUI apps get the full user PATH already: no-op.
//
// The PATH itself is never logged; only how many entries were added.

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

const TIMEOUT_MS = 3000

type RunShell = (shell: string, args: string[], timeoutMs: number) => Promise<string | null>

/** Existing PATH first, then the shell's entries, then candidate dirs that
 *  exist — de-duplicated, first occurrence wins, empty segments dropped. */
export function _mergePath(
  current: string,
  shellPath: string | null,
  candidates: readonly string[],
  exists: (dir: string) => boolean
): string {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (dir: string): void => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    out.push(dir)
  }
  for (const dir of current.split(':')) add(dir)
  for (const dir of (shellPath ?? '').split(':')) add(dir)
  for (const dir of candidates) if (!seen.has(dir) && exists(dir)) add(dir)
  return out.join(':')
}

/** Spawn a shell and return its stdout, or null on failure or timeout. The
 *  child gets its own process group so a timeout kills whatever the rc files
 *  started too; the promise settles on the timer, not on pipe close. */
export function _runShell(shell: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let out = ''
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: process.env })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      // Interactive shells ignore SIGTERM.
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      finish(null)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { out += chunk })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
    child.unref()
  })
}

/** The login shell's PATH, or null. `printenv` rather than `echo $PATH` so a
 *  fish login shell answers colon-separated like the rest. */
export async function _resolveLoginShellPath(
  shell: string | undefined,
  opts: { run?: RunShell; timeoutMs?: number } = {}
): Promise<string | null> {
  if (!shell || !path.isAbsolute(shell)) return null
  const run = opts.run ?? _runShell
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const tag = crypto.randomBytes(6).toString('hex')
  const start = `__REDLOG_PATH_START_${tag}__`
  const end = `__REDLOG_PATH_END_${tag}__`
  const script = `echo ${start}; /usr/bin/printenv PATH; echo ${end}`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const out = await Promise.race([
      run(shell, ['-ilc', script], timeoutMs),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    ])
    if (!out) return null
    const i = out.indexOf(start)
    const j = out.indexOf(end, i + start.length)
    if (i < 0 || j < 0) return null
    const value = out.slice(i + start.length, j).trim()
    return value || null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve the operator's PATH and widen `env.PATH` with it. Resolves true
 *  when PATH changed. */
export async function applyLoginPath(deps: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: RunShell
  timeoutMs?: number
  exists?: (dir: string) => boolean
  home?: string
} = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') return false
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const exists = deps.exists ?? ((dir: string) => { try { return fs.statSync(dir).isDirectory() } catch { return false } })
  const shellPath = await _resolveLoginShellPath(env.SHELL, { run: deps.run, timeoutMs: deps.timeoutMs })
  const candidates = [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const current = env.PATH ?? ''
  const next = _mergePath(current, shellPath, candidates, exists)
  if (next === current) return false
  const added = next.split(':').length - current.split(':').filter(Boolean).length
  env.PATH = next
  console.log(`[login-path] PATH widened by ${added} entr${added === 1 ? 'y' : 'ies'}${shellPath ? '' : ' (login shell unavailable)'}`)
  return true
}
