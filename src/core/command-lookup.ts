// Is a command available on PATH? Answered from the filesystem, without
// spawning `which` / `where`.
//
// Spawning cost a process per probe — on Windows a process start plus an
// antivirus scan, often hundreds of milliseconds — and detectHooks() probes
// every command a hook declares, synchronously, from capture health on the
// main thread. The first probe after launch could stall the UI for seconds.
//
// The name comes from a plugin manifest's `requires[]`, so it is untrusted:
// only a bare command name is looked up; anything with a path separator or
// shell syntax is "not available", never interpreted.

import fs from 'fs'
import path from 'path'

const BARE_NAME = /^[A-Za-z0-9._+-]+$/

export interface LookupOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; delimiter?: string }

/** Whether `cmd` is a name this module will look up at all. Tool detection
 *  uses it to tell "not checked" from "checked and absent". */
export function isBareCommandName(cmd: string): boolean {
  return BARE_NAME.test(cmd)
}

/** The PATH directories and the file names to try in each, in lookup order. */
function lookupPlan(cmd: string, opts: LookupOptions): { win: boolean; dirs: string[]; names: string[] } | null {
  if (!BARE_NAME.test(cmd)) return null
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const win = platform === 'win32'
  const delimiter = opts.delimiter ?? (win ? ';' : ':')
  // Windows environments spell it `Path`; env lookups there are
  // case-insensitive, a plain object is not.
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const names = win
    ? [cmd, ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => cmd + ext)]
    : [cmd]
  return { win, dirs, names }
}

export function isOnPath(cmd: string, opts: LookupOptions = {}): boolean {
  const plan = lookupPlan(cmd, opts)
  if (!plan) return false
  for (const dir of plan.dirs) {
    for (const name of plan.names) {
      if (isExecutableFile(path.join(dir, name), plan.win)) return true
    }
  }
  return false
}

/** Where `cmd` is on PATH, or null — the same answer as `isOnPath`, with the
 *  path, without blocking the event loop, and over absolute PATH entries only
 *  (a relative entry means something different in every process that reads
 *  it). Rejects with the signal's reason once it aborts. */
export async function findOnPath(cmd: string, opts: LookupOptions & { signal?: AbortSignal } = {}): Promise<string | null> {
  const plan = lookupPlan(cmd, opts)
  if (!plan) return null
  const { win, dirs, names } = plan
  for (const dir of dirs) {
    if (!path.isAbsolute(dir) && !(win && path.win32.isAbsolute(dir))) continue
    for (const name of names) {
      opts.signal?.throwIfAborted()
      const candidate = path.join(dir, name)
      if (await isExecutableFileAsync(candidate, win)) return candidate
    }
  }
  return null
}

function isExecutableFile(p: string, win: boolean): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false
    // Windows has no execute bit; PATHEXT decides what runs.
    if (!win) fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch (e) {
    return win && (e as NodeJS.ErrnoException).code === 'EACCES' && isAppExecutionAlias(p)
  }
}

async function isExecutableFileAsync(p: string, win: boolean): Promise<boolean> {
  try {
    if (!(await fs.promises.stat(p)).isFile()) return false
    if (!win) await fs.promises.access(p, fs.constants.X_OK)
    return true
  } catch (e) {
    return win && (e as NodeJS.ErrnoException).code === 'EACCES' && await isAppExecutionAliasAsync(p)
  }
}

async function isAppExecutionAliasAsync(p: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

// A Microsoft Store pwsh / python3 / wsl on PATH is an App Execution Alias: a
// reparse point only the AppX layer resolves. stat() on it throws EACCES — "it
// is there, you may not look" — though the command runs. lstat() succeeds and
// reports a symlink, which is how it is told apart from a file that is
// genuinely unreadable.
function isAppExecutionAlias(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
