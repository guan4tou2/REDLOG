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
  // With stdin piped, PSReadLine's ReadLine fails after every prompt and adds
  // an error no command made. A real console has no such error, and the hook
  // reads `$Error` to tell a failed cmdlet from a repeated native code.
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `Remove-Module PSReadLine -ErrorAction SilentlyContinue; . '${HOOK}'`], {
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

/** Every spooled payload, in order, with the fields the timing test reads. */
function readSpooled(home: string): Array<{ subtype: string; command: string; source_timestamp?: number }> {
  const pending = path.join(home, '.redlog', 'pending')
  const files = fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith('.json')).sort() : []
  return files.map((f) => (JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')) as { data: { subtype: string; command: string; source_timestamp?: number } }).data)
}

// Register explicit skips when the runtime is absent, rather than declaring
// an empty file (which Vitest treats as a failed suite).
const describePowerShell = shells.length ? describe : describe.skip
describePowerShell.each(shells.length ? shells : ['PowerShell unavailable'])('the %s prompt hook records the real exit code', (ps) => {
  let home: string
  // The hook only spools while a project is open (active-identity.json).
  const openProject = (): void => {
    fs.mkdirSync(path.join(home, '.redlog'), { recursive: true })
    fs.writeFileSync(path.join(home, '.redlog', 'active-identity.json'), JSON.stringify({ engagementId: 'eng-1', operatorId: 'op-1' }))
  }
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pshook-')); openProject() })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('writes nothing to the spool when no project is open', () => {
    fs.rmSync(path.join(home, '.redlog', 'active-identity.json'))
    const script = `. '${HOOK.replace(/'/g, "''")}'; _RedLogSpoolPayload -Json '{"sequence":1}'`
    const result = spawnSync(ps, ['-NoProfile', '-Command', script], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.existsSync(path.join(home, '.redlog', 'pending'))).toBe(false)
  }, 60_000)

  it('keeps every offline payload even when the timestamp is identical', () => {
    const script = `. '${HOOK.replace(/'/g, "''")}'; function _RedLogTimestamp { '0000000179196240000' }; foreach ($n in 1..3) { _RedLogSpoolPayload -Json ('{"sequence":' + $n + '}') }`
    const result = spawnSync(ps, ['-NoProfile', '-Command', script], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const pending = path.join(home, '.redlog', 'pending')
    const files = fs.readdirSync(pending).filter(f => f.endsWith('.json'))
    expect(files).toHaveLength(3)
    const sequences = files.map(f => JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')).sequence).sort()
    expect(sequences).toEqual([1, 2, 3])
  }, 60_000)

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

  it('does not carry a native code onto a later failing cmdlet', async () => {
    // A failing cmdlet sets `$?` but leaves `$LASTEXITCODE` alone, so after
    // `exit 3` a failed Get-Item was recorded as 3. Found by the packaged
    // PowerShell matrix on v0.18.5, in both editions.
    const native = (n: string): string => `& ${ps} -NoProfile -Command "exit 3" # ${n}`
    const commands = [native('a'), 'Get-Item C:\\redlog-missing-a', native('b'), native('c'), 'Get-Item C:\\redlog-missing-b', 'Write-Output ok']
    const recorded = await runInteractive(ps, home, [...commands, 'exit'])
    expect(recorded.filter((r) => commands.includes(r.command)).map((r) => [r.command, r.exit_code])).toEqual([
      [native('a'), 3],
      ['Get-Item C:\\redlog-missing-a', 1],
      // The same native code twice running is still that code: an unchanged
      // `$LASTEXITCODE` means a failed cmdlet only when it left a new error.
      [native('b'), 3],
      [native('c'), 3],
      ['Get-Item C:\\redlog-missing-b', 1],
      ['Write-Output ok', 0]
    ])
  }, 60_000)

  it('stamps start and end with when they happened, not when the prompt drew', async () => {
    const before = Date.now()
    await runInteractive(ps, home, ['Start-Sleep -Seconds 2', 'exit'])
    const after = Date.now()
    const rows = readSpooled(home).filter((r) => r.command === 'Start-Sleep -Seconds 2')
    const start = rows.find((r) => r.subtype === 'command_start')?.source_timestamp
    const end = rows.find((r) => r.subtype === 'command_end')?.source_timestamp
    expect(start, 'command_start has no source_timestamp').toBeTypeOf('number')
    expect(end, 'command_end has no source_timestamp').toBeTypeOf('number')
    // The start row is at the start, so it precedes the end by the sleep.
    expect(end! - start!).toBeGreaterThanOrEqual(1500)
    expect(start!).toBeGreaterThanOrEqual(before - 1000)
    expect(end!).toBeLessThanOrEqual(after + 1000)
  }, 60_000)
})
