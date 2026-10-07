import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget } from './helpers/zsh-pty'

// Spec 052 US3, T036/T037. The rule the whole feature is subordinate to: an
// audit logger may lose the recording, and may never take the shell with it.
//
// This is not a defensive extra. The adapter now sits in `preexec` on every
// command of an engagement, holding the shell's descriptors — so every way it
// can fail is a way the operator's shell can fail, in the middle of work that
// may not be repeatable. Unrecorded is bad. A wedged prompt, a lost reverse
// shell or a command that reports someone else's exit status is worse.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1

describeShell(`degrading honestly (${target?.label ?? 'no zsh reachable'})`, () => {
  // T036, FR-009. With RedLog unreachable the commands still run — that part
  // works today, silently. Silence is the bug: an operator whose RedLog
  // crashed two hours ago has been working unrecorded and has no way to know.
  // Once, though. A warning on every prompt is one an operator learns to read
  // past, and then the one that matters is read past too.
  describe('when RedLog cannot be reached', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['echo first-unrecorded', 'echo second-unrecorded', 'echo third-unrecorded'],
        // No `redlog` block: no api-port, no api-token in this throwaway HOME.
        //
        // And no WSL either. Under WSL the adapter deliberately falls back to
        // the Windows profile's `.redlog`, which on a developer's machine is a
        // real RedLog install — so omitting the files is not enough to make it
        // unreachable here. On CI's ubuntu runner the variable is already
        // unset and this line does nothing.
        env: { WSL_DISTRO_NAME: '' },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('runs the commands anyway', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).toContain('first-unrecorded')
      expect(run.steps[1].output).toContain('second-unrecorded')
      expect(run.steps[2].output).toContain('third-unrecorded')
    })

    it('says so once, and then stops saying it', () => {
      const warnings = occurrences(run.transcript, 'not reachable')
      expect(warnings, 'the operator is never told their commands are unrecorded')
        .toBeGreaterThan(0)
      expect(warnings, 'the warning repeats on every prompt').toBe(1)
    })
  })

  // T038, FR-029. The relay holds the shell's descriptors for the duration of
  // a command, so every shape of command it cannot hold safely is one it has
  // to decline — and decline BEFORE the command runs, not notice afterwards.
  describe('shapes the relay has to decline', () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let run: Awaited<ReturnType<typeof runZsh>>
    const token = 'us3-standdown'

    beforeAll(async () => {
      collector = await startCollector(token)
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          // A pager at the end of a pipeline is the hazard: classified on the
          // first word, `cat` is relayed, and then the pager's stdout is a
          // pipe to the relay rather than a terminal — so it stops being a
          // pager. `vim --version` stands in for it because it exits.
          'echo piped | vim --version',
          // A pipeline with nothing native in it is still worth capturing:
          // the last stage writes to the terminal, which is what the relay
          // holds, so the output is the pipeline's own.
          'echo one | tr a-z A-Z',
          'echo redirect-me > /tmp/redlog-t038.txt',
          'cat /tmp/redlog-t038.txt'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 90
      })
    }, 300_000)
    afterAll(async () => { await collector?.close() })

    const startFor = (match: string) => collector.events.find((e) =>
      e.data.subtype === 'command_start' && String(e.data.command ?? '').includes(match))
    const endFor = (match: string) => collector.events.find((e) =>
      e.data.subtype === 'command_end' && String(e.data.command ?? '').includes(match))

    it('stands down from a pipeline with a native stage, and the command still runs', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output, 'the command did not run').toMatch(/VIM|Vi IMproved/i)
      expect(startFor('vim --version')?.data.class, 'the pager was relayed anyway').toBe('native')
      expect(endFor('vim --version')?.data).toMatchObject({
        completeness: 'metadata-only', output_disposition: 'interactive'
      })
    })

    it('still relays a pipeline that is only ordinary commands', () => {
      expect(run.steps[1].output).toContain('ONE')
      expect(startFor('tr a-z A-Z')?.data.class).toBe('relayed')
      expect(String(endFor('tr a-z A-Z')?.data.stdout)).toContain('ONE')
    })

    it('stands down from a redirection instead of relaying nothing', () => {
      // The record is the same as it was when the relay ran and saw no bytes
      // (T022) — but two python3 processes are not started to hold a
      // descriptor the operator has already pointed somewhere else.
      expect(startFor('> /tmp/redlog-t038.txt')?.data.class).toBe('redirected')
      expect(endFor('> /tmp/redlog-t038.txt')?.data).toMatchObject({
        completeness: 'metadata-only', output_disposition: 'redirected'
      })
      // And the operator's redirection did what they asked.
      expect(String(endFor('cat /tmp/redlog-t038.txt')?.data.stdout)).toContain('redirect-me')
    })
  })

  // T037. Two different readers of the exit status, and the relay may lie to
  // neither: the record is what the client eventually reads, and `$?` at the
  // next prompt is what the operator's own `&&` and `||` depend on, mid
  // engagement. A logger that changes it changes what the engagement did.
  describe('when the relay dies underneath a command', () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let run: Awaited<ReturnType<typeof runZsh>>
    const token = 'us3-token'

    beforeAll(async () => {
      collector = await startCollector(token)
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          // The command kills its own relay and then exits 7. Both pipe
          // processes go, so the shell is left holding descriptors whose far
          // end is gone — which is the shape of a relay that crashed, an OOM
          // kill, or an operator's own `pkill python3`.
          // The bracket is not decoration: `pkill -f` matches full command
          // lines, and this command's own line contains the pattern — without
          // it the command kills itself and reports 143, which looks exactly
          // like the bug being tested for.
          `sh -c 'pkill -f "redlog-rela[y].py pipe" 2>/dev/null; exit 7'`,
          'echo code=$?',
          'echo still-here'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 90
      })
    }, 300_000)
    afterAll(async () => { await collector?.close() })

    it('leaves the shell alive and usable', () => {
      // If the shell died with the relay, nothing below this line can even be
      // asked. That is the failure this whole story exists to prevent.
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[2].output, 'the shell did not survive its own logger')
        .toContain('still-here')
    })

    it('reports the command’s own exit status to the shell', () => {
      expect(run.steps[1].output, 'the relay replaced the command’s status')
        .toContain('code=7')
    })

    it('reports the command’s own exit status to the record', () => {
      const end = collector.events.find((e) => e.agentType === 'shell'
        && e.data.subtype === 'command_end'
        && String(e.data.command ?? '').includes('exit 7'))
      expect(end, 'the command was not recorded at all').toBeTruthy()
      expect(end!.data.exit_code).toBe(7)
      // And it says the body is not there, rather than reporting the empty
      // string as if the command had printed nothing.
      expect(end!.data.completeness).not.toBe('complete')
    })
  })
})
