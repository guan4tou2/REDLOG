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
  invalid: number
}

/** Replay only files attributable to the active engagement. Mismatches remain
 * byte-for-byte in place so opening their owning project can recover them. */
export function replaySpoolDirectory(
  directory: string,
  active: { engagementId: string; operatorId: string },
  emit: (event: SpoolReplayEvent) => void,
  limit = Number.POSITIVE_INFINITY
): SpoolReplayResult {
  const result = { replayed: 0, deferred: 0, invalid: 0 }
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
      if (identity?.engagementId && identity.engagementId !== active.engagementId) {
        result.deferred++
        continue
      }
      emit({
        agentType,
        data: {
          ...data,
          recovered_from_spool: true,
          ...(!identity?.engagementId ? { spool_attribution: 'unattributed' } : {})
        },
        engagementId: identity?.engagementId ?? active.engagementId,
        operatorId: identity?.operatorId ?? active.operatorId
      })
      fs.unlinkSync(file)
      result.replayed++
    } catch {
      try { fs.renameSync(file, `${file}.bad`) } catch { /* preserve best effort */ }
      result.invalid++
    }
  }
  return result
}
