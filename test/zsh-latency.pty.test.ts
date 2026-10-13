import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import { findShellTarget, runInShell, runZsh, startCollector, type ShellTarget, type ZshReport } from './helpers/zsh-pty'

// #288 / #317 B. What the recorder costs, measured against the same shell
// without it — not against a number.
//
// The figure in specs/052 ("mean 479–616 ms per command") was the driver's
// `ms`, which includes its own 250 ms drain after every prompt, and it had no
// bare shell beside it. It could say the 100-command engagement worked; it
// could not say what the adapter adds. This asks that question directly, per
// command, with the prompt as the stopwatch (`prompt_ms`: the line sent until
// the next prompt drawn) and a bare shell run through the same driver as the
// baseline. What is reported is the DIFFERENCE, because the driver's own cost
// is in both.
//
// Opt-in (REDLOG_PERF=1): it is a measurement, and timings on a shared CI
// runner are not a gate. It prints a table and asserts only what is true on
// any machine — that the runs finished and that the adapter recorded what it
// was timed running — plus a ceiling that today's number must not cross.

const target: ShellTarget | null = findShellTarget()
const enabled = !!target && process.env.REDLOG_PERF === '1'
const describeShell = enabled ? describe : describe.skip

const ROUNDS = 2

interface Shape {
  name: string
  command: string
  /** Commands per shell after the cold one. */
  steady: number
}

const SHAPES: Shape[] = [
  { name: 'no output', command: 'true', steady: 30 },
  { name: 'one line', command: 'echo latency-probe', steady: 30 },
  { name: '2 000 lines (~9 KB)', command: 'seq 1 2000', steady: 20 },
  { name: '200 000 lines (~1.3 MB)', command: 'seq 1 200000', steady: 6 }
]

/** The line today's number must not cross, in ms added at the median for a
 *  command that prints nothing. It is NOT the goal: spec 052 plan.md asks for
 *  under 50, and the first measurement (2026-10-13, WSL, hooks on /mnt/c) was
 *  ~315. With the hooks on the distro disk and the payload and class lookup
 *  done without a process it reads 150–240 from run to run on this machine,
 *  which is wider than the steps being measured (see verification.md for the
 *  interleaved A/B that is not). So this only stops it getting worse than where
 *  it started; lower it as the gap closes, until it is the plan's own figure. */
const NO_OUTPUT_CEILING_MS = 300

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)]
const fmt = (n: number): string => n.toFixed(0).padStart(6)

interface Cell { cold: number[]; steady: number[] }

describeShell(`what the recorder adds to a command (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'latency-token'
  const bare = new Map<string, Cell>()
  const adapted = new Map<string, Cell>()
  const reports: ZshReport[] = []

  const timings = (report: ZshReport): { cold: number; steady: number[] } => {
    const ms = report.steps.map((s) => s.prompt_ms ?? NaN)
    return { cold: ms[0], steady: ms.slice(1) }
  }

  // Where the hook files are read from. Through WSL the repository is on the
  // Windows disk, which the shell reaches over 9p: the relay script alone costs
  // ~30 ms more to start from there than from the distro's own disk (36 ms
  // against 66 ms, minimum of 25), and the adapter starts it several times per
  // command. A Kali install has its hooks on its own disk, so that is what is
  // measured by default; REDLOG_PERF_HOOKS=source reads them in place instead.
  let hooksDir = ''
  const where = (): string => hooksDir.startsWith('/tmp/') ? 'copied to the distro disk' : 'read in place'

  beforeAll(async () => {
    collector = await startCollector(token)
    hooksDir = target!.toShellPath(path.join(__dirname, '..', 'hooks'))
    if (target!.prefix.length > 0 && process.env.REDLOG_PERF_HOOKS !== 'source') {
      const copied = await runInShell(target!,
        `set -e\nrm -rf /tmp/redlog-hooks-perf\nmkdir -p /tmp/redlog-hooks-perf\ncp -r ${hooksDir}/. /tmp/redlog-hooks-perf/\n`)
      if (copied.status !== 0) throw new Error(`could not copy the hooks: ${copied.stderr.slice(0, 300)}`)
      hooksDir = '/tmp/redlog-hooks-perf'
    }
    for (let round = 0; round < ROUNDS; round++) {
      for (const shape of SHAPES) {
        const commands = Array.from({ length: shape.steady + 1 }, () => shape.command)
        const common = { commands, timeoutSeconds: 60, totalTimeoutSeconds: 300 }
        const b = await runZsh(target!, { ...common, rc: '' })
        const a = await runZsh(target!, {
          ...common,
          rc: `source ${hooksDir}/shell-zsh-hook.zsh`,
          redlog: { port: collector.port, token }
        })
        reports.push(b, a)
        for (const [map, report] of [[bare, b], [adapted, a]] as const) {
          const cell = map.get(shape.name) ?? { cold: [], steady: [] }
          const t = timings(report)
          cell.cold.push(t.cold)
          cell.steady.push(...t.steady)
          map.set(shape.name, cell)
        }
      }
    }
  }, 1_800_000)

  afterAll(async () => { await collector?.close() })

  it('ran to the end in both shells, every time', () => {
    for (const r of reports) expect(r.ok, r.error).toBe(true)
  })

  it('recorded every command it was timing', () => {
    for (const shape of SHAPES) {
      const ends = collector.events.filter((e) =>
        e.data.subtype === 'command_end' && e.data.command === shape.command).length
      expect(ends, `${shape.command}: command_end events`).toBe((shape.steady + 1) * ROUNDS)
    }
  })

  it('prints the cost, and stays under the no-output ceiling', () => {
    const rows: string[] = []
    rows.push(`prompt_ms, ${ROUNDS} rounds, ${target!.label}, hooks ${where()} — bare | adapted | added (ms)`)
    rows.push('shape                            n    bare med  adapt med   +med   +mean   +p95   cold bare  cold adapt')
    let noOutputAdded = Number.NaN
    for (const shape of SHAPES) {
      const b = bare.get(shape.name)!
      const a = adapted.get(shape.name)!
      const addedMed = median(a.steady) - median(b.steady)
      if (shape.name === 'no output') noOutputAdded = addedMed
      rows.push(
        `${shape.name.padEnd(30)} ${String(a.steady.length).padStart(4)} ${fmt(median(b.steady))}  ${fmt(median(a.steady))}  ` +
        `${fmt(addedMed)}  ${fmt(mean(a.steady) - mean(b.steady))}  ${fmt(p95(a.steady) - p95(b.steady))}  ` +
        `${fmt(median(b.cold))}     ${fmt(median(a.cold))}`
      )
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n')
    expect(noOutputAdded, 'a command that prints nothing').toBeLessThan(NO_OUTPUT_CEILING_MS)
  })
})
