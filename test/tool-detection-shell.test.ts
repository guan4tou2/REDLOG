import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'
import { createToolDetector } from '../src/core/tool-detection'
import type { TerminalProfile } from '../src/core/terminal-class'
import cases from './fixtures/path-lookup-cases.json'

// #499 PR B. `redlog-relay.py detect` is the shell's half of tool detection: it
// resolves the profile executables against the PATH it was started with, which
// is the PATH the shell's commands resolve against, and writes one JSON report
// per kind of shell under ~/.redlog/tool-detection/. RedLog reads it
// (src/core/tool-detection.ts) and nothing in the shell reads it back.
//
// The lookup is a second implementation of src/core/command-lookup.ts findOnPath,
// so the two answer one shared table (test/fixtures/path-lookup-cases.json).

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }) })

const lookupNames = cases.lookups.map((c) => c.name)
// A shipped file of our own: the names under test are not any real tool's.
const SHIPPED = {
  native: [], pty: [], repl: [], replScriptFlags: [], wrappers: {},
  terminalProfiles: [
    { id: 'table', name: 'Table', mode: 'native', executables: lookupNames, reason: 'r' },
    // A profile naming anything but a bare command is not a profile at all, so
    // neither of these is looked for.
    { id: 'spaced', name: 'Spaced', mode: 'native', executables: ['has space', 'a;b'], reason: 'r' },
    { id: 'bad', name: 'Bad', mode: 'sideways', executables: ['ghost'], reason: 'r' }
  ]
}

// The temp tree the script works in, built from the shared table.
const fixtureLines = (): string[] => {
  const out: string[] = []
  for (const [dir, files] of Object.entries(cases.dirs)) {
    out.push(`mkdir -p "$T/${dir}"`)
    for (const f of files as Array<{ name: string; kind: string; target?: string }>) {
      const p = `"$T/${dir}/${f.name}"`
      if (f.kind === 'dir') out.push(`mkdir ${p}`)
      else if (f.kind === 'symlink') out.push(`ln -s "${f.target}" ${p}`)
      else out.push(`: > ${p}`, `chmod ${f.kind === 'exec' ? 755 : 644} ${p}`)
    }
  }
  out.push(`mkdir -p "$T/${cases.relative.dir}"`)
  for (const f of cases.relative.files) out.push(`: > "$T/${cases.relative.dir}/${f.name}"`, `chmod 755 "$T/${cases.relative.dir}/${f.name}"`)
  return out
}

/** The prologue every script shares: an absolute python3 pinned before PATH is
 *  changed, the three files `detect` reads beside itself, and a throwaway tree. */
const prologue = (shippedFile: unknown = SHIPPED): string[] => [
  'PY=$(command -v python3)',
  'T=$(mktemp -d -t redlog-detect.XXXXXX)',
  'trap \'rm -rf "$T"\' EXIT',
  'mkdir -p "$T/hooks" "$T/home"',
  `cp "${hookPath(target!, 'redlog-relay.py')}" "${hookPath(target!, 'terminal_app.py')}" "$T/hooks/"`,
  `cat > "$T/hooks/command-class.json" <<'JSON'\n${JSON.stringify(shippedFile)}\nJSON`,
  ...fixtureLines()
]
const DETECT = '"$PY" "$T/hooks/redlog-relay.py" detect --home "$T/home" --session s1'
const REPORTS = '"$T/home/.redlog/tool-detection"'

interface Report {
  version: number; environment: string; platform: string; wslDistro?: string; shell: string; sessionId: string
  detectedAt: number; checked: string[]; found: Record<string, string>
}
const section = (stdout: string, name: string): string => {
  const m = new RegExp(`=== ${name}\\n([\\s\\S]*?)(?=\\n=== |$)`).exec(stdout)
  return m ? m[1] : ''
}

