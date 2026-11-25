import { beforeEach, afterEach, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'

// A terminal app that integrates with the shell starts PowerShell as
// `pwsh -NoExit -Command "<its setup>"`: probe the language mode, wrap the
// `prompt` function, load its own script. PowerShell puts that string in the
// session history like a line read at a prompt, and the hook reported the
// newest history entry at every prompt — so the first prompt of the shell sent
// the app's setup line as a command the operator ran. Two apps on one Windows
// machine did it, each with its own line (#886).
//
// What tells the two apart is not the text. The host draws a prompt before it
// reads anything, so whatever is in history at this shell's first prompt was
// handed over by whatever started the shell, and nobody typed it.
//
// With no RedLog running there is no api-port file, so the hook spools each
// event to ~/.redlog/pending under the temporary home, which is what is read
// back here. `-NoProfile` throughout: the operator's own profile sources the
// installed hook, and that one posts to their open project.

const HOOK = path.resolve(__dirname, '..', 'hooks', 'shell-hook.ps1')

const pwsh = requires('pwsh')
// Windows PowerShell 5.1 as well where the machine has it; the hook supports both.
const shells = pwsh.ok
  ? ['pwsh', 'powershell'].filter((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0)
  : ['pwsh']

// The lines the two apps were seen to send, reduced to what they do, and one
// that reads like work. None of them is known to the hook.
const STARTUP_LINES = {
  'wraps the prompt function': '$global:__app_prompt = $function:prompt; function global:prompt { $p = & $global:__app_prompt; $p }',
  'probes the language mode': "try { if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'ConstrainedLanguage' }; $global:__app_ready = $true } catch { }",
  'reads like a command': 'Write-Output handed-over-at-startup'
} as const

interface Recorded { subtype: string; command: string }

/** Start `exe` the way a terminal app does, with `startup` on the command line
 *  after the hook is loaded, type `typed` at it, and return what was recorded. */
async function runShell(exe: string, home: string, startup: string, typed: string[]): Promise<Recorded[]> {
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${HOOK}'; ${startup}`], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => undefined)
  child.stderr.on('data', () => undefined)
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  // Written before the shell has started: the operator who types at once.
  for (const c of typed) child.stdin.write(`${c}\n`)
  child.stdin.end()
  await closed
  const pending = path.join(home, '.redlog', 'pending')
  if (!fs.existsSync(pending)) return []
  return fs.readdirSync(pending).filter((f) => f.endsWith('.json')).sort()
    .map((f) => (JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')) as { data: Recorded }).data)
}

const starts = (events: Recorded[]): string[] => events.filter((e) => e.subtype === 'command_start').map((e) => e.command)
const ends = (events: Recorded[]): string[] => events.filter((e) => e.subtype === 'command_end').map((e) => e.command)

pwsh.describe.each(shells)('%s started with a setup line on its command line', (ps) => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-psstart-'))
    fs.mkdirSync(path.join(home, '.redlog'), { recursive: true })
    fs.writeFileSync(path.join(home, '.redlog', 'active-identity.json'), JSON.stringify({ engagementId: 'eng-1', operatorId: 'op-1' }))
  })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  for (const [what, line] of Object.entries(STARTUP_LINES)) {
    pwsh.it(`records nothing when the shell is opened and closed (the line ${what})`, async () => {
      expect(await runShell(ps, home, line, [])).toEqual([])
    }, 60_000)

    pwsh.it(`records what is typed, from the first command on, and not the line that ${what}`, async () => {
      const events = await runShell(ps, home, line, ['Write-Output first', 'Write-Output second'])
      expect(starts(events)).toEqual(['Write-Output first', 'Write-Output second'])
      expect(ends(events)).toEqual(['Write-Output first', 'Write-Output second'])
    }, 60_000)
  }

  // Only the shell's first prompt is a starting line. A profile reloaded, or a
  // script of the operator's that sources the hook again, was typed at a prompt.
  pwsh.it('still records a typed line that loads the hook a second time', async () => {
    const again = `. '${HOOK}'; Write-Output reloaded`
    const events = await runShell(ps, home, STARTUP_LINES['wraps the prompt function'], ['Write-Output before', again, 'Write-Output after'])
    expect(starts(events)).toEqual(['Write-Output before', again, 'Write-Output after'])
    expect(ends(events)).toEqual(['Write-Output before', again, 'Write-Output after'])
  }, 60_000)
})
