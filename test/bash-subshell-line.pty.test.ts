import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// Bash's DEBUG trap does not follow a subshell or group compound, so
// `( make; ./run )` used to leave no record at all. The adapter now notices at
// the prompt that history moved by one while nothing was started, and writes
// the line with its exit code and an honest `not-captured` -- the output went
// to the terminal and was never ours.

const bashTarget: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }
const describeBash = process.platform === 'win32' ? describe.skip : describe

describeBash('a bash line the DEBUG trap does not see', () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let report: Awaited<ReturnType<typeof runZsh>>
  const token = 'subshell-bash'

  beforeAll(async () => {
    collector = await startCollector(token)
    report = await runZsh(bashTarget, {
      shellKind: 'bash',
      rc: `source ${hookPath(bashTarget, 'shell-bash-hook.sh')}`,
      commands: ['( echo sub-a; echo sub-b )', 'echo plain-line', '( exit 3 )', '{ echo grouped; }'],
      redlog: { port: collector.port, token, identity: { engagementId: 'eng-sub', operatorId: 'op-sub' } },
      timeoutSeconds: 40
    })
  }, 300_000)
  afterAll(async () => { await collector?.close() })

  const rows = (sub: string, needle: string): CapturedEvent[] => collector.events.filter((e) =>
    e.data.subtype === sub && String(e.data.command ?? '').includes(needle))

  it('records the subshell line once, as a start and an end', () => {
    expect(report.ok, report.error).toBe(true)
    expect(rows('command_start', 'sub-a')).toHaveLength(1)
    expect(rows('command_end', 'sub-a')).toHaveLength(1)
  })

  it('says the output was not captured, rather than inventing it', () => {
    const end = rows('command_end', 'sub-a')[0]
    expect(end.data).toMatchObject({ completeness: 'metadata-only', output_disposition: 'not-captured', exit_code: 0 })
    expect(end.data.stdout).toBeUndefined()
    expect(end.data.command_id).toBe(rows('command_start', 'sub-a')[0].data.command_id)
  })

  it('keeps the exit code of a subshell and records a group too', () => {
    expect(rows('command_end', 'exit 3')[0]?.data.exit_code).toBe(3)
    expect(rows('command_end', 'grouped')).toHaveLength(1)
  })

  it('does not double-record a line the trap already saw', () => {
    expect(rows('command_start', 'plain-line')).toHaveLength(1)
    expect(rows('command_end', 'plain-line')).toHaveLength(1)
  })
})
