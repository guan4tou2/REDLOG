import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bashCanChainDebugTrap } from './helpers/bash-trap-chain'

// The bash adapter recorded the operator's PROMPT_COMMAND instead of what they
// typed, and dropped every real command behind it. Run a real interactive bash.
const HOOK = path.resolve(__dirname, '../hooks/shell-bash-hook.sh')

// Sourcing the hook defines the real sender; this replaces it, so that a case
// which sources again has to say so.
const STUB = '_redlog_send_event() { echo "EVENT $1 [$2] X$3X" >&2; }'

// `before` runs ahead of the hook, in the operator's rc: where another tool's
// DEBUG trap or an array PROMPT_COMMAND would already be set. Returns stderr so
// a case can read what the operator's own hooks printed beside the events.
function runRaw(promptCommand: string | null, commands: string[], before: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bash-'))
  try {
    const script = [
      `HISTFILE=${dir}/hist`,
      promptCommand === null ? '' : `PROMPT_COMMAND='${promptCommand}'`,
      ...before,
      `source ${HOOK} 2>/dev/null`,
      STUB,
      ...commands,
      'exit'
    ].join('\n')
    const r = spawnSync('bash', ['--norc', '-i'], { input: script, env: { ...process.env, HOME: path.join(dir, 'home') }, encoding: 'utf8' })
    return r.stderr
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function run(promptCommand: string | null, commands: string[], before: string[] = []): Array<[string, string]> {
  // Interactive bash puts its prompt before our marker on the same line.
  return [...runRaw(promptCommand, commands, before).matchAll(/EVENT (\w+) \[([^\]]*)\]/g)]
    .map((m) => [m[1], m[2]] as [string, string]).filter(([, c]) => c !== 'exit')
}

/**
 * What a marker printed by the operator's own hook said, in order. Interactive
 * bash echoes each line it reads, so the trap definition itself shows up once
 * with its `$` unexpanded; a real marker never has one.
 */
const marks = (stderr: string, tag: string): string[] =>
  [...stderr.matchAll(new RegExp(`${tag}<([^>]*)>`, 'g'))].map((m) => m[1]).filter((m) => !m.includes('$'))

/**
 * How each command's `command_end` described its output. A command the trap
 * saw is `interactive` here (nothing relays it); one the trap missed is still
 * recorded, from history at the next prompt, as `not-captured`: the line and
 * its status, none of what it printed. That fallback is why a lost trap does
 * not show up as a missing command, so it is what these cases look at.
 */
const dispositions = (stderr: string): Array<[string, string]> =>
  [...stderr.matchAll(/EVENT command_end \[([^\]]*)\] X.*?"output_disposition":"([\w-]+)"/g)]
    .map((m) => [m[1], m[2]] as [string, string]).filter(([c]) => c !== 'exit')

const [bashMajor, bashMinor] = (() => {
  if (process.platform === 'win32') return [0, 0]
  const v = spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}'], { encoding: 'utf8' }).stdout.trim().split(' ')
  return [Number(v[0]), Number(v[1])]
})()

describe.skipIf(process.platform === 'win32')('bash adapter with an existing PROMPT_COMMAND', () => {
  const typed = ['echo one', 'pwd', 'echo three']
  const starts = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_start').map(([, c]) => c)
  const ends = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_end').map(([, c]) => c)

  it.each([
    ['one command', 'history -a'],
    ['a function', 'myprecmd() { :; }; myprecmd'],
    ['a trailing semicolon', 'history -a;'],
    ['several commands', 'history -a; true; :']
  ])('records what was typed, not the prompt command: %s', (_n, pc) => {
    const ev = run(pc, typed)
    expect(starts(ev)).toEqual(typed)
    expect(ends(ev)).toEqual(typed)
  })

  it('does not record the hook itself on an empty Enter or a bare definition', () => {
    const ev = run('history -a', ['', 'f() { :; }', '', ...typed])
    expect(starts(ev)).toEqual(typed)
    expect(JSON.stringify(ev)).not.toContain('_redlog_')
  })

  it('still works with no PROMPT_COMMAND, and does not record the hook itself', () => {
    const ev = run(null, typed)
    expect(starts(ev)).toEqual(typed)
    expect(JSON.stringify(ev)).not.toContain('_redlog_')
  })
})

