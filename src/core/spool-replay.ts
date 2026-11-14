import { bodyTargetId } from './ingest/body-target'
import { EVENT_NESTING_CEILING, NESTED_TOO_DEEP } from './ingest/depth'
import { jsonDepthExceeds } from './api-request'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { retryBusy } from './private-fs'
import { sourceTimeRejection } from './db/event-write'

// Replaying ~/.redlog/pending, one file at a time, for the open project.
//
// Every file a replay looks at ends in exactly one of four outcomes:
//   - ingested:    its event was handed to the pipeline and handled (written,
//                  or deliberately not: the 2 s dedup, RedLog's own plumbing);
//                  the file is removed.
//   - deferred:    left where it is for later — another project's, one that
//                  cannot be read now, one whose write failed this time, one
//                  that cannot be judged yet, one whose owner cannot be read
//                  when there is no room to set it aside.
//   - quarantined: moved under pending/quarantine/<project>/ (or _unknown/,
//                  _no-project/) as <reason>--<name>, a .why beside it.
//   - dropped:     removed without being written, and counted — observed
//                  during a recorded pause, or the open project's own file
//                  when that project's quarantine is full.
//
// A file is COUNTED at most once. The replay only plans: the drain commits the
// chained gap row that counts the file — the row names it — and only then
// moves or removes it (applySpoolActions). A row that cannot be written leaves
// every file it would have counted in place, uncounted. A file a committed row
// already names is not counted again; only its move or removal is retried
// (`retries`). The chain is the record of what was counted, so this holds
// across a crash between the commit and the move.
//
// A file that belongs to another project, or whose owner cannot be read, is
// never deleted.

export interface SpoolReplayEvent {
  agentType: string
  data: Record<string, unknown>
  engagementId: string
  operatorId: string
  /** The body's own target, read as the API reads it (ingest/body-target.ts). */
  targetId?: string
}

/** Why a file was set aside or dropped (Spec 071 FR-050 / FR-066). */
export type QuarantineReason = 'malformed' | 'kind-not-allowed' | 'no-project' | 'legacy-bad' | 'failed' | 'pause-end-unknown' | 'nested-too-deep'

/** What became of one replayed event, as the emitter reports it.
 *
 *  - `done`: written, or handled without a row on purpose. The file goes.
 *  - `rejected`: not written, deliberately, and never will be. Counted, then
 *    the file goes.
 *  - `invalid`: can never be written. Counted, then the file is quarantined.
 *  - `failed`: not written this time. The file stays and is tried again after
 *    a back-off; after MAX_ATTEMPTS it is quarantined as `failed`.
 *
 *  `true` and `false` are the older answers, `done` and "leave it in place". */
export type SpoolOutcome =
  | { outcome: 'done' }
  | { outcome: 'rejected'; reason: 'paused' | 'terminal-not-recording' | 'pause-end-unknown' }
  | { outcome: 'invalid'; reason: QuarantineReason; detail: string }
  | { outcome: 'failed'; detail: string }

export type FileOutcome = 'ingested' | 'deferred' | 'quarantined' | 'dropped'

type FileAction =
  | { kind: 'unlink' }
  /** Already moved into `_unknown` before it was counted: see moveUnknownFirst. */
  | { kind: 'moved'; to: string }
  | { kind: 'quarantine'; dir: string; target: string; reason: QuarantineReason; detail: string }

export interface PlannedFile {
  /** Path of the file now. */
  file: string
  /** Its name in the spool directory: the key of `outcomes`, and what a gap
   *  row names. */
  name: string
  action: FileAction
  /** Set on a counted file: whose it is, and the time it is placed at. */
  owner?: 'this' | 'unknown'
  at?: number
}

/** Files counted together, by reason: one gap row each (chunked). */
export interface SpoolLoss {
  reason: string
  intentional: boolean
  count: number
  /** How many of `count` go to quarantine; the rest are dropped. */
  kept: number
  /** How many belong to the open project, and how many could not be read far
   *  enough to say whose they are. */
  owners: { this: number; unknown: number }
  /** Earliest and latest time among them: a usable source time, else the
   *  time the replay saw the file. */
  firstAt: number
  lastAt: number
  files: PlannedFile[]
}

