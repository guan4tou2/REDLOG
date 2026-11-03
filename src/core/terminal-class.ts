// What happens to a command before it runs: relay its output, give it a PTY,
// or leave it completely alone. Spec 052, research.md D3.
//
// This is a product decision wearing a function's clothes. A PTY-captured
// command cannot be locally suspended, so putting `nc` in the `pty` class
// would silently break the Ctrl-Z / `stty raw -echo` / `fg` upgrade in the
// middle of an engagement (FR-025); relaying `vim` would fill the evidence
// with cursor movements and record none of the file (FR-026). The lists are
// the policy, and they are the operator's to edit.
//
// Pure, and over argv only. Nothing here reads a command's output — that is
// attacker-controlled (FR-002) — and nothing depends on the machine it runs
// on, so RedLog and the shell adapter can reach the same verdict.

import policy from '../../hooks/command-class.json'

export type CommandClass = 'relayed' | 'pty' | 'native'

// The names live in `hooks/command-class.json`, beside the adapter that also
// reads them (through `hooks/redlog-relay.py`). One file, two readers. A
// second copy of these names here would drift from the shell's, and the drift
// would be silent until the day an operator's reverse shell went through a
// relay mid-engagement — which is the failure the list exists to prevent.
const REPL = new Set(policy.repl)
const REPL_SCRIPT_FLAGS = new Set(policy.replScriptFlags)
const WRAPPERS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(policy.wrappers).map(([name, flags]) => [name, new Set(flags)])
)

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const MODES: readonly CommandClass[] = ['native', 'pty', 'relayed']

/** Where a command's mode came from: the operator's overlay, a tool profile,
 *  the shipped native/pty lists, or nothing naming it (relayed). */
export type PolicySource = 'override' | 'profile' | 'default' | 'fallback'

/** A tool, the executables that run it, and the mode it gets. */
export interface TerminalProfile {
  id: string
  name: string
  mode: CommandClass
  executables: string[]
  reason: string
}

export interface PolicyEntry {
  command: string
  mode: CommandClass
  source: PolicySource
  /** The profile's id, only when `source` is `profile`. */
  profile?: string
}

export type PolicyProblem =
  /** `~/.redlog/terminal-profiles.json` is not usable, so no plugin profile applies. */
  | { kind: 'invalid-snapshot'; reason: 'unreadable' | 'unsupported-version' }
  /** A profile that is not usable and was skipped. `profile` is its id, or `#<index>`
   *  counted across the shipped profiles and then the plugins'. */
  | { kind: 'invalid-profile'; profile: string }
  /** Profiles naming one executable in different modes. Without `kept` the layer
   *  below keeps it; with it, `kept` is the profile that had the command and still does. */
  | { kind: 'conflict'; command: string; claims: Array<{ profile: string; mode: CommandClass }>; kept?: string }
  /** An overlay field that is not a list at all, and is ignored whole. */
  | { kind: 'invalid-overlay'; field: CommandClass }
  /** An overlay field that is a list but holds an entry that is not a bare
   *  command name, which was dropped; the rest of the list stands. */
  | { kind: 'invalid-overlay-names'; field: CommandClass }

export interface CompiledClassPolicy {
  native: string[]
  pty: string[]
  entries: PolicyEntry[]
  problems: PolicyProblem[]
}

/** The part of `hooks/command-class.json` the compiler reads. Profiles are
 *  `unknown` because the compiler is what decides whether one is valid. */
export interface ShippedClassPolicy {
  native: string[]
  pty: string[]
  terminalProfiles: unknown[]
}

// The JSON import types a profile's mode as `string`, so this is a cast; the
// contract test in test/command-class.test.ts is what holds the file to it.
const SHIPPED = policy as ShippedClassPolicy

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const byCommand = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The most ~/.redlog/command-class.json or ~/.redlog/terminal-profiles.json
 *  may hold for the policy to read it. RedLog writes both and they are a few KB;
 *  a bigger one was not written by it and is read as not readable. Mirrored by
 *  MAX_CLASS_FILE_BYTES in `hooks/redlog-relay.py`. */
export const CLASS_FILE_MAX_BYTES = 1024 * 1024

