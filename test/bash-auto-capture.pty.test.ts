import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// The bash adapter recorded the command and its exit status, and nothing the
// command printed: output needed `redlog-run`, a prefix nobody remembers
// mid-engagement. HTTP is recorded whole without being asked; a shell is the
// same kind of evidence and was not. This is the zsh adapter's promise made by
// bash — through the DEBUG trap, since bash has no `preexec` — and it is
// checked the same way: a real interactive bash on a pty, because the trap and
// PROMPT_COMMAND behave differently when stdin is a pipe.
//
// macOS ships bash 3.2, which has no `exec {fd}>&1`, no `$EPOCHREALTIME` and no
// associative arrays. The adapter has to work there, so that is what this runs
// on whenever it is what the machine has.

const target: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }
const describeShell = process.platform === 'win32' ? describe.skip : describe

const events = (all: CapturedEvent[], subtype: string, match: string): CapturedEvent[] =>
  all.filter((e) => e.agentType === 'shell'
    && e.data.subtype === subtype
    && String(e.data.command ?? '').includes(match))

describeShell(`auto capture in an enrolled bash (${target.label})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let report: Awaited<ReturnType<typeof runZsh>>
  const token = 'bash-auto-capture-token'

  beforeAll(async () => {
    collector = await startCollector(token)
    report = await runZsh(target, {
      shellKind: 'bash',
      rc: `export PAGER=less\nsource ${hookPath(target, 'shell-bash-hook.sh')}`,
      commands: [
        'cd /tmp',
        'echo auto-captured-output',
        "sh -c 'exit 3'",
        'echo status=$?',
        'echo to-stdout; echo to-stderr >&2',
        'echo piped-line | cat',
        'echo into-file > "$HOME/out.txt"',
        'echo "pager=$PAGER"',
        'ls /nonexistent-redlog-dir'
      ],
      redlog: { port: collector.port, token },
      timeoutSeconds: 40
    })
  }, 300_000)
  afterAll(async () => { await collector?.close() })

  it('records a plain command with its output, status and cwd', () => {
    expect(report.ok, report.error).toBe(true)
    // The operator still sees their own output.
    expect(report.steps[1].output).toContain('auto-captured-output')

    const start = events(collector.events, 'command_start', 'auto-captured-output')[0]
    const end = events(collector.events, 'command_end', 'auto-captured-output')[0]
    expect(start, 'no command_start').toBeTruthy()
    expect(end, 'no command_end').toBeTruthy()
    expect(start.data.command_id).toBeTruthy()
    expect(end.data.command_id).toBe(start.data.command_id)
    expect(start.data.source).toBe('auto-relay')
    expect(start.data.class).toBe('relayed')
    expect(end.data.stdout).toContain('auto-captured-output')
    expect(end.data.exit_code).toBe(0)
    expect(String(end.data.cwd)).toBe('/tmp')
    expect(end.data).toMatchObject({ completeness: 'complete', output_disposition: 'captured' })
  })

  it('reports the command’s own exit status, to the record and to the shell', () => {
    const failed = events(collector.events, 'command_end', "sh -c 'exit 3'")[0]
    expect(failed?.data.exit_code).toBe(3)
    // `$?` at the next prompt is what the operator's own `&&` depends on.
    const next = events(collector.events, 'command_end', 'status=$?')[0]
    expect(next?.data.stdout, 'the relay changed the previous status').toContain('status=3')
  })

  it('keeps stdout and stderr apart', () => {
    const end = events(collector.events, 'command_end', 'to-stderr')[0]
    expect(end?.data.stdout).toContain('to-stdout')
    expect(String(end?.data.stdout)).not.toContain('to-stderr')
    expect(end?.data.stderr).toContain('to-stderr')
  })

  it('records the output of a command that failed, with its status', () => {
    const end = events(collector.events, 'command_end', 'ls /nonexistent-redlog-dir')[0]
    expect(end?.data.exit_code).not.toBe(0)
    expect(String(end?.data.stderr)).toMatch(/nonexistent-redlog-dir/)
  })

  it('records the last stage of a pipeline and still shows it', () => {
    expect(report.steps[5].output).toContain('piped-line')
    const end = events(collector.events, 'command_end', 'piped-line')[0]
    expect(end?.data.stdout).toContain('piped-line')
  })

  it('does not relay a command whose stdout the operator already redirected', () => {
    const end = events(collector.events, 'command_end', 'into-file')[0]
    expect(end?.data).toMatchObject({ output_disposition: 'redirected', completeness: 'metadata-only' })
  })

  it('switches pagers off for the command and puts them back at the prompt', () => {
    const during = events(collector.events, 'command_end', 'pager=')[0]
    expect(during?.data.stdout).toContain('pager=cat')
    expect(report.steps[7].output).toContain('pager=cat')
  })
})

describeShell(`bash auto capture degrades instead of wedging (${target.label})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'bash-degrade-token'
  beforeAll(async () => { collector = await startCollector(token) })
  afterAll(async () => { await collector?.close() })

  it('runs the command unrecorded when descriptor 8 is already the operator’s', async () => {
    const report = await runZsh(target, {
      shellKind: 'bash',
      rc: `exec 8>/dev/null\nsource ${hookPath(target, 'shell-bash-hook.sh')}`,
      commands: ['echo still-visible', 'echo second'],
      redlog: { port: collector.port, token },
      timeoutSeconds: 30
    })
    expect(report.ok, report.error).toBe(true)
    expect(report.steps[0].output).toContain('still-visible')
    expect(report.steps[1].output).toContain('second')
    const end = events(collector.events, 'command_end', 'still-visible')[0]
    expect(end?.data.output_disposition).toBe('not-captured')
    // And the operator's descriptor was not closed under them.
    const probe = await runZsh(target, {
      shellKind: 'bash',
      rc: `exec 8>/dev/null\nsource ${hookPath(target, 'shell-bash-hook.sh')}`,
      commands: ['echo x', '{ : >&8; } 2>/dev/null && echo fd8-open || echo fd8-closed'],
      redlog: { port: collector.port, token },
      timeoutSeconds: 30
    })
    expect(probe.steps[1].output).toContain('fd8-open')
  }, 120_000)
})

