import fs from 'fs'
import path from 'path'

export interface SpoolReplayEvent {
  agentType: string
  data: Record<string, unknown>
  engagementId: string
  operatorId: string
  /** When the file was written, ms since the epoch. The hooks write it at the
   *  moment they gave up delivering, so it is the latest the item can have been
   *  observed; ingest uses it only for an item that carries no source time. */
  observedAt: number
}

/** Why a file was set aside for good (Spec 071 FR-050 / FR-066). */
export type QuarantineReason = 'malformed' | 'kind-not-allowed' | 'no-project' | 'legacy-bad'

/** What became of one replayed event, as the emitter reports it.
 *
 *  - `done`: written, or handled without a row on purpose (the 2 s dedup,
 *    RedLog's own plumbing, a gap judged away by the pauses). The file goes.
 *  - `rejected`: not written, deliberately, and never will be — observed during
 *    a pause, or from a terminal that was not recording. The file goes and the
 *    rejection is counted.
 *  - `invalid`: can never be written. The file goes to quarantine and is counted.
 *  - `failed`: the write did not happen this time. The file stays and is tried
 *    again after a back-off.
 *
 *  `true` and `false` are the older answers, `done` and "leave it in place". */
export type SpoolOutcome =
  | { outcome: 'done' }
  | { outcome: 'rejected'; reason: 'paused' | 'terminal-not-recording' }
  | { outcome: 'invalid'; reason: QuarantineReason; detail: string }
  | { outcome: 'failed'; detail: string }

/** Items not written, grouped by reason, for the gap row the drain writes. */
export interface SpoolLoss {
  reason: string
  intentional: boolean
  count: number
  /** How many of `count` are kept in quarantine; the rest were not kept, by
   *  design (a pause) or because the quarantine was full. */
  kept: number
  /** Earliest and latest observation among them, ms since the epoch. */
  firstAt: number
  lastAt: number
  /** `unknown` when the file could not be read far enough to say which project
   *  it belonged to. */
  owner: 'this' | 'unknown'
}

export interface SpoolReplayResult {
  replayed: number
  deferred: number
  unattributed: number
  invalid: number
  /** Files whose write failed and that stay for a later try, including those
   *  still inside their back-off. */
  failed: number
  /** The last file name looked at, replayed or not, or null when there was none.
   *  Pass it back as `after` to carry on from there. Files left in place count:
   *  another project's would otherwise pin a sliced drain behind them. */
  last: string | null
  losses: SpoolLoss[]
}

export interface SpoolReplayOptions {
  /** The clock, for the back-off. */
  now?: () => number
  quarantineMaxFiles?: number
  quarantineMaxBytes?: number
}

/** Where the drain sets aside what it will never write: beside the waiting
 *  files, so it shares their permissions, and in a directory, so the hooks'
 *  `*.json` count of waiting files does not see it. */
export function quarantineDirectory(spoolDirectory: string): string {
  return path.join(spoolDirectory, 'quarantine')
}

/** FR-066: per quarantine, 1000 files or 256 MiB. Past either, a file is
 *  counted and not kept. */
const QUARANTINE_MAX_FILES = 1000
const QUARANTINE_MAX_BYTES = 256 * 1024 * 1024
const WHY_SUFFIX = '.why'
const SEPARATOR = '--'

/** What an earlier version renamed a file to when it carried no project
 *  identity (#255), or could not be read. Replay no longer makes either; it
 *  moves the ones it finds into quarantine. */
const LEGACY_UNATTRIBUTED_SUFFIX = '.unattributed'
const LEGACY_BAD_SUFFIX = '.bad'

/** A file that does not parse and was written this recently may still be being
 *  written: the shell hooks do not write through a temp file. It is tried again
 *  rather than set aside for good. */
const YOUNG_FILE_MS = 10_000

const RECEIVER = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

/** Files whose write failed, and when each may be tried again. */
const backoff = new Map<string, { attempts: number; at: number }>()
const BACKOFF_FIRST_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000

function receivedTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

class Quarantine {
  private files = 0
  private bytes = 0
  private measured = false
  constructor(readonly dir: string, private readonly maxFiles: number, private readonly maxBytes: number) {}

  private measure(): void {
    if (this.measured) return
    this.measured = true
    let names: string[] = []
    try { names = fs.readdirSync(this.dir) } catch { return }
    for (const name of names) {
      try { this.bytes += fs.statSync(path.join(this.dir, name)).size } catch { continue }
      if (!name.endsWith(WHY_SUFFIX)) this.files++
    }
  }

