import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'
import { beginTerminal, applyTerminalAction, type TerminalAction, type TerminalEnrollment } from '../src/core/terminal-enrollment'

// Spec 052 US2. The per-terminal state machine exists twice: in
// `src/core/terminal-enrollment.ts`, which RedLog reads for the capture card
// and Settings, and in `hooks/redlog-relay.py`, which the shell calls at the
// prompt. Neither can call the other — the shell cannot run TypeScript, and
// RedLog will not spawn python3 to draw a panel — so this is two
// implementations of rules that must agree.
//
// The rules are not arbitrary and the disagreements would be silent. A
// terminal whose project moved out from under it must stay stopped whatever
// it is asked, because the failure that prevents is a command from engagement
// A filed under engagement B — a lie in a document a client reads (FR-010).
// If one side lets `redlog start` undo that and the other does not, whichever
// one the operator is looking at will be the one that is wrong.
//
// The same arrangement over the classifier caught `classify` reading its own
// `--` separator as the program name on its first run.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

interface Case { name: string; mode: 'auto' | 'manual'; actions: TerminalAction[] }

const CASES: Case[] = [
  { name: 'auto, untouched', mode: 'auto', actions: [] },
  { name: 'manual, untouched', mode: 'manual', actions: [] },
  { name: 'stop then start', mode: 'auto', actions: [{ type: 'stop', reason: 'operator' }, { type: 'start' }] },
  { name: 'stop twice', mode: 'auto', actions: [{ type: 'stop', reason: 'operator' }, { type: 'stop', reason: 'operator' }] },
  { name: 'manual then start', mode: 'manual', actions: [{ type: 'start' }] },
  { name: 'mode manual at runtime', mode: 'auto', actions: [{ type: 'mode', mode: 'manual' }] },
  { name: 'mode manual then auto', mode: 'auto', actions: [{ type: 'mode', mode: 'manual' }, { type: 'mode', mode: 'auto' }] },
  { name: 'mode manual then start', mode: 'auto', actions: [{ type: 'mode', mode: 'manual' }, { type: 'start' }] },
  { name: 'project unchanged', mode: 'auto', actions: [{ type: 'project', engagementId: 'eng-1' }] },
  // The four that matter most: nothing talks a project-switched terminal back
  // into recording.
  { name: 'project switched', mode: 'auto', actions: [{ type: 'project', engagementId: 'eng-2' }] },
  { name: 'project switched then start', mode: 'auto', actions: [{ type: 'project', engagementId: 'eng-2' }, { type: 'start' }] },
  { name: 'project switched then mode auto', mode: 'auto', actions: [{ type: 'project', engagementId: 'eng-2' }, { type: 'mode', mode: 'auto' }] },
  { name: 'project switched then stop then start', mode: 'auto', actions: [{ type: 'project', engagementId: 'eng-2' }, { type: 'stop', reason: 'operator' }, { type: 'start' }] }
]

/** Only the fields the two sides are agreeing about. Timestamps and the
 *  session id are each side's own business. */
const comparable = (s: { recording: boolean; stoppedReason?: string; mode: string }) =>
  ({ recording: s.recording, stoppedReason: s.stoppedReason ?? null, mode: s.mode })

function inTypeScript(c: Case): TerminalEnrollment {
  let state = beginTerminal({
    sessionId: 'agree', mode: c.mode,
    engagementId: 'eng-1', operatorId: 'op-1', now: 1_700_000_000_000
  })
  for (const action of c.actions) state = applyTerminalAction(state, action)
  return state
}

function pythonScript(t: ShellTarget, c: Case): string {
  const relay = hookPath(t, 'redlog-relay.py')
  const call = (args: string) =>
    `python3 "${relay}" state --home "$H" --session agree ${args} > /dev/null`
  return [
    `H=$(mktemp -d -t redlog-agree.XXXXXX)`,
    call(`--action begin --mode ${c.mode} --engagement eng-1 --operator op-1`),
    ...c.actions.map((a) => {
      if (a.type === 'stop') return call(`--action stop --reason ${a.reason}`)
      if (a.type === 'start') return call('--action start')
      if (a.type === 'mode') return call(`--action mode --mode ${a.mode}`)
      return call(`--action project --engagement ${a.engagementId}`)
    }),
    `printf '%s\\t' ${JSON.stringify(c.name)}`,
    `python3 "${relay}" state --home "$H" --session agree --action show`,
    `printf '\\n'`,
    `rm -rf "$H"`
  ].join('\n')
}

describeShell(`the state machine agrees with itself (${target?.label ?? 'no shell reachable'})`, () => {
  it('reaches the same state on both sides, for every sequence', async () => {
    const script = CASES.map((c) => pythonScript(target!, c)).join('\n')
    const run = await runInShell(target!, script, { timeoutMs: 240_000 })

    const fromShell = new Map(run.stdout.split('\n').filter((l) => l.includes('\t'))
      .map((l) => {
        const tab = l.indexOf('\t')
        return [l.slice(0, tab), JSON.parse(l.slice(tab + 1)) as Parameters<typeof comparable>[0]] as const
      }))
    expect(fromShell.size, run.stderr.slice(0, 400)).toBe(CASES.length)

    for (const c of CASES) {
      expect(comparable(fromShell.get(c.name)!), `${c.name}: the shell and RedLog disagree`)
        .toEqual(comparable(inTypeScript(c)))
    }
  }, 300_000)
})
