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
      // `redlog status` discards the relay's stderr, so an empty answer says
      // nothing by itself; the whole run goes in the message so a failure on a
      // machine nobody can open a shell on still names what happened.
      const detail = `status was ${JSON.stringify(status)}; run: ${JSON.stringify(run)}`
      expect(status, detail).toMatch(/recording/i)
      expect(status, detail).toMatch(/auto/i)
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
    // One collector for the whole file, and `status` above also stops once —
    // so this block reads only what arrived during its own shell.
    let baseline = 0

    beforeAll(async () => {
      baseline = collector.events.length
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

    // T035, FR-012. "No events for twenty minutes" reads very differently as
    // "the operator stopped recording" than as "the operator was reading", and
    // a reader a year later cannot tell them apart from silence. RedLog
    // already brackets its GLOBAL pause with a pair of rows the timeline draws
    // as a band; a terminal that stopped on its own needs its own pair,
    // because reusing the global one would draw a band over an engagement that
    // never stopped recording.
    it('brackets the gap with a pair of rows, so it is a gap and not silence', () => {
      const mine = collector.events.slice(baseline)
      const stopped = mine.filter((e) => e.data.subtype === 'capture_stopped')
      const resumed = mine.filter((e) => e.data.subtype === 'capture_resumed')
      expect(stopped, 'nothing marks where recording stopped').toHaveLength(1)
      expect(resumed, 'nothing marks where it started again').toHaveLength(1)

      // Attributable: which terminal, and why. Silence has neither.
      expect(stopped[0].data.reason).toBe('operator')
      expect(stopped[0].data.session_id).toBeTruthy()
      expect(resumed[0].data.session_id).toBe(stopped[0].data.session_id)

      // And the gap is between them — the two commands that were not recorded
      // fall inside, which is what makes the bracket mean something.
      expect(stopped[0].receivedAt).toBeLessThanOrEqual(resumed[0].receivedAt)
      const between = mine.filter((e) =>
        e.receivedAt > stopped[0].receivedAt && e.receivedAt < resumed[0].receivedAt
        && String(e.data.command ?? '').startsWith('echo after-stop'))
      expect(between, 'something was recorded inside the gap').toHaveLength(0)
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
          'redlog class add relayed nc',
          'redlog class list',
          'redlog class remove nc',
          'redlog class list',
          'redlog class add native curl',
          'echo code=$?',
          'redlog class remove curl',
          'redlog class list',
          'redlog class add nonsense curl',
          `redlog class add pty 'a;b'`,
          'echo code=$?',
          'redlog class list'
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
      // vim and vi are native because a tool profile says so, not because a
      // list does; the listing says where each name came from (#499).
      expect(listed).toContain('tool profiles: Vim (vim vi)')
    })

    it('warns what moving a command into the PTY class costs', () => {
      expect(run.steps[1].output).toMatch(/curl is now pty/)
      expect(run.steps[1].output, 'the suspension cost was not named')
        .toMatch(/cannot be suspended|Ctrl-Z/)
      expect(run.steps[2].output).toMatch(/pty:.*\bcurl\b/)
    })

    it('moves a command out of the class it shipped in', () => {
      expect(run.steps[3].output).toMatch(/nc is now relayed/)
      expect(run.steps[4].output, 'nc is still native after add relayed').not.toMatch(/native:.*\bnc\b/)
      expect(run.steps[4].output).not.toMatch(/pty:.*\bnc\b/)
      // curl (pty) is still there from the step before.
      expect(run.steps[4].output).toContain('your changes: curl (pty), nc (relayed)')
    })

    // #296: remove used to drop a command from the shipped defaults as well,
    // so `remove pwncat-cs` left it relayed while saying "back to the
    // default". Remove undoes the operator's own edit and nothing else.
    it('puts a command back where it shipped when its edit is removed', () => {
      expect(run.steps[5].output).toMatch(/nc is back to the default/)
      expect(run.steps[6].output, 'nc did not return to native').toMatch(/native:.*\bnc\b/)
    })

    it('takes a command the operator added out again when it is removed', () => {
      expect(run.steps[10].output).not.toMatch(/native:.*\bcurl\b/)
      expect(run.steps[10].output).not.toMatch(/pty:.*\bcurl\b/)
    })

    it('exits 0 when an add succeeds', () => {
      expect(run.steps[7].output).toMatch(/curl is now native/)
      expect(run.steps[8].output, 'a successful add returned non-zero').toContain('code=0')
    })

    it('refuses a class that does not exist, instead of inventing one', () => {
      // Rule 3: a typo must not be silently a no-op.
      expect(run.steps[11].output).toMatch(/no such class: nonsense/)
    })

    // The wrapper function is built from this name, so it is not a free string.
    it('refuses a name that is not a bare command name, says so, and does not write it', () => {
      expect(run.steps[12].output).toMatch(/not a command name: a;b/)
      expect(run.steps[12].output).not.toMatch(/no such class/)
      expect(run.steps[13].output, 'a refused add returned zero').toContain('code=2')
      expect(run.steps[14].output).not.toMatch(/a;b/)
    })
  })

  // #499. A plugin's tool profile can arrive while a terminal is open. The
  // class list names it, and says the one thing that would otherwise surprise
  // the operator: the PTY wrappers are installed when a terminal starts, so
  // this one still runs the program on its own terminal.
  describe('class list with a plugin profile that arrived after this terminal started', () => {
    const snapshot = JSON.stringify({
      version: 1,
      profiles: [{ id: 'pack/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy', 'ligolo-gone'], reason: 'r' }],
      held: {}
    })
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: [
          'mkdir -p "$HOME/fakebin"',
          `printf '#!/bin/sh\\n' > "$HOME/fakebin/ligolo-proxy"`,
          'chmod +x "$HOME/fakebin/ligolo-proxy"',
          'export PATH="$HOME/fakebin:$PATH"',
          `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`
        ].join('\n'),
        commands: [
          'redlog class list',
          `printf '%s' '${snapshot}' > "$HOME/.redlog/terminal-profiles.json"`,
          'redlog class list'
        ],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-plug', operatorId: 'op-plug' } },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('names the plugin\'s profile and that its program is recorded in a new terminal only', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).not.toMatch(/plugin profiles|PTY-recorded in a new terminal/)

      const after = run.steps[2].output
      expect(after).toContain('plugin profiles: Ligolo-ng from pack (ligolo-proxy ligolo-gone)')
      expect(after).toMatch(/pty:.*\bligolo-proxy\b/)
      expect(after).toContain('ligolo-proxy is PTY-recorded in a new terminal, not this one')
      // ssh was wrapped when this terminal started, and ligolo-gone has no
      // program behind it: neither is something to warn about.
      expect(after).not.toMatch(/ssh is PTY-recorded/)
      expect(after).not.toMatch(/ligolo-gone is PTY-recorded/)
    })
  })

  // A program that was in the pty class when the hook loaded but had no
  // executable on PATH then gets no wrapper, and a PATH entry added afterwards
  // does not give it one. "A new terminal" is true only if the class changed;
  // here the next terminal would be wrapped, but this one and the line must not
  // promise it for a program the class already had.
  describe('class list for a pty program that was not on PATH when the hook loaded', () => {
    const snapshot = JSON.stringify({
      version: 1,
      // A name no machine has: kali ships a real ligolo-proxy, which would be wrapped at load.
      profiles: [{ id: 'pack/late', name: 'Late Tool', mode: 'pty', executables: ['late-pty-tool'], reason: 'r' }],
      held: {}
    })
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: [
          'mkdir -p "$HOME/.redlog"',
          `printf '%s' '${snapshot}' > "$HOME/.redlog/terminal-profiles.json"`,
          `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`
        ].join('\n'),
        commands: [
          'mkdir -p "$HOME/latebin"',
          `printf '#!/bin/sh\\n' > "$HOME/latebin/late-pty-tool"`,
          'chmod +x "$HOME/latebin/late-pty-tool"',
          'export PATH="$HOME/latebin:$PATH"',
          'redlog class list'
        ],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-late', operatorId: 'op-late' } },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('says it was not on PATH when the hook loaded, and does not promise a new terminal', () => {
      expect(run.ok, run.error).toBe(true)
      const out = run.steps[4].output
      expect(out).toContain('plugin profiles: Late Tool from pack (late-pty-tool)')
      expect(out).toContain('late-pty-tool is not PTY-recorded: it was not on PATH when the RedLog hook loaded')
      expect(out).not.toMatch(/late-pty-tool is PTY-recorded in a new terminal/)
    })
  })

  // `redlog class add|remove` rewrite the whole overlay, so one that cannot be
  // read is refused and left as it is, not replaced by a file with one edit.
  describe('class add and remove on an overlay that cannot be read', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: [
          'mkdir -p "$HOME/.redlog"',
          `printf '{"pty": ["keep-me"' > "$HOME/.redlog/command-class.json"`,
          `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`
        ].join('\n'),
        commands: [
          'redlog class add native some-tool',
          'echo code=$?',
          'redlog class remove keep-me',
          'echo code=$?',
          `redlog class add pty 'foo/'`,
          'echo code=$?',
          'cat "$HOME/.redlog/command-class.json"; echo'
        ],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-bad', operatorId: 'op-bad' } },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('says it cannot read the file, does not claim the change, and exits non-zero', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).toMatch(/command-class\.json cannot be read/)
      expect(run.steps[0].output).not.toMatch(/is now|no such class/)
      expect(run.steps[1].output).toContain('code=2')
      expect(run.steps[2].output).toMatch(/command-class\.json cannot be read/)
      expect(run.steps[2].output).not.toMatch(/back to the default/)
      expect(run.steps[3].output).toContain('code=2')
    })

    it('says a path with nothing after the slash is not a command name, and not that the class is wrong', () => {
      expect(run.steps[4].output).toMatch(/not a command name: foo\//)
      expect(run.steps[4].output).not.toMatch(/no such class/)
      expect(run.steps[5].output).toContain('code=2')
    })

    it('leaves the file exactly as it was', () => {
      expect(run.steps[6].output).toContain('{"pty": ["keep-me"')
      expect(run.steps[6].output).not.toMatch(/some-tool|relayed/)
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
