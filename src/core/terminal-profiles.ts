// Tool profiles that plugins contribute (#499): the registry of what loaded
// plugins declared, the validation that decides what counts, and the one file
// the compilers read — `~/.redlog/terminal-profiles.json`.
//
// This module does not compile anything. What a profile does to a command's
// mode is `compileClassPolicy` (src/core/terminal-class.ts) and `compile_policy`
// (hooks/redlog-relay.py), which read the file this one writes next to the
// operator's overlay. The shell cannot ask the app, so the app leaves it a file.
//
// The file records two things: the plugins' profiles, and `held`, the profile
// that had each command the last time it was written. `held` is how "the claim
// in effect stays" survives a restart: a plugin installed later cannot take a
// command from the tool that already had it, whichever order they load in.

import fs from 'fs'
import os from 'os'
import path from 'path'
import policy from '../../hooks/command-class.json'
import {
  compileClassPolicy, normalizeContributed, EXECUTABLE, CLASS_FILE_MAX_BYTES, parseClassFile,
  type CommandClass, type CompiledClassPolicy, type TerminalProfile
} from './terminal-class'
import type { RuleRejection } from './loot-detector'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Names a plugin may not claim, in any mode: the ones the shell adapter runs
 *  itself. The adapter's own functions (the PTY wrapper, the class lookup) run
 *  in the operator's shell, where a profile naming one of these would make the
 *  adapter's call land in the wrapper — `python3` would wrap the python3 that
 *  classifies the next command.
 *
 *  Derived, so re-derive it when an adapter calls a new external: the wrapper
 *  and REPL tables come from `hooks/command-class.json`, the rest from reading
 *  `hooks/shell-common.sh`, `hooks/shell-zsh-hook.zsh` and
 *  `hooks/shell-bash-hook.sh` for every command they run that is not one of
 *  their own functions. */
export const ADAPTER_RESERVED: ReadonlySet<string> = new Set([
  // Wrappers and REPLs: `sudo`, `env`, `proxychains`, and the interpreters the
  // relay and the helper themselves are run with.
  ...Object.keys(policy.wrappers),
  ...policy.repl,
  // Externals the adapters run in the shell's own function context.
  'redlog', 'curl', 'rm', 'mv', 'mkdir', 'mktemp', 'cat', 'date', 'grep', 'awk', 'tr', 'find', 'wc', 'ps',
  'dirname', 'sleep', 'wslpath', 'cmd.exe', 'ip', 'id', 'mkfifo',
  // Builtins with an external twin, or that the adapters call by name.
  'echo', 'printf', 'print', 'kill', 'test', 'true', 'false', 'pwd', 'read', 'command', 'builtin', 'exec',
  'export', 'local', 'return', 'trap', 'unset', 'whence', 'type', 'cd'
])

const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_PROFILES = 32
const MAX_EXECUTABLES = 16

/** The mode a shipped native or pty default list gives a command, if any; pty
 *  over native, as the compiler has it. */
function shippedDefaultMode(command: string): CommandClass | null {
  if (policy.pty.includes(command)) return 'pty'
  if (policy.native.includes(command)) return 'native'
  return null
}

const MODES: readonly string[] = ['native', 'pty', 'relayed']

/** What a printed name must not contain: C0 controls, DEL, C1 controls, the
 *  Unicode line and paragraph separators, and a lone surrogate. The last is
 *  not text at all: it has no UTF-8 form, so Python's stdout raises on it and
 *  `redlog class list` stops mid-line. hooks/redlog-relay.py `display_name`
 *  keeps the same rule for a snapshot someone edited by hand. */
// eslint-disable-next-line no-control-regex
const NOT_A_PLAIN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Why a profile a plugin declared is unusable, or null when it is usable. */
function rejection(raw: unknown, seen: Set<string>): string | null {
  if (!isRecord(raw)) return 'not an object'
  if (typeof raw.id !== 'string' || !LOCAL_ID.test(raw.id)) return 'id must be lowercase letters, digits and hyphens'
  if (seen.has(raw.id)) return 'duplicate id'
  const name = raw.name
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || name.includes(':')
    || NOT_A_PLAIN_LINE.test(name)) return 'name must be one short line with no colon'
  if (typeof raw.mode !== 'string' || !MODES.includes(raw.mode)) return 'mode must be native, pty or relayed'
  const exes = raw.executables
  if (!Array.isArray(exes) || exes.length < 1 || exes.length > MAX_EXECUTABLES
    || !exes.every((e) => typeof e === 'string' && EXECUTABLE.test(e))
    || new Set(exes).size !== exes.length) return 'executables must be bare command names'
  for (const exe of exes as string[]) {
    if (ADAPTER_RESERVED.has(exe)) return `${exe} is used by RedLog's shell adapter`
  }
  // The shipped native and pty lists are a floor: a plugin may repeat one in
  // the mode it already has, and may not change it. Changing a default is the
  // operator's call, through `redlog class add`.
  for (const exe of exes as string[]) {
    const has = shippedDefaultMode(exe)
    if (has !== null && has !== raw.mode) return `${exe} is a shipped ${has} default; change it with redlog class add`
  }
  if (typeof raw.reason !== 'string' || raw.reason.length < 1 || raw.reason.length > 200) return 'reason is required'
  return null
}

// plugin id -> its accepted profiles, ids already namespaced. A module Map, as
// the loot patterns are: `applyContributions` fills it, `removeContributions`
// empties it, and nothing reaches the compilers until `syncTerminalProfiles`.
const registry = new Map<string, TerminalProfile[]>()

/** What a plugin's declared profiles come to, without registering anything: the
 *  ones that would take effect and the ones refused, by name. A bad entry is
 *  dropped whole; the rest stand. The effective id is `<pluginId>/<localId>`, so
 *  two plugins can never collide on an id and a profile always says whose it is.
 *  The consent dialog reads this too, so what the operator is shown is what the
 *  registrar would accept. */
