import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Owner-only modes for engagement data on POSIX. Windows has its own path
// (fs-acl.ts restrictToOwner), and node ignores `mode` there, so every function
// below is a no-op on win32.
//
// The modes are passed explicitly on each create instead of relying on the
// process umask: a umask of 077 in the main process would also be inherited by
// every terminal the app spawns, and change what the operator's own commands
// create.

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const EXEC_MODE = 0o700

/** Create `dir` and any missing parents owner-only. */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
}

let reported = false

/** chmod that never throws. A read-only filesystem or a mount where chmod does
 *  nothing must not stop the app; the first real failure is logged, the rest are
 *  not. A path that is not there has nothing to restrict. */
function chmodBestEffort(target: string, mode: number): void {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(target, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || reported) return
    reported = true
    console.warn(`[private-fs] could not restrict permissions (${code ?? 'unknown'}); later failures are not reported`)
  }
}

/** Create `file` empty if missing, owner-only. Used for the database so that
 *  SQLite derives the -wal and -shm modes from it. */
export function ensurePrivateFile(file: string): void {
  if (process.platform === 'win32') return
  try {
    fs.closeSync(fs.openSync(file, 'a', FILE_MODE))
  } catch { /* the open that follows reports a real problem */ }
  chmodBestEffort(file, FILE_MODE)
}

/** Restrict an existing file to the owner. */
export function restrictFile(file: string): void {
  chmodBestEffort(file, FILE_MODE)
}

/** Restrict a directory and everything under it: directories 0700, files 0600,
 *  keeping the owner's execute bit on a file that has one. Symlinks are skipped. */
export function restrictTree(root: string): void {
  if (process.platform === 'win32') return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  chmodBestEffort(root, DIR_MODE)
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      restrictTree(full)
    } else if (entry.isFile()) {
      let executable = false
      try { executable = (fs.statSync(full).mode & 0o100) !== 0 } catch { continue }
      chmodBestEffort(full, executable ? EXEC_MODE : FILE_MODE)
    }
  }
}

/** Startup pass for installs made before these modes were passed at creation:
 *  ~/.redlog, the projects directory, each project directory, its database
 *  files and exports, and the spool. Creates ~/.redlog when it is missing so
 *  that nothing else creates it first with the umask's mode. */
export function restrictRedlogHome(home: string = os.homedir()): void {
  if (process.platform === 'win32') return
  const root = path.join(home, '.redlog')
  try { mkdirPrivate(root) } catch { /* reported by whatever needs it next */ }
  chmodBestEffort(root, DIR_MODE)
  chmodBestEffort(path.join(root, 'projects.json'), FILE_MODE)

  const projects = path.join(root, 'projects')
  chmodBestEffort(projects, DIR_MODE)
  let names: string[] = []
  try { names = fs.readdirSync(projects) } catch { /* no projects yet */ }
  for (const name of names) {
    const project = path.join(projects, name)
    chmodBestEffort(project, DIR_MODE)
    for (const suffix of ['', '-wal', '-shm']) chmodBestEffort(path.join(project, `timeline.db${suffix}`), FILE_MODE)
    restrictTree(path.join(project, 'exports'))
  }

  restrictTree(path.join(root, 'pending'))
  restrictTree(path.join(root, 'inflight'))
}