export interface SpoolReplayResult {
  /** Handed to the pipeline and handled. */
  replayed: number
  /** Left in place: another project's, or kept back by the emitter. */
  deferred: number
  /** Set aside for having no project. */
  unattributed: number
  /** Counted as never writable (to be quarantined or dropped). */
  invalid: number
  /** Not written or not read this time, to be retried; includes those inside a
   *  back-off. */
  failed: number
  /** The last file name looked at, replayed or not, or null when there was none.
   *  Pass it back as `after` to carry on from there. Files left in place count:
   *  another project's would otherwise pin a sliced drain behind them. */
  last: string | null
  /** What to count, and what to do with each counted file once counted. */
  losses: SpoolLoss[]
  /** Files a committed gap row already counted: their move or removal only. */
  retries: PlannedFile[]
  /** Every file looked at, by name. A counted file reads as it will end once
   *  its gap row is committed; the drain corrects that if it is not. */
  outcomes: Record<string, FileOutcome>
}

/** FR-066: per quarantine directory, 1000 files or 256 MiB. */
const QUARANTINE_MAX_FILES = 1000
const QUARANTINE_MAX_BYTES = 256 * 1024 * 1024
const WHY_SUFFIX = '.why'
const SEPARATOR = '--'

/** Room in the quarantine, measured once per drain and reserved as the drain
 *  plans — across every slice of it and the legacy migration, so one drain
 *  cannot overfill a bound by planning in pieces. */
export class QuarantineLedger {
  private readonly spaces = new Map<string, { files: number; bytes: number }>()
  constructor(private readonly maxFiles = QUARANTINE_MAX_FILES, private readonly maxBytes = QUARANTINE_MAX_BYTES) {}
  reserve(dir: string, size: number): boolean {
    let space = this.spaces.get(dir)
    if (!space) {
      space = { files: 0, bytes: 0 }
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { /* not made yet */ }
      for (const name of names) {
        try { space.bytes += fs.statSync(path.join(dir, name)).size } catch { continue }
        if (!name.endsWith(WHY_SUFFIX)) space.files++
      }
      this.spaces.set(dir, space)
    }
    if (space.files + 1 > this.maxFiles || space.bytes + size > this.maxBytes) return false
    space.files++
    space.bytes += size + 256
    return true
  }
}

export interface SpoolReplayOptions {
  /** The clock: back-off, the age of an unparseable file, a loss's window. */
  now?: () => number
  /** Shorthands for a ledger with these bounds, when `ledger` is not given. */
  quarantineMaxFiles?: number
  quarantineMaxBytes?: number
  /** The drain's ledger, shared by its slices. */
  ledger?: QuarantineLedger
  /** True for a file a committed gap row of this project already names. */
  /** The reason a committed gap row of this project counted the file under,
   *  or null when none did. */
  countedAs?: (name: string) => string | null
}

const INTENTIONAL_REASONS = new Set(['paused', 'terminal-not-recording'])
/** Kept in quarantine once counted. `pause-end-unknown` among them: observed
 *  after a pause whose end the record does not show, so not written to the
 *  record, but kept, and counted as a loss rather than as a pause. */
const QUARANTINE_REASONS = new Set<string>(['malformed', 'kind-not-allowed', 'no-project', 'legacy-bad', 'failed', 'pause-end-unknown', NESTED_TOO_DEEP])

function countedOf(options: SpoolReplayOptions): (name: string) => boolean {
  const countedAs = options.countedAs
  return countedAs ? (name) => countedAs(name) !== null : () => false
}

function ledgerOf(options: SpoolReplayOptions): QuarantineLedger {
  return options.ledger ?? new QuarantineLedger(options.quarantineMaxFiles, options.quarantineMaxBytes)
}

/** Where the drain sets aside what it will never write: beside the waiting
 *  files, so it shares their permissions, and in a directory, so the hooks'
 *  `*.json` count of waiting files does not see it. One directory per project
 *  (FR-066), one for files whose owner cannot be read, one for files that
 *  named no project. */
export function quarantineDirectory(spoolDirectory: string): string {
  return path.join(spoolDirectory, 'quarantine')
}
const UNKNOWN_OWNER_DIR = '_unknown'
const NO_PROJECT_DIR = '_no-project'

