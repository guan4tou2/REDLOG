import { describe, it, expect } from 'vitest'
import { classifyCommand, mergeClassPolicy } from '../src/core/terminal-class'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

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
  })

  it('leaves editors and pagers alone, because a redraw is not evidence', () => {
    for (const line of ['vim notes.txt', 'vi /etc/hosts', 'nvim x', 'nano x', 'less big.log', 'more big.log']) {
      expect(classify(line), line).toBe('native')
    }
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
    const script = CASES.map((line) =>
      `printf '%s\\t' ${quote(line)}\n` +
      `python3 "${hookPath(target!, 'redlog-relay.py')}" classify -- ${line.split(' ').map(quote).join(' ')}\n` +
      `printf '\\n'`
    ).join('\n')
    // 25 `python3` spawns across the WSL boundary, in a suite that runs files
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
      `python3 "${relay}" policy --home "$H" --action remove --command nc > /dev/null`,
      `python3 "${relay}" policy --home "$H" --action list`,
      'rm -rf "$H"'
    ].join('\n')
    const run = await runInShell(target!, script, { timeoutMs: 240_000 })

    const line = (name: string): string[] => {
      const found = run.stdout.split('\n').find((l) => l.startsWith(`${name}: `))
      return (found ?? '').slice(name.length + 2).trim().split(/\s+/).filter(Boolean)
    }
    const mine = mergeClassPolicy({ pty: ['curl'], removed: ['nc'] })

    expect(line('pty').sort(), run.stderr.slice(0, 400)).toEqual([...mine.pty].sort())
    expect(line('native').sort()).toEqual([...mine.native].sort())
    // And the two edits did what they said: curl joined the pty class, nc left
    // the native one.
    expect(mine.pty).toContain('curl')
    expect(mine.native).not.toContain('nc')
  }, 300_000)
})

// The merge itself, without a shell in the way.
describe('the class overlay', () => {
  it('adds, removes, and moves a command out of the class it was in', () => {
    expect(mergeClassPolicy(null).native).toContain('nc')
    expect(mergeClassPolicy({ removed: ['nc'] }).native).not.toContain('nc')
    // `vim` ships native; moving it to pty must take it out of native, or the
    // two lists would both claim it and whichever is consulted first wins.
    const moved = mergeClassPolicy({ pty: ['vim'] })
    expect(moved.pty).toContain('vim')
    expect(moved.native).not.toContain('vim')
  })

  it('does not duplicate a command that is already where it is being put', () => {
    const policy = mergeClassPolicy({ pty: ['ssh'] })
    expect(policy.pty.filter((c) => c === 'ssh')).toHaveLength(1)
  })
})
