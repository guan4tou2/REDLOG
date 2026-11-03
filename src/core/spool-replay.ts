import fs from 'fs'
import path from 'path'

export interface SpoolReplayEvent {
  agentType: string
  data: Record<string, unknown>
  engagementId: string
  operatorId: string
}

export interface SpoolReplayResult {
  replayed: number
  deferred: number
  unattributed: number
  invalid: number
  /** The last file name looked at, replayed or not, or null when there was none.
   *  Pass it back as `after` to carry on from there. Files left in place count:
   *  another project's would otherwise pin a sliced drain behind them. */
  last: string | null
}

/** What replay renames a spool file to when its payload carries no engagement
 *  identity. The hooks only stamp one while a project is open, so this is what
 *  becomes of every command typed while RedLog was closed or sitting on the
 *  project picker (#255). */
const UNATTRIBUTED_SUFFIX = '.unattributed'

export interface UnattributedSpoolSummary {
  count: number
  /** When the oldest and newest of them were written, ms since the epoch. */
  oldestAt: number
  newestAt: number
}

/** What replay has set aside and nobody has looked at, as it stands on disk.
 *
 *  Counted from the directory rather than from a replay's return value: the
 *  files outlive the run that renamed them, and an operator opening RedLog next
 *  week needs the same answer as one opening it a minute later. The time is the
 *  file's own mtime — a rename keeps it, and a hook writes the file at the
 *  moment the command ran — so nothing has to be parsed. Null when there are
 *  none, which is also what a missing directory means. */
export function summarizeUnattributedSpool(directory: string): UnattributedSpoolSummary | null {
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return null }
  let count = 0
  let oldestAt = Number.POSITIVE_INFINITY
  let newestAt = Number.NEGATIVE_INFINITY
  for (const name of names) {
    if (!name.endsWith(UNATTRIBUTED_SUFFIX)) continue
    let at: number
    try { at = Math.round(fs.statSync(path.join(directory, name)).mtimeMs) } catch { continue }
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
 *  Only `*.unattributed` — never a `.json` still waiting for replay, and never
 *  a `.bad` that someone may want to inspect. */
export function clearUnattributedSpool(directory: string, upTo: number): ClearUnattributedResult {
  const result = { removed: 0, failed: 0 }
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return result }
  for (const name of names) {
    if (!name.endsWith(UNATTRIBUTED_SUFFIX)) continue
    const file = path.join(directory, name)
    try {
      if (Math.round(fs.statSync(file).mtimeMs) > upTo) continue
      fs.unlinkSync(file)
      result.removed++
    } catch {
      result.failed++
    }
  }
  return result
}

/** Replay only files attributable to the active engagement. Mismatches remain
 * byte-for-byte in place so opening their owning project can recover them. */
export function replaySpoolDirectory(
  directory: string,
  active: { engagementId: string; operatorId: string },
  emit: (event: SpoolReplayEvent) => boolean,
  limit = Number.POSITIVE_INFINITY,
  after = ''
): SpoolReplayResult {
  const result: SpoolReplayResult = { replayed: 0, deferred: 0, unattributed: 0, invalid: 0, last: null }
  if (!fs.existsSync(directory)) return result
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json') && name > after).sort().slice(0, limit)
  for (const name of files) {
    result.last = name
    const file = path.join(directory, name)
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        agent_type?: unknown
        data?: unknown
        _identity?: { engagementId?: string; operatorId?: string }
      }
      const agentType = typeof payload.agent_type === 'string' ? payload.agent_type : ''
      const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : null
      if (!agentType || !data) throw new Error('invalid spool payload')
      const identity = payload._identity
      // A payload without a complete durable identity cannot be assigned
      // safely: the hooks stamp one only while a project is open. Preserve it
      // instead of silently claiming it belongs to whichever project happens to
      // open. The capture card says how many are waiting here.
      if (typeof identity?.engagementId !== 'string' || !identity.engagementId ||
          typeof identity.operatorId !== 'string' || !identity.operatorId) {
        fs.renameSync(file, `${file}${UNATTRIBUTED_SUFFIX}`)
        result.unattributed++
        continue
      }
      if (identity.engagementId !== active.engagementId) {
        result.deferred++
        continue
      }
      const accepted = emit({
        agentType,
        data: {
          ...data,
          recovered_from_spool: true
        },
        engagementId: identity.engagementId,
        operatorId: identity.operatorId
      })
      if (!accepted) {
        result.deferred++
        continue
      }
      fs.unlinkSync(file)
      result.replayed++
    } catch {
      try { fs.renameSync(file, `${file}.bad`) } catch { /* preserve best effort */ }
      result.invalid++
    }
  }
  return result
}

export interface SlicedDrainOptions {
  /** Replay up to `limit` files whose names sort after `after`, and return the
   *  last name looked at — or null when there was nothing to look at or the
   *  drain declined to run (recording paused, project gone). */
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
 *  tick to call on the interval; a tick that arrives while the last one is
 *  still working does nothing, and each slice resumes after the last name the
 *  previous one looked at, so a file is deleted only after ingest returns,
 *  exactly as before. */
export function drainInSlices(options: SlicedDrainOptions): () => void {
  const { drainOnce, total, slice, isCurrent, schedule = setImmediate } = options
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
  return () => {
    if (running) return
    running = true
    step('', total)
  }
}
