import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type CapturedEvent } from './helpers/zsh-pty'

// Spec 052 T045, SC-002 / SC-003: a scripted engagement of at least a hundred
// commands, every one recorded, none prefixed.
//
// The other pty suites run a handful of commands each, which is the right size
// for asking "does this behaviour work". It is the wrong size for asking "does
// it keep working": whatever leaks a descriptor, loses a race at the end of a
// command, or misorders a pair shows up once in fifty and never in five. A
// hundred is also the only place the cost of the relay is visible, because it
// is paid on every command.
//
// WHY A DRIVER AND NOT A SCRIPT. `preexec` fires once per line an operator
// types into an interactive shell. A `for` loop is one command, `source file`
// is one command, and a multi-line paste into zsh 5.9 becomes one buffer — so
// none of those can put a hundred commands through the adapter. The pty driver
// types them one at a time, which is the only honest way to measure this.
//
// Every command carries its own number, so each can be matched back to its
// record individually. Counting rows would pass with fifty duplicated and
// fifty missing.
//
// Slow on a Windows host: through WSL each relayed command costs a few
// seconds, so this is opt-in there (REDLOG_PTY_SC=1). On native Linux — CI —
// it runs by default.

const target: ShellTarget | null = findShellTarget()
const enabled = !!target && (target.prefix.length === 0 || process.env.REDLOG_PTY_SC === '1')
const describeShell = enabled ? describe : describe.skip

const COUNT = 100

interface Planned {
  n: number
  command: string
  /** what a reader of the record should be able to find */
  stdout?: string
  stderr?: string
  exit: number
  disposition: 'captured' | 'redirected'
}

/** Ten shapes, cycled — so the engagement is not a hundred copies of `echo`. */
function plan(n: number): Planned {
  switch (n % 10) {
    case 0: return { n, command: `echo engage-${n}`, stdout: `engage-${n}`, exit: 0, disposition: 'captured' }
    case 1: return { n, command: `printf 'line-a-${n}\\nline-b-${n}\\n'`, stdout: `line-b-${n}`, exit: 0, disposition: 'captured' }
    // `: ${n}` is a no-op that exists only to make the line unique. Without it
    // `exit ${n % 7}` repeats (2 and 72 are both `exit 2`), and a test that
    // matches rows back by command text then sees two rows for one command.
    case 2: return { n, command: `sh -c ': ${n}; exit ${n % 7}'`, exit: n % 7, disposition: 'captured' }
    case 3: return { n, command: `echo piped-${n} | tr a-z A-Z`, stdout: `PIPED-${n}`, exit: 0, disposition: 'captured' }
    case 4: return { n, command: `echo to-file-${n} > $HOME/out-${n}.txt`, exit: 0, disposition: 'redirected' }
    // A builtin: it runs in the shell and not as a process, which is a
    // different path through the relay than every other line here. No `#`
    // comments anywhere in this table — they are not comments in an
    // interactive zsh unless INTERACTIVE_COMMENTS is set, so `cd /tmp # x`
    // is `cd` with three arguments.
    case 5: return { n, command: `cd /tmp && echo cd-${n}`, stdout: `cd-${n}`, exit: 0, disposition: 'captured' }
    case 6: return { n, command: `pwd && echo pwd-${n}`, stdout: `pwd-${n}`, exit: 0, disposition: 'captured' }
    case 7: return { n, command: `echo err-${n} >&2`, stderr: `err-${n}`, exit: 0, disposition: 'captured' }
    case 8: return { n, command: `seq 1 20 | tail -1 && echo tail-${n}`, stdout: `tail-${n}`, exit: 0, disposition: 'captured' }
    default: return { n, command: `echo   spaced   out   ${n}`, stdout: `spaced out ${n}`, exit: 0, disposition: 'captured' }
  }
}

const planned = Array.from({ length: COUNT }, (_, i) => plan(i + 1))

