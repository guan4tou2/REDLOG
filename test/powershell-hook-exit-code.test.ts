import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The prompt hook reads two things about the command that just ran: `$?` and
// `$LASTEXITCODE`. `$?` describes only the *previous statement*, so reading it
// after any other statement — including `$lastExit = $LASTEXITCODE` — returns
// the success of that assignment, which is always true. The hook shipped with
// the assignment first, so every failing command was recorded as exit 0:
// `cmd /c exit 3` and a missing path both came back `exit_code: 0`. Found on a
// packaged Windows build, not by any test, because nothing ran the hook.
//
// With no RedLog running there is no api-port file, so the hook spools each
// event to ~/.redlog/pending — which lets the test read what was recorded
// without starting the app.

const HOOK = path.resolve(__dirname, '..', 'hooks', 'shell-hook.ps1')

// Both editions the hook claims to support: Windows PowerShell 5.1 is what a
// stock Windows box runs, pwsh is what everything else has.
const shells = ['pwsh', 'powershell'].filter(
  (exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0
)

interface Recorded { command: string; exit_code?: number }

async function runInteractive(exe: string, home: string, commands: string[]): Promise<Recorded[]> {
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${HOOK}'`], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => undefined)
  child.stderr.on('data', () => undefined)
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  for (const c of commands) child.stdin.write(`${c}\n`)
  child.stdin.end()
  await closed

  const pending = path.join(home, '.redlog', 'pending')
  const files = fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith('.json')).sort() : []
  const out: Recorded[] = []
  for (const f of files) {
    const body = JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')) as { data: { subtype: string; command: string; exit_code?: number } }
    if (body.data.subtype === 'command_end') out.push({ command: body.data.command, exit_code: body.data.exit_code })
  }
  return out
}

// Register explicit skips when the runtime is absent, rather than declaring
// an empty file (which Vitest treats as a failed suite).
const describePowerShell = shells.length ? describe : describe.skip
describePowerShell.each(shells.length ? shells : ['PowerShell unavailable'])('the %s prompt hook records the real exit code', (ps) => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pshook-')) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('records a failing native command with its own code, and a success as 0', async () => {
    // A native child that exits 3, using the shell under test so it exists on
    // every platform this runs on.
    const native = `& ${ps} -NoProfile -Command "exit 3"`
    const recorded = await runInteractive(ps, home, [native, 'Write-Output fine', 'exit'])
    const byCommand = new Map(recorded.map((r) => [r.command, r.exit_code]))
    expect(byCommand.get(native)).toBe(3)
    expect(byCommand.get('Write-Output fine')).toBe(0)
  }, 60_000)

  it('records a failing cmdlet as non-zero rather than success', async () => {
    const failing = 'Get-Item (Join-Path $env:USERPROFILE does-not-exist)'
    const recorded = await runInteractive(ps, home, [failing, 'exit'])
    const code = recorded.find((r) => r.command === failing)?.exit_code
    expect(code).toBeDefined()
    expect(code).not.toBe(0)
  }, 60_000)

  it('does not carry a native failure forward into the next successful command', async () => {
    const native = `& ${ps} -NoProfile -Command "exit 5"`
    const recorded = await runInteractive(ps, home, [native, 'Write-Output after', 'exit'])
    const byCommand = new Map(recorded.map((r) => [r.command, r.exit_code]))
    expect(byCommand.get(native)).toBe(5)
    expect(byCommand.get('Write-Output after')).toBe(0)
  }, 60_000)
})
