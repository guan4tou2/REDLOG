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
  /** Every name the lookup was asked about, answered or not: what "covered" means. */
  attempted: Set<string>
  finishedAt: number
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

async function readReports(dir: string): Promise<ShellReport[]> {
  let entries: string[]
  try { entries = await fs.promises.readdir(dir) } catch { return [] }
  const stats = await Promise.all(entries.filter((n) => n.endsWith('.json')).map(async (name) => {
    const file = path.join(dir, name)
    try {
      const st = await fs.promises.stat(file)
      return st.isFile() && st.size <= MAX_REPORT_BYTES ? { file, mtimeMs: st.mtimeMs } : null
    } catch { return null }
  }))
  const newest = stats.filter((s): s is { file: string; mtimeMs: number } => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_REPORTS)
  const reports: ShellReport[] = []
  const seen = new Set<string>()
  for (const { file } of newest) {
    try {
      const parsed = parseReport(JSON.parse(await fs.promises.readFile(file, 'utf8')))
      if (parsed && !seen.has(parsed.id)) { seen.add(parsed.id); reports.push(parsed) }
    } catch { /* unreadable or not JSON: not a report */ }
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

  const covers = (): boolean => last !== null && wanted().every((n) => last!.attempted.has(n))

  async function lookupAll(trigger: DetectionTrigger): Promise<void> {
    const started = now()
    const names = wanted()
    const env = deps.env()
    const signal = AbortSignal.timeout(timeoutMs)
    // A lookup that never answers must not hold the scan: the signal wins the
    // race, and whatever it had not answered is unchecked, not missing.
    const expired = new Promise<'expired'>((resolve) => signal.addEventListener('abort', () => resolve('expired'), { once: true }))
    const answers = await Promise.all(names.map(async (name) => {
      const answer = await Promise.race([
        lookup(name, { platform: deps.platform, env, signal }).then((where) => ({ where }), () => 'expired' as const),
        expired
      ])
      return { name, answer }
    }))
    const finding: AppLookup = { checked: new Set(), found: new Map(), attempted: new Set(names), finishedAt: now() }
    for (const { name, answer } of answers) {
      if (answer === 'expired') continue
      finding.checked.add(name)
      if (answer.where) finding.found.set(name, answer.where)
    }
    last = finding
    deps.log?.(`trigger=${trigger} checked=${finding.checked.size} found=${finding.found.size} ms=${Math.max(0, finding.finishedAt - started)}`)
  }

  async function snapshot(): Promise<ToolDetectionSnapshot> {
    // Profiles that gained an executable since the last lookup: look again,
    // behind this snapshot, not in front of it.
    if (last !== null && !inflight && !covers()) void rescan('profiles-changed').catch(() => {})
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

  async function rescan(trigger: DetectionTrigger): Promise<ToolDetectionSnapshot> {
    const skippable = trigger === 'settings-open' || trigger === 'profiles-changed'
    if (!inflight && !(skippable && last !== null && now() - last.finishedAt < FRESH_MS && covers())) {
      lastTrigger = trigger
      // Set before anything is awaited: a second caller in the same tick joins
      // this lookup instead of starting its own.
      inflight = lookupAll(trigger).finally(() => { inflight = null })
    }
    if (inflight) await inflight
    return snapshot()
  }

  return { snapshot, rescan }
}
