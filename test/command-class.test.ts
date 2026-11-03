import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  classifyCommand, compileClassPolicy, CLASS_FILE_MAX_BYTES,
  type CommandClass, type CompiledClassPolicy, type ShippedClassPolicy
} from '../src/core/terminal-class'
import { readClassOverlay } from '../src/core/terminal-enrollment'
import {
  readContributedProfiles, registerTerminalProfiles, unregisterTerminalProfiles, syncTerminalProfiles
} from '../src/core/terminal-profiles'
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

/** `contributed` is the exact text of ~/.redlog/terminal-profiles.json (null or
 *  absent: no file). `zeroChange` marks a case whose answer must equal what the
 *  same inputs give with no snapshot at all. */
interface MirrorCase {
  id: string; file: string | null; shipped?: ShippedClassPolicy; probes?: string[]
  contributed?: string | null; zeroChange?: boolean
  /** The same two files as raw bytes, hex, for what text cannot say: a byte
   *  that is not UTF-8. Used instead of `file` / `contributed`, never with a
   *  synthetic policy. */
  fileHex?: string; contributedHex?: string
  /** Whether the case's file is meant to be read: `raw-tool` is a pty tool then. */
  reads?: boolean
}
const hex = (...parts: Array<string | number[]>): string =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)))).toString('hex')
// The snapshot as the app reads it: no file is null, an unparseable one is
// false, anything else is what it parsed to.
const parseContributed = (text: string | null | undefined): unknown => {
  if (text === undefined || text === null) return null
  try { return JSON.parse(text) } catch { return false }
}
const snap = (profiles: unknown[], held: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, profiles, held })
// Which profile holds each command in a policy: what the writer records.
const heldOf = (p: CompiledClassPolicy): Record<string, string> =>
  Object.fromEntries(p.entries.filter((e) => e.source === 'profile').map((e) => [e.command, e.profile!]))
const synthetic = (native: string[], pty: string[], terminalProfiles: unknown[]): ShippedClassPolicy =>
  ({ native, pty, terminalProfiles })

// The most either file may hold: ~/.redlog/command-class.json and
// ~/.redlog/terminal-profiles.json are written by RedLog and are a few KB.
const CLASS_FILE_CAP = CLASS_FILE_MAX_BYTES
const padded = (text: string, bytes: number): string => text + ' '.repeat(bytes - Buffer.byteLength(text))
// A JSON object text with one more key added, `x`, nested so that the whole
// document is `levels` containers deep (the object itself is the first).
const deepInside = (objectText: string, levels: number): string =>
  objectText.replace(/}$/, `, "x": ${'['.repeat(levels - 1)}${']'.repeat(levels - 1)}}`)

// Profile ids a hand-edited snapshot can carry that are not `<plugin>/<id>` in
// plain lowercase: a terminal escape, an OSC title, a line that looks like a
// header, a NUL, an id too long, a trailing newline, text that is not ASCII.
const ODD_IDS = [
  'pack/\u001b[31mred', '\u001b]0;pwned\u0007', 'a\nnative: fake', 'a\u0000b', `pack/${'a'.repeat(130)}`,
  'pack/ok\n', 'pack/\u00e9', '\u00e9/x', 'Pack/x', 'a/b/c', 'a/', '/a', '-a', '', 'a b', 'pack/x\u2028y'
]

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
  { id: 'shipped broken, bad overlay', file: '{"native": 3, "pty": [false]}', shipped: CLASHING.broken },
  // The overlay feeds `--field pty`, which the zsh adapter pastes into the
  // source of a wrapper, so a name that is not a bare command name is dropped
  // from it as the executables of a profile are.
  { id: 'overlay names that are not bare command names', probes: ['curl', 'ok.tool_1+x-y', 'a', 'vim', 'nc', 'z'],
    file: JSON.stringify({
      pty: ['a;b', 'curl', 'x\n', '-x', 'ok.tool_1+x-y', 'a/b', 'é', '', 'a b', '$(id)', '`id`'],
      native: ['a b', 'vim', 'a'.repeat(65)],
      relayed: ['x;y', 'nc', 'z']
    }) },
  { id: 'overlay a name of 64 characters is fine, 65 is not', probes: ['curl'],
    file: JSON.stringify({ pty: ['a'.repeat(64), 'a'.repeat(65), 'curl'] }) },
  // The files are read with a cap and without recursing without limit: a file
  // too deep or too big is unreadable on both sides, never a traceback.
  { id: 'overlay nested 200000 deep', file: '['.repeat(200000) + ']'.repeat(200000), probes: ['curl', 'vim', 'ssh'] },
  { id: 'overlay at the size cap is read', file: padded('{"pty": ["capped-tool"]}', CLASS_FILE_CAP), probes: ['capped-tool', 'ssh'] },
  { id: 'overlay one byte over the cap is not', file: padded('{"pty": ["capped-tool"]}', CLASS_FILE_CAP + 1), probes: ['capped-tool', 'ssh'] },
  // Depth is counted in containers, the outer object being the first: V8 parses
  // any depth and Python gives up near a thousand, so both apply one cap (32).
  { id: 'snapshot 32 levels deep is read', file: null, probes: ['deep-tool'],
    contributed: deepInside(snap([profile('pack/deep', 'Deep', 'pty', ['deep-tool'])]), 32) },
  { id: 'snapshot 33 levels deep is not', file: null, probes: ['deep-tool'],
    contributed: deepInside(snap([profile('pack/deep', 'Deep', 'pty', ['deep-tool'])]), 33) },
  { id: 'overlay 32 levels deep is read', file: deepInside('{"pty": ["deep-tool"]}', 32), probes: ['deep-tool'] },
  { id: 'overlay 33 levels deep is not', file: deepInside('{"pty": ["deep-tool"]}', 33), probes: ['deep-tool'] },
  { id: 'snapshot nested 200000 deep', file: '{"pty": ["curl"]}', probes: ['curl', 'vim', 'ssh'],
    contributed: '['.repeat(200000) + ']'.repeat(200000) },
  { id: 'snapshot at the size cap is read', file: null, probes: ['capped-tool', 'vim'],
    contributed: padded(snap([profile('pack/capped', 'Capped', 'pty', ['capped-tool'])]), CLASS_FILE_CAP) },
  { id: 'snapshot one byte over the cap is not', file: null, probes: ['capped-tool', 'vim'],
    contributed: padded(snap([profile('pack/capped', 'Capped', 'pty', ['capped-tool'])]), CLASS_FILE_CAP + 1) },
  ...rawByteCases(),
  ...contributedCases()
]

