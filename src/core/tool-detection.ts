// Which tools this machine has, shown beside the tool profiles. #499 PR B,
// specs/052-terminal-auto-capture/research.md "Tool detection".
//
// This is a display, not an input. A profile decides how a command is
// recorded; detection only says whether the executables it names were found,
// and where. Nothing here reaches `compileClassPolicy`, `classifyCommand` or
// the shell's `classify`, and a miss never removes or changes a profile: that
// is the rule the issue sets, and `test/tool-detection.test.ts` holds it.
//
// Two sources, never merged:
//   - an `app` environment: RedLog's own PATH lookup, in memory, run only on a
//     named trigger (app start, Tool Settings opening, a manual rescan, a
//     profile set that grew) — never per command, never on a timer;
//   - one `shell` environment per kind of shell, written by the shell itself at
//     its first prompt (hooks/redlog-relay.py `detect`), because only the shell
//     knows the PATH its commands resolve against. RedLog reads those files
//     when asked and never writes or deletes one.

import fs from 'fs'
import path from 'path'
import { findOnPath, isBareCommandName } from './command-lookup'
import type { TerminalProfile } from './terminal-class'

export type DetectionTrigger = 'startup' | 'settings-open' | 'manual' | 'profiles-changed'
export type DetectionState = 'found' | 'missing' | 'unchecked'

export interface ExecutableDetection { name: string; state: DetectionState; path?: string }
export interface ProfileDetection { profile: string; state: DetectionState; executables: ExecutableDetection[] }
export interface EnvironmentDetection {
  id: string
  source: 'app' | 'shell'
  platform: string
  shell?: string
  wslDistro?: string
  sessionId?: string
  detectedAt: number
  stale: boolean
  profiles: ProfileDetection[]
}
export interface ToolDetectionSnapshot {
  /** The app first, then shells by `detectedAt`, newest first. */
  environments: EnvironmentDetection[]
  scanning: boolean
  lastTrigger: DetectionTrigger | null
}

const FRESH_MS = 30_000
const STALE_AFTER_MS = 7 * 86_400_000
const SCAN_TIMEOUT_MS = 5_000
const MAX_REPORTS = 64
const MAX_ENTRIES = 128
const MAX_REPORT_BYTES = 65_536
const MAX_EXECUTABLES = 64

const MAX_FUTURE_MS = 86_400_000
const SHELL_ENVIRONMENT = /^shell:[A-Za-z0-9._:-]{1,160}$/
const MAX_CHECKED = 256
const MAX_NAME = 128
const MAX_PATH = 4096

/** What one environment looked up and found. `found` keys are in `checked`. */
interface Finding { checked: Set<string>; found: Map<string, string> }

interface ShellReport extends Finding {
  id: string
  platform: string
  shell?: string
  wslDistro?: string
  sessionId?: string
  detectedAt: number
}

interface AppLookup extends Finding {
  /** Every name the lookup was set out to ask about, reached or not: how a
   *  profile set that grew since is told from one a deadline cut short. */
  attempted: Set<string>
  /** The deadline passed before every name was answered. */
  timedOut: boolean
  finishedAt: number
}

/** What main does with the argument of `tools:rescan`: only the two reasons a
 *  person can have cause a lookup, and anything else the renderer sends is a
 *  plain read. `startup` and `profiles-changed` are RedLog's own. */
