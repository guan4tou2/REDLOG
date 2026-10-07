import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget } from './helpers/zsh-pty'

// Spec 052 T002. Before any of the adapter exists, the harness itself has to
// be trustworthy, and "trustworthy" here means two things that are easy to get
// wrong and impossible to notice afterwards:
//
//   1. it really drives an INTERACTIVE zsh — `preexec`/`precmd` fire, which
//      they do not under `zsh -c`, and which a piped stdout hides;
//   2. it can tell recorded from not recorded — with no adapter installed,
//      running commands produces no events at all.
//
// The second is the RED the rest of the feature is measured against. A harness
// that cannot fail cannot witness anything.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

describeShell(`zsh pty harness (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'harness-token'

  beforeAll(async () => { collector = await startCollector(token) })
  afterAll(async () => { await collector?.close() })

  it('drives a real interactive zsh, not `zsh -c`', async () => {
    const report = await runZsh(target!, {
      rc: [
        'autoload -Uz add-zsh-hook',
        '_probe_pre() { print -r -- "PREEXEC<$1>" }',
        '_probe_post() { print -r -- "PRECMD<$?>" }',
        'add-zsh-hook preexec _probe_pre',
        'add-zsh-hook precmd _probe_post'
      ].join('\n'),
      commands: ['echo marco', 'false']
    })

    expect(report.error, report.transcript.slice(0, 400)).toBeUndefined()
    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => s.command)).toEqual(['echo marco', 'false'])
    // The command ran…
    expect(report.steps[0].output).toContain('marco')
    // …and the hooks that only exist in an interactive shell ran with it.
    expect(report.transcript, 'preexec did not fire — this is not an interactive shell')
      .toContain('PREEXEC<echo marco>')
    expect(report.transcript).toContain('PRECMD<')
  })

  it('reports a failing command by its own exit status, not the harness\'s', async () => {
    const report = await runZsh(target!, {
      rc: 'autoload -Uz add-zsh-hook\n_code() { print -r -- "EXIT<$?>" }\nadd-zsh-hook precmd _code',
      commands: ['false', 'true']
    })
    expect(report.ok).toBe(true)
    expect(report.transcript).toContain('EXIT<1>')
    expect(report.transcript).toContain('EXIT<0>')
  })

  it('RED: with no adapter installed, nothing is recorded', async () => {
    const before = collector.events.length
    const report = await runZsh(target!, {
      rc: '# no RedLog adapter here',
      commands: ['echo unrecorded', 'whoami'],
      redlog: { port: collector.port, token }
    })
    expect(report.ok, report.error).toBe(true)
    expect(report.steps[0].output).toContain('unrecorded')
    // The shell worked; RedLog heard nothing. Everything spec 052 adds is
    // measured against this line.
    expect(collector.events.length - before,
      'events arrived with no adapter installed — the harness is lying').toBe(0)
  })

  it('the existing command-line adapter reaches the collector', async () => {
    // Not the feature — the feature is recording output without a prefix —
    // but it proves the HOME, the token, the port and (under WSL) the host
    // resolution are all wired, so a later silence means the adapter, not the
    // harness. `shell-common.sh` resolves the host itself: 127.0.0.1, then the
    // default gateway when it is running under WSL.
    const before = collector.events.length
    const report = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      commands: ['echo recorded-by-the-hook'],
      redlog: { port: collector.port, token },
      timeoutSeconds: 30
    })
    expect(report.ok, report.error).toBe(true)
    const arrived = collector.events.slice(before)
    const commands = arrived.filter((e) => e.agentType === 'shell'
      && String(e.data.command ?? '').includes('recorded-by-the-hook'))
    expect(commands.length, `collector saw: ${JSON.stringify(arrived.map((e) => e.data.subtype))}`)
      .toBeGreaterThan(0)
    // And it is metadata only — which is the gap this spec exists to close.
    const end = commands.find((e) => e.data.subtype === 'command_end')
    expect(end, 'no command_end').toBeTruthy()
    expect(end!.data.stdout, 'the command-line hook must not carry output').toBeUndefined()
  })
})
