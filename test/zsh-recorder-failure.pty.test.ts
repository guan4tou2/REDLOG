import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { findShellTarget, runZsh, hookPath, type ShellTarget, type ZshReport } from './helpers/zsh-pty'

// #288 / #317 B: "a recording failure must not block or re-run the command".
//
// zsh-degradation covers a RedLog that is closed, one whose relay dies, and one
// that answers nothing. This is the rest of the ways the recorder can fail
// while the operator's command is already on its way, each one stated as the
// same four things the operator would notice:
//
//   - the command ran — ONCE. A recorder that "retries" by running it again
//     is the failure that costs an engagement, so every command here appends
//     to a file and the count is read back at the end;
//   - what it printed reached the terminal;
//   - the shell's `$?` is the command's own, not the recorder's;
//   - the next prompt came back, and the next command works.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const COMMANDS = [
  'echo ran >> $HOME/runs; echo first-ok',
  `sh -c 'echo ran >> $HOME/runs; exit 7'`,
  'echo status=$?',
  'echo ran >> $HOME/runs; echo third-ok',
  'wc -l < $HOME/runs'
]

interface Scenario {
  name: string
  /** Lines in the rc, after the adapter is sourced. */
  rc?: string
  /** Before the adapter is sourced. */
  rcBefore?: string
  env?: Record<string, string>
  /** RedLog "running" with a port that answers badly. */
  collector?: 'internal-error'
}

const SCENARIOS: Scenario[] = [
  {
    name: 'the payload builder is gone (python3 fails every time)',
    rc: 'python3() { return 1 }'
  },
  {
    name: 'there is nowhere to write the spool, and RedLog is closed',
    // A FILE where the directory should be: mkdir and cp both fail, quietly.
    rcBefore: 'mkdir -p $HOME/.redlog && : > $HOME/.redlog/pending'
  },
  {
    name: 'a temporary directory cannot be made (the relay has nowhere to stand)',
    env: { TMPDIR: '/nonexistent-redlog-tmp' }
  },
  {
    name: 'RedLog is up and answers every event with a 500',
    collector: 'internal-error'
  }
]

async function failingCollector(): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  let events = 0
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/api/health')) { res.writeHead(200).end('{"ok":true}'); return }
    if (req.url?.startsWith('/api/events')) {
      events++
      req.resume()
      req.on('end', () => res.writeHead(500).end('{"error":"db"}'))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    port: (server.address() as { port: number }).port,
    requests: () => events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describeShell(`when recording fails around a command (${target?.label ?? 'no zsh reachable'})`, () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      let run: ZshReport
      let collector: Awaited<ReturnType<typeof failingCollector>> | undefined

      beforeAll(async () => {
        if (scenario.collector) collector = await failingCollector()
        run = await runZsh(target!, {
          rc: [
            scenario.rcBefore ?? '',
            `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
            scenario.rc ?? ''
          ].filter(Boolean).join('\n'),
          commands: COMMANDS,
          redlog: collector ? { port: collector.port, token: 'fail-token' } : undefined,
          // No WSL fallback to the Windows profile's real RedLog: a developer's
          // machine has one, and "closed" would not be closed.
          env: { WSL_DISTRO_NAME: '', ...scenario.env },
          timeoutSeconds: 45
        })
      }, 300_000)

      afterAll(async () => { await collector?.close() })

      it('ran every command to the end', () => {
        expect(run.ok, run.error).toBe(true)
      })

      it('let each command print to the terminal', () => {
        expect(run.steps[0].output).toContain('first-ok')
        expect(run.steps[3].output).toContain('third-ok')
      })

      it('ran each command once, not again', () => {
        // Three commands append, so three lines — a retry would make it four or more.
        expect(run.steps[4].output.trim()).toBe('3')
      })

      it('left the command’s own exit status for the shell', () => {
        expect(run.steps[2].output).toContain('status=7')
      })

      if (scenario.collector) {
        it('did try to deliver (so the failure being exercised was real)', () => {
          expect(collector!.requests()).toBeGreaterThan(0)
        })
      }
    })
  }
})