describeShell(`bash auto capture when the relay cannot help (${target.label})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'bash-relay-fail-token'
  beforeAll(async () => { collector = await startCollector(token) })
  afterAll(async () => { await collector?.close() })

  it('keeps the terminal usable when the relay dies before it hands over the ptys', async () => {
    // A relay that exits at once never writes `pts`. The shell waits its five
    // seconds, restores its descriptors and runs the command unrecorded; what
    // it must not do is leave stdout pointing at nothing.
    const report = await runZsh(target, {
      shellKind: 'bash',
      // Classify must still say `relayed`, or the relay is never started and
      // nothing is tested; only the `pty` hand-over fails.
      rc: [
        `cat > $HOME/relay-stub.py <<'EOF'`,
        `import sys`,
        `sys.stdout.write('relayed') if sys.argv[1] == 'classify' else sys.exit(1)`,
        `EOF`,
        `source ${hookPath(target, 'shell-bash-hook.sh')}`,
        `_REDLOG_RELAY=$HOME/relay-stub.py`
      ].join('\n'),
      commands: ['echo still-here', 'echo and-again', 'echo status=$?'],
      redlog: { port: collector.port, token },
      timeoutSeconds: 40
    })
    expect(report.ok, report.error).toBe(true)
    expect(report.steps[0].output).toContain('still-here')
    expect(report.steps[1].output).toContain('and-again')
    expect(report.steps[2].output).toContain('status=0')
    const end = events(collector.events, 'command_end', 'still-here')[0]
    expect(end?.data.output_disposition).toBe('not-captured')
  }, 180_000)

  it('returns the prompt after a backgrounded command, and the next command is recorded', async () => {
    // Known cost, shared with the zsh adapter: a background job still holds the
    // relay's ptys, so the prompt waits out the relay's drain timeout. What is
    // asserted is that it does come back and that nothing after it is lost.
    const report = await runZsh(target, {
      shellKind: 'bash',
      rc: `source ${hookPath(target, 'shell-bash-hook.sh')}`,
      commands: ['sleep 2 &', 'echo after-background'],
      redlog: { port: collector.port, token },
      timeoutSeconds: 40
    })
    expect(report.ok, report.error).toBe(true)
    expect(report.steps[1].output).toContain('after-background')
    expect(events(collector.events, 'command_end', 'after-background')[0]?.data.stdout)
      .toContain('after-background')
  }, 180_000)
})