/** The directory name for a project's quarantine: its id when that is a safe
 *  file name, otherwise a digest of it. */
function projectQuarantineName(engagementId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(engagementId)
    ? engagementId
    : `p-${crypto.createHash('sha256').update(engagementId).digest('hex').slice(0, 16)}`
}

function quarantineDirFor(spoolDirectory: string, owner: { engagementId: string } | 'unknown' | 'no-project'): string {
  const name = owner === 'unknown' ? UNKNOWN_OWNER_DIR : owner === 'no-project' ? NO_PROJECT_DIR : projectQuarantineName(owner.engagementId)
  return path.join(quarantineDirectory(spoolDirectory), name)
}

/** What an earlier version renamed a file to when it carried no project
 *  identity (#255), or could not be read. Replay makes `.unattributed` only
 *  when the no-project quarantine is full; it moves the rest into quarantine. */
const LEGACY_UNATTRIBUTED_SUFFIX = '.unattributed'
const LEGACY_BAD_SUFFIX = '.bad'

/** A file that does not parse and was written less than this long ago may still
 *  be being written: the shell hooks do not write through a temp file. It is
 *  tried again rather than set aside. The mtime is used for this and for
 *  nothing else, and never for the pause decision; a file written "in the
 *  future" is not young, beyond MTIME_SLACK_MS — a just-written file's mtime
 *  can read a millisecond ahead of the clock that compares it. */
const YOUNG_FILE_MS = 10_000
const MTIME_SLACK_MS = 1_000

const RECEIVER = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

/** Files that could not be read or written, and when each may be tried again.
 *  In memory and keyed by path: a restart forgets it, which only means more
 *  tries. */
const backoff = new Map<string, { attempts: number; at: number }>()
const BACKOFF_FIRST_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000
/** After this many failed writes the open project's file is quarantined
 *  instead of retried. A file that cannot be READ is never given up on: whose
 *  it is cannot be told, so it is not this project's to count. */
const MAX_ATTEMPTS = 5

/** Move `file` into `dir` as `<reason>--<name>`, with a `.why` beside it. */
function moveIntoQuarantine(file: string, dir: string, target: string, reason: QuarantineReason, detail: string, now: number): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    let to = path.join(dir, `${reason}${SEPARATOR}${target}`)
    for (let n = 1; fs.existsSync(to); n++) to = path.join(dir, `${reason}${SEPARATOR}${target}.${n}`)
    const destination = to
    retryBusy(() => fs.renameSync(file, destination))
    try { fs.writeFileSync(`${destination}${WHY_SUFFIX}`, JSON.stringify({ reason, detail, at: now, receiver: RECEIVER }), { mode: 0o600 }) } catch { /* the name still says why */ }
    return destination
  } catch {
    return null
  }
}

/** Put back files moved ahead of a count that was not written (the gap row
 *  failed, or recording paused before the drain could commit), so they are
 *  where their outcome says — waiting — and the next drain counts them. What
 *  cannot be put back stays in quarantine, uncounted. */
export function unmoveSpoolFiles(files: readonly PlannedFile[]): Record<string, FileOutcome> {
  const out: Record<string, FileOutcome> = {}
  for (const { file, name, action } of files) {
    if (action.kind !== 'moved') { out[name] = 'deferred'; continue }
    try {
      retryBusy(() => fs.renameSync(action.to, file))
      try { fs.unlinkSync(`${action.to}${WHY_SUFFIX}`) } catch { /* none */ }
      out[name] = 'deferred'
    } catch {
      out[name] = 'quarantined'
    }
  }
  return out
}

/** A file whose owner cannot be read is moved into `_unknown` BEFORE it is
 *  counted, the reverse of every other file. Counted first, a file whose move
 *  kept failing stayed in the spool for the next project that opened, which
 *  counted it again: no project's chain records it, so none can recognise it
 *  as counted. Moved first, a file that cannot be moved is left uncounted for
 *  every project; one moved whose gap row then fails is kept in `_unknown` but
 *  not counted (Spec 071 FR-066). */
function moveUnknownFirst(file: string, dir: string, target: string, reason: QuarantineReason, detail: string, now: number): PlannedFile['action'] | null {
  const to = moveIntoQuarantine(file, dir, target, reason, detail, now)
  return to ? { kind: 'moved', to } : null
}

