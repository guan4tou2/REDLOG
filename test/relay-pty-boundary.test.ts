import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe.skipIf(process.platform === 'win32')('automatic relay PTY completion boundary', () => {
  it('finishes at EOF after an incomplete work directory is removed, without recreating it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-relay-abandon-'))
    const child = spawn('python3', ['hooks/redlog-relay.py', 'pty', '--dir', dir, '--err-fd', '3'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let output = ''
    child.stdout.on('data', b => { output += b })
    const writers: number[] = []
    try {
      await expect.poll(() => fs.existsSync(path.join(dir, 'pts'))).toBe(true)
      for (const name of fs.readFileSync(path.join(dir, 'pts'), 'utf8').split('\n')) writers.push(fs.openSync(name, 'w'))
      fs.writeFileSync(path.join(dir, 'opened'), '')
      fs.writeSync(writers[0], 'ready\n')
      await expect.poll(() => output).toContain('ready')
      // Omit the completion marker, like a failed drain; the owner is still
      // alive. Removing the work directory must release the background PTYs.
      for (const fd of writers.splice(0)) fs.closeSync(fd)
      fs.rmSync(dir, { recursive: true })
      expect(await finished).toBe(0)
      expect(fs.existsSync(dir)).toBe(false)
    } finally {
      for (const fd of writers) fs.closeSync(fd)
      child.kill('SIGKILL')
      await finished
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['eof', 'eio'] as const)('keeps both writable streams after a transient %s before shell completion', async (fault) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-relay-boundary-'))
    const wrapper = `
import errno, importlib.util, sys
spec = importlib.util.spec_from_file_location('relay', 'hooks/redlog-relay.py')
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
original = relay.Stream.pump
injected = False
def pump(self):
    global injected
    if not injected:
        injected = True
        print('INJECTED_${fault}', file=sys.stderr, flush=True)
        ${fault === 'eio' ? "raise OSError(errno.EIO, 'transient read')" : 'return False'}
    return original(self)
relay.Stream.pump = pump
sys.exit(relay.pty_pipe(sys.argv[1:]))
`
    const child = spawn('python3', ['-c', wrapper, '--dir', dir, '--err-fd', '3', '--max-bytes', '4096'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let diagnostic = '', stdout = '', stderr = ''
    child.stderr.on('data', b => { diagnostic += b })
    child.stdout.on('data', b => { stdout += b })
    child.stdio[3]?.on('data', b => { stderr += b })
    const writers: number[] = []
    try {
      await expect.poll(() => fs.existsSync(path.join(dir, 'pts'))).toBe(true)
      const names = fs.readFileSync(path.join(dir, 'pts'), 'utf8').split('\n')
      for (const name of names) writers.push(fs.openSync(name, 'w'))
      fs.writeFileSync(path.join(dir, 'opened'), '')
      fs.writeSync(writers[0], 'initial-out\n')
      fs.writeSync(writers[1], 'initial-err\n')
      await expect.poll(() => diagnostic).toContain(`INJECTED_${fault}`)
      // The shell still owns both descriptors. A read-side EOF/EIO must not
      // close their masters and make the next real write fail with EIO.
      expect(() => {
        fs.writeSync(writers[0], 'later-out\n')
        fs.writeSync(writers[1], 'later-err\n')
      }).not.toThrow()
      for (const fd of writers.splice(0)) fs.closeSync(fd)
      fs.writeFileSync(path.join(dir, 'closed'), '')
      expect(await finished).toBe(0)
      expect(stdout).toContain('initial-out')
      expect(stdout).toContain('later-out')
      expect(stderr).toContain('initial-err')
      expect(stderr).toContain('later-err')
      const out = JSON.parse(fs.readFileSync(path.join(dir, 'stdout.json'), 'utf8'))
      const err = JSON.parse(fs.readFileSync(path.join(dir, 'stderr.json'), 'utf8'))
      expect(out).toMatchObject({ text: 'initial-out\nlater-out\n', bytes: Buffer.byteLength(stdout), truncated: false })
      expect(err).toMatchObject({ text: 'initial-err\nlater-err\n', bytes: Buffer.byteLength(stderr), truncated: false })
    } finally {
      for (const fd of writers) fs.closeSync(fd)
      child.kill('SIGKILL')
      await finished
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