  /** Move `file` in under `reason`, with a `.why` beside it. False when the
   *  quarantine is full or the move failed; the caller decides what that means. */
  admit(file: string, baseName: string, reason: QuarantineReason, detail: string, now: number): boolean {
    this.measure()
    let size = 0
    try { size = fs.statSync(file).size } catch { return false }
    if (this.files + 1 > this.maxFiles || this.bytes + size > this.maxBytes) return false
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      let target = path.join(this.dir, `${reason}${SEPARATOR}${baseName}`)
      for (let n = 1; fs.existsSync(target); n++) target = path.join(this.dir, `${reason}${SEPARATOR}${baseName}.${n}`)
      fs.renameSync(file, target)
      const why = JSON.stringify({ reason, detail, at: now, receiver: RECEIVER })
      try { fs.writeFileSync(`${target}${WHY_SUFFIX}`, why, { mode: 0o600 }) } catch { /* the name still says why */ }
      this.files++
      this.bytes += size + Buffer.byteLength(why)
      return true
    } catch {
      return false
    }
  }
}

/** Tallies losses by reason. */
class LossTally {
  private readonly byReason = new Map<string, SpoolLoss>()
  add(reason: string, intentional: boolean, owner: SpoolLoss['owner'], at: number, kept: boolean): void {
    const key = `${reason}\u0000${owner}`
    const row = this.byReason.get(key) ?? { reason, intentional, count: 0, kept: 0, firstAt: at, lastAt: at, owner }
    row.count++
    if (kept) row.kept++
    if (at < row.firstAt) row.firstAt = at
    if (at > row.lastAt) row.lastAt = at
    this.byReason.set(key, row)
  }
  list(): SpoolLoss[] { return [...this.byReason.values()] }
}

export interface UnattributedSpoolSummary {
  count: number
  /** When the oldest and newest of them were written, ms since the epoch. */
  oldestAt: number
  newestAt: number
}

/** The commands no project could claim (#255): quarantined as `no-project`, or
 *  an earlier version's `*.unattributed` not yet moved. Paths, not names. */