/** How deep either file may nest. RedLog's own are four levels deep (snapshot,
 *  profiles, a profile, its executables). V8 parses any depth, Python's parser
 *  gives up near a thousand with RecursionError, so an explicit cap is what
 *  makes "too deep" one answer on both sides. Mirrored by
 *  MAX_CLASS_JSON_DEPTH in `hooks/redlog-relay.py`. */
export const CLASS_FILE_MAX_DEPTH = 32

/** Whether a parsed value nests deeper than `max` containers. Iterative: the
 *  point is to answer for a value too deep to recurse into. */
function nestsDeeperThan(value: unknown, max: number = CLASS_FILE_MAX_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [v, depth] = item
    if (typeof v !== 'object' || v === null) continue
    if (depth > max) return true
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1])
  }
  return false
}

// Strict, and with the byte order mark left in so that JSON refuses it: the
// default decoder replaces a byte that is not UTF-8 with U+FFFD and drops a BOM,
// so a file the shell's parser calls unreadable would be a readable one here.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** What a file under ~/.redlog that the policy reads parses to. Throws when it
 *  cannot be used: not UTF-8 (a byte order mark included), not JSON (NaN and
 *  Infinity included), or nested past `CLASS_FILE_MAX_DEPTH`. The size cap is
 *  the reader's, since it stops a file being read at all. Mirrors
 *  `read_json_capped` in `hooks/redlog-relay.py`. */
export function parseClassFile(bytes: Uint8Array): unknown {
  const parsed: unknown = JSON.parse(STRICT_UTF8.decode(bytes))
  if (nestsDeeperThan(parsed)) throw new Error('nested too deeply')
  return parsed
}

/** The operator's overlay as lists, plus what was wrong with it. Anything
 *  that is not an object is no overlay; unknown keys, the retired `removed`
 *  included, are ignored. A field that is not a list is ignored whole and an
 *  entry that is not a bare command name is dropped; each is recorded once, per
 *  field, as its own kind, in the order native, pty, relayed. Mirrors
 *  `normalize_overlay` in
 *  `hooks/redlog-relay.py`. */
function normalizeOverlay(raw: unknown): { lists: Record<CommandClass, string[]>; problems: PolicyProblem[] } {
  const lists: Record<CommandClass, string[]> = { native: [], pty: [], relayed: [] }
  const problems: PolicyProblem[] = []
  if (!isRecord(raw)) return { lists, problems }
  for (const field of MODES) {
    if (!hasOwn(raw, field)) continue
    const value = raw[field]
    if (!Array.isArray(value)) { problems.push({ kind: 'invalid-overlay', field }); continue }
    // A bare command name only, as an executable of a profile is: the zsh
    // adapter pastes the pty list into the source of a wrapper function.
    const kept = value.filter((c): c is string => typeof c === 'string' && EXECUTABLE.test(c))
    if (kept.length !== value.length) problems.push({ kind: 'invalid-overlay-names', field })
    lists[field] = kept
  }
  return { lists, problems }
}

/** A bare command name. This is a security bound, not tidiness: the shell
 *  adapter pastes each `pty` executable into the source of a wrapper function,
 *  so a name with a `;`, a space or a newline in it would be shell code.
 *  Mirrored by EXECUTABLE in `hooks/redlog-relay.py`. */
export const EXECUTABLE =/^[A-Za-z0-9_][A-Za-z0-9._+-]{0,63}$/

/** A profile id: lowercase words, optionally `<plugin>/<id>`, at most 129
 *  characters (a 64-character plugin id, the slash, a 64-character local id).
 *  An id is printed by `redlog class list`, so what is not this shape is never
 *  shown, only counted by position. Mirrored by PROFILE_ID in
 *  `hooks/redlog-relay.py`; the bundled ids (`vim`, `claude-code`, ...) and the
 *  plugins' (`<plugin>/<id>`) both fit. */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/
const PROFILE_ID_MAX = 129

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= PROFILE_ID_MAX && PROFILE_ID.test(id)
}

function validProfile(p: unknown): p is TerminalProfile {
  return isRecord(p)
    && validId(p.id)
    && MODES.includes(p.mode as CommandClass)
    && Array.isArray(p.executables)
    && p.executables.length > 0
    && p.executables.every((c) => typeof c === 'string' && EXECUTABLE.test(c))
}

/** What `~/.redlog/terminal-profiles.json` adds to the compiler: the plugins'
 *  profiles, and `held`, the profile that had each command when the file was
 *  last written. */
