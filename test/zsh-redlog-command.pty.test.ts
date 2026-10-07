import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// Spec 052 US2, T029/T030. The feature's first half removes the prefix; this
// half is what makes an operator willing to leave it on.
//
// An audit logger that cannot be stopped from inside the terminal it is
// logging is one that gets uninstalled before the engagement that needed it.
// `redlog stop` has to mean stopped — not "for this command", not "until the
// next prompt", and not "unless a subshell forgets". The state lives in a
// file, which is the only thing a new `preexec` in a shell that has kept no
// memory of the last one can read (FR-022), and it is the same file RedLog
// reads for the capture card, so the terminal and the card never disagree
// (FR-023, contracts/shell-commands.md rule 2).

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const commandsNamed = (events: CapturedEvent[], match: string): CapturedEvent[] =>
  events.filter((e) => e.agentType === 'shell'
    && String(e.data.command ?? '').includes(match))

describeShell(`the redlog command (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'us2-token'

  beforeAll(async () => { collector = await startCollector(token) })
  afterAll(async () => { await collector?.close() })

  describe('status', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'redlog status',
          'redlog stop',
          'redlog status',
          'cat $HOME/.redlog/terminals/*.json'
        ],
        redlog: {
          port: collector.port,
          token,
          identity: { engagementId: 'eng-us2', operatorId: 'op-us2' }
        },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('says whether it is recording, in what mode, and for which project', () => {
      expect(run.ok, run.error).toBe(true)
      const status = run.steps[0].output
      // FR-023. Three facts, because an operator who has to work out any of
      // them from the other two will not check at all.
      expect(status).toMatch(/recording/i)
      expect(status).toMatch(/auto/i)
      expect(status, 'the bound project is not named').toContain('eng-us2')
    })

    it('answers from the file RedLog reads, not from a shell variable', () => {
      // Rule 2 of contracts/shell-commands.md: the terminal and the capture
      // card must not be able to disagree. A variable would also survive the
      // subshell a naive test uses, so the discriminating evidence is that
      // the answer is on disk.
      expect(run.steps[2].output, 'status did not change after stop').toMatch(/stopped|not recording/i)
      const onDisk = run.steps[3].output
      expect(onDisk, 'no terminal state file was written').toContain('"recording"')
      expect(onDisk).toMatch(/"recording":\s*false/)
      expect(onDisk).toContain('eng-us2')
    })
  })

  describe('a stop that stays stopped', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'echo before-the-stop',
          'redlog stop',
          'echo after-stop-one',
          'echo after-stop-two',
          'redlog start',
          'echo after-the-start'
        ],
        redlog: {
          port: collector.port,
          token,
          identity: { engagementId: 'eng-us2', operatorId: 'op-us2' }
        },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('records nothing for the commands after it, across prompts', () => {
      expect(run.ok, run.error).toBe(true)
      // The operator still sees their own output — a stop stops the
      // recording, not the shell.
      expect(run.steps[2].output).toContain('after-stop-one')
      expect(run.steps[3].output).toContain('after-stop-two')

      expect(commandsNamed(collector.events, 'before-the-stop').length).toBeGreaterThan(0)
      // Two commands and two prompts later. A stop held in a shell variable
      // survives neither a subshell nor a `preexec` that has kept no memory
      // of the last one (FR-022).
      expect(commandsNamed(collector.events, 'after-stop-one')).toHaveLength(0)
      expect(commandsNamed(collector.events, 'after-stop-two')).toHaveLength(0)
    })

    it('starts again when told to', () => {
      expect(commandsNamed(collector.events, 'after-the-start').length).toBeGreaterThan(0)
    })

    it('records the stop itself', () => {
      // FR-012, and the reason this is not an exception to "RedLog's own
      // plumbing never enters the record": `redlog stop` is not plumbing, it
      // is the operator deciding that what comes next is not to be recorded.
      // A gap nobody can account for is worth less than no gap at all.
      expect(commandsNamed(collector.events, 'redlog stop').length).toBeGreaterThan(0)
    })
  })

  // T032, FR-021. The mode is the machine's, it changes at runtime, and
  // nothing is reinstalled to change it. `auto` is what an install leaves
  // behind, because a feature whose point is that there is nothing to type is
  // not one an operator opts each terminal into.
  describe('mode', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'redlog status',
          'redlog mode manual',
          'redlog status',
          'echo while-manual',
          'redlog mode auto',
          'echo while-auto',
          'cat $HOME/.redlog/terminal-mode'
        ],
        redlog: {
          port: collector.port, token,
          identity: { engagementId: 'eng-mode', operatorId: 'op-mode' }
        },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('installs as auto and switches without reinstalling', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output, 'the installed default is not auto').toMatch(/mode auto/)
      expect(run.steps[2].output).toMatch(/mode manual/)
      // Machine-level, so a NEW terminal starts the way this one was left.
      expect(run.steps[6].output.trim()).toBe('auto')
    })

    it('stops recording in manual and resumes in auto, in this terminal', () => {
      // An operator who types `redlog mode manual` means now, not "from the
      // next terminal I open".
      expect(commandsNamed(collector.events, 'while-manual')).toHaveLength(0)
      expect(commandsNamed(collector.events, 'while-auto').length).toBeGreaterThan(0)
    })
  })

  // T033, FR-028. The class lists are RedLog's policy, not a shell array
  // (research.md D7), and moving a command into the PTY class costs the
  // operator local suspension — which is not obvious, and is paid in the
  // middle of an engagement on the command they care most about.
  describe('class', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'redlog class list',
          'redlog class add pty curl',
          'redlog class list',
          'redlog class remove nc',
          'redlog class list',
          'redlog class add nonsense curl'
        ],
        redlog: {
          port: collector.port, token,
          identity: { engagementId: 'eng-class', operatorId: 'op-class' }
        },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('lists the classes that are lists, and says what the third one is', () => {
      expect(run.ok, run.error).toBe(true)
      const listed = run.steps[0].output
      expect(listed).toMatch(/native:.*\bnc\b/)
      expect(listed).toMatch(/pty:.*\bssh\b/)
      // `relayed` is not a list — it is what a command is when it is in no
      // other one, and printing "everything else" as a list would be a lie
      // the moment the operator ran something new.
      expect(listed).toMatch(/relayed: everything else/)
    })

    it('warns what moving a command into the PTY class costs', () => {
      expect(run.steps[1].output).toMatch(/curl is now pty/)
      expect(run.steps[1].output, 'the suspension cost was not named')
        .toMatch(/cannot be suspended|Ctrl-Z/)
      expect(run.steps[2].output).toMatch(/pty:.*\bcurl\b/)
    })

    it('takes a command back out of a class it shipped in', () => {
      expect(run.steps[4].output, 'nc is still native after remove').not.toMatch(/native:.*\bnc\b/)
    })

    it('refuses a class that does not exist, instead of inventing one', () => {
      // Rule 3: a typo must not be silently a no-op.
      expect(run.steps[5].output).toMatch(/no such class: nonsense/)
    })
  })

  describe('unknown subcommands', () => {
    it('print the list and exit non-zero', async () => {
      const run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['redlog stahp', 'echo code=$?'],
        redlog: { port: collector.port, token },
        timeoutSeconds: 60
      })
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).toMatch(/usage: redlog status\|start\|stop/)
      expect(run.steps[1].output, 'a typo was silently a no-op').toContain('code=2')
    }, 300_000)
  })

})
