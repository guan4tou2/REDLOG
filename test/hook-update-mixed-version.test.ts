import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileClassPolicy, type ShippedClassPolicy } from '../src/core/terminal-class'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'
import shipped from '../hooks/command-class.json'
import golden from './fixtures/command-class-golden.json'

// The hook support files are copied one at a time, and anything can stop the
// copy between two of them: a write that fails, a crash, an older RedLog
// installing over a newer one, a WSL or Kali copy updated by hand. What an
// enrolled shell then runs is a relay from one release reading a policy from
// another.
//
// #513 moved vim, ssh, pwncat-cs, claude and codex out of the flat `native` and
// `pty` lists and into `terminalProfiles`. A relay from before that reads only
// the flat lists, so it classified them `relayed` as soon as it met the new
// file. These tests hold the class of every shipped name to one answer across
// every pairing of the two releases and across a write that fails at each file.

const WSL_OR_LINUX = findShellTarget()
const describeShell = WSL_OR_LINUX ? describe : describe.skip
const target = WSL_OR_LINUX as ShellTarget

const HOOKS = path.resolve(__dirname, '..', 'hooks')
// hooks/redlog-relay.py and hooks/command-class.json exactly as they were at
// 381031da, the commit before #513 merged (identical at 51662f20, the last one
// to touch either). Verbatim: `git show 381031da:hooks/<name> | cmp - <copy>`.
// hooks/terminal_app.py, which the relay imports, did not change in between.
const BEFORE = path.join(__dirname, 'fixtures', 'hooks-before-profiles')

type Mode = 'native' | 'pty'

// What every one of these has been, in every release that has had it. It is
// written out, not computed from a file, so that a file cannot agree with
// itself about a wrong answer.
const EXPECTED: Record<string, Mode> = {
  nc: 'native', ncat: 'native', stty: 'native', nvim: 'native', nano: 'native',
  emacs: 'native', less: 'native', more: 'native',
  vim: 'native', vi: 'native', claude: 'native', codex: 'native',
  socat: 'pty', ssh: 'pty', 'pwncat-cs': 'pty'
}

interface PolicyFile { native: string[]; pty: string[]; terminalProfiles?: Array<{ mode: string; executables: string[] }> }
const before = JSON.parse(fs.readFileSync(path.join(BEFORE, 'command-class.json'), 'utf8')) as PolicyFile
const profileExecutables = (shipped.terminalProfiles as NonNullable<PolicyFile['terminalProfiles']>).flatMap((p) => p.executables)
const shippedNames = [...new Set([...shipped.native, ...shipped.pty, ...profileExecutables])]