// The hook used to replace whatever DEBUG trap the shell had: bash-preexec,
// starship's bash init and atuin all live there, and lost their hook without a
// word. The operator's trap keeps running, first, and the record is unchanged.
describe.skipIf(process.platform === 'win32')('bash adapter with another tool\'s DEBUG trap', () => {
  const typed = ['echo one', 'pwd', 'echo three']
  const starts = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_start').map(([, c]) => c)
  const ends = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_end').map(([, c]) => c)
  // `<>` rather than `[]`: the event regex above reads brackets.
  const THEIRS = `trap 'echo "THEIRS<$BASH_COMMAND>" >&2' DEBUG`

  const events = (stderr: string): Array<[string, string]> =>
    [...stderr.matchAll(/EVENT (\w+) \[([^\]]*)\]/g)].map((m) => [m[1], m[2]] as [string, string]).filter(([, c]) => c !== 'exit')

  // Chaining needs a bash that shows a DEBUG trap to the prompt command and
  // lets it set one over another. Where it does not, the hook installs its own
  // trap once and leaves the rest alone, and the cases below the chaining ones
  // are what hold there.
  const itChain = it.skipIf(!bashCanChainDebugTrap)

  itChain('runs the existing trap for each command, and records each command once', () => {
    const out = runRaw('history -a', typed, [THEIRS])
    const ev = events(out)
    expect(starts(ev)).toEqual(typed)
    expect(ends(ev)).toEqual(typed)
    const theirs = marks(out, 'THEIRS')
    for (const c of typed) expect(theirs.filter((t) => t === c), c).toHaveLength(1)
  })

  itChain('runs it with the status of the previous command, as it would without us', () => {
    const before = [`trap 'echo "THEIRS<rc=$? $BASH_COMMAND>" >&2' DEBUG`]
    const out = runRaw(null, ['false', 'echo after', 'sh -c "exit 7"', 'echo again'], before)
    const theirs = marks(out, 'THEIRS')
    expect(theirs).toContain('rc=1 echo after')
    expect(theirs).toContain('rc=7 echo again')
  })

  // The trap as the shell reports it. Not through a pipe or `$( )`: neither
  // sees a DEBUG trap.
  const SHOW = 'trap -p DEBUG >&2'
  const trapBody = (stderr: string): string => /trap -- '([\s\S]*?)' DEBUG/.exec(stderr)?.[1] ?? ''
  const count = (text: string, needle: string): number => text.split(needle).length - 1

  it('installs exactly its own trap when there was none, and records in full', () => {
    expect(trapBody(runRaw(null, [SHOW]))).toBe('_redlog_debug_trap')
    expect(dispositions(runRaw(null, typed))).toEqual(typed.map((c) => [c, 'interactive']))
  })

  // `_redlog_trap_plan` is what decides, from what the prompt command read, so
  // it is called directly: a bash that cannot show a `$( )` the trap cannot be
  // had on every machine this runs on, and its answers do not depend on one.
  it('plans from what it was shown, whatever bash it runs on', () => {
    // Quotes and dollar signs are made visible: `marks` drops what has a `$`.
    const define = 'plan() { _redlog_trap_plan "$1"; local n=${_REDLOG_TRAP_NEXT//\\$/DOLLAR}; n=${n//$\'\\n\'/|}; echo "PLAN<$n>" >&2; }'
    // One line, so that no prompt (which would plan too) comes between the calls.
    const calls = [
      'unset _REDLOG_TRAP_INSTALLED _REDLOG_TRAP_SEEN',
      'plan ""',                                      // nobody: install ours
      'plan ""',                                      // empty, and ours never seen: a blind bash, leave it
      `plan "trap -- '_redlog_debug_trap' DEBUG"`,    // ours seen: leave it; from now on empty means removed
      'plan ""',                                      // removed: install again
      `plan "trap -- '_redlog_debug_trap' DEBUG"`,
      `plan "trap -- 'echo it'\\\\''s' DEBUG"`,       // someone else's, quoted the way bash prints it
      `plan "trap -- 'echo a # c' DEBUG"`,            // a trailing comment must not swallow ours
      `plan "trap -- '' DEBUG"`                       // an ignored trap is not a hook to keep
    ].join('; ')
    expect(marks(runRaw(null, [define, calls]), 'PLAN')).toEqual([
      '_redlog_debug_trap',
      '',
      '',
      '_redlog_debug_trap',
      '',
      "echo it's|_redlog_debug_trap DOLLAR?",
      'echo a # c|_redlog_debug_trap DOLLAR?',
      '_redlog_debug_trap'
    ])
  })

  itChain('does not chain the hook to itself when it is loaded twice', () => {
    // The loaded-in-this-shell guard, and then with the guard out of the way.
    const guarded = runRaw(null, [`source ${HOOK} 2>/dev/null`, ...typed, SHOW], [THEIRS])
    expect(count(trapBody(guarded), '_redlog_debug_trap')).toBe(1)
    expect(count(trapBody(guarded), 'THEIRS<')).toBe(1)
    const unguarded = runRaw(null, ['unset _REDLOG_HOOK_LOADED_IN', `source ${HOOK} 2>/dev/null`, STUB, ...typed, SHOW], [THEIRS])
    expect(count(trapBody(unguarded), '_redlog_debug_trap')).toBe(1)
    expect(count(trapBody(unguarded), 'THEIRS<')).toBe(1)
    expect(starts(events(unguarded)).filter((c) => typed.includes(c))).toEqual(typed)
  })

  itChain('still records after another tool sets its trap at a later prompt (bash-preexec style)', () => {
    // A prompt command that installs its trap, as bash-preexec does on the
    // first prompt and starship's init may do after the hook is loaded.
    const before = [
      `_late() { trap 'echo "LATER<$BASH_COMMAND>" >&2' DEBUG; }`,
      'PROMPT_COMMAND=_late'
    ]
    const out = runRaw(null, typed, before)
    expect(starts(events(out))).toEqual(typed)
    for (const c of typed) expect(marks(out, 'LATER').filter((t) => t === c), c).toHaveLength(1)
    // Seen by the trap, not reconstructed from history afterwards.
    expect(dispositions(out)).toEqual(typed.map((c) => [c, 'interactive']))
  })

  itChain('still records after a typed command replaces the trap', () => {
    const swap = `trap 'echo "LATER<$BASH_COMMAND>" >&2' DEBUG`
    const out = runRaw(null, [swap, ...typed], [])
    const ev = events(out)
    // The line that replaced it was seen before it ran; the rest keep being seen
    // from the next prompt on, and the new trap keeps running.
    expect(starts(ev)).toEqual([swap, ...typed])
    for (const c of typed) expect(marks(out, 'LATER').filter((t) => t === c), c).toHaveLength(1)
    expect(dispositions(out)).toEqual([swap, ...typed].map((c) => [c, 'interactive']))
  })
})

