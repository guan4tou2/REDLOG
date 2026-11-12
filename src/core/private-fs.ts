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

// Atomics.wait is allowed on the main thread of a Node process, which is what
// the Electron main process and the vitest worker both are (it is only the
// browser's main thread and a renderer that refuse it). So the wait is a real
// sleep, with no busy loop; if some host did refuse it, it would throw out of
// retryBusy into the callers' catch, and the write is reported as not done.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Run a file operation, trying it again a few times when Windows says the file
 *  is busy. A rename or an unlink onto a file another process holds open (the
 *  relay under WSL, an antivirus scan) fails with EPERM, EBUSY or EACCES for a
 *  moment. Any other error, and the last of these, is thrown. */
export function retryBusy(op: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      op()
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      sleepSync(25 * (attempt + 1))
    }
  }
}

/** Replace `target` with `text`, owner-only, so that a reader — or the next
 *  start after a crash — finds the old bytes or the new ones and never a mix.
 *
 *  The text goes to a temp file in the same directory (a rename is atomic only
 *  within one filesystem), is flushed to disk, then renamed over the target.
 *  On any failure the temp file is removed and the target is untouched. On
 *  Windows the rename is a replace that a reader holding the target open
 *  without delete sharing refuses; that is retried briefly and then thrown,
 *  leaving the old file. */
export function writePrivateFileAtomic(target: string, text: string): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  // A rename needs only the directory to be writable. A target the owner made
  // read-only refused the old in-place write, and still refuses this one.
  try { fs.accessSync(target, fs.constants.W_OK) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'wx', FILE_MODE)
    fs.writeFileSync(fd, text, 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    retryBusy(() => fs.renameSync(tmp, target))
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already reported by the throw below */ } }
    try { fs.rmSync(tmp, { force: true }) } catch { /* a leftover temp file is harmless */ }
    throw e
  }
  // The rename itself is durable once the directory entry is. Windows cannot
  // open a directory for this, and NTFS journals the rename anyway.
  if (process.platform !== 'win32') {
    try { const dirFd = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) } } catch { /* best effort */ }
  }
  chmodBestEffort(target, FILE_MODE)
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
    for (const suffix of ['', '-wal', '-shm']) {
      chmodBestEffort(path.join(project, `timeline.db${suffix}`), FILE_MODE)
      chmodBestEffort(path.join(project, `cast-index.db${suffix}`), FILE_MODE)
    }
    chmodBestEffort(path.join(project, 'config.yaml'), FILE_MODE)
    restrictTree(path.join(project, 'exports'))
  }

  restrictTree(path.join(root, 'pending'))
  restrictTree(path.join(root, 'inflight'))
}