/** Groups what is to be counted by reason. */
class LossPlan {
  private readonly groups = new Map<string, SpoolLoss>()
  readonly retries: PlannedFile[] = []
  constructor(private readonly counted: (name: string) => boolean) {}
  /** False when the file was already counted: only its action is retried. */
  add(reason: string, intentional: boolean, owner: 'this' | 'unknown', at: number, planned: PlannedFile): boolean {
    if (this.counted(planned.name)) { this.retries.push(planned); return false }
    planned.owner = owner
    planned.at = at
    const row = this.groups.get(reason) ?? { reason, intentional, count: 0, kept: 0, owners: { this: 0, unknown: 0 }, firstAt: at, lastAt: at, files: [] }
    row.count++
    row.owners[owner]++
    if (planned.action.kind !== 'unlink') row.kept++
    if (at < row.firstAt) row.firstAt = at
    if (at > row.lastAt) row.lastAt = at
    row.files.push(planned)
    this.groups.set(reason, row)
    return true
  }
  list(): SpoolLoss[] { return [...this.groups.values()] }
}

/** Carry out planned moves and removals — once the gap row that counts them is
 *  committed, or for files a committed row already counted. Returns what each
 *  file became: a move or removal that fails leaves the file where it was. */
export function applySpoolActions(files: readonly PlannedFile[], now = Date.now()): Record<string, FileOutcome> {
  const out: Record<string, FileOutcome> = {}
  for (const { file, name, action } of files) {
    if (action.kind === 'unlink') {
      try { retryBusy(() => fs.unlinkSync(file)); out[name] = 'dropped' } catch { out[name] = 'deferred' }
    } else if (action.kind === 'moved') {
      out[name] = 'quarantined'
    } else {
      out[name] = moveIntoQuarantine(file, action.dir, action.target, action.reason, action.detail, now) ? 'quarantined' : 'deferred'
    }
    if (out[name] !== 'deferred') backoff.delete(file)
  }
  return out
}

export interface UnattributedSpoolSummary {
  count: number
  /** When the oldest and newest of them were written, ms since the epoch. */
  oldestAt: number
  newestAt: number
}

/** The commands no project could claim (#255): quarantined as `no-project`, or
 *  an earlier version's `*.unattributed` not yet moved. Paths. */
function unattributedFiles(directory: string): string[] {
  const out: string[] = []
  const q = quarantineDirFor(directory, 'no-project')
  try {
    for (const name of fs.readdirSync(q)) {
      if (name.startsWith(`no-project${SEPARATOR}`) && !name.endsWith(WHY_SUFFIX)) out.push(path.join(q, name))
    }
  } catch { /* no quarantine yet */ }
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith(LEGACY_UNATTRIBUTED_SUFFIX)) out.push(path.join(directory, name))
    }
  } catch { /* no spool directory */ }
  return out
}

/** What replay has set aside for having no project, as it stands on disk.
 *
 *  Counted from the directory rather than from a replay's return value: the
 *  files outlive the run that moved them, and an operator opening RedLog next
 *  week needs the same answer as one opening it a minute later. The time is the
 *  file's own mtime — a rename keeps it, and a hook writes the file at the
 *  moment the command ran — so nothing has to be parsed. Null when there are
 *  none, which is also what a missing directory means. */
export function summarizeUnattributedSpool(directory: string): UnattributedSpoolSummary | null {
  let count = 0
  let oldestAt = Number.POSITIVE_INFINITY
  let newestAt = Number.NEGATIVE_INFINITY
  for (const file of unattributedFiles(directory)) {
    let at: number
    try { at = Math.round(fs.statSync(file).mtimeMs) } catch { continue }
    count++
    if (at < oldestAt) oldestAt = at
    if (at > newestAt) newestAt = at
  }
  return count === 0 ? null : { count, oldestAt, newestAt }
}

export interface ClearUnattributedResult {
  removed: number
  /** Files that matched and could not be deleted (open elsewhere, no
   *  permission). They stay on disk and stay counted. */
  failed: number
}