// Bash 5.1 made PROMPT_COMMAND an array whose elements each run as a command.
// `"${PROMPT_COMMAND:-}"` is element 0 only, so the rest ran after the hook had
// armed its trap and were recorded as things the operator typed.
describe.skipIf(process.platform === 'win32' || bashMajor < 5 || (bashMajor === 5 && bashMinor < 1))(
  `bash adapter with an array PROMPT_COMMAND (bash ${bashMajor}.${bashMinor}; arrays are not prompt commands before 5.1)`, () => {
    const typed = ['echo one', 'pwd', 'echo three']
    const starts = (stderr: string): string[] =>
      [...stderr.matchAll(/EVENT command_start \[([^\]]*)\]/g)].map((m) => m[1]).filter((c) => c !== 'exit')
    // `$((n))` so the echoed definition is not mistaken for output (see `marks`).
    const ARRAY = [`PROMPT_COMMAND=('echo "PC<$((1))>" >&2' 'echo "PC<$((2))>" >&2' 'echo "PC<$((3))>" >&2')`]

    it('runs every element in order, and records none of them', () => {
      const out = runRaw(null, typed, ARRAY)
      expect(starts(out)).toEqual(typed)
      const seen = marks(out, 'PC')
      // One round per prompt, always 1, 2, 3.
      expect(seen.length).toBeGreaterThanOrEqual(typed.length * 3)
      expect(seen.length % 3).toBe(0)
      expect(seen).toEqual(Array.from({ length: seen.length / 3 }, () => ['1', '2', '3']).flat())
      expect(dispositions(out)).toEqual(typed.map((c) => [c, 'interactive']))
    })

    it('does not record an element that is a function, or a trailing semicolon', () => {
      const before = [`pcf() { :; }`, `PROMPT_COMMAND=('pcf' 'history -a;' ':')`]
      const out = runRaw(null, typed, before)
      expect(starts(out)).toEqual(typed)
      expect(out.split('\n').filter((l) => l.startsWith('EVENT')).join('\n')).not.toContain('_redlog_')
    })

    it('records the typed command once beside an existing DEBUG trap', () => {
      const out = runRaw(null, typed, [...ARRAY, `trap 'echo "THEIRS<$BASH_COMMAND>" >&2' DEBUG`])
      expect(starts(out)).toEqual(typed)
      for (const c of typed) expect(marks(out, 'THEIRS').filter((t) => t === c), c).toHaveLength(1)
    })
  })
