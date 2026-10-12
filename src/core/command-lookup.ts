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

export function isOnPath(
  cmd: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; delimiter?: string } = {}
): boolean {
  if (!BARE_NAME.test(cmd)) return false
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
  for (const dir of dirs) {
    for (const name of names) {
      if (isExecutableFile(path.join(dir, name), win)) return true
    }
  }
  return false
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