export interface ContributedProfiles {
  profiles: unknown[]
  held: Map<string, string>
  problems: PolicyProblem[]
}

/** The snapshot as the compiler reads it. `null` is no file (and a file that
 *  says `null`): nothing, silently. Anything that is not a version-1 object
 *  with a list of profiles and an object of held is no snapshot at all, and
 *  one problem says why; a version above 1 is a file a newer RedLog wrote.
 *  A `held` value that is not a string is dropped, and each profile is passed
 *  through for `validProfile` to judge. Mirrors `normalize_contributed` in
 *  `hooks/redlog-relay.py`. */
export function normalizeContributed(raw: unknown): ContributedProfiles {
  const empty = (reason: 'unreadable' | 'unsupported-version'): ContributedProfiles =>
    ({ profiles: [], held: new Map(), problems: [{ kind: 'invalid-snapshot', reason }] })
  if (raw === null || raw === undefined) return { profiles: [], held: new Map(), problems: [] }
  if (!isRecord(raw)) return empty('unreadable')
  if (typeof raw.version === 'number' && raw.version > 1) return empty('unsupported-version')
  if (typeof raw.version !== 'number' || raw.version !== 1) return empty('unreadable')
  if (!Array.isArray(raw.profiles) || !isRecord(raw.held)) return empty('unreadable')
  const held = new Map<string, string>()
  for (const [command, profile] of Object.entries(raw.held)) {
    if (typeof profile === 'string') held.set(command, profile)
  }
  return { profiles: raw.profiles, held, problems: [] }
}

/** The tool profiles the compiler accepts, in the order it reads them: the
 *  shipped ones, then the plugins' from `contributed`. Tool detection joins its
 *  findings to these, so a plugin's tool is looked for the way a shipped one
 *  is; it never feeds them back. The compiler and this read the same two
 *  lists, and the detection test holds them to one set of ids. */
export function knownProfiles(
  shipped: ShippedClassPolicy = SHIPPED,
  contributed: unknown = null
): TerminalProfile[] {
  return [...(shipped.terminalProfiles ?? []), ...normalizeContributed(contributed).profiles].filter(validProfile)
}

/** The shipped policy with the operator's overlay on top, layered.
 *
 *  The highest layer that names a command decides its mode: the operator's
 *  overlay, then the tool profiles, then the shipped native and pty lists;
 *  a command no layer names is relayed. Two profiles that claim one
 *  executable in different modes cancel out, so the layer below keeps it and
 *  the clash is reported as a problem.
 *
 *  `contributed` is the plugins' snapshot (`~/.redlog/terminal-profiles.json`,
 *  see `src/core/terminal-profiles.ts`): its profiles join the profile layer
 *  after the shipped ones, and its `held` map is the one thing that changes
 *  the rule above. When profiles disagree on a command and one of them is the
 *  recorded holder, the holder keeps it and the clash is still reported, with
 *  `kept` naming it: the claim in effect stays, so a plugin installed later
 *  cannot take a command from the tool that already had it. With no snapshot
 *  nothing holds anything and this is exactly the layering above.
 *
 *  Mirrored in `hooks/redlog-relay.py` (`compile_policy`), because the shell
 *  cannot call this and RedLog will not spawn python3 to draw a settings
 *  panel. `test/command-class.test.ts` holds the two together: one golden
 *  table of modes under every overlay, and the same synthetic cases run
 *  through both sides and compared, list order included. */
