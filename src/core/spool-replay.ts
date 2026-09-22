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
      // Pre-release payloads without a complete durable identity cannot be
      // assigned safely. Preserve them for manual inspection instead of
      // silently claiming they belong to whichever project happens to open.
      if (typeof identity?.engagementId !== 'string' || !identity.engagementId ||
          typeof identity.operatorId !== 'string' || !identity.operatorId) {
        fs.renameSync(file, `${file}.unattributed`)
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