/** Delete the set-aside files an operator has chosen to get rid of (#255).
 *
 *  Only what they were shown: `upTo` is the newest write time the summary
 *  reported, and anything written after it is left alone. A hook can set one
 *  more aside between the card drawing its count and the operator confirming,
 *  and removing a file nobody has seen counted is the worse way to be wrong.
 *  Only the no-project ones — never a `.json` still waiting for replay, and
 *  never a file quarantined for another reason, which someone may want to
 *  inspect. */
export function clearUnattributedSpool(directory: string, upTo: number): ClearUnattributedResult {
  const result = { removed: 0, failed: 0 }
  for (const file of unattributedFiles(directory)) {
    try {
      if (Math.round(fs.statSync(file).mtimeMs) > upTo) continue
      fs.unlinkSync(file)
      result.removed++
    } catch {
      result.failed++
      continue
    }
    try { fs.unlinkSync(`${file}${WHY_SUFFIX}`) } catch { /* an earlier version's file has none */ }
  }
  return result
}

/** The project a payload names, complete or not. */
function namedEngagement(payload: unknown): string | null {
  const engagementId = (payload as { _identity?: { engagementId?: unknown } } | null)?._identity?.engagementId
  return typeof engagementId === 'string' && engagementId ? engagementId : null
}

/** The project a file that does not parse still names in its text — a
 *  truncated payload keeps the identity the hook wrote. The first
 *  `"engagementId":"…"` is the one; null when there is none. */
function engagementInText(text: string): string | null {
  const m = /"engagementId"\s*:\s*"((?:[^"\\]|\\.){1,256})"/.exec(text)
  if (!m) return null
  try { return JSON.parse(`"${m[1]}"`) as string } catch { return null }
}

function identityOf(payload: unknown): { engagementId: string; operatorId: string } | null {
  const identity = (payload as { _identity?: { engagementId?: unknown; operatorId?: unknown } } | null)?._identity
  if (typeof identity?.engagementId !== 'string' || !identity.engagementId ||
      typeof identity.operatorId !== 'string' || !identity.operatorId) return null
  return { engagementId: identity.engagementId, operatorId: identity.operatorId }
}

/** A producer's time on the payload, if it passes the rule the row's
 *  timestamp uses (FR-004); null otherwise. Places a loss in time only. */
function claimedTime(data: Record<string, unknown> | null, now: number): number | null {
  const t = data?.source_timestamp
  return t !== undefined && t !== null && sourceTimeRejection(t, now) === null ? t as number : null
}

export interface LegacySpoolMigration {
  legacyBad: number
  noProject: number
  losses: SpoolLoss[]
  retries: PlannedFile[]
  outcomes: Record<string, FileOutcome>
}

/** Plan moving what an earlier version set aside into the quarantine, once
 *  (Spec 071 FR-069): `*.bad` as `legacy-bad`, `*.unattributed` as
 *  `no-project`.
 *
 *  A `.bad` file whose identity names another project is left for that project
 *  to move and count when it opens. One that names this project goes to its
 *  quarantine, one that cannot be read to `_unknown`; both are counted, and
 *  moved only once counted. Nothing is deleted: a file the full quarantine
 *  cannot take stays where it is. */