describeShell(`a ${COUNT}-command engagement (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let report: Awaited<ReturnType<typeof runZsh>>
  const token = 'engagement-token'

  beforeAll(async () => {
    collector = await startCollector(token)
    report = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      // Typed exactly as the operator types them. Nothing here says redlog-run.
      commands: planned.map((p) => p.command),
      redlog: { port: collector.port, token },
      // Per command, and for the whole thing — a hundred commands at the
      // relay's cost is minutes through WSL, and the default total would kill
      // the shell a quarter of the way through and call it a hang.
      timeoutSeconds: 60,
      totalTimeoutSeconds: 1500
    })
  }, 1_800_000)
  afterAll(async () => { await collector?.close() })

  const rowsFor = (command: string, subtype: string): CapturedEvent[] =>
    collector.events.filter((e) => e.agentType === 'shell'
      && e.data.subtype === subtype && e.data.command === command)

  it('is a plan in which every line is different', () => {
    // Everything below matches a record back to a command by its text. If two
    // lines were the same, the test would report a product bug that is really
    // a planning one — which is exactly how this file's first run failed.
    const seen = new Set<string>()
    const repeated = planned.filter((p) => seen.size === seen.add(p.command).size).map((p) => p.command)
    expect(repeated).toEqual([])
  })

  it('ran every command to the end, in a shell that was still usable', () => {
    expect(report.ok, report.error).toBe(true)
    expect(report.steps).toHaveLength(COUNT)
  })

  it('recorded each of them, once, with the output it produced', () => {
    const problems: string[] = []
    for (const p of planned) {
      const starts = rowsFor(p.command, 'command_start')
      const ends = rowsFor(p.command, 'command_end')
      if (starts.length !== 1) problems.push(`#${p.n} ${p.command}: ${starts.length} command_start rows`)
      if (ends.length !== 1) { problems.push(`#${p.n} ${p.command}: ${ends.length} command_end rows`); continue }
      const end = ends[0].data
      if (end.exit_code !== p.exit) problems.push(`#${p.n}: exit ${String(end.exit_code)}, wanted ${p.exit}`)
      if (end.output_disposition !== p.disposition) {
        problems.push(`#${p.n}: ${String(end.output_disposition)}, wanted ${p.disposition}`)
      }
      if (p.stdout !== undefined && !String(end.stdout ?? '').includes(p.stdout)) {
        problems.push(`#${p.n}: stdout lost — wanted "${p.stdout}", got ${JSON.stringify(end.stdout)}`)
      }
      if (p.stderr !== undefined && !String(end.stderr ?? '').includes(p.stderr)) {
        problems.push(`#${p.n}: stderr lost — wanted "${p.stderr}", got ${JSON.stringify(end.stderr)}`)
      }
      if (end.exit_code !== p.exit || (p.stderr !== undefined && !String(end.stderr ?? '').includes(p.stderr))) {
        problems.push(`#${p.n}: terminal output ${JSON.stringify(report.steps[p.n - 1]?.output)}`)
      }
      // The pair is correlated by the id the adapter minted, on both ends.
      if (starts[0] && starts[0].data.command_id !== end.command_id) {
        problems.push(`#${p.n}: command_start and command_end carry different ids`)
      }
    }
    // One list, so a failure says everything that went wrong rather than the
    // first thing — a hundred commands that fail in three different ways is a
    // different bug from one that fails once.
    expect(problems, problems.slice(0, 12).join('\n')).toEqual([])
  })

  it('never needed a prefix', () => {
    const prefixed = collector.events.filter((e) => /^\s*redlog-run\b/.test(String(e.data.command ?? '')))
    expect(prefixed, 'something was typed with redlog-run in front of it').toHaveLength(0)
    // …and every body in the record came from the automatic path, not from the
    // explicit wrapper that used to be the only way to get one.
    const withBody = collector.events.filter((e) => e.data.subtype === 'command_end' && e.data.stdout)
    for (const e of withBody) expect(e.data.captured_by, String(e.data.command)).toBe('auto-relay')
  })

  it('kept the commands in the order they were typed', () => {
    const order = collector.events
      .filter((e) => e.data.subtype === 'command_start')
      .map((e) => planned.findIndex((p) => p.command === e.data.command))
      .filter((i) => i >= 0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('says what the relay costs, which is the number SC-001’s reader will want', () => {
    const times = report.steps.map((s) => s.ms ?? 0).sort((a, b) => a - b)
    const mean = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    const p95 = times[Math.floor(times.length * 0.95)]
    // Reported, not asserted. The bound that matters is "an operator does not
    // notice", which no CI machine can judge — but the number belongs in
    // verification.md rather than in somebody's memory of a slow afternoon.
    console.log(`[T045] ${COUNT} commands on ${target!.label}: mean ${mean} ms, p95 ${p95} ms, max ${times[times.length - 1]} ms, total ${report.elapsedMs} ms`)
    expect(times).toHaveLength(COUNT)
  })
})