export function compileClassPolicy(
  overlay: unknown,
  shipped: ShippedClassPolicy = SHIPPED,
  contributed: unknown = null
): CompiledClassPolicy {
  const layer = new Map<string, { mode: CommandClass; source: PolicySource; profile?: string }>()
  for (const command of shipped.native ?? []) layer.set(command, { mode: 'native', source: 'default' })
  // After native, so a command in both lists is pty, as classifyCommand has it.
  for (const command of shipped.pty ?? []) layer.set(command, { mode: 'pty', source: 'default' })

  const snapshot = normalizeContributed(contributed)
  const problems: PolicyProblem[] = [...snapshot.problems]
  const claims = new Map<string, Array<{ profile: string; mode: CommandClass }>>()
  // The plugins' profiles join after the shipped ones, so `#<index>` keeps counting.
  ;[...(shipped.terminalProfiles ?? []), ...snapshot.profiles].forEach((profile, index) => {
    if (!validProfile(profile)) {
      // Named by its id only when that is safe to print: it comes out of a file.
      const id = isRecord(profile) && validId(profile.id) ? profile.id : `#${index}`
      problems.push({ kind: 'invalid-profile', profile: id })
      return
    }
    for (const command of profile.executables) {
      const claimed = claims.get(command) ?? []
      claims.set(command, claimed)
      if (!claimed.some((c) => c.profile === profile.id)) claimed.push({ profile: profile.id, mode: profile.mode })
    }
  })
  const conflicts: Array<Extract<PolicyProblem, { kind: 'conflict' }>> = []
  for (const [command, claimed] of claims) {
    // The profile that had this command when the snapshot was written, if it
    // still claims it. With no snapshot nothing holds anything, and this is
    // the layering without a plugin in it.
    const holding = claimed.find((c) => c.profile === snapshot.held.get(command))
    if (new Set(claimed.map((c) => c.mode)).size === 1) {
      const winner = holding ?? claimed[0]
      layer.set(command, { mode: winner.mode, source: 'profile', profile: winner.profile })
    } else if (holding) {
      // Disagreement over a command somebody already has: the holder keeps it,
      // and the clash is still reported so the operator can settle it.
      layer.set(command, { mode: holding.mode, source: 'profile', profile: holding.profile })
      conflicts.push({ kind: 'conflict', command, claims: claimed, kept: holding.profile })
    } else {
      conflicts.push({ kind: 'conflict', command, claims: claimed })
    }
  }
  problems.push(...conflicts.sort((a, b) => byCommand(a.command, b.command)))

  const normalized = normalizeOverlay(overlay)
  problems.push(...normalized.problems)
  // Ascending, so a hand-edit naming one command twice resolves
  // pty over native over relayed.
  for (const mode of ['relayed', 'native', 'pty'] as const) {
    for (const command of normalized.lists[mode]) layer.set(command, { mode, source: 'override' })
  }

  const entries = [...new Set([...layer.keys(), ...conflicts.map((p) => p.command)])]
    .sort(byCommand)
    .map((command): PolicyEntry => {
      const found = layer.get(command)
      if (!found) return { command, mode: 'relayed', source: 'fallback' }
      return found.source === 'profile'
        ? { command, mode: found.mode, source: found.source, profile: found.profile }
        : { command, mode: found.mode, source: found.source }
    })
  const listed = (mode: CommandClass): string[] => [...layer].filter(([, v]) => v.mode === mode).map(([c]) => c)
  return { native: listed('native'), pty: listed('pty'), entries, problems }
}

// Defined after everything the compiler reads: a `const` used above its
// declaration typechecks and throws at import.
const DEFAULTS = compileClassPolicy(null)
const NATIVE = new Set(DEFAULTS.native)
const PTY = new Set(DEFAULTS.pty)

function basename(token: string): string {
  const cut = token.lastIndexOf('/')
  return cut === -1 ? token : token.slice(cut + 1)
}

/** Walk past the wrappers and return where the real command starts. */
function programIndex(argv: string[]): number {
  let i = 0
  while (i < argv.length) {
    const wrapper = WRAPPERS[basename(argv[i])]
    if (!wrapper) break
    i += 1
    while (i < argv.length) {
      const token = argv[i]
      if (token === '--') { i += 1; break }
      if (token.startsWith('-')) { i += wrapper.has(token) ? 2 : 1; continue }
      // `env FOO=bar cmd` — the assignments belong to the wrapper.
      if (ASSIGNMENT.test(token)) { i += 1; continue }
      break
    }
  }
  return i
}

export function classifyCommand(argv: string[]): CommandClass {
  const start = programIndex(argv)
  const program = basename(argv[start] ?? '')
  // Nothing to run. `native` rather than `relayed`, because a bare Enter must
  // not route the shell's own empty prompt through a relay.
  if (program === '') return 'native'

  if (PTY.has(program)) return 'pty'
  if (NATIVE.has(program)) return 'native'
  if (REPL.has(program)) {
    const args = argv.slice(start + 1)
    const given = args.some((a) => REPL_SCRIPT_FLAGS.has(a) || !a.startsWith('-'))
    return given ? 'relayed' : 'native'
  }
  return 'relayed'
}