// What text cannot say, written as the bytes it is. JSON has no spelling for
// NaN or Infinity and neither parser takes one; a byte that is not UTF-8 is a
// file that cannot be read, not a file with a replacement character in it. Both
// sides must call each of these unreadable, or the app and the shell disagree
// about a file that one of them has just been handed.
function rawByteCases(): MirrorCase[] {
  const goodSnap = (reason: Array<string | number[]>): string => hex(
    '{"version":1,"profiles":[{"id":"pack/x","name":"X","mode":"pty","executables":["raw-tool"],"reason":"', ...reason,
    '"}],"held":{}}')
  const overlayOf = (...tail: Array<string | number[]>): string => hex('{"pty":["raw-tool"],"note":', ...tail, '}')
  const readable = [
    { id: 'raw: an overlay of plain ASCII is read', fileHex: hex('{"pty":["raw-tool"]}') },
    { id: 'raw: an overlay with valid multibyte text is read', fileHex: overlayOf('"café 中文"') },
    { id: 'raw: a snapshot of plain ASCII is read', contributedHex: goodSnap(['why']) }
  ]
  const refused = [
    { id: 'raw: an overlay with NaN', fileHex: overlayOf('NaN') },
    { id: 'raw: an overlay with Infinity', fileHex: overlayOf('Infinity') },
    { id: 'raw: an overlay with -Infinity', fileHex: overlayOf('-Infinity') },
    { id: 'raw: an overlay with an invalid UTF-8 byte', fileHex: overlayOf('"', [0xff], '"') },
    { id: 'raw: an overlay with a truncated multibyte character', fileHex: overlayOf('"', [0xe4, 0xb8], '"') },
    { id: 'raw: an overlay with an encoded surrogate', fileHex: overlayOf('"', [0xed, 0xa0, 0x80], '"') },
    { id: 'raw: an overlay with an overlong encoding', fileHex: overlayOf('"', [0xc0, 0xaf], '"') },
    { id: 'raw: an overlay with a byte order mark', fileHex: 'efbbbf' + hex('{"pty":["raw-tool"]}') },
    { id: 'raw: a snapshot with an invalid UTF-8 byte', contributedHex: goodSnap(['r', [0xff], 'r']) },
    { id: 'raw: a snapshot with a truncated multibyte character', contributedHex: goodSnap([[0xe4, 0xb8]]) },
    { id: 'raw: a snapshot with an encoded surrogate', contributedHex: goodSnap([[0xed, 0xa0, 0x80]]) },
    { id: 'raw: a snapshot with NaN', contributedHex: hex('{"version":NaN,"profiles":[],"held":{}}') },
    { id: 'raw: a snapshot with a byte order mark', contributedHex: 'efbbbf' + goodSnap(['why']) }
  ]
  // `reads` says what the file is for: `raw-tool` is a pty tool only if it was read.
  return [
    ...readable.map((c): MirrorCase => ({ file: null, probes: ['raw-tool', 'vim'], reads: true, ...c })),
    ...refused.map((c): MirrorCase => ({ file: null, probes: ['raw-tool', 'vim'], reads: false, ...c }))
  ]
}

