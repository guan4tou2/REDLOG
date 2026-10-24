import path from 'node:path'
import type { OfficialAgentPlugin } from './plugins/official-agents'
import type { LoadedPlugin } from './plugins/types'
export type AgentKind = string
export interface AgentCaptureSourceConfig {
  /** Transcript directory, independent of authorized working directories. */
  sourceRoot?: string
  excludedSessions?: string[]
  sessionStarts?: Record<string, number>
  enabled?: boolean
  installationId?: string
  workPaths?: string[]
  startedAt?: number
  /** When the project scope last changed under a recording source.
   *
   *  A scope change stops recording on purpose: the operator widened or
   *  narrowed what this project may read, and the new range has not been
   *  agreed to yet. `resolveAgentCapture` already stops on `enabled !== true`,
   *  so this marker buys no behaviour — it buys the SETTINGS a sentence that
   *  is true: "the scope changed, nothing is being recorded until you
   *  confirm it", instead of the generic "not recording" that reads the same
   *  whether the source was never enabled or was just switched off. */
  scopeChangedAt?: number
}
export interface AgentCaptureConfig { agentTailer?: { sources?: Partial<Record<AgentKind, AgentCaptureSourceConfig>> } }
export interface ActiveAgentCapture { agentKind: AgentKind; workPaths: string[]; startedAt: number }
export function resolveAgentCapture(config: AgentCaptureConfig, catalog: readonly OfficialAgentPlugin[], plugins: readonly LoadedPlugin[]): ActiveAgentCapture[] {
  return catalog.flatMap(entry => {
    const source = config.agentTailer?.sources?.[entry.agentKind]
    if (entry.state !== 'installed' || !plugins.some(p => p.manifest.id === entry.pluginId && p.status === 'active')) return []
    if (!entry.installationId || source?.installationId !== entry.installationId) return []
    if (source?.enabled !== true || !Number.isSafeInteger(source.startedAt) || source.startedAt! <= 0) return []
    if (source.sourceRoot !== undefined && (typeof source.sourceRoot !== 'string' || !source.sourceRoot.trim() || !path.isAbsolute(source.sourceRoot))) return []
    if (source.excludedSessions !== undefined && (!Array.isArray(source.excludedSessions) || source.excludedSessions.some(id => typeof id !== 'string' || !id || id.length > 300))) return []
    if (source.sessionStarts !== undefined && (!source.sessionStarts || typeof source.sessionStarts !== 'object' || Array.isArray(source.sessionStarts) || Object.values(source.sessionStarts).some(at => !Number.isSafeInteger(at) || at <= 0))) return []
    const paths = source.workPaths
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.trim() || !path.isAbsolute(p))) return []
    return [{ agentKind: entry.agentKind, workPaths: [...new Set(paths)], startedAt: source.startedAt! }]
  })
}

export function agentTranscriptRoot(entry: Pick<OfficialAgentPlugin, 'source'>, home: string, source?: AgentCaptureSourceConfig, env: Record<string, string | undefined> = process.env): string {
  if (source?.sourceRoot !== undefined) {
    if (!source.sourceRoot.trim() || !path.isAbsolute(source.sourceRoot)) throw new Error('AI transcript directory must be absolute')
    return source.sourceRoot
  }
  const location = entry.source
  const vendorRoot = location.configEnv ? env[location.configEnv] : undefined
  if (vendorRoot && path.isAbsolute(vendorRoot)) return path.join(vendorRoot, location.envSuffix ?? '')
  return path.join(home, location.defaultPath)
}
