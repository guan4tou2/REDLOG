import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// Spec 052 T018, FR-001. The whole feature in one assertion: an operator opens
// a terminal, types a command, and the command, its output, its exit status
// and where it ran are in the record — with nothing typed before it.
//
// "Nothing typed before it" is the requirement, not a detail of it. RedLog can
// already capture a command's output: `redlog-run nmap -sV host` has worked
// for releases. It is used a handful of times per engagement, because an
// operator mid-engagement does not remember a prefix, and the commands worth
// having are the ones typed without thinking about the logger. Everything in
// this file is about removing that prefix.
//
// It runs on a real interactive zsh on a pty because `preexec` and `precmd` do
// not fire under `zsh -c`, and a piped stdout hides the line discipline the
// relay has to leave intact. See test/helpers/zsh-pty.py.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const shellEvents = (events: CapturedEvent[], subtype: string, match: string): CapturedEvent[] =>
  events.filter((e) => e.agentType === 'shell'
    && e.data.subtype === subtype
    && String(e.data.command ?? '').includes(match))

describeShell(`auto capture in an enrolled zsh (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let report: Awaited<ReturnType<typeof runZsh>>
  const token = 'auto-capture-token'

  // One session, several assertions. A shell that takes six seconds to reach
  // its first prompt is not something to pay for once per `it`, and these are
  // readings of one run rather than independent scenarios.
  beforeAll(async () => {
    collector = await startCollector(token)
    report = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      commands: [
        'cd /tmp',
        'echo auto-captured-output',
        "sh -c 'exit 3'",
        'echo status=$?'
      ],
      redlog: { port: collector.port, token },
      timeoutSeconds: 40
    })
  }, 300_000)
  afterAll(async () => { await collector?.close() })

  it('records a plain command with its output, status and cwd', () => {
    expect(report.ok, report.error).toBe(true)
    // The operator still sees their own output. A relay that captures by
    // taking the terminal away is not a capture, it is an outage.
    expect(report.steps[1].output).toContain('auto-captured-output')

    const start = shellEvents(collector.events, 'command_start', 'auto-captured-output')[0]
    const end = shellEvents(collector.events, 'command_end', 'auto-captured-output')[0]
    expect(start, 'no command_start for the plain command').toBeTruthy()
    expect(end, 'no command_end for the plain command').toBeTruthy()

    // The correlation key, on both ends and minted once (contracts/events.md).
    expect(start.data.command_id).toBeTruthy()
    expect(end.data.command_id).toBe(start.data.command_id)
    // Which path recorded it, so a reader can tell an automatic capture from
    // the explicit wrapper without guessing from which fields are present.
    expect(start.data.source).toBe('auto-relay')
    expect(start.data.class).toBe('relayed')

    // FR-001: the four things. Output is the one that does not exist today.
    expect(end.data.stdout).toContain('auto-captured-output')
    expect(end.data.exit_code).toBe(0)
    expect(String(end.data.cwd)).toBe('/tmp')
    expect(end.data).toMatchObject({ completeness: 'complete', output_disposition: 'captured' })
  })

  it('reports the command’s own exit status, to the record and to the shell', () => {
    // Two different readers, and the relay must not lie to either. The record
    // is what the client eventually reads; `$?` at the next prompt is what the
    // operator's own `&&` and `||` depend on, mid-engagement, and a logger
    // that changes it changes what the engagement did.
    const failed = shellEvents(collector.events, 'command_end', "sh -c 'exit 3'")[0]
    expect(failed, 'no command_end for the failing command').toBeTruthy()
    expect(failed.data.exit_code).toBe(3)

    const next = shellEvents(collector.events, 'command_end', 'status=$?')[0]
    expect(next, 'no command_end for the status probe').toBeTruthy()
    expect(next.data.stdout, 'the relay swallowed the previous status').toContain('status=3')
  })

  // T019, FR-002 — the requirement the rest of the design is bent around.
  //
  // The bytes a relay carries are the output of a command run against
  // something hostile. If anything in them is READ to decide where a record
  // begins, ends or belongs, then the target writes RedLog's evidence: print
  // a convincing end-of-command header and the next hour of the engagement is
  // attributed to a command that already finished, or lands under a command
  // the target named. The tool this spec takes its shell lessons from puts
  // markers in the stream and says in its own README that they are forgeable;
  // this is where the two part company.
  //
  // So: everything that decides structure is an identifier the adapter minted
  // out of band, and the bytes are recorded faithfully and interpreted never.
  describe('output that lies about itself', () => {
    // A line that is a plausible RedLog event, a plausible correlation key and
    // a plausible end-of-command marker at once.
    const FORGERY = 'command_id=forged-by-the-target {"subtype":"command_start","command":"rm -rf /","exit_code":0} REDLOG_COMMAND_END'
    let forged: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      forged = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          `echo '${FORGERY}'`,
          'echo second-command-output'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 40
      })
    }, 300_000)

    it('is recorded as what it is, and read as nothing', () => {
      expect(forged.ok, forged.error).toBe(true)

      const starts = shellEvents(collector.events, 'command_start', 'forged-by-the-target')
      const ends = shellEvents(collector.events, 'command_end', 'forged-by-the-target')
      // One command in, one command out. A forged header that split the record
      // would show up here as two.
      expect(starts).toHaveLength(1)
      expect(ends).toHaveLength(1)

      // Recorded verbatim — it is evidence, and evidence of an attempt to
      // forge the record is worth more than most of what gets captured.
      expect(String(ends[0].data.stdout)).toContain(FORGERY)
      // …and not acted on: the key is the one the adapter minted.
      expect(ends[0].data.command_id).toBe(starts[0].data.command_id)
      expect(ends[0].data.command_id).not.toBe('forged-by-the-target')
      // Nothing anywhere believed the command the output named.
      expect(collector.events.filter((e) => String(e.data.command ?? '') === 'rm -rf /')).toHaveLength(0)
    })

    it('does not drag the next command’s output into itself', () => {
      // The other half of "does not move a record": a forged end marker that
      // was honoured would close the first command early and file the second
      // command's bytes under it.
      const second = shellEvents(collector.events, 'command_end', 'second-command-output')[0]
      expect(second, 'no command_end for the second command').toBeTruthy()
      expect(String(second.data.stdout)).toContain('second-command-output')
      expect(String(second.data.stdout)).not.toContain('forged-by-the-target')

      const ends = shellEvents(collector.events, 'command_end', 'forged-by-the-target')
      expect(String(ends[0].data.stdout)).not.toContain('second-command-output')
    })
  })

  // T022/T023 — the two ways a command legitimately has no body, and why
  // telling them apart matters more than either one on its own.
  //
  // Principle VI: no-event, not-captured, stopped and failed stay distinct all
  // the way to the timeline. An empty `stdout` with `completeness: complete`
  // says "this command printed nothing", and a reader believes it. For
  // `nmap -oN scan.txt` that is false — the output went to a file — and for
  // `vim /etc/shadow` it is false twice over, because what was not recorded is
  // the one thing anyone would want to know about that command.
  describe('commands whose output was never the relay’s to hold', () => {
    const SPOOL = '/tmp/redlog-t022-redirect.txt'
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          `echo redirected-body > ${SPOOL}`,
          `cat ${SPOOL}`,
          'vim --version'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('says a redirected command was redirected, not that it was silent', () => {
      expect(run.ok, run.error).toBe(true)

      const end = shellEvents(collector.events, 'command_end', `> ${SPOOL}`)[0]
      expect(end, 'no command_end for the redirected command').toBeTruthy()
      expect(end.data).toMatchObject({
        output_disposition: 'redirected',
        completeness: 'metadata-only'
      })
      expect(String(end.data.stdout ?? '')).toBe('')

      // And the operator's redirection still did what they asked — the bytes
      // are in the file. A relay that swallowed them would be a capture tool
      // that broke the capture.
      const read = shellEvents(collector.events, 'command_end', `cat ${SPOOL}`)[0]
      expect(read, 'no command_end for the read-back').toBeTruthy()
      expect(String(read.data.stdout)).toContain('redirected-body')
    })

    it('says an interactive command was interactive, and leaves it alone', () => {
      // `vim` is in the native class: relaying it would record cursor
      // movements and none of the file (FR-026), and the same list keeps `nc`
      // suspendable for the shell upgrade (FR-025). `--version` is used only
      // so the thing exits; the classification is on the program name.
      const start = shellEvents(collector.events, 'command_start', 'vim --version')[0]
      const end = shellEvents(collector.events, 'command_end', 'vim --version')[0]
      expect(start, 'no command_start for the native command').toBeTruthy()
      expect(end, 'no command_end for the native command').toBeTruthy()

      expect(start.data.class).toBe('native')
      expect(end.data).toMatchObject({
        output_disposition: 'interactive',
        completeness: 'metadata-only'
      })
      expect(String(end.data.stdout ?? '')).toBe('')
      // Still a recorded command, with its status and where it ran. The
      // record says the body is absent and why; it does not go missing.
      expect(end.data.exit_code).toBeDefined()
      expect(String(end.data.cwd)).not.toBe('')
      // `interactive` and `not-captured` are different words for different
      // things: this one was never going to be held, the other means the
      // relay could not run (contracts/events.md).
      expect(end.data.output_disposition).not.toBe('not-captured')
    })
  })

  // T024, research.md D7. `ssh` and friends bring their own TTY, so diverting
  // the shell's descriptors records nothing worth having — the bytes are drawn
  // inside a terminal the relay never sees. They get a real PTY recorder, and
  // RedLog already has one: hooks/redlog-session.py, verified under spec 022,
  // with bounded output, identity pinned at session start and pause honoured
  // at receipt. `script(1)` would be a second recorder with different
  // semantics and no identity pinning.
  describe('the PTY class', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    it('leaves ssh on its native path when no project is open', async () => {
      const result = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['ssh -V'],
        redlog: { port: collector.port, token },
        timeoutSeconds: 60
      })
      expect(result.ok, result.error).toBe(true)
      expect(result.steps[0].output).toContain('OpenSSH')
      expect(result.steps[0].output).not.toContain('[redlog] session')
    }, 300_000)

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['ssh -V'],
        redlog: {
          port: collector.port,
          token,
          // Only the recorder needs this: it pins identity when the session
          // opens rather than when an event is sent.
          identity: { engagementId: 'eng-harness', operatorId: 'op-harness' }
        },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('records an ssh through the session recorder, not through the relay', () => {
      expect(run.ok, run.error).toBe(true)

      const start = shellEvents(collector.events, 'command_start', 'ssh -V')[0]
      expect(start, 'no command_start for the ssh').toBeTruthy()
      expect(start.data.class).toBe('pty')

      // The recorder opened a session of its own, and says who recorded it.
      const session = collector.events.find((e) => e.data.subtype === 'session_start'
        && String(e.data.command ?? '').includes('ssh -V'))
      expect(session, `collector saw: ${JSON.stringify(collector.events.map((e) => e.data.subtype))}`)
        .toBeTruthy()
      expect(session!.data.captured_by).toBe('redlog-session')
      // Its own terminal id, so the session's output can be found from the
      // session rather than guessed at from timing.
      expect(session!.data.terminalId).toBeTruthy()

      // The adapter's own row still exists and still says the body is not on
      // it — which is true: the body is in the session, under that id.
      const end = shellEvents(collector.events, 'command_end', 'ssh -V')[0]
      expect(end, 'no command_end for the ssh').toBeTruthy()
      expect(end.data.output_disposition).toBe('interactive')
    })

    // #296. The recorder's own terminal id differs from the shell's, so until the
    // wrapper handed it the command's id the only way to tie a session to its
    // command was the command text — which cannot tell two `ssh host` runs apart.
    it('stamps every session event with the command_id of the command it belongs to', () => {
      expect(run.ok, run.error).toBe(true)
      const start = shellEvents(collector.events, 'command_start', 'ssh -V')[0]
      expect(start?.data.command_id, 'no command_id on the command_start').toBeTruthy()

      const sessionEvents = collector.events.filter((e) => e.data.captured_by === 'redlog-session'
        && e.data.terminalId === collector.events.find((s) => s.data.subtype === 'session_start'
          && String(s.data.command ?? '').includes('ssh -V'))?.data.terminalId)
      const subtypes = sessionEvents.map((e) => e.data.subtype)
      expect(subtypes, 'session start and end are both recorded').toEqual(expect.arrayContaining(['session_start', 'session_end']))
      for (const e of sessionEvents) {
        expect(e.data.command_id, `${String(e.data.subtype)} carries no command_id`).toBe(start.data.command_id)
      }
    })

    // #296 round 2: the wrapper is installed once, when the hook loads, so
    // moving ssh out of the pty class printed "ssh is now native" and went on
    // recording the next ssh in full, under a command_start that said native.
    it('runs a program moved out of the pty class as itself, in the same shell', async () => {
      const result = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['redlog class add native ssh', 'ssh -V moved-probe'],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-harness', operatorId: 'op-harness' } },
        timeoutSeconds: 60
      })
      expect(result.ok, result.error).toBe(true)
      expect(result.steps[0].output).toMatch(/ssh is now native/)
      expect(result.steps[1].output).toContain('OpenSSH')
      expect(result.steps[1].output, 'the moved program was handed to the session recorder')
        .not.toContain('[redlog] session')
      expect(collector.events.some((e) => e.data.subtype === 'session_start'
        && String(e.data.command ?? '').includes('moved-probe'))).toBe(false)
    }, 300_000)

    // Issue #296. The wrapper asked only whether RedLog was running, so after
    // `redlog stop` a pty-class program was still recorded in full by the
    // session recorder — output and all — while the adapter correctly sent
    // nothing. Stopped means the program runs as itself; started again means
    // it is recorded again, in the same shell, without re-sourcing the hook.
    it('runs a pty-class program as itself while recording is stopped, and records it again after start', async () => {
      const result = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['redlog stop', 'ssh -V stopped-probe', 'redlog start', 'ssh -V started-probe'],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-harness', operatorId: 'op-harness' } },
        timeoutSeconds: 60
      })
      expect(result.ok, result.error).toBe(true)

      // It still ran, and nothing stood between the operator and it.
      expect(result.steps[1].output).toContain('OpenSSH')
      expect(result.steps[1].output).not.toContain('[redlog] session')
      const sessionFor = (probe: string) => collector.events.find((e) => e.data.subtype === 'session_start'
        && String(e.data.command ?? '').includes(probe))
      expect(sessionFor('stopped-probe'), 'a stopped terminal handed the program to the session recorder').toBeUndefined()
      expect(collector.events.some((e) => JSON.stringify(e.data).includes('stopped-probe')),
        'something was recorded while stopped').toBe(false)

      // The gate is read per call, so `redlog start` reopens it.
      expect(sessionFor('started-probe'), `collector saw: ${JSON.stringify(collector.events.map((e) => e.data.subtype))}`)
        .toBeTruthy()
    }, 300_000)

    // Issue #288. The wrapper is a function named after the program, so a
    // function the operator already had under that name was silently replaced
    // — and, with RedLog not recording, replaced by `command ssh "$@"`, which
    // is not what their function did. A function defined BEFORE the hook is
    // the operator's own and is left alone. (One defined after it replaces
    // RedLog's wrapper instead; that is their choice, and that program goes
    // native.)
    describe('a function of the operator’s own', () => {
      // Whether `ssh` is RedLog's wrapper, without printing its body: the
      // answer has to differ from the typed line, which the pty echoes.
      const wrapperProbe = '[[ "${functions[ssh]-}" == *_REDLOG_SESSION_HELPER* ]] && echo "wrapper:$((1+1))" || echo "wrapper:$((0+0))"'
      const identity = { engagementId: 'eng-harness', operatorId: 'op-harness' }
      const source = (): string => `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`

      it('keeps a function defined before the hook, and records the command as metadata', async () => {
        const result = await runZsh(target!, {
          rc: `ssh() { print -r -- "USERFN-RAN:$1" }\n${source()}`,
          commands: ['ssh userfn-probe', wrapperProbe, 'redlog class list'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)

        // Their function ran, and not a wrapper standing in for it.
        expect(result.steps[0].output).toContain('USERFN-RAN:userfn-probe')
        expect(result.steps[0].output).not.toContain('[redlog] session')
        expect(result.steps[1].output).toContain('wrapper:0')
        expect(result.steps[1].output).not.toContain('wrapper:2')

        // Never handed to the session recorder.
        const session = collector.events.find((e) => e.data.subtype === 'session_start'
          && String(e.data.command ?? '').includes('userfn-probe'))
        expect(session, 'the operator’s function was handed to the session recorder').toBeUndefined()

        // Still recorded, and as what it is: a pty-class command that nothing
        // relayed, so there is a row with no body and a reason for that.
        const start = shellEvents(collector.events, 'command_start', 'userfn-probe')[0]
        const end = shellEvents(collector.events, 'command_end', 'userfn-probe')[0]
        expect(start, 'no command_start for the skipped program').toBeTruthy()
        expect(start.data.class).toBe('pty')
        expect(end, 'no command_end for the skipped program').toBeTruthy()
        expect(end.data).toMatchObject({ completeness: 'metadata-only', output_disposition: 'interactive' })
        expect(String(end.data.stdout ?? '')).toBe('')

        // The class is policy and says `pty`; what happened is a separate
        // field, so nothing reading the row mistakes it for a PTY capture.
        for (const e of [start, end]) {
          expect(e.data).toMatchObject({ capture_mode: 'native', capture_reason: 'existing-shell-function' })
          expect(e.data.source).not.toBe('auto-pty')
          expect(e.data.captured_by).not.toBe('redlog-session')
        }

        // Discoverable: the class list names the program that is not wrapped.
        expect(result.steps[2].output).toMatch(/pty:.*\bssh\b/)
        expect(result.steps[2].output).toMatch(/ssh is your own function/)
      }, 300_000)

      it('wraps ssh as before when there is no function, and says nothing in the class list', async () => {
        const result = await runZsh(target!, {
          rc: source(),
          commands: [wrapperProbe, 'redlog class list'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        expect(result.steps[0].output).toContain('wrapper:2')
        expect(result.steps[1].output).not.toMatch(/your own function/)
      }, 300_000)

      it('still installs its own wrapper when the hook is sourced twice', async () => {
        const result = await runZsh(target!, {
          rc: `${source()}\n${source()}`,
          commands: [wrapperProbe, 'ssh -4 -V', 'redlog class list'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        // RedLog's wrapper from the first source is not "a function of theirs".
        expect(result.steps[0].output).toContain('wrapper:2')
        const session = collector.events.find((e) => e.data.subtype === 'session_start'
          && String(e.data.command ?? '').includes('ssh -4 -V'))
        expect(session, 'the second source dropped the PTY wrapper').toBeTruthy()
        // A wrapped program carries no capture_mode: nothing to qualify.
        const start = shellEvents(collector.events, 'command_start', 'ssh -4 -V')[0]
        expect(start.data.class).toBe('pty')
        expect(start.data.capture_mode).toBeUndefined()
        expect(result.steps[2].output).not.toMatch(/your own function/)
      }, 300_000)

      // Wrappers are installed at load from what is on PATH and not the
      // operator's: no program behind the name means no wrapper, and a
      // function with no program behind it is still theirs.
      it('does not wrap a name with no program behind it, nor a function with none', async () => {
        const result = await runZsh(target!, {
          rc: `zz-fnonly() { print -r -- "FNONLY-RAN" }
${source()}`,
          commands: [
            'redlog class add pty zz-nobinary',
            'redlog class add pty zz-fnonly',
            source(),
            '[[ -z "${functions[zz-nobinary]-}" ]] && echo "nobinary:$((1+1))"',
            'zz-fnonly',
            '[[ "${functions[zz-fnonly]}" != *_REDLOG_SESSION_HELPER* ]] && echo "fnonly:$((1+1))"'
          ],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        expect(result.steps[3].output).toContain('nobinary:2')
        expect(result.steps[4].output).toContain('FNONLY-RAN')
        expect(result.steps[5].output).toContain('fnonly:2')
      }, 300_000)
    })

    // The wrapper is a function installed when the hook loads, so a program
    // that is `pty` for any other reason — added to the class afterwards, or
    // reached through `sudo` — runs on the shell's own terminal. `class: pty`
    // is the policy; the record has to say what happened beside it, as it does
    // for the operator's own function and as bash does for every pty program.
    describe('a pty program with no wrapper in this shell', () => {
      const identity = { engagementId: 'eng-harness', operatorId: 'op-harness' }
      const source = (): string => `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`

      it('is marked no-pty-wrapper when it joined the class after the shell started', async () => {
        const result = await runZsh(target!, {
          rc: source(),
          commands: ['redlog class add pty uname', 'uname -s noshim-probe'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        const start = shellEvents(collector.events, 'command_start', 'noshim-probe')[0]
        const end = shellEvents(collector.events, 'command_end', 'noshim-probe')[0]
        expect(start, 'no command_start').toBeTruthy()
        expect(end, 'no command_end').toBeTruthy()
        expect(start.data.class).toBe('pty')
        for (const e of [start, end]) {
          expect(e.data).toMatchObject({ capture_mode: 'native', capture_reason: 'no-pty-wrapper' })
        }
      }, 300_000)

      // #499. A plugin's profile can name a program as pty while a terminal is
      // open. The wrappers were installed at start, so there is none for it.
      it('is marked no-pty-wrapper when a plugin\'s profile named it after the shell started', async () => {
        const snapshot = JSON.stringify({
          version: 1,
          profiles: [{ id: 'pack/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'r' }],
          held: {}
        })
        const result = await runZsh(target!, {
          rc: `mkdir -p "$HOME/fakebin"\nprintf '#!/bin/sh\\necho ligolo-ran\\n' > "$HOME/fakebin/ligolo-proxy"\nchmod +x "$HOME/fakebin/ligolo-proxy"\nexport PATH="$HOME/fakebin:$PATH"\n${source()}`,
          commands: ['ligolo-proxy plug-before', `printf '%s' '${snapshot}' > "$HOME/.redlog/terminal-profiles.json"`, 'ligolo-proxy plug-after'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        expect(result.steps[2].output).toContain('ligolo-ran')
        const before = shellEvents(collector.events, 'command_start', 'plug-before')[0]
        expect(before.data.class).toBe('relayed')
        expect(before.data.capture_mode).toBeUndefined()
        const after = shellEvents(collector.events, 'command_start', 'plug-after')[0]
        expect(after.data.class).toBe('pty')
        expect(after.data).toMatchObject({ capture_mode: 'native', capture_reason: 'no-pty-wrapper' })
      }, 300_000)

      it('is marked no-pty-wrapper behind sudo, and still carries nothing when wrapped', async () => {
        // A stand-in `sudo` that runs its arguments, so the case needs no
        // privilege: the class walks past it to `ssh`, and the word the shell
        // looks a function up by is `sudo`.
        const result = await runZsh(target!, {
          rc: `mkdir -p "$HOME/fakebin"\nprintf '#!/bin/sh\\nexec "$@"\\n' > "$HOME/fakebin/sudo"\nchmod +x "$HOME/fakebin/sudo"\nexport PATH="$HOME/fakebin:$PATH"\n${source()}`,
          commands: ['sudo ssh -4 -V sudo-probe', 'ssh -4 -V shimmed-probe'],
          redlog: { port: collector.port, token, identity },
          timeoutSeconds: 60
        })
        expect(result.ok, result.error).toBe(true)
        const sudoStart = shellEvents(collector.events, 'command_start', 'sudo-probe')[0]
        expect(sudoStart, 'no command_start for sudo ssh').toBeTruthy()
        expect(sudoStart.data.class).toBe('pty')
        expect(sudoStart.data).toMatchObject({ capture_mode: 'native', capture_reason: 'no-pty-wrapper' })

        const wrappedStart = shellEvents(collector.events, 'command_start', 'shimmed-probe')[0]
        expect(wrappedStart, 'no command_start for ssh').toBeTruthy()
        expect(wrappedStart.data.class).toBe('pty')
        expect(wrappedStart.data.capture_mode).toBeUndefined()
        expect(wrappedStart.data.capture_reason).toBeUndefined()
      }, 300_000)
    })
  })

  // T021, FR-004. The bound is no longer a truncation limit: RedLog keeps a
  // large body whole and references it (research.md T006, and
  // `test/ingest.test.ts` covers that half). What is left in the relay is a
  // MEMORY bound, so a runaway `yes` is stopped instead of growing until
  // something else fails — and when it fires the record says so and names it.
  //
  // Driven by `REDLOG_MAX_BYTES` so the bound can be hit without producing
  // eight megabytes through a pty.
  describe('the bound, when it fires', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      run = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [`printf 'x%.0s' $(seq 1 200)`],
        redlog: { port: collector.port, token },
        env: { REDLOG_MAX_BYTES: '64' },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('cuts the record, names the bound, and does not cut the terminal', () => {
      expect(run.ok, run.error).toBe(true)

      const end = shellEvents(collector.events, 'command_end', 'seq 1 200')[0]
      expect(end, 'no command_end for the capped command').toBeTruthy()

      expect(String(end.data.stdout)).toHaveLength(64)
      // Counted in full. An operator reading `stdout_bytes: 64` of a 200-byte
      // scan would believe the record is complete; the whole point of the
      // field is to say it is not.
      expect(end.data.stdout_bytes).toBe(200)
      expect(end.data).toMatchObject({
        stdout_truncated: true,
        completeness: 'truncated',
        limit_hit: 'stdout:64'
      })

      // The cap is the record's, not the operator's: all 200 bytes were on
      // the terminal while the command ran.
      expect(run.steps[0].output).toContain('x'.repeat(200))
    })
  })
})


describeShell('terminal application boundary in real POSIX adapters', () => {
  it.each(['zsh', 'bash'] as const)('stops an existing %s adapter after narrowing, regardless of inherited app hints', async shellKind => {
    const collector = await startCollector('app-scope')
    const rc = `mkdir -p "$HOME/.redlog"\nprintf 'all\\n' > "$HOME/.redlog/terminal-app"\nsource ${hookPath(target!, shellKind === 'zsh' ? 'shell-zsh-hook.zsh' : 'shell-bash-hook.sh')}`
    try {
      for (const terminal of ['WarpTerminal', 'Apple_Terminal', '']) {
        const before = collector.events.length
        const report = await runZsh(target!, {
          shellKind, rc,
          redlog: { port: collector.port, token: 'app-scope' },
          env: { TERM_PROGRAM: terminal, WT_SESSION: '', REDLOG_TERMINAL: '', REDLOG_EXTERNAL_SESSION: '' },
          commands: ['echo app-probe', `printf 'WindowsTerminal\\n' > "$HOME/.redlog/terminal-app"`, 'echo after-exclusion'],
          timeoutSeconds: 30
        })
        expect(report.ok, report.error).toBe(true)
        expect(report.steps[0].output).toContain('app-probe')
        expect(report.steps[2].output).toContain('after-exclusion')
        const events = collector.events.slice(before)
        expect(events.some(e => String(e.data.command).includes('app-probe'))).toBe(true)
        expect(events.some(e => String(e.data.command).includes('after-exclusion'))).toBe(false)
        expect(report.transcript).toContain('[redlog] shell hook loaded')
      }
    } finally { await collector.close() }
  }, 180_000)
})


describeShell('existing prompt rendering', () => {
  it('drains command output before another precmd hook renders a prompt', async () => {
    const collector = await startCollector('prompt-order')
    try {
      const report = await runZsh(target!, {
        rc: `autoload -Uz add-zsh-hook\n_existing_prompt() { print -rn -- 'EXISTING-PROMPT'; }\nadd-zsh-hook precmd _existing_prompt\nsource ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['echo command-visible'],
        redlog: { port: collector.port, token: 'prompt-order' },
        timeoutSeconds: 30
      })
      expect(report.ok, report.error).toBe(true)
      const end = shellEvents(collector.events, 'command_end', 'command-visible')[0]
      expect(end?.data.stdout).toBe('command-visible\n')
      expect(report.steps[0].output.indexOf('command-visible')).toBeLessThan(report.steps[0].output.indexOf('EXISTING-PROMPT'))
    } finally { await collector.close() }
  }, 300_000) // includes the queue for the WSL lock when run from Windows
})