export function rescanTrigger(reason: unknown): 'settings-open' | 'manual' | null {
  return reason === 'settings-open' || reason === 'manual' ? reason : null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string'

/** A shell report, if it is one this code wrote the schema of. The file is
 *  written by a script on the operator's machine and read here, so every field
 *  is checked and one wrong one rejects the whole file. */
function parseReport(raw: unknown): ShellReport | null {
  if (!isRecord(raw) || raw.version !== 1) return null
  const { environment, platform, shell, wslDistro, sessionId, detectedAt, checked, found } = raw
  // `shell:` and nothing else, so a report can never take the place of `app:*`.
  if (typeof environment !== 'string' || !SHELL_ENVIRONMENT.test(environment) || typeof platform !== 'string') return null
  if (!optionalString(shell) || !optionalString(wslDistro) || !optionalString(sessionId)) return null
  if (typeof detectedAt !== 'number' || !Number.isFinite(detectedAt) || detectedAt <= 0) return null
  if (!Array.isArray(checked) || checked.length > MAX_CHECKED) return null
  if (!checked.every((n): n is string => typeof n === 'string' && n.length <= MAX_NAME)) return null
  if (!isRecord(found)) return null
  const names = new Set<string>(checked)
  if (names.size !== checked.length) return null
  const hits = new Map<string, string>()
  for (const [name, where] of Object.entries(found)) {
    if (!names.has(name) || typeof where !== 'string' || where.length === 0 || where.length > MAX_PATH) return null
    hits.set(name, where)
  }
  return { id: environment, platform, shell, wslDistro, sessionId, detectedAt, checked: names, found: hits }
}

// Whoever can write the report directory can put anything in it, so a file is
// opened before it is believed: not followed if it is a link, not waited on if it
// is a pipe, and judged by the handle it is read through rather than by a name
// that may point at something else a moment later. A platform without a flag
// (Windows has neither) simply has no such thing to guard against.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)

/** The file's text if it is a regular file of at most MAX_REPORT_BYTES, else null.
 *  Never reads past the cap, whatever the file has become since it was listed. */
async function readRegularFile(file: string): Promise<{ text: string; mtimeMs: number } | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, OPEN_FLAGS)
    const st = await handle.stat()
    if (!st.isFile() || st.size > MAX_REPORT_BYTES) return null
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > MAX_REPORT_BYTES ? null : { text: buffer.toString('utf8', 0, length), mtimeMs: st.mtimeMs }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readReports(dir: string): Promise<ShellReport[]> {
  let entries: string[]
  try { entries = await fs.promises.readdir(dir) } catch { return [] }
  // The bound comes before any file is touched: a directory of thousands of
  // names costs one listing, not thousands of opens. Which names survive the cut
  // is by name, since modification time is exactly what has not been read yet.
  const names = entries.filter((n) => n.endsWith('.json')).sort().slice(0, MAX_ENTRIES)
  const files: Array<{ text: string; mtimeMs: number }> = []
  for (const name of names) {
    const file = await readRegularFile(path.join(dir, name))
    if (file) files.push(file)
  }
  const reports: ShellReport[] = []
  const seen = new Set<string>()
  for (const { text } of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_REPORTS)) {
    try {
      const parsed = parseReport(JSON.parse(text))
      if (parsed && !seen.has(parsed.id)) { seen.add(parsed.id); reports.push(parsed) }
    } catch { /* not JSON: not a report */ }
  }
  return reports
}

function stateFor(finding: Finding, name: string): ExecutableDetection {
  const where = finding.found.get(name)
  if (where !== undefined) return { name, state: 'found', path: where }
  return { name, state: finding.checked.has(name) ? 'missing' : 'unchecked' }
}

function profileDetection(finding: Finding, profile: TerminalProfile): ProfileDetection {
  const executables = profile.executables.map((name) => stateFor(finding, name))
  const state: DetectionState = executables.some((e) => e.state === 'found') ? 'found'
    : executables.every((e) => e.state === 'missing') ? 'missing' : 'unchecked'
  return { profile: profile.id, state, executables }
}

