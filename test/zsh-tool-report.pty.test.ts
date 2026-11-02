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
const WAIT_FOR_REPORT =
  'for i in $(seq 1 100); do test -n "$(ls $HOME/.redlog/tool-detection 2>/dev/null)" && break; sleep 0.1; done; echo waited-$((1+1))'

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

    it('reports once, however many prompts there are', () => {
      expect(run.ok, run.error).toBe(true)
      expect(run.steps[6].output.trim(), `trace: ${run.steps[6].output}`).toBe('1')
      expect(run.steps[7].output.trim().split(/\s+/)).toHaveLength(1)
    })

    it('reports the PATH the first prompt has, not the one the hook was sourced with', () => {
      const report = JSON.parse(run.steps[5].output.trim()) as {
        environment: string; shell: string; found: Record<string, string>; checked: string[]
      }
      expect(report.shell).toBe('zsh')
      expect(report.environment).toMatch(/^shell:linux:[^:]+:zsh$/)
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
  }, 120_000)
})
