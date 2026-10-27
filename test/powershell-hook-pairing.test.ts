import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { operationPairKey } from '../src/core/operation-pair-key'

// The prompt hook sent command_start and command_end with neither a command id
// nor a source session, so the Activity list could not pair them and every
// PowerShell command showed as two operations. Found in the 2026-10-27 Windows
// acceptance. The ids are minted by the shell, as the POSIX adapters do; the
// app still never pairs by PID.

const HOOK = path.resolve(__dirname, '..', 'hooks', 'shell-hook.ps1')
const shells = ['pwsh', 'powershell'].filter(
  (exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0
)

type Spooled = { subtype: string; command: string; shell: string; terminalId?: string; command_id?: string }

async function runShell(exe: string, home: string, commands: string[], env: Record<string, string> = {}): Promise<Spooled[]> {
  const before = new Set(fs.existsSync(path.join(home, '.redlog', 'pending')) ? fs.readdirSync(path.join(home, '.redlog', 'pending')) : [])
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${HOOK}'`], {
    env: { ...process.env, USERPROFILE: home, HOME: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => undefined)
  child.stderr.on('data', () => undefined)
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  for (const c of commands) child.stdin.write(`${c}\n`)
  child.stdin.end()
  await closed
  const pending = path.join(home, '.redlog', 'pending')
  return fs.readdirSync(pending).filter((f) => f.endsWith('.json') && !before.has(f)).sort()
    .map((f) => (JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')) as { data: Spooled }).data)
}

const pairKey = (d: Spooled): string | null =>
  operationPairKey({ engagementId: 'eng-1', sessionId: 'capture-1', agentType: 'shell', data: d })

const describePowerShell = shells.length ? describe : describe.skip
describePowerShell.each(shells.length ? shells : ['PowerShell unavailable'])('the %s prompt hook pairs each command', (ps) => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pspair-'))
    fs.mkdirSync(path.join(home, '.redlog'), { recursive: true })
    fs.writeFileSync(path.join(home, '.redlog', 'active-identity.json'), JSON.stringify({ engagementId: 'eng-1', operatorId: 'op-1' }))
  })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('gives start and end of one command the same pair key, and each command its own', async () => {
    // -Command puts the dot-source itself in history; a $PROFILE load is not.
    const events = (await runShell(ps, home, ['Write-Output first', 'Write-Output second']))
      .filter((e) => e.command.startsWith('Write-Output'))
    const starts = events.filter((e) => e.subtype === 'command_start')
    const ends = events.filter((e) => e.subtype === 'command_end')
    expect(starts.map((e) => e.command)).toEqual(['Write-Output first', 'Write-Output second'])
    expect(ends).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      expect(pairKey(starts[i])).not.toBeNull()
      expect(pairKey(starts[i])).toBe(pairKey(ends[i]))
    }
    expect(pairKey(starts[0])).not.toBe(pairKey(starts[1]))
  }, 60_000)

  it('keeps one source session per shell, and a different one in another shell', async () => {
    const a = await runShell(ps, home, ['Write-Output a1', 'Write-Output a2'])
    const b = await runShell(ps, home, ['Write-Output b1'])
    expect(new Set(a.map((e) => e.terminalId)).size).toBe(1)
    expect(a[0].terminalId).toBeTruthy()
    expect(b[0].terminalId).toBeTruthy()
    expect(b[0].terminalId).not.toBe(a[0].terminalId)
  }, 60_000)

  it('uses the built-in terminal id when the app opened the shell', async () => {
    const events = await runShell(ps, home, ['Write-Output inside'], { REDLOG_TERMINAL_ID: 'term-42' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.terminalId === 'term-42')).toBe(true)
  }, 60_000)
})
