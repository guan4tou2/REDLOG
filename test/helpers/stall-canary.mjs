import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function runRound(base, label, sync, { now = () => performance.now(), write = line => console.error(line), timestamp = () => new Date().toISOString().slice(11, 23) } = {}) {
  const steps = {}
  const step = (name, call) => {
    const start = now()
    try { return call() } finally { steps[name] = now() - start }
  }
  let dir, fd
  try {
    dir = step('mkdtemp', () => fs.mkdtempSync(path.join(base, 'redlog-stall-')))
    const file = path.join(dir, 'probe'), renamed = path.join(dir, 'renamed')
    fd = step('create', () => fs.openSync(file, 'wx'))
    const data = Buffer.alloc(4096)
    step('write', () => fs.writeFileSync(fd, data))
    if (sync) step('fsync', () => fs.fsyncSync(fd))
    step('close', () => fs.closeSync(fd))
    fd = undefined
    step('read', () => fs.readFileSync(file))
    step('rename', () => fs.renameSync(file, renamed))
    step('unlink', () => fs.unlinkSync(renamed))
    step('rmdir', () => fs.rmdirSync(dir))
    dir = undefined
    if (Object.values(steps).some(ms => ms >= 250)) write(`[canary] ${timestamp()} ${label} ${sync ? 'sync' : 'nosync'} ${JSON.stringify(steps)}`)
  } finally {
    // A failed step must not strand an open handle or its directory.
    try { if (fd !== undefined) fs.closeSync(fd) } finally {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function startCanary() {
  const bases = [['tmp', os.tmpdir()], ['repo', path.resolve('test-results')]]
  const errors = new Set()
  const report = error => {
    const message = error instanceof Error ? error.message : String(error)
    if (!errors.has(message)) {
      errors.add(message)
      console.error(`[canary] error ${message}`)
    }
  }
  console.error(`[canary] bases ${bases.map(([label, base]) => `${label}=${base}`).join(' ')}`)
  const parent = process.ppid
  const timer = setInterval(() => {
    if (process.ppid !== parent || process.ppid <= 1) { stop(); return }
    try { process.kill(parent, 0) } catch { stop(); return }
    for (const [label, base] of bases) {
      try { fs.mkdirSync(base, { recursive: true }) } catch (error) { report(error); continue }
      for (const sync of [true, false]) {
        try { runRound(base, label, sync) } catch (error) { report(error) }
      }
    }
  }, 500)
  const stop = () => {
    clearInterval(timer)
    for (const event of ['disconnect', 'SIGTERM', 'SIGINT']) process.removeListener(event, stop)
  }
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return stop
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.platform === 'win32' && process.env.CI) startCanary()
