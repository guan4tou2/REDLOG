import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// A command that prints a lot still has a record.
//
// `_redlog_send_event` used to hand the whole event to `python3 -c` as ONE
// argument. Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN) and the
// relay keeps up to 8 MiB per stream, so for any command whose output passed
// about 110 KB the exec failed — and `|| return 0` hid it. No `command_end`, no
// exit code, no spool file: a `seq 40000` left a `command_start` and nothing
// else. The commands that hit it are the ones worth recording — a long nmap, a
// ffuf run, a dump — and research.md D2 had promised the relay avoids exactly
// this ("argv-size … hazard").
//
// Nothing caught it because every test printed a line or two.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

// Probes live in files the rc writes, so no test command is long.
const RC = [
  `cat > $HOME/b-230k.sh <<'EOF'`, `seq 1 40000`, `EOF`,
  `cat > $HOME/b-both.sh <<'EOF'`,
  `i=0; while [ $i -lt 15000 ]; do echo out$i; echo err$i >&2; i=$((i+1)); done`,
  `EOF`,
  `cat > $HOME/b-4m.sh <<'EOF'`, `seq 1 600000`, `EOF`,
  ''
].join('\n')

const endOf = (events: CapturedEvent[], command: string): Record<string, unknown> | undefined =>
  events.find((e) => e.data.subtype === 'command_end' && e.data.command === command)?.data

describeShell(`a command with a large body (${target?.label ?? 'no zsh reachable'})`, () => {
  describe('while RedLog is running', () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let run: Awaited<ReturnType<typeof runZsh>>
    const token = 'large-body-token'

    beforeAll(async () => {
      collector = await startCollector(token)
      run = await runZsh(target!, {
        rc: `${RC}source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: ['sh $HOME/b-230k.sh', 'sh $HOME/b-both.sh', 'sh $HOME/b-4m.sh', 'echo still-recorded'],
        redlog: { port: collector.port, token },
        timeoutSeconds: 90,
        totalTimeoutSeconds: 300
      })
    }, 600_000)
    afterAll(async () => { await collector?.close() })

    it('ran', () => {
      expect(run.ok, run.error).toBe(true)
    })

    it('records a 229 KB output, with its exit code', () => {
      const end = endOf(collector.events, 'sh $HOME/b-230k.sh')
      expect(end, 'command_end never arrived').toBeTruthy()
      expect(end!.exit_code).toBe(0)
      expect(end!.stdout_bytes).toBe(228894)
      expect(String(end!.stdout).length, 'the body was cut').toBeGreaterThan(200_000)
    })

    it('records a command that fills both streams', () => {
      const end = endOf(collector.events, 'sh $HOME/b-both.sh')
      expect(end, 'command_end never arrived').toBeTruthy()
      expect(String(end!.stdout)).toContain('out14999')
      expect(String(end!.stderr)).toContain('err14999')
    })

    it('records a multi-megabyte output', () => {
      const end = endOf(collector.events, 'sh $HOME/b-4m.sh')
      expect(end, 'command_end never arrived').toBeTruthy()
      expect(end!.stdout_bytes).toBe(4_088_895)
      expect(end!.completeness).toBe('complete')
    })

    it('and the next, small, command is unaffected', () => {
      expect(endOf(collector.events, 'echo still-recorded')?.exit_code).toBe(0)
    })
  })

  // The other half of the contract: when the POST cannot happen, the event is
  // spooled for replay. It used to be dropped first, so there was nothing to
  // spool.
  describe('while RedLog is closed', () => {
    let run: Awaited<ReturnType<typeof runZsh>>

    beforeAll(async () => {
      const stillborn = await startCollector('unused')
      const deadPort = stillborn.port
      await stillborn.close()
      run = await runZsh(target!, {
        rc: `${RC}source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
        commands: [
          'sh $HOME/b-230k.sh',
          // One name and size per line; the bodies themselves are not printed.
          'for f in $HOME/.redlog/pending/*.json; do print -r -- "spooled $(wc -c < $f) $(grep -c command_end $f)"; done'
        ],
        redlog: {
          port: deadPort, token: 'nobody-home',
          identity: { engagementId: 'eng-large', operatorId: 'op-large' }
        },
        timeoutSeconds: 90
      })
    }, 300_000)

    it('keeps the whole event for replay', () => {
      expect(run.ok, run.error).toBe(true)
      const sizes = run.steps[1].output.split('\n')
        .map((l) => /^spooled (\d+) (\d+)/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ bytes: Number(m[1]), isEnd: Number(m[2]) > 0 }))
      const end = sizes.find((s) => s.isEnd && s.bytes > 200_000)
      expect(end, `no spooled command_end of that size: ${JSON.stringify(sizes)}`).toBeTruthy()
    })
  })
})