export function createToolDetector(deps: {
  home: string
  platform: NodeJS.Platform
  env: () => NodeJS.ProcessEnv
  profiles: () => TerminalProfile[]
  now?: () => number
  lookup?: typeof findOnPath
  scanTimeoutMs?: number
  /** One counting line per lookup, for the debug log. */
  log?: (line: string) => void
}): {
  snapshot(): Promise<ToolDetectionSnapshot>
  rescan(trigger: DetectionTrigger): Promise<ToolDetectionSnapshot>
} {
  const now = deps.now ?? Date.now
  const lookup = deps.lookup ?? findOnPath
  const timeoutMs = deps.scanTimeoutMs ?? SCAN_TIMEOUT_MS
  const reportDir = path.join(deps.home, '.redlog', 'tool-detection')

  let last: AppLookup | null = null
  let lastTrigger: DetectionTrigger | null = null
  let inflight: Promise<void> | null = null

  // Sorted, unique, bare names only, and no more than a lookup is allowed to do.
  const wanted = (): string[] =>
    [...new Set(deps.profiles().flatMap((p) => p.executables))].filter(isBareCommandName).sort().slice(0, MAX_EXECUTABLES)

  /** A name counts as covered only if the last lookup answered it. */
  const covers = (): boolean => last !== null && wanted().every((n) => last!.checked.has(n))
  /** The profiles name an executable the last lookup was not set out to ask about. */
  const grew = (): boolean => last !== null && !wanted().every((n) => last!.attempted.has(n))

  async function lookupAll(trigger: DetectionTrigger): Promise<void> {
    const started = now()
    const names = wanted()
    const env = deps.env()
    const signal = AbortSignal.timeout(timeoutMs)
    // A lookup that never answers must not hold the scan: the signal wins the
    // race, and whatever it had not answered is unchecked, not missing.
    const expired = new Promise<'expired'>((resolve) => signal.addEventListener('abort', () => resolve('expired'), { once: true }))
    const finding: AppLookup = { checked: new Set(), found: new Map(), attempted: new Set(names), timedOut: false, finishedAt: 0 }
    // One name at a time, dirs in order inside it, and the deadline looked at
    // before each: a PATH entry on a dead share blocks a libuv thread until the
    // SMB timeout, and the abort frees the scan, not the thread. Sequential,
    // that is one thread, not all four.
    for (const name of names) {
      if (signal.aborted) break
      const answer = await Promise.race([
        lookup(name, { platform: deps.platform, env, signal }).then((where) => ({ where }), () => 'unanswered' as const),
        expired
      ])
      if (answer === 'expired') break
      if (answer === 'unanswered') continue
      finding.checked.add(name)
      if (answer.where) finding.found.set(name, answer.where)
    }
    finding.timedOut = signal.aborted && finding.checked.size < names.length
    finding.finishedAt = now()
    last = finding
    deps.log?.(`trigger=${trigger} checked=${finding.checked.size} found=${finding.found.size} ms=${Math.max(0, finding.finishedAt - started)}`)
  }

  async function snapshot(): Promise<ToolDetectionSnapshot> {
    // Profiles that gained an executable since the last lookup: look again,
    // behind this snapshot, not in front of it.
    if (!inflight && grew()) void rescan('profiles-changed').catch(() => {})
    const profiles = deps.profiles()
    const environments: EnvironmentDetection[] = []
    if (last !== null) {
      environments.push({
        id: `app:${deps.platform}`, source: 'app', platform: deps.platform,
        detectedAt: last.finishedAt, stale: false,
        profiles: profiles.map((p) => profileDetection(last!, p))
      })
    }
    const at = now()
    const shells = (await readReports(reportDir)).sort((a, b) => b.detectedAt - a.detectedAt)
    for (const r of shells) {
      const env: EnvironmentDetection = {
        id: r.id, source: 'shell', platform: r.platform, detectedAt: r.detectedAt,
        // A clock that was far ahead when the report was written is as untrustworthy as an old one.
        stale: at - r.detectedAt > STALE_AFTER_MS || r.detectedAt - at > MAX_FUTURE_MS,
        profiles: profiles.map((p) => profileDetection(r, p))
      }
      if (r.shell !== undefined) env.shell = r.shell
      if (r.wslDistro !== undefined) env.wslDistro = r.wslDistro
      if (r.sessionId !== undefined) env.sessionId = r.sessionId
      environments.push(env)
    }
    return { environments, scanning: inflight !== null, lastTrigger }
  }

  let inflightTrigger: DetectionTrigger | null = null
  let freshManual: Promise<void> | null = null

  // Set before anything is awaited: a second caller in the same tick joins
  // this lookup instead of starting its own.
  function startLookup(trigger: DetectionTrigger): Promise<void> {
    lastTrigger = trigger
    inflightTrigger = trigger
    const run: Promise<void> = lookupAll(trigger).finally(() => {
      if (inflight === run) { inflight = null; inflightTrigger = null }
    })
    inflight = run
    return run
  }

  async function rescan(trigger: DetectionTrigger): Promise<ToolDetectionSnapshot> {
    if (trigger === 'manual' && inflight && inflightTrigger !== 'manual') {
      // The lookup in flight started before this click and may have read an
      // environment older than it: wait for it, then run one that did not.
      // Manuals that arrive meanwhile share that one run.
      freshManual ??= (async () => {
        while (inflight) await inflight.catch(() => {})
        freshManual = null
        return startLookup('manual')
      })()
      await freshManual
    } else if (inflight) {
      await inflight
    } else if (!(trigger === 'settings-open' && last !== null && now() - last.finishedAt < FRESH_MS && (covers() || last.timedOut))) {
      await startLookup(trigger)
    }
    return snapshot()
  }

  return { snapshot, rescan }
}