export function checkTerminalProfiles(
  pluginId: string,
  raw: unknown
): { accepted: TerminalProfile[]; rejected: RuleRejection[] } {
  const list = Array.isArray(raw) ? raw : []
  const rejected: RuleRejection[] = []
  const accepted: TerminalProfile[] = []
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    const local = isRecord(entry) && typeof entry.id === 'string' && entry.id !== '' ? entry.id.slice(0, 64) : `#${index}`
    if (index >= MAX_PROFILES) { rejected.push({ name: local, reason: 'too many profiles' }); return }
    const why = rejection(entry, seen)
    if (why !== null) { rejected.push({ name: local, reason: why }); return }
    const p = entry as Record<string, unknown>
    seen.add(p.id as string)
    accepted.push({
      id: `${pluginId}/${p.id as string}`,
      name: p.name as string,
      mode: p.mode as CommandClass,
      executables: [...(p.executables as string[])],
      reason: p.reason as string
    })
  })
  return { accepted, rejected }
}

/** Register a plugin's profiles: what `checkTerminalProfiles` accepts. */
export function registerTerminalProfiles(
  pluginId: string,
  raw: unknown
): { accepted: number; rejected: RuleRejection[] } {
  const r = checkTerminalProfiles(pluginId, raw)
  registry.set(pluginId, r.accepted)
  return { accepted: r.accepted.length, rejected: r.rejected }
}

export function unregisterTerminalProfiles(pluginId: string): void {
  registry.delete(pluginId)
}

const snapshotPath = (home: string): string => path.join(home, '.redlog', 'terminal-profiles.json')

/** The snapshot as parsed: null when there is no file (or it says `null`),
 *  false when it exists and cannot be read or parsed, else what it parsed to.
 *  Not validated: `compileClassPolicy` decides what in it counts. */
export function readContributedProfiles(home: string = os.homedir()): unknown {
  let bytes: Buffer
  try {
    const target = snapshotPath(home)
    // Over the cap it is not read at all: RedLog writes this file and it is a
    // few KB. The shell's reader draws the same line (`read_json_capped`).
    if (fs.statSync(target).size > CLASS_FILE_MAX_BYTES) return false
    bytes = fs.readFileSync(target)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
  try {
    return parseClassFile(bytes)
  } catch {
    return false
  }
}

/** The profile that wins each command it wins, sorted by command. */
function heldOf(p: CompiledClassPolicy): Record<string, string> {
  return Object.fromEntries(
    p.entries.filter((e) => e.source === 'profile').map((e) => [e.command, e.profile as string])
  )
}

// Atomics.wait is allowed on the main thread of a Node process, which is what
// the Electron main process and the vitest worker both are (it is only the
// browser's main thread and a renderer that refuse it). So the wait is a real
// sleep, with no busy loop; if some host did refuse it, it would throw out of
// retryBusy into the callers' catch, and the write is reported as not done.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Run a file operation, trying it again a few times when Windows says the file
 *  is busy. A rename or an unlink onto a file another process holds open (the
 *  relay under WSL, an antivirus scan) fails with EPERM, EBUSY or EACCES for a
 *  moment. Any other error, and the last of these, is thrown. */
function retryBusy(op: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      op()
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      sleepSync(25 * (attempt + 1))
    }
  }
}

/** Whole or not at all, as `writeTerminalEnrollment` does it: the reader is a
 *  prompt hook that cannot wait. If the rename still fails after the retries the
 *  old file stays, which is a stale answer and not a wrong one. */
function replaceFile(target: string, body: string): string | undefined {
  const tmp = `${target}.part`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    retryBusy(() => fs.renameSync(tmp, target))
    return undefined
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* a leftover .part is overwritten next time */ }
    return (e as Error).message
  }
}

/** Write `~/.redlog/terminal-profiles.json` from what the loaded plugins
 *  declared. Called once per `initPlugins()`, which is every path by which a
 *  plugin appears, disappears, is enabled or is disabled.
 *
 *  No plugin profile means no file, and a file that was there is removed: the
 *  compilers then read nothing and the shipped layering is all there is.
 *
 *  `held` is the part with a memory. The previous file's holders are the
 *  incumbents, so what each command resolves to now is compiled with them and
 *  the winners are recorded as the next file's holders. With no readable
 *  previous file the bundled tools are the incumbents, the same answer the
 *  shell gets from the shipped file alone. The overlay is left out on purpose:
 *  it overrides at read time, and a command the operator moved is still held
 *  by whichever tool had it. */
export function syncTerminalProfiles(home: string = os.homedir()): { written: boolean; error?: string } {
  const target = snapshotPath(home)
  const profiles = [...registry.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap((pluginId) => registry.get(pluginId) ?? [])
  if (profiles.length === 0) {
    try {
      retryBusy(() => fs.unlinkSync(target))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { written: false, error: (e as Error).message }
    }
    return { written: false }
  }

  const raw = readContributedProfiles(home)
  const previous = normalizeContributed(raw)
  const readable = raw !== null && previous.problems.length === 0
  const priorHeld = readable ? Object.fromEntries(previous.held) : heldOf(compileClassPolicy(null))
  const held = heldOf(compileClassPolicy(null, undefined, { version: 1, profiles, held: priorHeld }))

  const body = JSON.stringify({ version: 1, profiles, held }, null, 2) + '\n'
  let existing: string | null = null
  try { existing = fs.readFileSync(target, 'utf8') } catch { /* no file, or one we cannot read: write it */ }
  if (existing === body) return { written: false }

  const error = replaceFile(target, body)
  return error === undefined ? { written: true } : { written: false, error }
}
