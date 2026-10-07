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
  })
})
