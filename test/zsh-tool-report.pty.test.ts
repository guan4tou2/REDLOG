import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #499 PR B. A shell reports which tools its PATH reaches, once, at its first
// prompt, and only then: the rc line that sources the hook is appended at
// install, so every later installer's PATH line comes AFTER it, and a report
// taken at source time would miss the tools those installers added. Once,
// because the answer is for a settings panel and a lookup per prompt would be
// a cost on every command for something that does not change between them.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

// `ls` of the directory itself: a glob that matches nothing is an error in zsh.
const LISTED = 'test -n "$(ls $HOME/.redlog/tool-detection 2>/dev/null)"'
const WAIT_FOR_REPORT = `for i in $(seq 1 100); do ${LISTED} && break; sleep 0.1; done; echo waited-$((1+1))`
// The first thing typed. The first prompt is drawn before it, so a report taken
// at the FIRST COMMAND's prompt (the early return in precmd) is not there yet
// and this polls into its own timeout; a report taken at the first prompt is.
const BEFORE_ANY_COMMAND = `for i in $(seq 1 50); do ${LISTED} && break; sleep 0.1; done; ${LISTED}; echo before-any-command-$?`

describeShell(`the first-prompt tool report (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'pr-b-token'
  beforeAll(async () => { collector = await startCollector(token) })
  afterAll(async () => { await collector?.close() })

  describe('one shell, several commands', () => {
    let run: Awaited<ReturnType<typeof runZsh>>
    beforeAll(async () => {
      run = await runZsh(target!, {
        // The tool is put on PATH AFTER the hook is sourced, as a later installer would.
        rc: [
          'export REDLOG_SESSION_TRACE="$HOME/detect-trace"',
          `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
          'mkdir -p "$HOME/late-bin" && : > "$HOME/late-bin/pwncat-cs" && chmod 755 "$HOME/late-bin/pwncat-cs"',
          'export PATH="$HOME/late-bin:$PATH"'
        ].join('\n'),
        commands: [
          BEFORE_ANY_COMMAND,
          'echo one', 'echo two', 'echo three',
          WAIT_FOR_REPORT,
          // The background write has finished; give a second one the chance to show itself.
          'sleep 1; echo slept-$((1+1))',
          'cat $HOME/.redlog/tool-detection/*.json',
          `grep -c ' relay detect checked=' $HOME/detect-trace`,
          'ls $HOME/.redlog/tool-detection'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 60
      })
    }, 300_000)

    it('reports at the first prompt, before any command has run', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[0].output).toContain('before-any-command-0')
    })

    it('reports once, however many prompts there are', () => {
      expect(run.steps[7].output.trim(), `trace: ${run.steps[7].output}`).toBe('1')
      expect(run.steps[8].output.trim().split(/\s+/)).toHaveLength(1)
    })

    it('reports the PATH the first prompt has, not the one the hook was sourced with', () => {
      const report = JSON.parse(run.steps[6].output.trim()) as {
        environment: string; shell: string; found: Record<string, string>; checked: string[]
      }
      expect(report.shell).toBe('zsh')
      expect(report.environment).toMatch(new RegExp(`^shell:${target!.prefix.length ? 'linux' : process.platform}:[^:]+:zsh$`))
      expect(report.checked).toContain('pwncat-cs')
      expect(report.found['pwncat-cs']).toMatch(/\/late-bin\/pwncat-cs$/)
    })
  })

  it('writes nothing from a shell RedLog already owns', async () => {
    const run = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      commands: ['echo one', 'sleep 1; echo slept-$((1+1))', 'test -d $HOME/.redlog/tool-detection; echo rc-$?'],
      redlog: { port: collector.port, token },
      env: { REDLOG_EXTERNAL_SESSION: '1' },
      timeoutSeconds: 60
    })
    expect(run.ok, run.error).toBe(true)
    expect(run.steps[2].output).toContain('rc-1')
  }, 300_000)

  // After `redlog stop` RedLog writes nothing new for that shell, and that
  // includes this report. A shell that begins stopped (machine mode manual)
  // reports at the first prompt after `redlog start`, once; stopping and
  // starting again adds nothing.
  it('writes no report while stopped, one after redlog start, and no second one after that', async () => {
    const reports = 'rl_n' // defined in the rc: a long typed line wraps and is echoed into the output
    const run = await runZsh(target!, {
      rc: [
        'export REDLOG_SESSION_TRACE="$HOME/detect-trace"',
        'mkdir -p "$HOME/.redlog" && echo manual > "$HOME/.redlog/terminal-mode"',
        `rl_n() { cat $HOME/detect-trace 2>/dev/null | grep -c ' relay detect checked='; }`,
        `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`
      ].join('\n'),
      commands: [
        'echo one', 'echo two',
        'sleep 1; echo slept-$((1+1))',
        `${reports}; test -d $HOME/.redlog/tool-detection; echo dir-rc-$?`, // 3: while stopped
        'redlog start',
        WAIT_FOR_REPORT,
        'sleep 1; echo slept-$((1+1))',
        reports, // 7: after start
        'redlog stop', 'echo three', 'redlog start', 'echo four',
        'sleep 1; echo slept-$((1+1))',
        reports // 13: after stop and start again
      ],
      redlog: { port: collector.port, token },
      timeoutSeconds: 60
    })
    expect(run.ok, run.error).toBe(true)
    expect(run.steps[3].output, 'a stopped shell reported').toMatch(/^0\s+dir-rc-1/)
    expect(run.steps[7].output.trim(), 'redlog start did not produce exactly one report').toBe('1')
    expect(run.steps[13].output.trim(), 'stop and start again reported again').toBe('1')
  }, 300_000)

  // Under WARN_CREATE_GLOBAL a function that assigns an undeclared parameter
  // prints a warning. The first prompt now runs the shell-name lookup, which on
  // main first ran at the first command; the adapter declares what it assigns.
  it('prints no created-globally warning before the first prompt with WARN_CREATE_GLOBAL set', async () => {
    const run = await runZsh(target!, {
      rc: ['setopt WARN_CREATE_GLOBAL', `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`].join('\n'),
      commands: ['echo ready-$((1+1))'],
      redlog: { port: collector.port, token },
      // Under WSL the hook resolves the directory at source time, which warns
      // on main as well; this test is about the first prompt.
      env: { WSL_DISTRO_NAME: '' },
      timeoutSeconds: 60
    })
    expect(run.ok, run.error).toBe(true)
    const beforeFirstPrompt = run.transcript.split(run.marker)[0]
    expect(beforeFirstPrompt).not.toMatch(/created globally/)
  }, 300_000)
})