export function migrateLegacySpoolFiles(
  directory: string,
  active: { engagementId: string },
  options: SpoolReplayOptions = {}
): LegacySpoolMigration {
  const result: LegacySpoolMigration = { legacyBad: 0, noProject: 0, losses: [], retries: [], outcomes: {} }
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return result }
  const now = (options.now ?? Date.now)()
  const ledger = ledgerOf(options)
  const plan = new LossPlan(countedOf(options))
  for (const name of names.sort()) {
    const unattributed = name.endsWith(LEGACY_UNATTRIBUTED_SUFFIX)
    if (!unattributed && !name.endsWith(LEGACY_BAD_SUFFIX)) continue
    const file = path.join(directory, name)
    const base = name.slice(0, -(unattributed ? LEGACY_UNATTRIBUTED_SUFFIX : LEGACY_BAD_SUFFIX).length)
    let size: number
    try { size = fs.statSync(file).size } catch { continue }
    if (unattributed) {
      // Not counted in any project: the #255 line is its trace. A move.
      const dir = quarantineDirFor(directory, 'no-project')
      if (ledger.reserve(dir, size) && moveIntoQuarantine(file, dir, base, 'no-project', 'set aside as .unattributed by an earlier version', now)) {
        result.noProject++
        result.outcomes[name] = 'quarantined'
      } else {
        result.outcomes[name] = 'deferred'
      }
      continue
    }
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { result.outcomes[name] = 'deferred'; continue }
    let owner: 'this' | 'unknown' = 'unknown'
    let at = now
    try {
      const payload = JSON.parse(text) as { data?: Record<string, unknown> }
      const named = namedEngagement(payload)
      if (named && named !== active.engagementId) { result.outcomes[name] = 'deferred'; continue }
      if (named) owner = 'this'
      at = claimedTime(payload?.data && typeof payload.data === 'object' ? payload.data : null, now) ?? now
    } catch {
      const named = engagementInText(text)
      if (named && named !== active.engagementId) { result.outcomes[name] = 'deferred'; continue }
      if (named) owner = 'this'
    }
    const dir = quarantineDirFor(directory, owner === 'this' ? active : 'unknown')
    if (!ledger.reserve(dir, size)) { result.outcomes[name] = 'deferred'; continue }
    const detail = 'set aside as .bad by an earlier version'
    const action = owner === 'unknown'
      ? moveUnknownFirst(file, dir, base, 'legacy-bad', detail, now)
      : { kind: 'quarantine' as const, dir, target: base, reason: 'legacy-bad' as const, detail }
    if (!action) { result.outcomes[name] = 'deferred'; continue }
    plan.add('legacy-bad', false, owner, at, { file, name, action })
    result.legacyBad++
    result.outcomes[name] = 'quarantined'
  }
  result.losses = plan.list()
  result.retries = plan.retries
  return result
}

/** Replay only files attributable to the active engagement. Mismatches remain
 * byte-for-byte in place so opening their owning project can recover them.
 * Counted files are only planned here: see applySpoolActions. */
