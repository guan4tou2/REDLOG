import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  classifyCommand, compileClassPolicy, type CommandClass, type CompiledClassPolicy, type ShippedClassPolicy
} from '../src/core/terminal-class'
import { readClassOverlay } from '../src/core/terminal-enrollment'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'
import shipped from '../hooks/command-class.json'
import golden from './fixtures/command-class-golden.json'

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

// Spec 052 T014, research.md D3. The classifier decides what happens to a
// command before it runs, and the deciding constraint is not implementation
// cost — a PTY-captured command cannot be suspended locally, so the list IS
// the product decision. A default that records `nc` destroys the shell upgrade
// the operator is in the middle of (FR-025); a default that records `vim`
// fills the evidence with redraws and records no content at all (FR-026).
//
// It is a pure function over argv on purpose: nothing it reads comes from the
// command's output, and nothing it decides depends on the machine it runs on.

describe('command classification', () => {
  const classify = (line: string) => classifyCommand(line.split(' '))

  it('relays an ordinary command', () => {
    expect(classify('nmap -sV 10.0.0.1')).toBe('relayed')
    expect(classify('ls -la')).toBe('relayed')
    expect(classify('ffuf -u http://10.0.0.1/FUZZ -w words.txt')).toBe('relayed')
  })

  it('leaves `nc` alone, because the operator is going to suspend it', () => {
    // The upgrade is Ctrl-Z, `stty raw -echo`, `fg`. A relay in the middle of
    // that is a lost shell on a box someone spent two days reaching.
    expect(classify('nc -lvnp 4444')).toBe('native')
    expect(classify('ncat -lvnp 4444')).toBe('native')
    // stty operates on the controlling terminal, not a relay's output PTY.
    expect(classify('stty raw -echo')).toBe('native')
    expect(classify('stty size')).toBe('native')
  })

  it('leaves editors and pagers alone, because a redraw is not evidence', () => {
    for (const line of ['vim notes.txt', 'vi /etc/hosts', 'nvim x', 'nano x', 'less big.log', 'more big.log']) {
      expect(classify(line), line).toBe('native')
    }
  })

  it('leaves the AI CLIs alone, because their conversation is not on the screen', () => {
    // claude and codex are full-screen TUIs, and the AI tailer already records
    // the conversation from the local transcript. A relay would store redraws
    // as output and risk the interface (streaming, Esc, Ctrl-C, resize).
    expect(classify('claude')).toBe('native')
    expect(classify('claude --resume')).toBe('native')
    expect(classify('codex')).toBe('native')
    expect(classify('codex resume')).toBe('native')
    expect(classify('sudo claude')).toBe('native')
    expect(classify('/usr/local/bin/codex')).toBe('native')
  })

  it('gives a PTY to the things that bring their own', () => {
    expect(classify('ssh root@10.0.0.1')).toBe('pty')
    expect(classify('socat - TCP:10.0.0.1:4444')).toBe('pty')
    expect(classify('pwncat-cs 10.0.0.1 4444')).toBe('pty')
  })

  it('reads through sudo, env, proxychains and an absolute path (FR-027)', () => {
    // The wrapper is not the command. Classifying on the first word puts
    // `sudo nc` in the relayed class and breaks the upgrade just as surely.
    expect(classify('sudo nc -lvnp 4444')).toBe('native')
    expect(classify('sudo -u root nc -lvnp 4444')).toBe('native')
    expect(classify('env FOO=bar nc -lvnp 4444')).toBe('native')
    expect(classify('proxychains4 -q ssh root@10.0.0.1')).toBe('pty')
    expect(classify('/usr/bin/nc -lvnp 4444')).toBe('native')
    expect(classify('sudo /usr/bin/vim /etc/shadow')).toBe('native')
    // …and a wrapper around something ordinary is still ordinary.
    expect(classify('sudo nmap -sS 10.0.0.1')).toBe('relayed')
  })

  it('tells a REPL from a REPL given something to run', () => {
    // Bare, it is an interactive session and recording it records the
    // prompt's redrawing. Given a script or an expression, it is a command
    // with output like any other (FR-027).
    expect(classify('python3')).toBe('native')
    expect(classify('python3 -i')).toBe('native')
    expect(classify('node')).toBe('native')
    expect(classify('irb')).toBe('native')

    expect(classify('python3 exploit.py')).toBe('relayed')
    expect(classify('python3 -c print(1)')).toBe('relayed')
    expect(classify('python3 -m http.server')).toBe('relayed')
    expect(classify('node -e 1+1')).toBe('relayed')
    expect(classify('perl -e print')).toBe('relayed')
  })

  it('does not guess from nothing', () => {
    // An empty argv is not a command. Returning `relayed` here would route
    // the shell's own empty prompt through the relay on every bare Enter.
    expect(classifyCommand([])).toBe('native')
    expect(classifyCommand(['sudo'])).toBe('native')
  })
})