function unattributedFiles(directory: string): string[] {
  const out: string[] = []
  const q = quarantineDirectory(directory)
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

function identityOf(payload: unknown): { engagementId: string; operatorId: string } | null {
  const identity = (payload as { _identity?: { engagementId?: unknown; operatorId?: unknown } } | null)?._identity
  if (typeof identity?.engagementId !== 'string' || !identity.engagementId ||
      typeof identity.operatorId !== 'string' || !identity.operatorId) return null
  return { engagementId: identity.engagementId, operatorId: identity.operatorId }
}

export interface LegacySpoolMigration {
  legacyBad: number
  noProject: number
  losses: SpoolLoss[]
}

/** Move what an earlier version set aside into the quarantine, once (Spec 071
 *  FR-069): `*.bad` as `legacy-bad`, `*.unattributed` as `no-project`.
 *
 *  A `.bad` file whose identity names another project is left where it is for
 *  that project to move and count when it opens, as a waiting file would be
 *  (Spec 002 FR-001). One that names this project, or that cannot be read far
 *  enough to say, is moved and counted here. Nothing is deleted: a file the
 *  full quarantine cannot take stays where it is. */
export function migrateLegacySpoolFiles(
  directory: string,
  active: { engagementId: string },
  options: SpoolReplayOptions = {}
): LegacySpoolMigration {
  const result: LegacySpoolMigration = { legacyBad: 0, noProject: 0, losses: [] }
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return result }
  const now = (options.now ?? Date.now)()
  const quarantine = new Quarantine(quarantineDirectory(directory), options.quarantineMaxFiles ?? QUARANTINE_MAX_FILES, options.quarantineMaxBytes ?? QUARANTINE_MAX_BYTES)
  const tally = new LossTally()
  for (const name of names.sort()) {
    const unattributed = name.endsWith(LEGACY_UNATTRIBUTED_SUFFIX)
    if (!unattributed && !name.endsWith(LEGACY_BAD_SUFFIX)) continue
    const file = path.join(directory, name)
    const base = name.slice(0, -(unattributed ? LEGACY_UNATTRIBUTED_SUFFIX : LEGACY_BAD_SUFFIX).length)
    let at = now
    try { at = Math.round(fs.statSync(file).mtimeMs) } catch { continue }
    if (unattributed) {
      if (quarantine.admit(file, base, 'no-project', 'set aside as .unattributed by an earlier version', now)) result.noProject++
      continue
    }
    let owner: SpoolLoss['owner'] = 'unknown'
    try {
      const identity = identityOf(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (identity && identity.engagementId !== active.engagementId) continue
      if (identity) owner = 'this'
    } catch { /* unreadable: owner unknown */ }
    if (quarantine.admit(file, base, 'legacy-bad', 'set aside as .bad by an earlier version', now)) {
      result.legacyBad++
      tally.add('legacy-bad', false, owner, at, true)
    }
  }
  result.losses = tally.list()
  return result
}

/** Replay only files attributable to the active engagement. Mismatches remain
 * byte-for-byte in place so opening their owning project can recover them. */
export function replaySpoolDirectory(
  directory: string,
  active: { engagementId: string; operatorId: string },
  emit: (event: SpoolReplayEvent) => boolean | SpoolOutcome,
  limit = Number.POSITIVE_INFINITY,
  after = '',
  options: SpoolReplayOptions = {}
): SpoolReplayResult {
  const result: SpoolReplayResult = { replayed: 0, deferred: 0, unattributed: 0, invalid: 0, failed: 0, last: null, losses: [] }
  if (!fs.existsSync(directory)) return result
  const clock = options.now ?? Date.now
  const quarantine = new Quarantine(quarantineDirectory(directory), options.quarantineMaxFiles ?? QUARANTINE_MAX_FILES, options.quarantineMaxBytes ?? QUARANTINE_MAX_BYTES)
  const tally = new LossTally()
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json') && name > after).sort().slice(0, limit)

  /** Set `file` aside for good; past the bound, delete it and say it was not kept. */
  const setAside = (file: string, name: string, reason: QuarantineReason, detail: string, owner: SpoolLoss['owner'], at: number): void => {
    const kept = quarantine.admit(file, name, reason, detail, clock())
    if (!kept) { try { fs.unlinkSync(file) } catch { /* left for the next pass */ } }
    result.invalid++
    tally.add(reason, false, owner, at, kept)
  }

  for (const name of files) {
    result.last = name
    const file = path.join(directory, name)
    const held = backoff.get(file)
    if (held && clock() < held.at) {
      result.failed++
      continue
    }
    let mtime: number
    let payload: { agent_type?: unknown; data?: unknown }
    try {
      mtime = Math.round(fs.statSync(file).mtimeMs)
    } catch {
      backoff.delete(file)
      continue // gone since the listing
    }
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof payload
    } catch (e) {
      if (clock() - mtime < YOUNG_FILE_MS) { result.failed++; continue }
      setAside(file, name, 'malformed', (e as Error).message, 'unknown', mtime)
      continue
    }
    const agentType = typeof payload?.agent_type === 'string' ? payload.agent_type : ''
    const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : null
    const identity = identityOf(payload)
    if (!agentType || !data) {
      setAside(file, name, 'malformed', 'no agent_type or no data object', identity?.engagementId === active.engagementId ? 'this' : 'unknown', mtime)
      continue
    }
    // A payload without a complete durable identity cannot be assigned
    // safely: the hooks stamp one only while a project is open. Preserve it
    // instead of silently claiming it belongs to whichever project happens to
    // open. The capture card says how many are waiting here. A full quarantine
    // leaves it beside the waiting files as an earlier version did, still kept
    // and still counted by the card.
    if (!identity) {
      if (!quarantine.admit(file, name, 'no-project', 'no engagement identity: no project was open when it was written', clock())) {
        try { fs.renameSync(file, `${file}${LEGACY_UNATTRIBUTED_SUFFIX}`) } catch { /* left for the next pass */ }
      }
      result.unattributed++
      continue
    }
    if (identity.engagementId !== active.engagementId) {
      result.deferred++
      continue
    }
    const sourceTime = receivedTime(data.source_timestamp)
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
        observedAt: mtime
      })
    } catch (e) {
      outcome = { outcome: 'failed', detail: (e as Error).message }
    }
    if (outcome === false) {
      result.deferred++
      continue
    }
    const decided: SpoolOutcome = outcome === true ? { outcome: 'done' } : outcome
    if (decided.outcome === 'failed') {
      const attempts = (held?.attempts ?? 0) + 1
      backoff.set(file, { attempts, at: clock() + Math.min(BACKOFF_FIRST_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS) })
      result.failed++
      continue
    }
    backoff.delete(file)
    if (decided.outcome === 'invalid') {
      setAside(file, name, decided.reason, decided.detail, 'this', sourceTime ?? mtime)
      continue
    }
    try { fs.unlinkSync(file) } catch { /* replayed; a second pass answers duplicate */ }
    if (decided.outcome === 'rejected') tally.add(decided.reason, true, 'this', sourceTime ?? mtime, false)
    else result.replayed++
  }
  result.losses = tally.list()
  return result
}

export interface SlicedDrainOptions {
  /** Replay up to `limit` files whose names sort after `after`, and return the
   *  last name looked at — or null when there was nothing to look at or the
   *  drain declined to run (project gone). */
  drainOnce: (limit: number, after: string) => string | null
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
  const { drainOnce, slice, isCurrent, schedule = setImmediate } = options
  let running = false
  const step = (cursor: string, left: number): void => {
    let last: string | null = null
    try {
      if (isCurrent()) last = drainOnce(Math.min(slice, left), cursor)
    } catch { /* the files still on disk are retried next tick */ }
    const remaining = left - slice
    if (last === null || remaining <= 0) { running = false; return }
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