describe('the names this contract covers', () => {
  it('are what the release before tool profiles shipped, in the modes it shipped them', () => {
    const was: Record<string, Mode> = {}
    for (const c of before.native) was[c] = 'native'
    for (const c of before.pty) was[c] = 'pty'
    expect(was).toEqual(EXPECTED)
  })

  it('are every name the shipped policy mentions, so a new one has to be decided here', () => {
    expect([...shippedNames].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  // The one rule that makes a mixed install safe. A relay from before tool
  // profiles reads these two lists and nothing else, so a tool that is only in
  // a profile is relayed by it. Listing it here as well, in the mode its
  // profile gives it, is what an old relay needs and costs a new one nothing.
  it('list every profile executable in the default list of the mode its profile gives it', () => {
    for (const profile of shipped.terminalProfiles) {
      for (const e of profile.executables) {
        const home = profile.mode === 'native' ? shipped.native : shipped.pty
        const other = profile.mode === 'native' ? shipped.pty : shipped.native
        expect(home, `${e} (${profile.mode}) is missing from the default list a relay without profiles reads`).toContain(e)
        expect(other, `${e} is in the default list of the other mode`).not.toContain(e)
      }
    }
  })

  // Not a behaviour change for the compiler: the same overlays, over the shipped
  // file with and without the duplicates, give the same entries, problems and
  // lists (as sets: only the order of a list can differ, and only when an
  // overlay moves a command from one list to the other).
  it('compile to the same policy with or without the profile executables in the default lists', () => {
    const bare: ShippedClassPolicy = {
      ...(shipped as ShippedClassPolicy),
      native: shipped.native.filter((c) => !profileExecutables.includes(c)),
      pty: shipped.pty.filter((c) => !profileExecutables.includes(c))
    }
    const overlays = [null, ...golden.cases.map((c) => { try { return JSON.parse(c.file ?? 'null') } catch { return null } })]
    for (const overlay of overlays) {
      const a = compileClassPolicy(overlay, bare)
      const b = compileClassPolicy(overlay, shipped as ShippedClassPolicy)
      expect(b.entries, JSON.stringify(overlay)).toEqual(a.entries)
      expect(b.problems, JSON.stringify(overlay)).toEqual(a.problems)
      expect([...b.native].sort(), JSON.stringify(overlay)).toEqual([...a.native].sort())
      expect([...b.pty].sort(), JSON.stringify(overlay)).toEqual([...a.pty].sort())
    }
    // With no overlay the order is the same too, which is what Settings and
    // `redlog class list` print.
    expect(compileClassPolicy(null, shipped as ShippedClassPolicy).native).toEqual(compileClassPolicy(null, bare).native)
    expect(compileClassPolicy(null, shipped as ShippedClassPolicy).pty).toEqual(compileClassPolicy(null, bare).pty)
  })
})

// Each shape a command can reach the classifier in: bare, behind a wrapper, and
// by absolute path. The wrapper table is in the same file as the lists.
const PROBES: string[][] = shippedNames.flatMap((n) => [[n], ['sudo', n], [`/usr/bin/${n}`]])
const wanted = (argv: string[]): Mode => EXPECTED[path.posix.basename(argv[argv.length - 1])]

interface Answer { modes: Record<string, string>; native: string[]; pty: string[] }

/** What each directory's relay says about every probe, in one python process. */
async function ask(sets: Array<{ id: string; dir: string }>): Promise<Record<string, Answer>> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-modes-'))
  try {
    const input = path.join(tmp, 'input.json')
    fs.writeFileSync(input, JSON.stringify({
      sets: sets.map((s) => ({ id: s.id, dir: target.toShellPath(s.dir) })),
      probes: PROBES
    }))
    const driver = target.toShellPath(path.join(__dirname, 'helpers', 'class-modes-driver.py'))
    const run = await runInShell(target, `python3 "${driver}" "${target.toShellPath(input)}"`, { timeoutMs: 240_000 })
    expect(run.status, run.stderr.slice(0, 600)).toBe(0)
    return JSON.parse(run.stdout) as Record<string, Answer>
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function expectUnchanged(answer: Answer, label: string): void {
  for (const argv of PROBES) {
    expect(answer.modes[argv.join(' ')], `${label}: ${argv.join(' ')}`).toBe(wanted(argv))
  }
  // What the zsh adapter wraps at startup is the pty list `policy --field`
  // prints, so a tool missing from it never gets its PTY.
  for (const [name, mode] of Object.entries(EXPECTED)) {
    expect(mode === 'pty' ? answer.pty : answer.native, `${label}: ${name} is not in the ${mode} list`).toContain(name)
  }
}

// relay, then policy: the two files that decide a class.
const RELAYS = { old: path.join(BEFORE, 'redlog-relay.py'), new: path.join(HOOKS, 'redlog-relay.py') }
const POLICIES = { old: path.join(BEFORE, 'command-class.json'), new: path.join(HOOKS, 'command-class.json') }

function stage(root: string, relay: keyof typeof RELAYS, policy: keyof typeof POLICIES): string {
  const dir = path.join(root, `${relay}-relay-${policy}-json`)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(RELAYS[relay], path.join(dir, 'redlog-relay.py'))
  fs.copyFileSync(POLICIES[policy], path.join(dir, 'command-class.json'))
  fs.copyFileSync(path.join(HOOKS, 'terminal_app.py'), path.join(dir, 'terminal_app.py'))
  return dir
}

describeShell(`every pairing of the two releases (${target?.label ?? 'no shell reachable'})`, () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pairs-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const PAIRS: Array<[keyof typeof RELAYS, keyof typeof POLICIES, string]> = [
    ['old', 'old', 'a complete older install'],
    ['new', 'new', 'a complete current install'],
    ['old', 'new', 'the policy landed and the relay did not'],
    ['new', 'old', 'the relay landed and the policy did not']
  ]

  for (const [relay, policy, what] of PAIRS) {
    it(`${relay} relay + ${policy} policy (${what}): every shipped name keeps its class`, async () => {
      const dir = stage(root, relay, policy)
      const answers = await ask([{ id: 'set', dir }])
      expectUnchanged(answers.set, `${relay} relay + ${policy} policy`)
    }, 300_000)
  }

  // The same four, through the commands the adapters actually run, because the
  // functions the driver calls are a claim about what those commands do.
  it('answers the same through `classify` and `policy --field`', async () => {
    const lines: string[] = ['H=$(mktemp -d -t redlog-pairs-home.XXXXXX)', 'trap \'rm -rf "$H"\' EXIT']
    for (const [relay, policy] of [['old', 'old'], ['new', 'new'], ['old', 'new'], ['new', 'old']] as const) {
      const r = target.toShellPath(path.join(stage(root, relay, policy), 'redlog-relay.py'))
      for (const name of ['vim', 'ssh', 'claude']) {
        lines.push(`printf '%s %s %s\\t' ${relay} ${policy} ${name}; python3 "${r}" classify --home "$H" -- ${name}; printf '\\n'`)
      }
      lines.push(`printf '%s %s pty-field\\t' ${relay} ${policy}; python3 "${r}" policy --home "$H" --field pty | tr '\\n' ' '; printf '\\n'`)
    }
    const run = await runInShell(target, lines.join('\n'), { timeoutMs: 240_000 })
    const said = new Map(run.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t') as [string, string]))
    for (const [relay, policy] of [['old', 'old'], ['new', 'new'], ['old', 'new'], ['new', 'old']]) {
      expect(said.get(`${relay} ${policy} vim`), run.stderr.slice(0, 400)).toBe('native')
      expect(said.get(`${relay} ${policy} claude`)).toBe('native')
      expect(said.get(`${relay} ${policy} ssh`)).toBe('pty')
      expect((said.get(`${relay} ${policy} pty-field`) ?? '').trim().split(/\s+/).sort(), `${relay} relay + ${policy} policy`)
        .toEqual(Object.entries(EXPECTED).filter(([, m]) => m === 'pty').map(([n]) => n).sort())
    }
  }, 300_000)
})

// ---------------------------------------------------------------------------
// The installer. Both writers copy the plan one file at a time, and one of them
// (refreshInstalledHooks) carries on after a failure, so a file that cannot be
// written is the way a real install ends up with a mixed set.

const fail = vi.hoisted(() => ({ name: '' }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  // Only a write into ~/.redlog, and only of the one file named: the test's own
  // setup writes the same names into the same place before it arms this.
  const guard = <A extends unknown[], R>(destination: (args: A) => unknown, fn: (...args: A) => R) => (...args: A): R => {
    const to = String(destination(args)).replace(/\\/g, '/')
    if (fail.name && to.endsWith(`/.redlog/${fail.name}`)) throw new Error(`EIO: simulated failure writing ${fail.name}`)
    return fn(...args)
  }
  return {
    ...actual,
    writeFileSync: guard((a) => a[0], actual.writeFileSync as (...args: unknown[]) => void),
    copyFileSync: guard((a) => a[1], actual.copyFileSync as (...args: unknown[]) => void)
  }
})

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const PLAN_FILES = ['shell-bash-hook.sh', 'shell-common.sh', 'redlog-session.py', 'redlog-relay.py', 'terminal_app.py', 'command-class.json']

describeShell(`an update that stops part-way (${target?.label ?? 'no shell reachable'})`, () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-partial-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    // A shell that is enrolled and runs the previous release's files.
    fs.writeFileSync(path.join(home, '.bashrc'), 'source ~/.redlog/shell-bash-hook.sh\n')
    const dir = path.join(home, '.redlog')
    fs.mkdirSync(dir)
    for (const f of PLAN_FILES) fs.writeFileSync(path.join(dir, f), `# previous release: ${f}\n`)
    fs.copyFileSync(RELAYS.old, path.join(dir, 'redlog-relay.py'))
    fs.copyFileSync(POLICIES.old, path.join(dir, 'command-class.json'))
    fs.copyFileSync(path.join(HOOKS, 'terminal_app.py'), path.join(dir, 'terminal_app.py'))
  })
  afterEach(() => {
    fail.name = ''
    process.env.HOME = saved.HOME
    process.env.USERPROFILE = saved.USERPROFILE
    fs.rmSync(home, { recursive: true, force: true })
  })

  const load = async (): Promise<typeof import('../src/core/hooks-manager')> => {
    vi.resetModules()
    return import('../src/core/hooks-manager')
  }
  const installed = (file: string): string => fs.readFileSync(path.join(home, '.redlog', file), 'utf8')
  const bundled = (file: string): string => fs.readFileSync(path.join(HOOKS, file), 'utf8')

  // The app refreshes the files it shipped over an enrolled copy at start-up,
  // and carries on after a file it could not write. terminal_app.py is not
  // here: the copy is already current, so there is no write to fail.
  for (const failing of PLAN_FILES.filter((f) => f !== 'terminal_app.py')) {
    it(`refresh: ${failing} cannot be written, the others are`, async () => {
      const { refreshInstalledHooks } = await load()
      fail.name = failing
      refreshInstalledHooks()
      fail.name = ''
      // The scenario is what it says: the one file is still the previous
      // release's, and every other one moved on.
      expect(installed(failing), `${failing} was written after all`).not.toBe(bundled(failing))
      for (const other of PLAN_FILES.filter((f) => f !== failing)) {
        expect(installed(other), `${other} did not land`).toBe(bundled(other))
      }

      const answers = await ask([{ id: 'set', dir: path.join(home, '.redlog') }])
      expectUnchanged(answers.set, `refresh with ${failing} failing`)
    }, 300_000)
  }

  // One-click install. It stops at the first file it cannot write, and
  // refuses outright on Windows, so it is exercised where it runs.
  for (const failing of PLAN_FILES) {
    it.skipIf(process.platform === 'win32')(`install: stops at ${failing}`, async () => {
      fs.rmSync(path.join(home, '.bashrc'))
      const { installHook } = await load()
      fail.name = failing
      installHook('shell-bash')
      fail.name = ''
      const answers = await ask([{ id: 'set', dir: path.join(home, '.redlog') }])
      expectUnchanged(answers.set, `install with ${failing} failing`)
    }, 300_000)
  }
})