// What classifyCommand does with the lists: pty, then native, then a bare REPL
// is native, else relayed.
const modeFor = (lists: { native: string[]; pty: string[] }, program: string): CommandClass =>
  lists.pty.includes(program) ? 'pty'
    : lists.native.includes(program) ? 'native'
      : shipped.repl.includes(program) ? 'native'
        : 'relayed'

// The overlay file as the app reads it: unparseable is no overlay.
const parseOverlay = (file: string | null): unknown => {
  if (file === null) return null
  try { return JSON.parse(file) } catch { return null }
}

// The golden table was generated before tool profiles, and is not regenerated.
// One thing in it is now different on purpose: O11 names curl as native AND
// pty, so curl used to be in both lists. The compiler gives a command one mode,
// pty over native, so it is in `pty` only. Its mode, which is what the table
// is for, has not changed.
const expectedLists = (c: { id: string; native: string[]; pty: string[] }): { native: string[]; pty: string[] } =>
  c.id === 'O11' ? { native: c.native.filter((x) => x !== 'curl'), pty: c.pty } : { native: c.native, pty: c.pty }

const profile = (id: string, name: string, mode: string, executables: string[]): Record<string, unknown> =>
  ({ id, name, mode, executables, reason: 'r' })

interface MirrorCase { id: string; file: string | null; shipped?: ShippedClassPolicy; probes?: string[] }
const synthetic = (native: string[], pty: string[], terminalProfiles: unknown[]): ShippedClassPolicy =>
  ({ native, pty, terminalProfiles })

// Synthetic shipped policies, each one a way profiles can disagree or break.
const CLASHING = {
  sameMode: synthetic([], [], [profile('a', 'A', 'native', ['x']), profile('b', 'B', 'native', ['x'])]),
  overDefault: synthetic(['x'], [], [profile('a', 'A', 'pty', ['x']), profile('b', 'B', 'native', ['x'])]),
  nothingBelow: synthetic([], [], [profile('a', 'A', 'pty', ['x']), profile('b', 'B', 'native', ['x'])]),
  three: synthetic([], [], [profile('a', 'A', 'pty', ['x']), profile('b', 'B', 'native', ['x']), profile('c', 'C', 'relayed', ['x'])]),
  profileBeatsDefault: synthetic(['x'], ['y'], [profile('a', 'A', 'pty', ['x']), profile('b', 'B', 'native', ['y'])]),
  relayedProfile: synthetic(['x'], [], [profile('a', 'A', 'relayed', ['x', 'z'])]),
  twice: synthetic([], [], [profile('a', 'A', 'pty', ['x', 'x'])]),
  bothDefaultLists: synthetic(['x'], ['x'], []),
  broken: synthetic(['n'], [], [
    profile('ok', 'Ok', 'pty', ['k']),
    { id: 'nomode', mode: 'sideways', executables: ['x'] },
    { mode: 'pty', executables: ['x'] },
    { id: 'empty', mode: 'pty', executables: [] },
    { id: 'notlist', mode: 'pty', executables: 'x' },
    { id: 'nonstring', mode: 'pty', executables: ['x', 1] },
    'text',
    null
  ])
}

// Every input both sides are asked about: the golden table's overlays against
// the real policy, the synthetic policies, and malformed overlays.
const MIRROR_CASES: MirrorCase[] = [
  ...golden.cases.map((c) => ({ id: `golden ${c.id}`, file: c.file, probes: golden.probes })),
  { id: 'overlay native null', file: '{"native": null}', probes: golden.probes },
  { id: 'overlay native string', file: '{"native": "vim"}', probes: golden.probes },
  { id: 'overlay pty with a number', file: '{"pty": [1, "curl"]}', probes: golden.probes },
  { id: 'overlay relayed object', file: '{"relayed": {"nc": true}, "pty": ["curl", null]}', probes: golden.probes },
  ...Object.entries(CLASHING).map(([name, shipped]) => ({ id: `shipped ${name}`, file: null, shipped })),
  { id: 'shipped overDefault, overridden', file: '{"relayed": ["x"]}', shipped: CLASHING.overDefault },
  { id: 'shipped nothingBelow, overridden', file: '{"pty": ["x"]}', shipped: CLASHING.nothingBelow },
  { id: 'shipped relayedProfile, moved', file: '{"native": ["z"], "pty": ["x"]}', shipped: CLASHING.relayedProfile },
  { id: 'shipped broken, bad overlay', file: '{"native": 3, "pty": [false]}', shipped: CLASHING.broken }
]