describeShell(`redlog-relay detect (${target?.label ?? 'no shell reachable'})`, () => {
  it('finds what the shared table says, and checks exactly the valid profile executables, sorted', async () => {
    const run = await runInShell(target!, [
      ...prologue(),
      'echo "=== root"; echo "$T"',
      `cd "$T" && env -u WSL_DISTRO_NAME REDLOG_SESSION_TRACE="$T/trace" PATH="$T/first:$T/second:${cases.relative.dir}" ${DETECT} --shell zsh; echo "exit=$?"`,
      `echo "=== files"; ls -A ${REPORTS}`,
      `echo "=== report"; cat ${REPORTS}/*.json`,
      'echo; echo "=== trace"; cat "$T/trace"'
    ].join('\n'), { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('exit=0')
    const root = section(run.stdout, 'root').split('\n')[0].trim()
    const report = JSON.parse(section(run.stdout, 'report')) as Report

    expect(report.version).toBe(1)
    expect(report.environment).toBe(`shell:${report.platform}:-:zsh`)
    expect(report.shell).toBe('zsh')
    expect(report.sessionId).toBe('s1')
    expect(report).not.toHaveProperty('wslDistro')
    expect(Math.abs(report.detectedAt - Date.now())).toBeLessThan(120_000)
    expect(report.checked).toEqual([...new Set(lookupNames)].sort())
    expect(report.checked).not.toContain('has space')
    expect(report.checked).not.toContain('ghost')
    const expected = Object.fromEntries(cases.lookups.filter((c) => c.found !== null).map((c) => [c.name, `${root}/${c.found}`]))
    expect(report.found).toEqual(expected)
    expect(section(run.stdout, 'files').trim()).toBe(`shell_${report.platform}_-_zsh.json`)

    // Counts only: what was looked for, not where it was found.
    const trace = section(run.stdout, 'trace').trim().split('\n')
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatch(new RegExp(`relay detect checked=${report.checked.length} found=${Object.keys(expected).length} ms=\\d+ pid=\\d+$`))

    // What the shell wrote is what RedLog's reader accepts.
    const reportHome = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-detect-roundtrip-'))
    homes.push(reportHome)
    fs.mkdirSync(path.join(reportHome, '.redlog', 'tool-detection'), { recursive: true })
    fs.writeFileSync(path.join(reportHome, '.redlog', 'tool-detection', 'x.json'), JSON.stringify(report))
    const profile: TerminalProfile = { id: 'table', name: 'Table', mode: 'native', executables: ['exe-first', 'absent', 'plain-file'], reason: 'r' }
    const snap = await createToolDetector({ home: reportHome, platform: 'linux', env: () => ({}), profiles: () => [profile] }).snapshot()
    expect(snap.environments[0].id).toBe(report.environment)
    expect(snap.environments[0].profiles[0].executables).toEqual([
      { name: 'exe-first', state: 'found', path: `${root}/first/exe-first` },
      { name: 'absent', state: 'missing' },
      { name: 'plain-file', state: 'missing' }
    ])
  }, 90_000)

  it('also looks for the executables of a plugin\'s valid profiles, and skips an invalid one', async () => {
    const snapshot = {
      version: 1, held: {},
      profiles: [
        { id: 'acme/scanner', name: 'Acme', mode: 'pty', executables: ['exe-first', 'acme-scan'], reason: 'r' },
        { id: 'acme/broken', name: 'Broken', mode: 'pty', executables: ['acme-ok', 'not ok'], reason: 'r' }
      ]
    }
    const run = await runInShell(target!, [
      ...prologue(),
      `mkdir -p "$T/home/.redlog"`,
      `cat > "$T/home/.redlog/terminal-profiles.json" <<'JSON'\n${JSON.stringify(snapshot)}\nJSON`,
      `cd "$T" && env PATH="$T/first" ${DETECT} --shell bash; echo "exit=$?"`,
      `echo "=== report"; cat ${REPORTS}/*.json`
    ].join('\n'), { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('exit=0')
    const report = JSON.parse(section(run.stdout, 'report')) as Report
    expect(report.checked).toContain('acme-scan')
    expect(report.checked).not.toContain('acme-ok')
    expect(report.checked).not.toContain('not ok')
    expect(report.checked).toEqual([...new Set(report.checked)].sort())
  }, 90_000)

  it('names the distro and the shell it was told about, and sanitises the file name', async () => {
    const run = await runInShell(target!, [
      ...prologue(),
      `cd "$T" && env WSL_DISTRO_NAME='kali linux/x' PATH="$T/first" ${DETECT} --shell bash; echo "exit=$?"`,
      `echo "=== files"; ls -A ${REPORTS}`,
      `echo "=== report"; cat ${REPORTS}/*.json`
    ].join('\n'), { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('exit=0')
    const report = JSON.parse(section(run.stdout, 'report')) as Report
    // The id is made of characters RedLog's reader accepts; the distro as WSL spells it is kept beside it.
    expect(report.environment).toBe(`shell:${report.platform}:kali_linux_x:bash`)
    expect(report.environment).toMatch(/^shell:[A-Za-z0-9._:-]{1,160}$/)
    expect(report.wslDistro).toBe('kali linux/x')
    expect(report.shell).toBe('bash')
    expect(section(run.stdout, 'files').trim()).toBe(`shell_${report.platform}_kali_linux_x_bash.json`)
  }, 90_000)

  it('looks up at most 64 executables', async () => {
    const many = { ...SHIPPED, terminalProfiles: [{ id: 'many', name: 'Many', mode: 'native', executables: Array.from({ length: 80 }, (_, i) => `tool-${String(i).padStart(2, '0')}`), reason: 'r' }] }
    const run = await runInShell(target!, [
      ...prologue(many),
      `cd "$T" && PATH="$T/first" ${DETECT} --shell zsh`,
      `echo "=== report"; cat ${REPORTS}/*.json`
    ].join('\n'), { timeoutMs: 60_000 })
    const report = JSON.parse(section(run.stdout, 'report')) as Report
    expect(report.checked).toHaveLength(64)
    expect(report.checked[0]).toBe('tool-00')
  }, 90_000)

  it('two detects at once leave one valid report and no .part behind', async () => {
    const run = await runInShell(target!, [
      ...prologue(),
      'cd "$T"',
      `for i in 1 2 3 4 5 6 7 8; do PATH="$T/first:$T/second" ${DETECT} --shell zsh & done; wait`,
      `echo "=== files"; ls -A ${REPORTS}`,
      `echo "=== report"; cat ${REPORTS}/*.json`
    ].join('\n'), { timeoutMs: 90_000 })
    const files = section(run.stdout, 'files').trim().split('\n')
    expect(files, run.stderr.slice(0, 300)).toHaveLength(1)
    expect(files[0]).toMatch(/\.json$/)
    expect((JSON.parse(section(run.stdout, 'report')) as Report).version).toBe(1)
  }, 120_000)

  it('writes nothing, and says nothing, when it cannot write', async () => {
    const run = await runInShell(target!, [
      ...prologue(),
      '# a home that is a file, so the report directory cannot exist',
      ': > "$T/not-a-dir"',
      `PATH="$T/first" "$PY" "$T/hooks/redlog-relay.py" detect --home "$T/not-a-dir" --session s1 --shell zsh >"$T/out" 2>"$T/err"; echo "exit=$?"`,
      'echo "=== out"; cat "$T/out" "$T/err"'
    ].join('\n'), { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 300)).toContain('exit=0')
    expect(section(run.stdout, 'out').trim()).toBe('')
  }, 90_000)

  it('expands PATHEXT in Windows mode, bare name first, and gives up at its deadline', async () => {
    const run = await runInShell(target!, [
      ...prologue(),
      'mkdir "$T/win"; : > "$T/win/wsl.EXE"; : > "$T/win/plain"',
      `"$PY" - "$T/hooks/redlog-relay.py" "$T/win" <<'PY'`,
      'import importlib.util, sys, time',
      'spec = importlib.util.spec_from_file_location("relay", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'ahead = time.monotonic() + 30',
      'print("wsl", m.find_executable("wsl", [sys.argv[2]], True, [".COM", ".EXE"], ahead))',
      'print("plain", m.find_executable("plain", [sys.argv[2]], True, [".COM", ".EXE"], ahead))',
      'print("bash", m.find_executable("bash", [sys.argv[2]], True, [".COM", ".EXE"], ahead))',
      'try:',
      '    m.find_executable("wsl", [sys.argv[2]], True, [".EXE"], time.monotonic() - 1)',
      '    print("late returned")',
      'except Exception as e:',
      '    print("late", type(e).__name__)',
      'PY'
    ].join('\n'), { timeoutMs: 60_000 })
    const lines = run.stdout.split('\n')
    expect(lines.find((l) => l.startsWith('wsl '))).toMatch(/\/win\/wsl\.EXE$/)
    expect(lines.find((l) => l.startsWith('plain '))).toMatch(/\/win\/plain$/)
    expect(lines.find((l) => l.startsWith('bash '))).toBe('bash None')
    expect(lines.find((l) => l.startsWith('late'))).toBe('late DetectDeadline')
  }, 90_000)

  // A report is information about a machine. The shell's decisions about how a
  // command is recorded are made from the shipped file and the operator's
  // overlay, and a report that says every tool is missing must change none.
  it('leaves classify and the policy listing exactly as they were, with an all-missing report present', async () => {
    const relay = hookPath(target!, 'redlog-relay.py')
    const asked = (home: string): string => [
      ...['vim', 'ssh', 'claude', 'pwncat-cs', 'nmap'].map((c) => `echo "${c}=$("$PY" "${relay}" classify --home ${home} -- ${c})"`),
      `echo "pty=$("$PY" "${relay}" policy --home ${home} --field pty | tr '\\n' ' ')"`,
      `"$PY" "${relay}" policy --home ${home} --action list`
    ].join('\n')
    const run = await runInShell(target!, [
      'PY=$(command -v python3)',
      'T=$(mktemp -d -t redlog-detect-inv.XXXXXX)',
      'trap \'rm -rf "$T"\' EXIT',
      'mkdir -p "$T/clean" "$T/reported" "$T/empty"',
      '# the real shipped profiles, everything reported missing',
      `PATH="$T/empty" "$PY" "${relay}" detect --home "$T/reported" --session s1 --shell zsh`,
      `ls "$T/reported/.redlog/tool-detection" | sed 's/^/report: /'`,
      'echo "=== clean"', asked('"$T/clean"'),
      'echo "=== reported"', asked('"$T/reported"')
    ].join('\n'), { timeoutMs: 120_000 })
    const clean = section(run.stdout, 'clean').trim()
    const reported = section(run.stdout, 'reported').trim()
    expect(run.stdout, run.stderr.slice(0, 300)).toContain('report: ')
    expect(reported).toBe(clean)
    expect(clean).toContain('vim=native')
    expect(clean).toContain('ssh=pty')
    expect(clean).toContain('claude=native')
    expect(clean).toContain('pwncat-cs=pty')
    expect(clean).toContain('nmap=relayed')
  }, 180_000)
})
