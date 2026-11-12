// What a test file needs from the machine, said once, with a reason when it is
// missing — and a failure, not a skip, when CI has declared it present.
//
// Seventy-eight files used to guard their imports like this:
//
//   try { db = await import('../src/core/db/index'); … ; available = true }
//   catch { /* better-sqlite3 not built for this Node ABI */ }
//   describe.skipIf(!available)(…)
//
// The catch cannot tell "the native module was built for Electron" (fine on a
// laptop after electron-rebuild) from "a src module threw while loading" (the
// missing-import ReferenceError CLAUDE.md describes). Both turned the whole
// file grey, and the run stayed green. Now the file asks for the capability,
// the probe tests that capability and nothing else, and the import of the code
// under test sits outside any try:
//
//   if (requires('better-sqlite3').ok) {
//     db = await import('../src/core/db/index')
//     …
//   }
//
// When a capability is absent:
//   - locally, the file skips and prints one line saying which capability and why;
//   - in CI (REDLOG_CI_CAPABILITIES=1), test/capabilities.json says per platform
//     whether it is "required", "absent" or "unknown". A required capability
//     that is missing THROWS, so the file fails and names it. "absent" skips
//     as locally. "unknown" skips and is reported, so a first run on a new
//     image reports instead of failing.
//
// Each probe exercises the capability itself (open an in-memory database, run
// the shell), never the module under test. A probe that fails for a reason
// that is not "this machine lacks it" rethrows: that is a broken install, not
// an absent capability.
//
// test/helpers/capability-report.ts (Vitest globalSetup) prints the table of
// what each file asked for at the end of the run and, in CI, writes every
// capability's state to test-results/ for scripts/verify-skip-baseline.mjs.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

export type Capability =
  | 'better-sqlite3'
  | 'built-renderer'
  | 'built-main'
  | 'posix-shell'
  | 'bash'
  | 'zsh'
  | 'pwsh'
  | 'python-cryptography'
  | 'pty'
  | 'listen'

export const CAPABILITIES: readonly Capability[] = [
  'better-sqlite3', 'built-renderer', 'built-main', 'posix-shell', 'bash', 'zsh', 'pwsh',
  'python-cryptography', 'pty', 'listen'
]

export type Expectation = 'required' | 'absent' | 'unknown'

export interface Probe { ok: boolean; detail: string }

export interface Requirement {
  readonly ok: boolean
  /** Why it is absent; empty when present. */
  readonly reason: string
  /** `describe` when present, `describe.skip` when absent. */
  readonly describe: typeof describe
  /** `it` when present, `it.skip` when absent. */
  readonly it: typeof it
}

const ROOT = path.resolve(__dirname, '..', '..')
const nodeRequire = createRequire(__filename)

function run(cmd: string, args: string[], timeout = 15_000): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true })
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/)
  // A version is on the first line; a Python traceback's cause is on the last.
  const out = (lines[0]?.startsWith('Traceback') ? lines[lines.length - 1] : lines[0]) ?? ''
  if (r.error) return { ok: false, out: (r.error as NodeJS.ErrnoException).code ?? r.error.message }
  return { ok: r.status === 0, out: out || `exit ${r.status}` }
}

// A node child for the probes that cannot be done synchronously in-process.
function nodeChild(script: string): { ok: boolean; out: string } {
  return run(process.execPath, ['-e', script])
}

const NATIVE_ABSENT = /NODE_MODULE_VERSION|Could not locate the bindings file|Module did not self-register|was compiled against a different Node\.js version|not a valid Win32 application|invalid ELF header|mach-o|wrong architecture/i

