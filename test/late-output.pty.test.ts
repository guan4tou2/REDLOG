import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// A background job outlives the prompt. `nmap -p- host &` returns at once and
// prints for minutes; the relay used to hold the prompt for ten seconds, give
// up, and leave a record holding whatever had arrived by then. The record has
// to be whole: the body that existed when the prompt came back is `command_end`
// (partial), and what the job prints afterwards is `command_output` rows with
// the same command_id, ending in a row marked `final`.
//
// Both adapters, because both relay through the same process and the failure
// is in what they hand it.

const bashTarget: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }
const zshTarget: ShellTarget | null = findShellTarget()

// A simple command, not `( … ) &`: bash's DEBUG trap does not fire for a
// subshell compound, so that line is not seen by the bash adapter at all.
const JOB = `sh -c 'echo job-early; sleep 3; echo job-late; echo job-err >&2' &`

const forShell = (kind: 'bash' | 'zsh', target: ShellTarget | null): void => {
  const describeShell = process.platform === 'win32' || !target ? describe.skip : describe
  describeShell(`output from a background job after the prompt (${kind})`, () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let report: Awaited<ReturnType<typeof runZsh>>
    const token = `late-${kind}`

    beforeAll(async () => {
      collector = await startCollector(token)
      report = await runZsh(target!, {
        shellKind: kind,
        rc: `source ${hookPath(target!, kind === 'bash' ? 'shell-bash-hook.sh' : 'shell-zsh-hook.zsh')}`,
        commands: [JOB, 'echo after-job'],
        redlog: { port: collector.port, token, identity: { engagementId: 'eng-late', operatorId: 'op-late' } },
        timeoutSeconds: 40
      })
      // The job runs three seconds past the prompt; give the last chunk time.
      await new Promise((r) => setTimeout(r, 5000))
    }, 300_000)
    afterAll(async () => { await collector?.close() })

    const end = (): CapturedEvent | undefined => collector.events.find((e) =>
      e.data.subtype === 'command_end' && String(e.data.command ?? '').includes('job-early'))
    const chunks = (): CapturedEvent[] => collector.events.filter((e) =>
      e.data.subtype === 'command_output' && e.data.command_id === end()?.data.command_id)

    it('gives the prompt back long before the job finishes', () => {
      expect(report.ok, report.error).toBe(true)
      // The job sleeps 3 s. The old wait was the relay's 5 s drain timeout per
      // stream; the prompt is now back within a second or so.
      expect(report.steps[0].prompt_ms, 'the prompt waited for the job').toBeLessThan(2500)
      expect(report.steps[1].output).toContain('after-job')
    })

    it('records what had printed by then, and says more is coming', () => {
      const e = end()
      expect(e, 'no command_end').toBeTruthy()
      expect(e!.data).toMatchObject({ completeness: 'partial', output_disposition: 'captured', late_output: true })
      expect(String(e!.data.stdout)).toContain('job-early')
      expect(String(e!.data.stdout)).not.toContain('job-late')
    })

    it('sends the rest as chunks of the same command, in order, per stream', () => {
      const rows = chunks()
      expect(rows.length, 'no command_output rows').toBeGreaterThan(0)
      const stdout = rows.filter((r) => r.data.stream === 'stdout').map((r) => String(r.data.stdout)).join('')
      const stderr = rows.filter((r) => r.data.stream === 'stderr').map((r) => String(r.data.stderr)).join('')
      expect(stdout).toContain('job-late')
      expect(stderr).toContain('job-err')
      const seqs = rows.map((r) => Number(r.data.seq))
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size, 'a seq was reused').toBe(seqs.length)
      expect(rows.every((r) => r.data.late === true)).toBe(true)
    })

    it('ends with one final row that accounts for the bytes', () => {
      const finals = chunks().filter((r) => r.data.final === true)
      expect(finals).toHaveLength(1)
      expect(finals[0].data).toMatchObject({ truncated: false, dropped_bytes: 0 })
      expect(Number(finals[0].data.late_bytes)).toBeGreaterThan(0)
    })
  })
}

forShell('bash', bashTarget)
forShell('zsh', zshTarget)
