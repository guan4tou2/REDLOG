import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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

  // T039, FR-010. The dangerous outcome is not a missing command. It is a
  // command from engagement A filed under engagement B — a lie in a document a
  // client reads, written by the tool whose entire job is to be believable.
  //
  // So a terminal is pinned to the project it was opened against, and when the
  // operator switches project in RedLog the terminal stops. It does not
  // re-bind, and it cannot be talked back into recording: `redlog start` in
  // that terminal is not the way around the guarantee. The safe answer is a
  // new terminal (research.md D5).
  describe('when the project changes under an open terminal', () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let run: Awaited<ReturnType<typeof runZsh>>
    const token = 'us3-switch'

    beforeAll(async () => {
      collector = await startCollector(token)
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'echo before-the-switch',
          // RedLog rewrites this file when the operator opens another
          // project; the terminal finds out the same way it would then.
          `printf '%s' '{"engagementId":"eng-after","operatorId":"op-a"}' > $HOME/.redlog/active-identity.json`,
          'echo after-the-switch',
          'redlog start',
          'echo after-trying-to-start',
          'redlog status'
        ],
        redlog: {
          port: collector.port, token,
          identity: { engagementId: 'eng-before', operatorId: 'op-a' }
        },
        timeoutSeconds: 90
      })
    }, 300_000)
    afterAll(async () => { await collector?.close() })

    const named = (match: string) => collector.events.filter((e) =>
      String(e.data.command ?? '').includes(match))

    it('stops, rather than writing the new project’s name on old work', () => {
      expect(run.ok, run.error).toBe(true)
      expect(named('before-the-switch').length).toBeGreaterThan(0)
      expect(named('after-the-switch'), 'a command was recorded after the switch')
        .toHaveLength(0)
      // The operator's command still ran — stopping the recording is not
      // stopping the engagement.
      expect(run.steps[2].output).toContain('after-the-switch')
    })

    it('says why, in the record and in the terminal', () => {
      const ended = collector.events.find((e) => e.data.subtype === 'session_end'
        && e.data.reason === 'project-switched')
      expect(ended, 'nothing in the record explains the gap').toBeTruthy()
      // Attributed to the project it was recording, not the one now open:
      // this row belongs to the engagement whose work just stopped.
      expect(ended!.data.engagement_id).toBe('eng-before')
      expect(run.transcript, 'the terminal never said anything')
        .toMatch(/project changed|stopped recording/i)
    })

    it('cannot be talked back into recording', () => {
      expect(named('after-trying-to-start'), '`redlog start` re-bound the terminal')
        .toHaveLength(0)
      expect(run.steps[5].output).toMatch(/project-switched/)
    })
  })

  // T040, Domain Invariant #8. The spool already existed: a POST that fails
  // writes the payload to `~/.redlog/pending` and RedLog replays it on the
  // next project open. What it did not carry was WHEN — so a command run at
  // 02:00 while RedLog was closed arrived claiming to have happened at 09:00,
  // when the operator next opened the project. A record whose times are the
  // times someone looked at it is not a record of the engagement.
  describe('commands run while RedLog is closed', () => {
    let run: Awaited<ReturnType<typeof runZsh>>
    let payloads: Array<Record<string, unknown>> = []
    let ranAt = 0

    beforeAll(async () => {
      // A port that is certainly dead: one the OS just gave us and we handed
      // straight back.
      const stillborn = await startCollector('unused')
      const deadPort = stillborn.port
      await stillborn.close()

      ranAt = Date.now()
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'echo spooled-while-down',
          // One per line: the spool writes payloads with no trailing newline,
          // so a plain `cat` of the directory runs them together.
          'for f in $HOME/.redlog/pending/*.json; do print -r -- "$(<$f)"; done'
        ],
        redlog: {
          port: deadPort, token: 'nobody-home',
          identity: { engagementId: 'eng-spool', operatorId: 'op-spool' }
        },
        timeoutSeconds: 90
      })
      payloads = run.steps[1].output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    }, 300_000)

    it('keeps the command, and the operator keeps their shell', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).toContain('spooled-while-down')
      expect(payloads.length, 'nothing reached the spool').toBeGreaterThan(0)
    })

    it('stamps when it happened, not when it will be read', () => {
      for (const payload of payloads) {
        const data = payload.data as Record<string, unknown>
        const stamp = data.source_timestamp
        expect(typeof stamp, `no source_timestamp on ${String(data.subtype)}`).toBe('number')
        // Within the window the shell actually ran in. `insertEvent` validates
        // this field too — it refuses anything before 2015 or more than a
        // minute in the future — so a wrong unit would be rejected rather
        // than drag the row to 1970.
        expect(stamp as number).toBeGreaterThanOrEqual(ranAt - 60_000)
        expect(stamp as number).toBeLessThanOrEqual(Date.now() + 60_000)
      }
    })

    it('carries that time through the replay', async () => {
      const { replaySpoolDirectory } = await import('../src/core/spool-replay')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-'))
      try {
        payloads.forEach((p, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(p)))
        const emitted: Array<Record<string, unknown>> = []
        const result = replaySpoolDirectory(
          dir,
          { engagementId: 'eng-spool', operatorId: 'op-spool' },
          (e) => { emitted.push(e.data); return true }
        )
        expect(result.replayed).toBe(payloads.length)
        for (const data of emitted) {
          expect(data.source_timestamp, 'the replay dropped the occurrence time').toBeTruthy()
          expect(data.recovered_from_spool).toBe(true)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
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