export function replaySpoolDirectory(
  directory: string,
  active: { engagementId: string; operatorId: string },
  emit: (event: SpoolReplayEvent) => boolean | SpoolOutcome,
  limit = Number.POSITIVE_INFINITY,
  after = '',
  options: SpoolReplayOptions = {}
): SpoolReplayResult {
  const result: SpoolReplayResult = { replayed: 0, deferred: 0, unattributed: 0, invalid: 0, failed: 0, last: null, losses: [], retries: [], outcomes: {} }
  if (!fs.existsSync(directory)) return result
  const clock = options.now ?? Date.now
  const ledger = ledgerOf(options)
  const counted = countedOf(options)
  const plan = new LossPlan(counted)
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json') && name > after).sort().slice(0, limit)

  const defer = (name: string): void => { result.outcomes[name] = 'deferred' }
  /** Count `file` as never writable: to quarantine, or — only the open
   *  project's own, when its quarantine is full and it has not been counted
   *  before — to be dropped. A file whose owner is unknown and finds no room
   *  stays where it is. */
  const setAside = (file: string, name: string, size: number, reason: QuarantineReason, detail: string, owner: 'this' | 'unknown', at: number): void => {
    const dir = quarantineDirFor(directory, owner === 'this' ? active : 'unknown')
    if (ledger.reserve(dir, size)) {
      const action = owner === 'unknown'
        ? moveUnknownFirst(file, dir, name, reason, detail, clock())
        : { kind: 'quarantine' as const, dir, target: name, reason, detail }
      if (!action) { defer(name); return }
      plan.add(reason, false, owner, at, { file, name, action })
      result.outcomes[name] = 'quarantined'
    } else if (owner === 'this' && !counted(name)) {
      plan.add(reason, false, owner, at, { file, name, action: { kind: 'unlink' } })
      result.outcomes[name] = 'dropped'
    } else {
      defer(name)
      return
    }
    result.invalid++
  }
  /** A write that did not happen. After MAX_ATTEMPTS, set aside. */
  const failed = (file: string, name: string, size: number, detail: string): void => {
    const attempts = (backoff.get(file)?.attempts ?? 0) + 1
    if (attempts >= MAX_ATTEMPTS) {
      setAside(file, name, size, 'failed', `${detail} (after ${attempts} tries)`, 'this', clock())
      if (result.outcomes[name] === 'deferred') backoff.set(file, { attempts, at: clock() + BACKOFF_MAX_MS })
      return
    }
    retryLater(file, name, attempts)
  }
  const retryLater = (file: string, name: string, attempts: number): void => {
    backoff.set(file, { attempts, at: clock() + Math.min(BACKOFF_FIRST_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS) })
    result.failed++
    defer(name)
  }

  for (const name of files) {
    result.last = name
    const file = path.join(directory, name)
    const held = backoff.get(file)
    if (held && clock() < held.at) {
      result.failed++
      defer(name)
      continue
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { backoff.delete(file); continue } // gone since the listing
      retryLater(file, name, (held?.attempts ?? 0) + 1)
      continue
    }
    // A read error — permissions, too many open files, an I/O error, a file
    // held open — says nothing about the content, nor about whose it is. Retry
    // it, for as long as it takes; it is never this project's to count.
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      retryLater(file, name, (held?.attempts ?? 0) + 1)
      continue
    }
    // Past the doors' ceiling a file is not parsed: set aside and counted, as
    // the API refuses the same body (FR-097; ingest/nesting-ceiling.ts). Whose
    // it is comes from the identity the hook wrote, read from the text.
    if (jsonDepthExceeds(text, EVENT_NESTING_CEILING)) {
      const named = engagementInText(text)
      if (named && named !== active.engagementId) { result.deferred++; defer(name); continue }
      setAside(file, name, stat.size, NESTED_TOO_DEEP, `nested more than ${EVENT_NESTING_CEILING} levels deep`, named ? 'this' : 'unknown', clock())
      continue
    }
    let payload: { agent_type?: unknown; data?: unknown; target_id?: unknown; targetId?: unknown }
    try {
      payload = JSON.parse(text) as typeof payload
    } catch (e) {
      const age = clock() - Math.round(stat.mtimeMs)
      if (age > -MTIME_SLACK_MS && age < YOUNG_FILE_MS) { result.failed++; defer(name); continue }
      // Unparseable, but the identity the hook wrote may still be there.
      const named = engagementInText(text)
      if (named && named !== active.engagementId) { result.deferred++; defer(name); continue }
      setAside(file, name, stat.size, 'malformed', (e as Error).message, named ? 'this' : 'unknown', clock())
      continue
    }
    const named = namedEngagement(payload)
    // Another project's, whatever else is wrong with it: that project's to
    // replay or count when it opens.
    if (named && named !== active.engagementId) {
      result.deferred++
      defer(name)
      continue
    }
    const agentType = typeof payload?.agent_type === 'string' ? payload.agent_type : ''
    const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : null
    const identity = identityOf(payload)
    // A payload without a complete durable identity cannot be assigned
    // safely: the hooks stamp one only while a project is open. Preserve it
    // instead of silently claiming it belongs to whichever project happens to
    // open. The capture card says how many are waiting here. A full quarantine
    // leaves it beside the waiting files as an earlier version did, still kept
    // and still counted by the card. Not counted in any project.
    if (!identity) {
      const dir = quarantineDirFor(directory, 'no-project')
      const moved = ledger.reserve(dir, stat.size) &&
        moveIntoQuarantine(file, dir, name, 'no-project', 'no engagement identity: no project was open when it was written', clock())
      if (!moved) { try { fs.renameSync(file, `${file}${LEGACY_UNATTRIBUTED_SUFFIX}`) } catch { /* left for the next pass */ } }
      result.unattributed++
      result.outcomes[name] = 'quarantined'
      continue
    }
    if (!agentType || !data) {
      setAside(file, name, stat.size, 'malformed', 'no agent_type or no data object', 'this', clock())
      continue
    }
    const at = claimedTime(data, clock()) ?? clock()
    // Counted by a committed row and still here: its move or removal failed.
    // It is not offered to the pipeline again — a loss already on the record
    // must not also become a row — only that step is retried.
    const countedAs = options.countedAs?.(name) ?? null
    if (countedAs !== null) {
      if (INTENTIONAL_REASONS.has(countedAs)) {
        plan.add(countedAs, true, 'this', at, { file, name, action: { kind: 'unlink' } })
        result.outcomes[name] = 'dropped'
      } else {
        setAside(file, name, stat.size, QUARANTINE_REASONS.has(countedAs) ? countedAs as QuarantineReason : 'failed', 'counted earlier; the move did not happen then', 'this', at)
      }
      continue
    }
    let outcome: boolean | SpoolOutcome
    try {
      outcome = emit({
        agentType,
        data: {
          ...data,
          recovered_from_spool: true
        },
        engagementId: identity.engagementId,
        operatorId: identity.operatorId,
        targetId: bodyTargetId(payload)
      })
    } catch (e) {
      outcome = { outcome: 'failed', detail: (e as Error).message }
    }
    if (outcome === false) {
      result.deferred++
      defer(name)
      continue
    }
    const decided: SpoolOutcome = outcome === true ? { outcome: 'done' } : outcome
    if (decided.outcome === 'failed') {
      failed(file, name, stat.size, decided.detail)
      continue
    }
    backoff.delete(file)
    if (decided.outcome === 'invalid') {
      setAside(file, name, stat.size, decided.reason, decided.detail, 'this', at)
      continue
    }
    if (decided.outcome === 'rejected' && decided.reason === 'pause-end-unknown') {
      setAside(file, name, stat.size, 'pause-end-unknown', 'observed after a pause whose end was not recorded; recording may have resumed', 'this', at)
      continue
    }
    if (decided.outcome === 'rejected') {
      plan.add(decided.reason, true, 'this', at, { file, name, action: { kind: 'unlink' } })
      result.outcomes[name] = 'dropped'
      continue
    }
    // Handled. If this unlink fails the file is replayed again on a later pass:
    // within two seconds of the first row the dedup window drops a repeated
    // shell or agent command, but after that, or for any other kind, the
    // replay writes a second row. Spec 071 Phase 5's event_id is the fix.
    try { retryBusy(() => fs.unlinkSync(file)) } catch { /* see above */ }
    result.replayed++
    result.outcomes[name] = 'ingested'
  }
  result.losses = plan.list()
  result.retries = plan.retries
  return result
}

