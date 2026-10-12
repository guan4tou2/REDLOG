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
  limit = Number.POSITIVE_INFINITY
): SpoolReplayResult {
  const result = { replayed: 0, deferred: 0, unattributed: 0, invalid: 0 }
  if (!fs.existsSync(directory)) return result
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().slice(0, limit)
  for (const name of files) {
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
