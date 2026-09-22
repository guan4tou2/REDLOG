import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// The suite spawns a real bash and drops a `#!/bin/sh` curl shim on PATH, so
// it is POSIX by construction — the describe has said so since it was written.
// Nothing enforced it, so the windows-latest leg of the CI matrix ran it, the
// shim never executed, and the assertion failed on the payload file that was
// therefore never written. The failure looked like a product bug in
// `redlog-run` and was a missing platform guard.
describe.skipIf(process.platform === 'win32')('POSIX redlog-run', () => {
  // These spawn a real bash and run the hook end to end. Alone the file takes
  // ~3.4s, which fits under vitest's 5s default — but vitest runs files in
  // parallel, and under that load the first one goes over and fails as a
  // timeout rather than on anything it asserts. Same shape as the tailer-seed
  // flake: a real-process test on the default budget. 30s is generous on
  // purpose; a genuine hang still ends the run, a busy CI box does not.
  it('streams output before exit and preserves separated event payloads', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-run-'))
    tempDirs.push(home)
    const redlogDir = path.join(home, '.redlog')
    const binDir = path.join(home, 'bin')
    const payloadFile = path.join(home, 'payloads.jsonl')
    fs.mkdirSync(redlogDir)
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(redlogDir, 'api-port'), '6660')
    fs.writeFileSync(path.join(redlogDir, 'api-token'), 'test-token')

    const curl = path.join(binDir, 'curl')
    fs.writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    printf '%s\\n' "$1" >> "$REDLOG_TEST_PAYLOADS"
  fi
  shift
done
exit 0
`)
    fs.chmodSync(curl, 0o755)

    const hook = path.resolve('hooks/shell-bash-hook.sh')
    const script = `source "$1"
redlog-run sh -c 'printf REDLOG_FIRST; sleep 1; printf REDLOG_SECOND; printf REDLOG_ERR >&2; exit 7'
exit $?
`
    const started = Date.now()
    const child = spawn('bash', ['-c', script, 'bash', hook], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        REDLOG_TEST_PAYLOADS: payloadFile
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let firstSeenAt: number | null = null
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (firstSeenAt === null && stdout.includes('REDLOG_FIRST')) firstSeenAt = Date.now()
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const finishedAt = Date.now()

    expect(exitCode).toBe(7)
    expect(stdout).toContain('REDLOG_FIRSTREDLOG_SECOND')
    expect(stderr).toContain('REDLOG_ERR')
    expect(firstSeenAt).not.toBeNull()
    expect(finishedAt - started).toBeGreaterThanOrEqual(900)
    // Assert the observable contract: the first chunk arrives while the
    // command is still running. An absolute spawn-time threshold is unstable
    // when the full suite starts many workers concurrently.
    expect(finishedAt - firstSeenAt!).toBeGreaterThan(200)

    const payloads = fs.readFileSync(payloadFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const end = payloads.find((payload) => payload.data?.subtype === 'command_end')
    expect(end?.data).toMatchObject({
      exit_code: 7,
      stdout: 'REDLOG_FIRSTREDLOG_SECOND',
      stderr: 'REDLOG_ERR',
      stdout_bytes: 25,
      stderr_bytes: 10,
      stdout_truncated: false,
      stderr_truncated: false,
      captured_by: 'redlog-run'
    })
  }, 30_000)

  it('runs transparently when RedLog credentials are unavailable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-run-offline-'))
    tempDirs.push(home)
    const hook = path.resolve('hooks/shell-bash-hook.sh')
    const script = `source "$1" >/dev/null
redlog-run sh -c 'printf OFFLINE_OK; exit 9'
exit $?
`
    const child = spawn('bash', ['-c', script, 'bash', hook], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    expect(exitCode).toBe(9)
    expect(stdout).toBe('OFFLINE_OK')
  })

  it.skipIf(spawnSync('zsh', ['-c', 'exit 0']).status !== 0)('loads the shared wrapper through the zsh adapter', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-run-zsh-'))
    tempDirs.push(home)
    const adapter = path.resolve('hooks/shell-zsh-hook.zsh')
    const script = `source "$1" >/dev/null
redlog-run sh -c 'printf ZSH_OK; exit 6'
exit $?
`
    const child = spawn('zsh', ['-c', script, 'zsh', adapter], {
      env: { ...process.env, HOME: home, SHELL: '/bin/zsh' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    expect(exitCode).toBe(6)
    expect(stdout).toBe('ZSH_OK')
  }, 30_000)
})