interface DriverAnswer extends CompiledClassPolicy { modes: Record<string, string> }

async function runDriver(cases: MirrorCase[]): Promise<{ answers: Record<string, DriverAnswer>; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-mirror-'))
  try {
    const input = path.join(dir, 'cases.json')
    fs.writeFileSync(input, JSON.stringify({ cases }))
    const driver = target!.toShellPath(path.join(__dirname, 'helpers', 'class-policy-driver.py'))
    const run = await runInShell(
      target!,
      `python3 "${driver}" "${hookPath(target!, 'redlog-relay.py')}" "${target!.toShellPath(input)}"`,
      { timeoutMs: 240_000 }
    )
    return { answers: JSON.parse(run.stdout), stderr: run.stderr }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// T020. The lists have one home — `hooks/command-class.json`, which this
// module imports and `hooks/redlog-relay.py` reads at the prompt. The walk
// over wrappers does not: there is a copy in TypeScript and a copy in Python,
// because the shell cannot call the first one and RedLog will not spawn the
// second to draw a settings panel.
//
// So the names cannot drift, but the two walks can, and silently: they agree
// on `nc`, disagree on `sudo -u root nc`, and the operator finds out when
// their reverse shell goes through a relay. This is the test that notices.
describeShell(`the shell and RedLog agree (${target?.label ?? 'no shell reachable'})`, () => {
  const CASES = [
    'nmap -sV 10.0.0.1',
    'ls -la',
    'nc -lvnp 4444',
    'ncat -lvnp 4444',
    'vim notes.txt',
    'less big.log',
    'claude',
    'codex resume',
    'sudo claude',
    'ssh root@10.0.0.1',
    'socat - TCP:10.0.0.1:4444',
    'pwncat-cs 10.0.0.1 4444',
    'sudo nc -lvnp 4444',
    'sudo -u root nc -lvnp 4444',
    'env FOO=bar nc -lvnp 4444',
    'proxychains4 -q ssh root@10.0.0.1',
    '/usr/bin/nc -lvnp 4444',
    'sudo /usr/bin/vim /etc/shadow',
    'sudo nmap -sS 10.0.0.1',
    'python3',
    'python3 -i',
    'node',
    'python3 exploit.py',
    'python3 -c print(1)',
    'python3 -m http.server',
    'node -e 1+1',
    'sudo -- nc -lvnp 4444',
    'env -- nmap -sV 10.0.0.1'
  ]

  it('classifies every default the same way on both sides', async () => {
    // One shell, one python3 per case — a spawn each would be the slow way to
    // learn the same thing.
    // Each word quoted: the argv is handed to the relay exactly as the TS
    // side receives it, and `python3 -c print(1)` is a bash syntax error
    // otherwise rather than a test case.
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`
    // Defaults must not inherit the operator's ~/.redlog class overlay.
    const script = ['H=$(mktemp -d -t redlog-defaults.XXXXXX)', 'trap \'rm -rf "$H"\' EXIT', ...CASES.map((line) =>
      `printf '%s\\t' ${quote(line)}\n` +
      `python3 "${hookPath(target!, 'redlog-relay.py')}" classify --home "$H" -- ${line.split(' ').map(quote).join(' ')}\n` +
      `printf '\\n'`
    )].join('\n')
    // 28 `python3` spawns across the WSL boundary, in a suite that runs files
    // in parallel. Alone this is seconds; under full-suite load it is a
    // minute, and the default budget turns that into a truncated stdout and a
    // mystery — the same shape test/shell-redlog-run.test.ts documents.
    const run = await runInShell(target!, script, { timeoutMs: 240_000 })

    const fromShell = new Map(
      run.stdout.split('\n').filter((l) => l.includes('\t'))
        .map((l) => l.split('\t') as [string, string])
    )
    expect(fromShell.size, run.stderr.slice(0, 400)).toBe(CASES.length)
    for (const line of CASES) {
      expect(fromShell.get(line), `${line}: shell and RedLog disagree`)
        .toBe(classifyCommand(line.split(' ')))
    }
    // Agreeing is not enough: both sides read one file, so they agree on a
    // wrong default too. The AI CLIs are native in the shell as well.
    for (const line of ['claude', 'codex resume', 'sudo claude']) {
      expect(fromShell.get(line), `${line}: the shell relays it`).toBe('native')
    }
  }, 300_000)

  // T034. Settings shows the EFFECTIVE lists — the shipped defaults with the
  // operator's `redlog class` edits on top — and the merge that produces them
  // exists twice for the same reason the classifier does. A Settings panel
  // that disagrees with the shell is worse than one that shows nothing: it
  // tells the operator their `nc` is safe when the shell will relay it.
  it('merges an overlay the same way on both sides', async () => {
    const relay = hookPath(target!, 'redlog-relay.py')
    const script = [
      'H=$(mktemp -d -t redlog-overlay.XXXXXX)',
      `python3 "${relay}" policy --home "$H" --action add --field pty --command curl > /dev/null`,
      `python3 "${relay}" policy --home "$H" --action add --field relayed --command nc > /dev/null`,
      `python3 "${relay}" policy --home "$H" --action add --field pty --command vim > /dev/null`,
      `python3 "${relay}" policy --home "$H" --action remove --command vim > /dev/null`,
      `python3 "${relay}" policy --home "$H" --action list`,
      'rm -rf "$H"'
    ].join('\n')
    const run = await runInShell(target!, script, { timeoutMs: 240_000 })

    const line = (name: string): string[] => {
      const found = run.stdout.split('\n').find((l) => l.startsWith(`${name}: `))
      return (found ?? '').slice(name.length + 2).trim().split(/\s+/).filter(Boolean)
    }
    const mine = compileClassPolicy({ pty: ['curl'], relayed: ['nc'] })

    expect(line('pty').sort(), run.stderr.slice(0, 400)).toEqual([...mine.pty].sort())
    expect(line('native').sort()).toEqual([...mine.native].sort())
    // And the edits did what they said: curl joined the pty class, nc left
    // the native one, and vim's edit was undone, so it is native as it shipped.
    expect(mine.pty).toContain('curl')
    expect(mine.native).not.toContain('nc')
    expect(line('native')).toContain('vim')
    expect(line('pty')).not.toContain('vim')
  }, 300_000)

  // The golden table is what the classifier did before tool profiles moved the
  // names around, so it is the shell half of the proof that they did not change
  // what any command does. One python3 for every case: each overlay file is
  // written into a temp home, and the shell's own load_policy and classify_argv
  // answer for every probe.
  it('gives every probe the golden mode under every overlay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-golden-'))
    try {
      const input = path.join(dir, 'cases.json')
      fs.writeFileSync(input, JSON.stringify({
        cases: golden.cases.map((c) => ({ id: c.id, file: c.file, probes: golden.probes }))
      }))
      const driver = target!.toShellPath(path.join(__dirname, 'helpers', 'class-policy-driver.py'))
      const run = await runInShell(
        target!,
        `python3 "${driver}" "${hookPath(target!, 'redlog-relay.py')}" "${target!.toShellPath(input)}"`,
        { timeoutMs: 240_000 }
      )
      const answers = JSON.parse(run.stdout) as Record<string, { modes: Record<string, string>; native: string[]; pty: string[] }>
      for (const c of golden.cases) {
        expect(answers[c.id].modes, `${c.id} ${c.name}: ${run.stderr.slice(0, 300)}`).toEqual(c.modes)
        expect([...answers[c.id].native].sort(), `${c.id} native list`).toEqual(expectedLists(c).native)
        expect([...answers[c.id].pty].sort(), `${c.id} pty list`).toEqual(expectedLists(c).pty)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  // Two implementations of one compiler are only one if something runs them
  // over the same inputs and compares everything they say, order included:
  // the table above checks modes, this checks the lists, the entries and the
  // problems, and adds the cases a table of real overlays cannot reach —
  // profiles that clash, profiles that are broken, overlays that are broken.
  it('compiles every case the same way on both sides', async () => {
    const run = await runDriver(MIRROR_CASES)
    for (const c of MIRROR_CASES) {
      const mine = compileClassPolicy(parseOverlay(c.file), c.shipped)
      const theirs = run.answers[c.id]
      expect(theirs, `${c.id}: ${run.stderr.slice(0, 300)}`).toBeDefined()
      expect(theirs.native, `${c.id} native`).toEqual(mine.native)
      expect(theirs.pty, `${c.id} pty`).toEqual(mine.pty)
      expect(theirs.entries, `${c.id} entries`).toEqual(mine.entries)
      expect(theirs.problems, `${c.id} problems`).toEqual(mine.problems)
      if (!c.shipped) expect(theirs.modes, `${c.id} modes`).toEqual(Object.fromEntries(
        (c.probes ?? []).map((p) => [p, modeFor(mine, p)])))
    }
  }, 300_000)

  // Declared deviations: a hand-edited overlay that is not what `redlog class`
  // writes. Before, each of these either took the shell down quietly or did
  // something nobody meant; each is now defined, and says so in `list`.
  describe('a hand-edited overlay that is not what `redlog class` writes', () => {
    const relay = (): string => hookPath(target!, 'redlog-relay.py')
    const inOverlay = (file: string, body: string[]): string => [
      'H=$(mktemp -d -t redlog-bad.XXXXXX)',
      'mkdir -p "$H/.redlog"',
      `printf '%s' '${file}' > "$H/.redlog/command-class.json"`,
      ...body,
      'rm -rf "$H"'
    ].join('\n')
    const classify = (word: string): string =>
      `printf '%s=' ${word}; python3 "${relay()}" classify --home "$H" -- ${word}; printf '\\n'`
    const list = (): string => `python3 "${relay()}" policy --home "$H" --action list; echo "list-exit=$?"`

    it('{"native": null}: the field is ignored and the defaults stand', async () => {
      // Before: python3 raised TypeError, `classify` printed nothing, and the
      // shell took that as native for everything — capture stopped silently,
      // no PTY wrappers, and `redlog class list` crashed.
      const run = await runInShell(target!, inOverlay('{"native": null}', [classify('vim'), classify('ssh'), classify('nmap'), list()]), { timeoutMs: 120_000 })
      expect(run.stdout, run.stderr.slice(0, 300)).toContain('vim=native\n')
      expect(run.stdout).toContain('ssh=pty\n')
      expect(run.stdout).toContain('nmap=relayed\n')
      expect(run.stdout).toContain('list-exit=0')
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: native is not a list of commands\n')
    }, 180_000)

    it('{"native": "vim"}: a string is not a list, so it adds nothing', async () => {
      // Before: iterating the string added v, i and m to the native list.
      const run = await runInShell(target!, inOverlay('{"native": "vim"}', [classify('v'), classify('m'), list()]), { timeoutMs: 120_000 })
      expect(run.stdout, run.stderr.slice(0, 300)).toContain('v=relayed\n')
      expect(run.stdout).toContain('m=relayed\n')
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: native is not a list of commands\n')
    }, 180_000)

    it('{"pty": [1, "curl"]}: the item that is not a command is dropped, curl stays', async () => {
      // Before: `redlog class list` crashed joining the number.
      const run = await runInShell(target!, inOverlay('{"pty": [1, "curl"]}', [classify('curl'), list()]), { timeoutMs: 120_000 })
      expect(run.stdout, run.stderr.slice(0, 300)).toContain('curl=pty\n')
      expect(run.stdout).toContain('list-exit=0')
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: pty is not a list of commands\n')
    }, 180_000)

    it('add and remove rewrite a malformed field instead of crashing', async () => {
      const edit = (action: string): string =>
        `python3 "${relay()}" policy --home "$H" ${action}; echo "exit=$?"; cat "$H/.redlog/command-class.json"; printf '\\n'`
      const run = await runInShell(target!, [
        inOverlay('{"native": "vim"}', [edit('--action add --field pty --command curl')]),
        inOverlay('{"pty": [1, "curl"]}', [edit('--action remove --command curl')])
      ].join('\n'), { timeoutMs: 120_000 })
      const out = run.stdout.split('\n')
      expect(out.filter((l) => l === 'exit=0'), run.stderr.slice(0, 300)).toHaveLength(2)
      const written = out.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
      expect(written[0]).toEqual({ native: [], pty: ['curl'], relayed: [] })
      expect(written[1]).toEqual({ native: [], pty: [], relayed: [] })
    }, 180_000)
  })

  // `redlog class list` is what an operator reads to learn why a command did
  // what it did, so its lines are asserted exactly — and none of the new ones
  // may look like a class header, which other tests and anyone grepping
  // the listing take `native:`, `pty:` and `relayed:` to be.
  it('lists tool profiles, changes, clashes and what it ignored, one line each', async () => {
    const shippedFile = {
      native: ['nc'], pty: ['socat'], repl: [], replScriptFlags: [], wrappers: {},
      terminalProfiles: [
        profile('alpha', 'Alpha', 'pty', ['tool', 'nc']),
        profile('beta', 'Beta', 'native', ['tool', 'nc']),
        profile('gamma', 'Gamma', 'relayed', ['tool']),
        { id: 'bad', name: 'Bad', mode: 'sideways', executables: ['x'], reason: 'r' },
        profile('fine', 'Fine', 'native', ['fn', 'fm'])
      ]
    }
    const script = [
      'D=$(mktemp -d -t redlog-list.XXXXXX)',
      `cp "${hookPath(target!, 'redlog-relay.py')}" "${hookPath(target!, 'terminal_app.py')}" "$D/"`,
      `cat > "$D/command-class.json" <<'JSON'\n${JSON.stringify(shippedFile)}\nJSON`,
      'mkdir -p "$D/home/.redlog"',
      `cat > "$D/home/.redlog/command-class.json" <<'JSON'\n{"pty": ["curl"], "native": "vim"}\nJSON`,
      'python3 "$D/redlog-relay.py" policy --home "$D/home" --action list',
      'rm -rf "$D"'
    ].join('\n')
    const run = await runInShell(target!, script, { timeoutMs: 120_000 })
    const lines = run.stdout.split('\n').filter(Boolean)
    expect(lines, run.stderr.slice(0, 300)).toEqual([
      'native: nc fn fm',
      'pty: socat curl',
      'relayed: everything else',
      'tool profiles: Fine (fn fm)',
      'your changes: curl (pty)',
      'nc stays native because profiles Alpha (pty) and Beta (native) disagree; choose one with: redlog class add <class> nc',
      'tool stays relayed because profiles Alpha (pty), Beta (native) and Gamma (relayed) disagree; choose one with: redlog class add <class> tool',
      'ignored in ~/.redlog/command-class.json: native is not a list of commands',
      'skipped tool profile bad: not valid'
    ])
    for (const l of lines.slice(3)) expect(l, 'a header lookalike').not.toMatch(/\b(native|pty|relayed):/)
  }, 180_000)
})

// The merge itself, without a shell in the way.
describe('the class overlay', () => {
  it('adds, removes, and moves a command out of the class it was in', () => {
    expect(compileClassPolicy(null).native).toContain('nc')
    expect(compileClassPolicy({ relayed: ['nc'] }).native).not.toContain('nc')
    // `vim` ships native; moving it to pty must take it out of native, or the
    // two lists would both claim it and whichever is consulted first wins.
    const moved = compileClassPolicy({ pty: ['vim'] })
    expect(moved.pty).toContain('vim')
    expect(moved.native).not.toContain('vim')
  })

  it('does not duplicate a command that is already where it is being put', () => {
    const policy = compileClassPolicy({ pty: ['ssh'] })
    expect(policy.pty.filter((c) => c === 'ssh')).toHaveLength(1)
  })
})

// The golden table (test/fixtures/command-class-golden.json) pins what every
// probe command is under every overlay file an operator could have. It was
// generated from the code before tool profiles existed, and the shell leg above
// runs the same table through hooks/redlog-relay.py. Here the TypeScript side
// reads each overlay the way the app does — readClassOverlay on a real file —
// and derives a mode the way classifyCommand does: pty, then native, then a
// bare REPL is native, else relayed.
describe('the golden class table', () => {
  const homes: string[] = []
  afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }) })

  const homeWith = (file: string | null): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-class-home-'))
    homes.push(home)
    if (file !== null) {
      fs.mkdirSync(path.join(home, '.redlog'))
      fs.writeFileSync(path.join(home, '.redlog', 'command-class.json'), file)
    }
    return home
  }

  for (const c of golden.cases) {
    it(`${c.id}: ${c.name}`, () => {
      const lists = compileClassPolicy(readClassOverlay(homeWith(c.file)))
      const modes = Object.fromEntries(golden.probes.map((p) => [p, modeFor(lists, p)]))
      expect(modes).toEqual(c.modes)
      expect([...lists.native].sort()).toEqual(expectedLists(c).native)
      expect([...lists.pty].sort()).toEqual(expectedLists(c).pty)
    })
  }

  it('declares its one exception honestly: O11 still has curl in both lists in the table', () => {
    const o11 = golden.cases.find((c) => c.id === 'O11')!
    expect(o11.native).toContain('curl')
    expect(o11.pty).toContain('curl')
    expect(compileClassPolicy(readClassOverlay(homeWith(o11.file))).native).not.toContain('curl')
  })
})

// The shipped file is data other code trusts: the compiler skips a profile it
// cannot read and says so, but a profile that shipped unreadable is a bug in
// the release, not something to find out from a problem list on a customer's
// machine. This is where the file is held to its own schema.
describe('the shipped tool profiles', () => {
  const profiles = shipped.terminalProfiles
  const executables = profiles.flatMap((p) => p.executables)

  it('are valid: a plugin-style id, a name, a known mode, bare executable names, a reason', () => {
    for (const p of profiles) {
      expect(p.id, p.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/)
      expect(p.name.trim(), p.id).not.toBe('')
      expect(['native', 'pty', 'relayed'], p.id).toContain(p.mode)
      expect(p.executables.length, p.id).toBeGreaterThan(0)
      for (const e of p.executables) expect(e, `${p.id} executable`).toMatch(/^[^/\s]+$/)
      expect(p.reason.trim(), p.id).not.toBe('')
    }
    expect(new Set(profiles.map((p) => p.id)).size, 'ids are unique').toBe(profiles.length)
  })

  it('are exactly these five, in these modes', () => {
    expect(profiles.map((p) => [p.id, p.mode, p.executables])).toEqual([
      ['vim', 'native', ['vim', 'vi']],
      ['ssh', 'pty', ['ssh']],
      ['pwncat-cs', 'pty', ['pwncat-cs']],
      ['claude-code', 'native', ['claude']],
      ['codex', 'native', ['codex']]
    ])
  })

  // A profile's executables are also in the default list of their mode, for a
  // relay that does not read profiles: test/hook-update-mixed-version.test.ts.
  it('claim no executable twice, and none that the REPL and wrapper tables hold', () => {
    expect(new Set(executables).size, 'an executable in two profiles').toBe(executables.length)
    const defaults = [...shipped.native, ...shipped.pty]
    expect(new Set(defaults).size, 'a command in both default lists').toBe(defaults.length)
    for (const e of executables) {
      expect(shipped.repl, `${e} is a profile's and a REPL`).not.toContain(e)
      expect(Object.keys(shipped.wrappers), `${e} is a profile's and a wrapper`).not.toContain(e)
    }
  })

  it('compile without a problem', () => {
    expect(compileClassPolicy(null).problems).toEqual([])
  })
})

// Where two readings of the same name meet. The compiler's job is to give a
// command one mode and to say so when it could not, and these are the ways it
// can be handed more than one.
describe('profiles that overlap or break', () => {
  const entry = (p: CompiledClassPolicy, command: string) => p.entries.find((e) => e.command === command)

  it('two profiles in one mode are not a clash: the first one is the source', () => {
    const p = compileClassPolicy(null, CLASHING.sameMode)
    expect(p.problems).toEqual([])
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'native', source: 'profile', profile: 'a' })
    expect(p.native).toEqual(['x'])
  })

  it('profiles in different modes cancel out over a default: the default stands, and the clash is reported', () => {
    const p = compileClassPolicy(null, CLASHING.overDefault)
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'native', source: 'default' })
    expect(p.problems).toEqual([{
      kind: 'conflict', command: 'x', claims: [{ profile: 'a', mode: 'pty' }, { profile: 'b', mode: 'native' }]
    }])
  })

  it('with nothing below them, a clash leaves the command relayed, from the fallback', () => {
    const p = compileClassPolicy(null, CLASHING.nothingBelow)
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'fallback' })
    expect([...p.native, ...p.pty]).toEqual([])
    expect(p.problems).toHaveLength(1)
  })

  it('names every claimant of a clash, three or more', () => {
    const [problem] = compileClassPolicy(null, CLASHING.three).problems
    expect(problem).toMatchObject({ kind: 'conflict', command: 'x' })
    expect((problem as { claims: unknown[] }).claims).toHaveLength(3)
  })

  it('the operator\'s choice wins over a clash, and the clash is still reported', () => {
    const p = compileClassPolicy({ relayed: ['x'] }, CLASHING.overDefault)
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'override' })
    expect(p.native).not.toContain('x')
    expect(p.problems.map((q) => q.kind)).toEqual(['conflict'])
  })

  it('a profile beats the default list that names the same command', () => {
    const p = compileClassPolicy(null, CLASHING.profileBeatsDefault)
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'pty', source: 'profile', profile: 'a' })
    expect(entry(p, 'y')).toEqual({ command: 'y', mode: 'native', source: 'profile', profile: 'b' })
    expect(p.pty).toEqual(['x'])
    expect(p.native).toEqual(['y'])
  })

  it('a relayed profile is in neither list, and its entry says it is relayed by a profile', () => {
    const p = compileClassPolicy(null, CLASHING.relayedProfile)
    expect([...p.native, ...p.pty]).toEqual([])
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'profile', profile: 'a' })
    expect(entry(p, 'z')).toEqual({ command: 'z', mode: 'relayed', source: 'profile', profile: 'a' })
  })

  it('a profile naming one executable twice is not a clash with itself', () => {
    expect(compileClassPolicy(null, CLASHING.twice).problems).toEqual([])
  })

  it('a command in both default lists is pty, as classifyCommand has always had it', () => {
    const p = compileClassPolicy(null, CLASHING.bothDefaultLists)
    expect(p.pty).toEqual(['x'])
    expect(p.native).toEqual([])
  })

  it('skips a profile it cannot read, names it, and keeps the ones it can', () => {
    const p = compileClassPolicy(null, CLASHING.broken)
    expect(p.problems).toEqual([
      { kind: 'invalid-profile', profile: 'nomode' },
      { kind: 'invalid-profile', profile: '#2' },
      { kind: 'invalid-profile', profile: 'empty' },
      { kind: 'invalid-profile', profile: 'notlist' },
      { kind: 'invalid-profile', profile: 'nonstring' },
      { kind: 'invalid-profile', profile: '#6' },
      { kind: 'invalid-profile', profile: '#7' }
    ])
    expect(p.pty).toEqual(['k'])
    expect(p.native).toEqual(['n'])
    expect(entry(p, 'x')).toBeUndefined()
  })
})