export interface SlicedDrainOptions {
  /** Replay up to `limit` files whose names sort after `after`, and return the
   *  last name looked at — or null when there was nothing to look at or the
   *  drain declined to run (recording paused, project gone). */
  drainOnce: (limit: number, after: string) => string | null
  /** Called once when a run of slices ends, however it ended. */
  finish?: () => void
  /** The most files one tick may look at, across all its slices. */
  total: number
  /** The most files looked at before yielding to the event loop. */
  slice: number
  /** False once the project this drain belongs to has closed. */
  isCurrent: () => boolean
  schedule?: (next: () => void) => void
}

/** The periodic spool drain, split so the event loop runs between slices.
 *
 *  The main thread also serves the local API, and replaying a file costs about
 *  20 ms through ingest(): two hundred in one call is a four-second stall of
 *  /api/health (#291). Same files, same order, `slice` at a time. Returns the
 *  tick to call on the interval, which takes an optional total for this one
 *  run; a tick that arrives while the last one is still working does nothing,
 *  and each slice resumes after the last name the previous one looked at, so a
 *  file is deleted only after ingest returns, exactly as before. */
export function drainInSlices(options: SlicedDrainOptions): (total?: number) => void {
  const { drainOnce, finish, slice, isCurrent, schedule = setImmediate } = options
  let running = false
  const step = (cursor: string, left: number): void => {
    let last: string | null = null
    try {
      if (isCurrent()) last = drainOnce(Math.min(slice, left), cursor)
    } catch { /* the files still on disk are retried next tick */ }
    const remaining = left - slice
    if (last === null || remaining <= 0) {
      running = false
      try { finish?.() } catch { /* the files it would have counted stay */ }
      return
    }
    const next = last
    schedule(() => step(next, remaining))
  }
  return (total = options.total) => {
    if (running) return
    running = true
    step('', total)
  }
}

/** What opening a project starts (Spec 071 FR-069): everything waiting, in
 *  slices, beginning on a later turn of the event loop — never inside the open
 *  itself, which used to replay the whole spool synchronously before the window
 *  could answer — and then the bounded tick on every `repeat`. */
export function startSpoolDrain(options: SlicedDrainOptions & { repeat: (tick: () => void) => void }): void {
  const tick = drainInSlices(options)
  const schedule = options.schedule ?? setImmediate
  schedule(() => tick(Number.POSITIVE_INFINITY))
  options.repeat(() => tick())
}