// The snapshot a plugin writes (#499): profiles that join the profile layer
// after the shipped ones, and `held`, the profile that had each command when
// the file was last written. Every case here is run through both compilers.
function contributedCases(): MirrorCase[] {
  const bundledHeld = heldOf(compileClassPolicy(null))
  const pack = (id: string, mode: string, executables: unknown[]) => profile(`pack/${id}`, id, mode, executables as string[])
  const plain = (shippedPolicy: ShippedClassPolicy, held: Record<string, unknown>, profiles: unknown[], id: string): MirrorCase =>
    ({ id, file: null, shipped: shippedPolicy, contributed: snap(profiles, held) })
  const empty = synthetic([], [], [])
  const vimKeys = [pack('vimkeys', 'pty', ['vim'])]
  const two = [profile('a/p', 'P', 'pty', ['x']), profile('b/q', 'Q', 'native', ['x'])]
  return [
    // Zero change: a snapshot that names no profile, holding exactly the
    // bundled winners, is PR A's answer under every overlay and every clash.
    ...golden.cases.map((c): MirrorCase => ({
      id: `empty snapshot over golden ${c.id}`, file: c.file, probes: golden.probes,
      contributed: snap([], bundledHeld), zeroChange: true
    })),
    ...Object.entries(CLASHING).map(([name, s]): MirrorCase => ({
      id: `empty snapshot over shipped ${name}`, file: null, shipped: s,
      contributed: snap([], heldOf(compileClassPolicy(null, s))), zeroChange: true
    })),
    { id: 'snapshot text null is no snapshot', file: null, contributed: 'null', probes: golden.probes, zeroChange: true },

    { id: 'contributed: a new tool with no clash', file: null, probes: ['ligolo-proxy', 'vim', 'ssh'],
      contributed: snap([pack('ligolo', 'pty', ['ligolo-proxy'])]) },
    { id: 'contributed: newcomer against bundled vim, no holder', file: null, probes: ['vim', 'vi'], contributed: snap(vimKeys) },
    { id: 'contributed: newcomer against bundled vim, bundled holds it', file: null, probes: ['vim', 'vi'],
      contributed: snap(vimKeys, { vim: 'vim', vi: 'vim' }) },
    { id: 'contributed: operator overlay over a kept clash', file: '{"relayed": ["vim"]}', probes: ['vim'],
      contributed: snap(vimKeys, { vim: 'vim' }) },
    plain(synthetic([], [], [profile('b', 'B', 'native', ['x'])]), { x: 'pack/p' }, [pack('p', 'pty', ['x'])], 'contributed: held plugin against a newer bundled profile'),
    plain(empty, {}, two, 'contributed: two plugins clash, no holder'),
    plain(empty, { x: 'b/q' }, two, 'contributed: two plugins clash, one holds'),
    plain(empty, { x: 'c/gone' }, two, 'contributed: the holder is no longer present'),
    plain(synthetic(['x'], [], []), { x: 'a/p' }, two, 'contributed: a holder keeps the command over a default'),
    plain(empty, { x: 'b/q' }, [profile('a/p', 'P', 'native', ['x']), profile('b/q', 'Q', 'native', ['x'])],
      'contributed: agreement, the holder is the second claimant'),
    plain(empty, {}, [profile('a/p', 'P', 'native', ['x']), profile('b/q', 'Q', 'native', ['x'])],
      'contributed: agreement, no holder, the first claimant'),
    plain(empty, { x: 'a/p' }, [profile('a/p', 'P', 'native', ['x']), profile('a/p', 'P', 'pty', ['x'])],
      'contributed: one id twice'),
    { id: 'contributed: a holder over an overlay, clash kept', file: '{"pty": ["x"]}', shipped: empty,
      contributed: snap(two, { x: 'a/p' }) },

    // A snapshot the compiler cannot use: one line in `list`, bundled and overlay stand.
    ...[
      ['not json', '{'], ['an array', '[]'], ['a string', '"x"'], ['a number', '7'], ['false', 'false'],
      ['no profiles or held', '{"version":1}'],
      ['profiles a string', '{"version":1,"profiles":"x","held":{}}'],
      ['held an array', '{"version":1,"profiles":[],"held":[]}'],
      ['version true', '{"version":true,"profiles":[],"held":{}}'],
      ['version a string', '{"version":"1","profiles":[],"held":{}}'],
      ['version 0', '{"version":0,"profiles":[],"held":{}}'],
      ['version 2', '{"version":2,"profiles":[],"held":{}}'],
      ['version 2, profiles a string', '{"version":2,"profiles":"x","held":{}}'],
      ['version 1.0 is valid', '{"version":1.0,"profiles":[],"held":{}}']
    ].map(([name, text]): MirrorCase => ({ id: `snapshot ${name}`, file: '{"pty": ["curl"]}', probes: ['vim', 'curl'], contributed: text })),
    { id: 'snapshot held with a value that is not a string', file: null, probes: ['vim', 'claude'],
      contributed: snap(vimKeys, { vim: 'vim', claude: 7, codex: null }) },

    // The compiler, not the writer, is what keeps `executables` safe to paste into shell source.
    { id: 'snapshot executables that are not bare names', file: null, probes: ['a', 'x'],
      contributed: snap([
        pack('semi', 'pty', ['a;b']), pack('dash', 'pty', ['-x']), pack('space', 'pty', ['a b']),
        pack('newline', 'pty', ['x\n']), pack('good', 'pty', ['ok.tool_1+x-y']), pack('long', 'pty', ['a'.repeat(65)]),
        pack('slash', 'pty', ['a/b']), pack('empty', 'pty', [''])
      ]) },
    // An id is printed by `redlog class list`, so it is held to a shape and to
    // plain text, and an invalid one is named by its position instead.
    { id: 'snapshot profile ids that are not plain', file: null, probes: ['e-esc', 'e-ok', 'e-uni'],
      contributed: snap(ODD_IDS.map((id, i) => profile(id, 'Odd', 'pty', [`e-${i}`])).concat([
        profile('pack/e-ok', 'Ok', 'pty', ['e-ok']), profile('plain', 'Plain', 'native', ['e-plain'])
      ])) },
    { id: 'snapshot profile id valid but its executables are not', file: null,
      contributed: snap([profile('pack/fine-id', 'Fine', 'pty', ['a;b']), profile('Pack/Bad', 'Bad', 'pty', ['a;b'])]) },
    { id: 'snapshot invalid profile counts on from the shipped ones', file: null,
      contributed: snap([{ mode: 'pty', executables: ['x'] }, 'text', pack('fine', 'pty', ['f'])]) },
    { id: 'snapshot invalid profile counts on from a synthetic shipped list', file: null,
      shipped: synthetic([], [], [profile('a', 'A', 'pty', ['q']), { mode: 'pty' }]),
      contributed: snap([{ mode: 'pty', executables: ['x'] }]) }
  ]
}

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
  // The name rule has two ends: the registry refuses a name, and the relay shows
  // the id instead of one it was handed by a hand-edited snapshot. They must
  // call the same names plain, or one of them lets through what the other won't.
  it('calls the same profile names plain on both sides', async () => {
    const names = [
      'Ligolo-ng', 'Ligolo \u00e9\u00a0\u00a1', 'Sat \u{1F6F0} Ligolo', '\u{1F6F0}', 'a b', 'tab\there',
      'Ligolo\ud800', '\udc00Ligolo', 'a\udc00\ud800b', 'x\ud83d', '\ude00x',
      'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0080b', 'a\u0085b', 'a\u009fb', 'a\u00a0b',
      'a\u2027b', 'a\u2028b', 'a\u2029b', 'a\u202ab'
    ]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-names-'))
    try {
      const input = path.join(dir, 'cases.json')
      fs.writeFileSync(input, JSON.stringify({ cases: [], names }))
      const driver = target!.toShellPath(path.join(__dirname, 'helpers', 'class-policy-driver.py'))
      const run = await runInShell(
        target!,
        `python3 "${driver}" "${hookPath(target!, 'redlog-relay.py')}" "${target!.toShellPath(input)}"`,
        { timeoutMs: 240_000 }
      )
      const theirs = (JSON.parse(run.stdout) as { __plain_names: boolean[] }).__plain_names
      const mine = names.map((name, i) => {
        const pluginId = `name-mirror-${i}`
        try {
          return registerTerminalProfiles(pluginId, [{ id: 'p', name, mode: 'pty', executables: [`nm${i}`], reason: 'r' }]).accepted === 1
        } finally { unregisterTerminalProfiles(pluginId) }
      })
      expect(theirs, run.stderr.slice(0, 300)).toEqual(mine)
      // and the table is not trivial: it holds both answers
      expect(mine.filter(Boolean).length).toBeGreaterThan(5)
      expect(mine.filter((x) => !x).length).toBeGreaterThan(10)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('compiles every case the same way on both sides', async () => {
    const run = await runDriver(MIRROR_CASES)
    // The real policy is compiled from a temp home read the way the app reads
    // it; a synthetic one cannot be, because the app only reads the shipped
    // file beside it, so its inputs are parsed here.
    const homes: string[] = []
    const compileMine = (c: MirrorCase, withSnapshot: boolean): CompiledClassPolicy => {
      if (c.shipped) {
        return compileClassPolicy(parseOverlay(c.file), c.shipped, withSnapshot ? parseContributed(c.contributed) : null)
      }
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-mirror-home-'))
      homes.push(home)
      fs.mkdirSync(path.join(home, '.redlog'))
      if (c.fileHex !== undefined) fs.writeFileSync(path.join(home, '.redlog', 'command-class.json'), Buffer.from(c.fileHex, 'hex'))
      else if (c.file !== null) fs.writeFileSync(path.join(home, '.redlog', 'command-class.json'), c.file)
      if (withSnapshot && c.contributedHex !== undefined) {
        fs.writeFileSync(path.join(home, '.redlog', 'terminal-profiles.json'), Buffer.from(c.contributedHex, 'hex'))
      } else if (withSnapshot && c.contributed != null) {
        fs.writeFileSync(path.join(home, '.redlog', 'terminal-profiles.json'), c.contributed)
      }
      return compileClassPolicy(readClassOverlay(home), undefined, readContributedProfiles(home))
    }
    try {
      for (const c of MIRROR_CASES) {
        const mine = compileMine(c, true)
        const theirs = run.answers[c.id]
        expect(theirs, `${c.id}: ${run.stderr.slice(0, 300)}`).toBeDefined()
        expect(theirs.native, `${c.id} native`).toEqual(mine.native)
        expect(theirs.pty, `${c.id} pty`).toEqual(mine.pty)
        expect(theirs.entries, `${c.id} entries`).toEqual(mine.entries)
        expect(theirs.problems, `${c.id} problems`).toEqual(mine.problems)
        if (c.reads !== undefined) {
          expect(mine.pty.includes('raw-tool'), `${c.id}: the app ${c.reads ? 'reads' : 'refuses'} it`).toBe(c.reads)
          expect(theirs.pty.includes('raw-tool'), `${c.id}: the shell ${c.reads ? 'reads' : 'refuses'} it`).toBe(c.reads)
        }
        if (!c.shipped) expect(theirs.modes, `${c.id} modes`).toEqual(Object.fromEntries(
          (c.probes ?? []).map((p) => [p, modeFor(mine, p)])))
        // Not only the same on both sides: the same as having no snapshot.
        if (c.zeroChange) {
          const without = compileMine(c, false)
          for (const side of [mine, theirs]) {
            expect(side.native, `${c.id} native vs no snapshot`).toEqual(without.native)
            expect(side.pty, `${c.id} pty vs no snapshot`).toEqual(without.pty)
            expect(side.entries, `${c.id} entries vs no snapshot`).toEqual(without.entries)
            expect(side.problems, `${c.id} problems vs no snapshot`).toEqual(without.problems)
          }
        }
      }
    } finally {
      for (const h of homes) fs.rmSync(h, { recursive: true, force: true })
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

    // `--field pty` is pasted into the source of the zsh wrappers, so it must
    // never carry a name that is more than a bare command name, whoever wrote
    // the overlay, and `class add` must not write one.
    it('drops a name that is not a bare command name from the overlay, and says so once', async () => {
      const file = JSON.stringify({ pty: ['curl', 'a;b', 'x y', '$(id)', 'ok.tool'], native: ['a`b`'] }).replace(/'/g, '')
      const run = await runInShell(target!, inOverlay(file, [
        `python3 "${relay()}" policy --home "$H" --field pty; echo`, list()
      ]), { timeoutMs: 120_000 })
      const pty = run.stdout.split('native:')[0] // what `--field pty` printed, before the list
      expect(pty, run.stderr.slice(0, 300)).toContain('curl')
      expect(pty).toContain('ok.tool')
      expect(pty).not.toMatch(/a;b|x y|\$\(|`| /)
      // Both fields are lists; what was dropped is entries in them, and the line says that.
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: pty lists something that is not a command name\n')
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: native lists something that is not a command name\n')
      expect(run.stdout).not.toContain('is not a list of commands')
    }, 180_000)

    it('refuses to add a name that is not a bare command name, exits 3, and writes nothing', async () => {
      const add = (name: string): string =>
        `python3 "${relay()}" policy --home "$H" --action add --field pty --command ${name}; echo "rc=$?"`
      const run = await runInShell(target!, [
        'H=$(mktemp -d -t redlog-add.XXXXXX)',
        add(`'a;b'`), add(`'a b'`), add(`'-x'`), add(`'$(id)'`), add(`'a\`id\`'`), add(`"$(printf 'x\\ny')"`), add(`"$(printf 'a%.0s' $(seq 65))"`),
        'test -e "$H/.redlog/command-class.json" && echo written || echo nothing-written',
        add('ligolo-proxy'), add('/usr/bin/ssh'),
        'cat "$H/.redlog/command-class.json"; echo',
        'rm -rf "$H"'
      ].join('\n'), { timeoutMs: 120_000 })
      const lines = run.stdout.split('\n')
      expect(lines.slice(0, 7), run.stderr.slice(0, 300)).toEqual(Array(7).fill('rc=3'))
      expect(lines[7]).toBe('nothing-written')
      expect(lines.slice(8, 10)).toEqual(['rc=0', 'rc=0'])
      expect(JSON.parse(lines[10])).toEqual({ native: [], pty: ['ligolo-proxy', 'ssh'], relayed: [] })
    }, 180_000)

    // `foo/` has an empty basename, which came back as "no such class: pty".
    it('says "not a bare command name" for a path with nothing after the slash, and not that the class is wrong', async () => {
      const run = await runInShell(target!, [
        'H=$(mktemp -d -t redlog-add.XXXXXX)',
        `python3 "${relay()}" policy --home "$H" --action add --field pty --command 'foo/'; echo "rc=$?"`,
        `python3 "${relay()}" policy --home "$H" --action add --field pty --command 'a/b/'; echo "rc=$?"`,
        `python3 "${relay()}" policy --home "$H" --action remove --command 'foo/'; echo "rc=$?"`,
        `python3 "${relay()}" policy --home "$H" --action add --field nonsense --command 'foo/'; echo "rc=$?"`,
        'test -e "$H/.redlog/command-class.json" && echo written || echo nothing-written',
        'rm -rf "$H"'
      ].join('\n'), { timeoutMs: 120_000 })
      expect(run.stdout, run.stderr.slice(0, 300)).toBe('rc=3\nrc=3\nrc=3\nrc=2\nnothing-written\n')
      expect(run.stderr).toContain("'foo/' is not a bare command name")
    }, 180_000)

    // `class add` and `class remove` rewrite the whole overlay. One that cannot
    // be read was read as no overlay, and replaced by an overlay holding only
    // the one edit: the operator's own choices gone with no word said.
    it('does not overwrite an overlay it cannot read: it says why, exits 4, and leaves the file as it was', async () => {
      const cap = CLASS_FILE_MAX_BYTES
      const shapes: Array<[string, string]> = [
        ['nested too deep', `python3 -c "import sys; sys.stdout.write('{\\"pty\\": [\\"keep-me\\"], \\"x\\": ' + '['*200000 + ']'*200000 + '}')" > "$F"`],
        ['over the size cap', `python3 -c "import sys; sys.stdout.write('{\\"pty\\": [\\"keep-me\\"], \\"pad\\": \\"' + 'a'*${cap} + '\\"}')" > "$F"`],
        ['not UTF-8', `printf '{"pty": ["keep-me"], "note": "\\377"}' > "$F"`],
        ['NaN', `printf '{"pty": ["keep-me"], "x": NaN}' > "$F"`],
        ['truncated JSON', `printf '{"pty": ["keep-me"' > "$F"`]
      ]
      for (const [what, make] of shapes) {
        const run = await runInShell(target!, [
          'H=$(mktemp -d -t redlog-keep.XXXXXX)', 'mkdir -p "$H/.redlog"', `F="$H/.redlog/command-class.json"`, make,
          'cp "$F" "$H/before"',
          `python3 "${relay()}" policy --home "$H" --action add --field native --command ligolo-proxy; echo "add-rc=$?"`,
          `python3 "${relay()}" policy --home "$H" --action remove --command keep-me; echo "remove-rc=$?"`,
          'cmp -s "$F" "$H/before" && echo unchanged || echo CHANGED',
          'ls "$H/.redlog"',
          'rm -rf "$H"'
        ].join('\n'), { timeoutMs: 120_000 })
        expect(run.stdout, `${what}: ${run.stderr.slice(0, 300)}`).toBe('add-rc=4\nremove-rc=4\nunchanged\ncommand-class.json\n')
        expect(run.stderr, what).toContain('command-class.json cannot be read')
        expect(run.stderr, what).toContain('it was not changed')
        expect(run.stderr, what).not.toMatch(/Traceback|RecursionError/)
      }
    }, 300_000)

    it('an overlay that is not there, or is readable, is edited as before', async () => {
      const run = await runInShell(target!, [
        'H=$(mktemp -d -t redlog-keep.XXXXXX)',
        `python3 "${relay()}" policy --home "$H" --action add --field pty --command first; echo "rc=$?"`,
        `python3 "${relay()}" policy --home "$H" --action add --field native --command second; echo "rc=$?"`,
        `python3 "${relay()}" policy --home "$H" --action remove --command first; echo "rc=$?"`,
        'cat "$H/.redlog/command-class.json"; echo',
        'rm -rf "$H"'
      ].join('\n'), { timeoutMs: 120_000 })
      const lines = run.stdout.split('\n')
      expect(lines.slice(0, 3), run.stderr.slice(0, 300)).toEqual(['rc=0', 'rc=0', 'rc=0'])
      expect(JSON.parse(lines[3])).toEqual({ native: ['second'], pty: [], relayed: [] })
    }, 180_000)

    // json.load recurses, and a deep enough file raised RecursionError: classify
    // and `--field pty` exited 1 with a traceback, zsh installed no PTY wrappers
    // and every command fell back to native, silently.
    it('reads a file nested too deep, or too big, as not readable: the relay still answers and exits 0', async () => {
      const cap = CLASS_FILE_MAX_BYTES
      const bundledPty = (): string => `python3 "${relay()}" policy --home "$H" --field pty; rc=$?; echo; echo "pty-rc=$rc"`
      const classify = `python3 "${relay()}" classify --home "$H" -- ssh -x; rc=$?; echo; echo "classify-rc=$rc"`
      // `make` is the shell that writes the file, with $F as its path.
      const check = async (name: 'command-class.json' | 'terminal-profiles.json', make: string): Promise<string[]> => {
        const run = await runInShell(target!, [
          'H=$(mktemp -d -t redlog-deep.XXXXXX)', 'mkdir -p "$H/.redlog"', `F="$H/.redlog/${name}"`,
          make, bundledPty(), classify,
          `python3 "${relay()}" policy --home "$H" --action list; echo "list-rc=$?"`,
          'rm -rf "$H"'
        ].join('\n'), { timeoutMs: 120_000 })
        return run.stdout.split('\n')
      }
      for (const name of ['command-class.json', 'terminal-profiles.json'] as const) {
        const nested = (await check(name, `python3 -c "import sys; sys.stdout.write('['*200000+']'*200000)" > "$F"`)).join('\n')
        expect(nested, name).toContain('\nssh\n')
        expect(nested, name).toContain('pty-rc=0')
        expect(nested, name).toContain('pty\nclassify-rc=0')
        expect(nested, name).toContain('list-rc=0')
        expect(nested, name).not.toMatch(/Traceback|RecursionError/)
        const body = name === 'command-class.json'
          ? '{"pty": ["capped-tool"]}'
          : '{"version":1,"profiles":[{"id":"pack/capped","name":"Capped","mode":"pty","executables":["capped-tool"],"reason":"r"}],"held":{}}'
        const padTo = (bytes: number): string =>
          `printf '%s' '${body}' > "$F"; python3 -c "import sys; p=sys.argv[1]; t=open(p).read(); open(p,'w').write(t+' '*(${bytes}-len(t)))" "$F"`
        const big = await check(name, padTo(cap + 1))
        expect(big.join('\n'), `${name} one byte over the cap`).not.toContain('capped-tool')
        expect(big.join('\n'), name).toContain('list-rc=0')
        const exact = await check(name, padTo(cap))
        expect(exact.join('\n'), `${name} at the cap`).toContain('capped-tool')
      }
    }, 300_000)

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
      expect(run.stdout).toContain('ignored in ~/.redlog/command-class.json: pty lists something that is not a command name\n')
      expect(run.stdout).not.toContain('is not a list of commands')
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

  // #499. The plugins' profiles are named on their own line, a clash that a
  // holder kept says who kept it and who did not get it, and a snapshot the
  // compiler could not use says so once.
  describe('`redlog class list` with plugin profiles', () => {
    const bundled = {
      native: ['nc'], pty: ['socat'], repl: [], replScriptFlags: [], wrappers: {},
      terminalProfiles: [profile('vim', 'Vim', 'native', ['vim', 'vi'])]
    }
    const run = async (snapshot: string | null, overlay: string | null = null): Promise<string[]> => {
      const script = [
        'D=$(mktemp -d -t redlog-plist.XXXXXX)',
        `cp "${hookPath(target!, 'redlog-relay.py')}" "${hookPath(target!, 'terminal_app.py')}" "$D/"`,
        `cat > "$D/command-class.json" <<'JSON'\n${JSON.stringify(bundled)}\nJSON`,
        'mkdir -p "$D/home/.redlog"',
        ...(snapshot === null ? [] : [`cat > "$D/home/.redlog/terminal-profiles.json" <<'JSON'\n${snapshot}\nJSON`]),
        ...(overlay === null ? [] : [`cat > "$D/home/.redlog/command-class.json" <<'JSON'\n${overlay}\nJSON`]),
        'python3 "$D/redlog-relay.py" policy --home "$D/home" --action list',
        'rm -rf "$D"'
      ].join('\n')
      const r = await runInShell(target!, script, { timeoutMs: 120_000 })
      const lines = r.stdout.split('\n').filter(Boolean)
      expect(lines.length, r.stderr.slice(0, 300)).toBeGreaterThanOrEqual(3)
      for (const l of lines.slice(3)) expect(l, 'a header lookalike').not.toMatch(/\b(native|pty|relayed):/)
      return lines
    }
    const keys = { id: 'pack-a/keys', name: 'Vim Keys', mode: 'pty', executables: ['vim', 'vi'], reason: 'r' }

    it('names a plugin\'s profile with the plugin it came from, once it owns an executable', async () => {
      const lines = await run(snap([
        { id: 'pack-b/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy', 'ligolo-agent'], reason: 'r' },
        { id: 'pack-b/odd', name: 'a: b', mode: 'native', executables: ['odd-tool'], reason: 'r' },
        keys
      ], {}))
      // Vim owns nothing here — a newcomer cancelled it — so it has no line.
      expect(lines.slice(3)).toEqual([
        'plugin profiles: Ligolo-ng from pack-b (ligolo-proxy ligolo-agent), pack-b/odd from pack-b (odd-tool)',
        'vi stays relayed because profiles Vim (native) and Vim Keys from pack-a (pty) disagree; choose one with: redlog class add <class> vi',
        'vim stays relayed because profiles Vim (native) and Vim Keys from pack-a (pty) disagree; choose one with: redlog class add <class> vim'
      ])
    }, 180_000)

    it('says who kept a command a plugin wanted, and who did not get it', async () => {
      const lines = await run(snap([keys, { id: 'pack-c/two', name: 'Vim Two', mode: 'relayed', executables: ['vi'], reason: 'r' }],
        { vim: 'vim', vi: 'vim' }))
      expect(lines.slice(0, 2)).toEqual(['native: nc vim vi', 'pty: socat'])
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vim vi)',
        'vi stays native because Vim had it first; Vim Keys from pack-a (pty) and Vim Two from pack-c (relayed) are not applied; choose one with: redlog class add <class> vi',
        'vim stays native because Vim had it first; Vim Keys from pack-a (pty) is not applied; choose one with: redlog class add <class> vim'
      ])
    }, 180_000)

    // When the holder is itself a plugin the name already says "from <plugin>",
    // so the line must not say "from" twice.
    it('names a plugin that holds a command once, with a single "from"', async () => {
      const lines = await run(snap([
        { id: 'red-team-pack/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'r' },
        { id: 'vimpack/keys', name: 'Vim Keys', mode: 'relayed', executables: ['ligolo-proxy'], reason: 'r' }
      ], { 'ligolo-proxy': 'red-team-pack/ligolo' }))
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vim vi)',
        'plugin profiles: Ligolo-ng from red-team-pack (ligolo-proxy)',
        'ligolo-proxy stays pty because Ligolo-ng from red-team-pack had it first; Vim Keys from vimpack (relayed) is not applied; choose one with: redlog class add <class> ligolo-proxy'
      ])
      expect(lines[5].match(/\bfrom\b/g)).toHaveLength(2)
    }, 180_000)

    it('leaves out a kept clash the operator has already settled', async () => {
      const lines = await run(snap([keys], { vim: 'vim', vi: 'vim' }), '{"relayed": ["vim"]}')
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vi)',
        'your changes: vim (relayed)',
        'vi stays native because Vim had it first; Vim Keys from pack-a (pty) is not applied; choose one with: redlog class add <class> vi'
      ])
    }, 180_000)

    it('says once that a snapshot it cannot use is ignored, and keeps the bundled tools and the overlay', async () => {
      for (const [text, why] of [
        ['{', 'not readable'], ['[]', 'not readable'], ['{"version":1}', 'not readable'],
        ['{"version":2,"profiles":[],"held":{}}', 'written by a newer RedLog']
      ]) {
        const lines = await run(text, '{"pty": ["curl"]}')
        expect(lines.slice(3), text).toEqual([
          'tool profiles: Vim (vim vi)',
          'your changes: curl (pty)',
          `ignored ~/.redlog/terminal-profiles.json: ${why}, so no plugin profile applies`
        ])
      }
    }, 300_000)

    it('says nothing about a snapshot that is not there, or that says null', async () => {
      for (const text of [null, 'null']) {
        expect((await run(text)).slice(3), String(text)).toEqual(['tool profiles: Vim (vim vi)'])
      }
    }, 180_000)

    it('skips an invalid profile in the snapshot, by id, and keeps the rest', async () => {
      const lines = await run(snap([
        { id: 'pack-d/bad', name: 'Bad', mode: 'pty', executables: ['a;b'], reason: 'r' },
        { id: 'pack-d/fine', name: 'Fine', mode: 'pty', executables: ['fine-tool'], reason: 'r' }
      ]))
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vim vi)',
        'plugin profiles: Fine from pack-d (fine-tool)',
        'skipped tool profile pack-d/bad: not valid'
      ])
    }, 180_000)

    // An id is the one thing printed raw if it is not checked: a terminal escape
    // or a newline in it would draw on the operator's screen or fake a header.
    // An invalid profile is named by its position, a valid-looking one by id.
    it('names an invalid profile by position when its id is not plain, and prints nothing raw', async () => {
      const lines = await run(snap([
        ...ODD_IDS.map((id, i) => ({ id, name: 'Odd', mode: 'pty', executables: [`e-${i}`], reason: 'r' })),
        { id: 'pack-d/bad', name: 'Bad', mode: 'pty', executables: ['a;b'], reason: 'r' },
        { id: 'pack-d/fine', name: 'Fine', mode: 'pty', executables: ['fine-tool'], reason: 'r' }
      ]))
      const bundledCount = 1 // the bundled Vim profile counts first
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vim vi)',
        'plugin profiles: Fine from pack-d (fine-tool)',
        ...ODD_IDS.map((_, i) => `skipped tool profile #${bundledCount + i}: not valid`),
        'skipped tool profile pack-d/bad: not valid'
      ])
      expect(lines.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/)
    }, 180_000)

    // A snapshot someone edited by hand can carry a name the app would refuse.
    // A lone surrogate cannot be written to stdout as UTF-8: it used to raise
    // after `tool profiles:` and lose everything below it, with exit 1. Such a
    // name is shown as the id, and the listing runs to its last line.
    it('shows the id for a name that is not plain well-formed text, and still prints every line', async () => {
      const odd: Record<string, string> = {
        high: 'Ligolo\ud800', low: '\udc00Ligolo', del: 'a\u007fb', c1: 'a\u0085b', ls: 'a\u2028b', ps: 'a\u2029b'
      }
      const lines = await run(snap([
        ...Object.entries(odd).map(([k, name]) => ({ id: `pack-e/${k}`, name, mode: 'pty', executables: [`x-${k}`], reason: 'r' })),
        { id: 'pack-e/astral', name: 'Sat \u{1F6F0} Ligolo', mode: 'pty', executables: ['x-astral'], reason: 'r' },
        { id: 'pack-e/fine', name: 'Fine', mode: 'pty', executables: ['x-fine'], reason: 'r' },
        { id: 'pack-e/bad', name: 'Bad', mode: 'pty', executables: ['a;b'], reason: 'r' }
      ]))
      expect(lines.slice(3)).toEqual([
        'tool profiles: Vim (vim vi)',
        'plugin profiles: ' + [
          ...Object.keys(odd).map((k) => `pack-e/${k} from pack-e (x-${k})`),
          'Sat \u{1F6F0} Ligolo from pack-e (x-astral)', 'Fine from pack-e (x-fine)'
        ].join(', '),
        'skipped tool profile pack-e/bad: not valid'
      ])
    }, 180_000)

    // The same text, from the other end: what the app writes is what the shell reads.
    it('reads a snapshot that RedLog itself wrote', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-written-'))
      try {
        registerTerminalProfiles('written-pack', [{ id: 'ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'r' }])
        expect(syncTerminalProfiles(home).written).toBe(true)
        const relay = hookPath(target!, 'redlog-relay.py')
        const h = target!.toShellPath(home)
        const r = await runInShell(target!, [
          `python3 "${relay}" classify --home "${h}" -- ligolo-proxy -x`, 'echo',
          `python3 "${relay}" classify --home "${h}" -- vim x`, 'echo',
          `python3 "${relay}" policy --home "${h}" --action list`
        ].join('\n'), { timeoutMs: 120_000 })
        const out = r.stdout.split('\n')
        expect(out[0], r.stderr.slice(0, 300)).toBe('pty')
        expect(out[1]).toBe('native')
        expect(out).toContain('plugin profiles: Ligolo-ng from written-pack (ligolo-proxy)')
        expect(compileClassPolicy(null, undefined, readContributedProfiles(home)).pty).toContain('ligolo-proxy')
      } finally {
        unregisterTerminalProfiles('written-pack')
        fs.rmSync(home, { recursive: true, force: true })
      }
    }, 180_000)
  })
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

// #499. Plugins contribute profiles through ~/.redlog/terminal-profiles.json,
// which adds one input to the compiler and replaces nothing. `held` is the
// forward rule: the profile that had a command when the file was last written
// keeps it against a profile that disagrees, and the clash is still reported.
describe('plugin tool profiles in the compiler', () => {
  const entry = (p: CompiledClassPolicy, command: string) => p.entries.find((e) => e.command === command)
  const none = synthetic([], [], [])
  const compileWith = (s: ShippedClassPolicy, profiles: unknown[], held: Record<string, unknown> = {}, overlay: unknown = null) =>
    compileClassPolicy(overlay, s, parseContributed(snap(profiles, held)))

  it('adds a profile after the shipped ones, as a profile source', () => {
    const p = compileWith(synthetic(['n'], [], [profile('a', 'A', 'native', ['x'])]), [profile('pack/b', 'B', 'pty', ['y'])])
    expect(entry(p, 'y')).toEqual({ command: 'y', mode: 'pty', source: 'profile', profile: 'pack/b' })
    expect(p.native).toEqual(['n', 'x'])
    expect(p.pty).toEqual(['y'])
    expect(p.problems).toEqual([])
  })

  it('a newcomer against a bundled profile cancels, and the bundled one is kept once it holds the command', () => {
    const bundled = synthetic([], [], [profile('vim', 'Vim', 'native', ['vim'])])
    const keys = [profile('pack/keys', 'Keys', 'pty', ['vim'])]
    const claims = [{ profile: 'vim', mode: 'native' }, { profile: 'pack/keys', mode: 'pty' }]

    const without = compileWith(bundled, keys)
    expect(entry(without, 'vim')).toEqual({ command: 'vim', mode: 'relayed', source: 'fallback' })
    expect(without.problems).toEqual([{ kind: 'conflict', command: 'vim', claims }])

    const held = compileWith(bundled, keys, { vim: 'vim' })
    expect(entry(held, 'vim')).toEqual({ command: 'vim', mode: 'native', source: 'profile', profile: 'vim' })
    expect(held.native).toEqual(['vim'])
    expect(held.problems).toEqual([{ kind: 'conflict', command: 'vim', claims, kept: 'vim' }])
  })

  it('a plugin that holds a command keeps it against a newer bundled profile', () => {
    const newer = synthetic([], [], [profile('b', 'B', 'native', ['x'])])
    const p = compileWith(newer, [profile('pack/p', 'P', 'pty', ['x'])], { x: 'pack/p' })
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'pty', source: 'profile', profile: 'pack/p' })
    expect(p.problems).toEqual([{
      kind: 'conflict', command: 'x', kept: 'pack/p',
      claims: [{ profile: 'b', mode: 'native' }, { profile: 'pack/p', mode: 'pty' }]
    }])
  })

  it('two new plugins in one write cancel; with a recorded holder it stays with the holder', () => {
    const two = [profile('a/p', 'P', 'pty', ['x']), profile('b/q', 'Q', 'native', ['x'])]
    expect(entry(compileWith(none, two), 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'fallback' })
    const q = compileWith(none, two, { x: 'b/q' })
    expect(entry(q, 'x')).toEqual({ command: 'x', mode: 'native', source: 'profile', profile: 'b/q' })
    expect(q.problems).toHaveLength(1)
    expect(q.problems[0]).toMatchObject({ kind: 'conflict', kept: 'b/q' })
    // A holder that is not among the claimants holds nothing.
    expect(entry(compileWith(none, two, { x: 'c/gone' }), 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'fallback' })
    expect(compileWith(none, two, { x: 'c/gone' }).problems[0]).not.toHaveProperty('kept')
  })

  it('profiles that agree on the mode go to the holder when it is among them, else the first', () => {
    const agree = [profile('a/p', 'P', 'native', ['x']), profile('b/q', 'Q', 'native', ['x'])]
    expect(entry(compileWith(none, agree, { x: 'b/q' }), 'x')).toMatchObject({ profile: 'b/q' })
    expect(entry(compileWith(none, agree), 'x')).toMatchObject({ profile: 'a/p' })
    expect(compileWith(none, agree, { x: 'b/q' }).problems).toEqual([])
  })

  it('the holder\'s own update to another mode keeps the command in the new mode', () => {
    const p = compileWith(none, [profile('a/p', 'P', 'pty', ['x'])], { x: 'a/p' })
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'pty', source: 'profile', profile: 'a/p' })
  })

  it('the operator\'s overlay still wins over a kept clash, and the clash is still reported', () => {
    const two = [profile('a/p', 'P', 'pty', ['x']), profile('b/q', 'Q', 'native', ['x'])]
    const p = compileWith(none, two, { x: 'a/p' }, { relayed: ['x'] })
    expect(entry(p, 'x')).toEqual({ command: 'x', mode: 'relayed', source: 'override' })
    expect(p.problems).toHaveLength(1)
  })

  it('held is read, never extended: a command no profile claims is not touched by it', () => {
    const p = compileWith(synthetic(['n'], [], []), [], { n: 'ghost', other: 'ghost' })
    expect(p).toEqual(compileClassPolicy(null, synthetic(['n'], [], [])))
  })

  it('numbers an invalid profile on from the shipped ones, and skips an executable that is not a bare name', () => {
    const p = compileWith(synthetic([], [], [profile('a', 'A', 'pty', ['q']), { mode: 'pty' }]), [
      { mode: 'pty', executables: ['x'] },
      profile('pack/semi', 'S', 'pty', ['a;b']), profile('pack/dash', 'D', 'pty', ['-x']),
      profile('pack/space', 'W', 'pty', ['a b']), profile('pack/nl', 'N', 'pty', ['x\n']),
      profile('pack/ok', 'K', 'pty', ['ok.tool_1+x-y'])
    ])
    expect(p.problems).toEqual([
      { kind: 'invalid-profile', profile: '#1' },
      { kind: 'invalid-profile', profile: '#2' },
      { kind: 'invalid-profile', profile: 'pack/semi' },
      { kind: 'invalid-profile', profile: 'pack/dash' },
      { kind: 'invalid-profile', profile: 'pack/space' },
      { kind: 'invalid-profile', profile: 'pack/nl' }
    ])
    expect(p.pty).toEqual(['q', 'ok.tool_1+x-y'])
  })

  describe('a snapshot it cannot use', () => {
    const base = compileClassPolicy({ pty: ['curl'] })
    const used = (raw: unknown) => compileClassPolicy({ pty: ['curl'] }, undefined, raw)

    it('is no snapshot, with one problem first, for every shape that is not version 1', () => {
      for (const text of ['{', '[]', '"x"', '7', 'false', '{"version":1}', '{"version":1,"profiles":"x","held":{}}',
        '{"version":1,"profiles":[],"held":[]}', '{"version":true,"profiles":[],"held":{}}',
        '{"version":"1","profiles":[],"held":{}}', '{"version":0,"profiles":[],"held":{}}']) {
        const p = used(parseContributed(text))
        expect(p.problems, text).toEqual([{ kind: 'invalid-snapshot', reason: 'unreadable' }])
        expect({ ...p, problems: [] }, text).toEqual({ ...base, problems: [] })
      }
      for (const text of ['{"version":2,"profiles":[],"held":{}}', '{"version":2,"profiles":"x"}', '{"version":1.5,"profiles":[],"held":{}}']) {
        expect(used(parseContributed(text)).problems, text).toEqual([{ kind: 'invalid-snapshot', reason: 'unsupported-version' }])
      }
    })

    it('version 1.0 is version 1; text null, and no file, are no snapshot and say nothing', () => {
      expect(used(parseContributed('{"version":1.0,"profiles":[],"held":{}}'))).toEqual(base)
      expect(used(parseContributed('null'))).toEqual(base)
      expect(used(null)).toEqual(base)
      expect(used(undefined)).toEqual(base)
    })

    it('puts the snapshot problem before the profile problems', () => {
      const p = compileClassPolicy({ native: 3 }, synthetic([], [], [{ mode: 'pty' }]), parseContributed('{"version":9}'))
      expect(p.problems.map((q) => q.kind)).toEqual(['invalid-snapshot', 'invalid-profile', 'invalid-overlay'])
    })

    it('drops a held value that is not a string, silently', () => {
      const p = compileClassPolicy(null, synthetic([], [], [profile('b', 'B', 'native', ['x'])]), parseContributed(
        snap([profile('a', 'A', 'pty', ['x'])], { x: 7 })))
      expect(p.problems).toEqual([{
        kind: 'conflict', command: 'x', claims: [{ profile: 'b', mode: 'native' }, { profile: 'a', mode: 'pty' }]
      }])
    })
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

  // A field that is a list with something wrong in it is not "not a list": the
  // line the operator reads says which of the two it is.
  it('{"pty": [1, "curl"]} drops the 1 and keeps curl, and says an entry was dropped, not that the field is no list', () => {
    const p = compileClassPolicy({ pty: [1, 'curl'] })
    expect(p.pty).toEqual([...defaults.pty, 'curl'])
    expect(p.problems).toEqual([{ kind: 'invalid-overlay-names', field: 'pty' }])
  })

  it('reports each bad field once, in the order native, pty, relayed', () => {
    expect(compileClassPolicy({ relayed: 1, pty: [null, 2], native: {} }).problems).toEqual([
      { kind: 'invalid-overlay', field: 'native' },
      { kind: 'invalid-overlay-names', field: 'pty' },
      { kind: 'invalid-overlay', field: 'relayed' }
    ])
  })

  it('treats anything that is not an object as no overlay, silently', () => {
    for (const value of [null, undefined, [], 'x', 7, true]) {
      expect(compileClassPolicy(value), String(value)).toEqual(defaults)
    }
  })
})