const PROBES: Record<Capability, () => Probe> = {
  'better-sqlite3': () => {
    try {
      const Database = nodeRequire('better-sqlite3') as new (file: string) => { close(): void }
      new Database(':memory:').close()
      return { ok: true, detail: 'in-memory database opened' }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ERR_DLOPEN_FAILED' || NATIVE_ABSENT.test(err.message)) {
        return { ok: false, detail: `native binding not built for this Node (${err.message.split('\n')[0]}); \`npm test\` rebuilds it` }
      }
      throw e
    }
  },
  'built-renderer': () => {
    const missing = ['out/renderer/index.html', 'out/renderer/overlay.html', 'out/renderer/assets']
      .filter((p) => !fs.existsSync(path.join(ROOT, p)))
    return missing.length ? { ok: false, detail: `${missing.join(', ')} missing; run \`npm run build\`` } : { ok: true, detail: 'out/renderer' }
  },
  'built-main': () => fs.existsSync(path.join(ROOT, 'out/main/index.js'))
    ? { ok: true, detail: 'out/main/index.js' }
    : { ok: false, detail: 'out/main/index.js missing; run `npm run build`' },
  'posix-shell': () => {
    if (process.platform === 'win32') return { ok: false, detail: 'win32' }
    const r = run('/bin/sh', ['-c', 'exit 0'])
    return { ok: r.ok, detail: r.ok ? '/bin/sh' : r.out }
  },
  bash: () => { const r = run('bash', ['-c', 'echo "$BASH_VERSION"']); return { ok: r.ok && r.out !== '', detail: r.out } },
  zsh: () => { const r = run('zsh', ['-c', 'echo "$ZSH_VERSION"']); return { ok: r.ok && r.out !== '', detail: r.out } },
  pwsh: () => { const r = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']); return { ok: r.ok, detail: r.out } },
  'python-cryptography': () => {
    for (const py of ['python3', 'python']) {
      const r = run(py, ['-c', 'import cryptography; print(cryptography.__version__)'])
      if (r.ok) return { ok: true, detail: `${py}: cryptography ${r.out}` }
    }
    return { ok: false, detail: 'no python3/python that imports cryptography' }
  },
  // The *.pty tests drive shells through python3's pty (test/helpers/zsh-pty.py);
  // node-pty is mocked in unit tests. So: can python3 open a pseudo-terminal?
  pty: () => {
    const r = run('python3', ['-c', 'import os; m, s = os.openpty(); os.close(m); os.close(s)'])
    return { ok: r.ok, detail: r.ok ? 'python3 os.openpty()' : r.out }
  },
  listen: () => {
    const r = nodeChild(
      "const s = require('net').createServer();" +
      "s.on('error', (e) => { console.error(e.code || e.message); process.exit(3) });" +
      "s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)))"
    )
    return { ok: r.ok, detail: r.ok ? '127.0.0.1:0' : r.out }
  }
}

const cache = new Map<Capability, Probe>()

export function probe(cap: Capability): Probe {
  let p = cache.get(cap)
  if (!p) { p = PROBES[cap](); cache.set(cap, p) }
  return p
}

/** The manifest entry for this platform, or null when CI has not opted in. */
export function expectation(cap: Capability): Expectation | null {
  if (process.env.REDLOG_CI_CAPABILITIES !== '1') return null
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/capabilities.json'), 'utf8')) as Record<string, Record<string, Expectation>>
  return manifest[process.platform]?.[cap] ?? 'unknown'
}

function callerFile(): string {
  const fromVitest = expect.getState().testPath
  const file = fromVitest ?? ''
  return file ? path.relative(ROOT, file).split(path.sep).join('/') : '(unknown file)'
}

export function requires(cap: Capability): Requirement {
  const state = probe(cap)
  const want = expectation(cap)
  const file = callerFile()
  const log = process.env.REDLOG_CAPABILITY_LOG
  if (log) {
    fs.appendFileSync(path.join(log, 'records.jsonl'), JSON.stringify({ file, cap, ok: state.ok, detail: state.detail, want }) + '\n')
  }
  if (!state.ok && want === 'required') {
    throw new Error(`${file}: capability "${cap}" is required on ${process.platform} by test/capabilities.json but absent: ${state.detail}`)
  }
  if (!state.ok) {
    console.log(`[requires] ${file}: skipped — ${cap} absent: ${state.detail}${want === 'unknown' ? ' (test/capabilities.json: unknown on this platform)' : ''}`)
  }
  return {
    ok: state.ok,
    reason: state.ok ? '' : state.detail,
    describe: state.ok ? describe : (describe.skip as typeof describe),
    it: state.ok ? it : (it.skip as typeof it)
  }
}