// An overlay is a file an operator can edit by hand, so it can be wrong. These
// are the three shapes the old merge mishandled; the shell side of each is in
// the shell block above. What they have in common now: the defaults stand, the
// part that is wrong is ignored, and the compiler says which part.
describe('a hand-edited overlay that is not what `redlog class` writes', () => {
  const defaults = compileClassPolicy(null)

  it('{"native": null} is ignored and the defaults stand', () => {
    const p = compileClassPolicy({ native: null })
    expect(p.native).toEqual(defaults.native)
    expect(p.pty).toEqual(defaults.pty)
    expect(p.problems).toEqual([{ kind: 'invalid-overlay', field: 'native' }])
  })

  it('{"native": "vim"} adds nothing: a string is not a list of commands', () => {
    const p = compileClassPolicy({ native: 'vim' })
    expect(p.native).toEqual(defaults.native)
    for (const letter of ['v', 'i', 'm']) expect(p.native).not.toContain(letter)
    expect(p.problems).toEqual([{ kind: 'invalid-overlay', field: 'native' }])
  })

  it('{"pty": [1, "curl"]} drops the 1 and keeps curl', () => {
    const p = compileClassPolicy({ pty: [1, 'curl'] })
    expect(p.pty).toEqual([...defaults.pty, 'curl'])
    expect(p.problems).toEqual([{ kind: 'invalid-overlay', field: 'pty' }])
  })

  it('reports each bad field once, in the order native, pty, relayed', () => {
    expect(compileClassPolicy({ relayed: 1, pty: [null, 2], native: {} }).problems).toEqual([
      { kind: 'invalid-overlay', field: 'native' },
      { kind: 'invalid-overlay', field: 'pty' },
      { kind: 'invalid-overlay', field: 'relayed' }
    ])
  })

  it('treats anything that is not an object as no overlay, silently', () => {
    for (const value of [null, undefined, [], 'x', 7, true]) {
      expect(compileClassPolicy(value), String(value)).toEqual(defaults)
    }
  })
})
