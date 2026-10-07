import { describe, it, expect } from 'vitest'
import { findShellTarget, runZsh, startBlackHole, hookPath, type ShellTarget } from './helpers/zsh-pty'

// Spec 052 T002a. FR-009: when RedLog cannot be reached, the command runs
// untouched and the shell keeps working. The failure mode this pins is the one
// that is NOT a connection refusal — a RedLog that accepts the socket and then
// never answers. `--connect-timeout` is satisfied by the handshake, so before
// `--max-time` bounded them the two health probes in `hooks/shell-common.sh`
// waited on that forever, from `preexec`, on the operator's prompt. An audit
// logger that can wedge the shell it is logging will be uninstalled, and the
// engagement goes unrecorded for the reason the tool exists.
//
// Found by accident while building the harness: `spawnSync` had blocked the
// collector's event loop, which is exactly this shape. `startBlackHole` is
// that accident, on purpose.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

describeShell(`shell hook against an unresponsive RedLog (${target?.label ?? 'no zsh reachable'})`, () => {
  it('does not hang the prompt when RedLog accepts and never answers', async () => {
    const hole = await startBlackHole()
    try {
      const started = Date.now()
      const report = await runZsh(target!, {
        rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['echo still-alive'],
        redlog: { port: hole.port, token: 'black-hole-token' },
        timeoutSeconds: 45
      })

      // The prompt came back. Unbounded, this is `no prompt after echo
      // still-alive` and the whole driver timeout is spent waiting on curl.
      expect(report.ok, report.error).toBe(true)
      // And the command itself ran, with its own output, not the hook's idea
      // of it — degradation is silent to the operator, never destructive.
      expect(report.steps[0].output).toContain('still-alive')

      // Bounded, not merely finite. The budget is the two probes (127.0.0.1
      // and, under WSL, the gateway) plus a POST per event, each capped at
      // --max-time 2; the host resolution happens once per shell because
      // _REDLOG_HOST is exported. Generous on purpose: this asserts there is a
      // ceiling, and a tight one would measure the machine's load instead.
      expect(Date.now() - started).toBeLessThan(40_000)
    } finally {
      await hole.close()
    }
  }, 240_000)
})
