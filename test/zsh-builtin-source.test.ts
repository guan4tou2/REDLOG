import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findShellTarget, hookPath, runZsh, startCollector } from './helpers/zsh-pty'

const target = findShellTarget()
const suite = target ? describe : describe.skip

suite('an embedded Zsh keeps its terminal provenance', () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let report: Awaited<ReturnType<typeof runZsh>>
  beforeAll(async () => {
    collector = await startCollector('builtin-source-token')
    report = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      redlog: { port: collector.port, token: 'builtin-source-token', identity: { engagementId: 'builtin-source-project', operatorId: 'test-operator' } },
      env: { REDLOG_TERMINAL: '1', REDLOG_TERMINAL_ID: 'embedded-test' },
      commands: ['echo builtin-source-canary', "sh -c 'exit 3'"],
      timeoutSeconds: 30
    })
  }, 60_000)
  afterAll(async () => { await collector?.close() })

  it('keeps both command boundaries attributed to the embedded pane, including relay output', () => {
    expect(report.ok, report.error).toBe(true)
    const command = collector.events.filter(e => e.data.command === 'echo builtin-source-canary')
    expect(command.map(e => e.data.subtype)).toEqual(['command_start', 'command_end'])
    for (const event of command) {
      expect(event.data.source).toBe('builtin-terminal')
      expect(event.data.terminalId).toBe('embedded-test')
    }
    const end = command.find(e => e.data.subtype === 'command_end')!
    expect(end.data.stdout).toContain('builtin-source-canary')
    expect(end.data.captured_by).toBe('auto-relay')
    expect(end.data.exit_code).toBe(0)
  })

  it('also preserves pane provenance for a failed command', () => {
    const end = collector.events.find(e => e.data.subtype === 'command_end' && e.data.command === "sh -c 'exit 3'")
    expect(end?.data).toMatchObject({ source: 'builtin-terminal', terminalId: 'embedded-test', exit_code: 3 })
  })

  it('keeps builtin picker commands usable without relaying or sending them', async () => {
    const result = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      redlog: { port: collector.port, token: 'builtin-source-token' },
      env: { REDLOG_TERMINAL: '1', REDLOG_TERMINAL_ID: 'picker-pane' },
      commands: ['echo picker-command-is-not-evidence'], timeoutSeconds: 30
    })
    expect(result.ok, result.error).toBe(true)
    expect(result.steps[0].output).toContain('picker-command-is-not-evidence')
    expect(collector.events.filter(event => event.data.terminalId === 'picker-pane')).toEqual([])
  })
})
