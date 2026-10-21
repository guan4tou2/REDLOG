import path from 'node:path'
import type { OfficialAgentPlugin } from './plugins/official-agents'
import type { LoadedPlugin } from './plugins/types'
export type AgentKind = OfficialAgentPlugin['agentKind']
export interface AgentCaptureSourceConfig { enabled?: boolean; installationId?: string; workPaths?: string[]; startedAt?: number }
export interface AgentCaptureConfig { agentTailer?: { sources?: Partial<Record<AgentKind, AgentCaptureSourceConfig>> } }
export interface ActiveAgentCapture { agentKind: AgentKind; workPaths: string[]; startedAt: number }
export function resolveAgentCapture(config: AgentCaptureConfig, catalog: readonly OfficialAgentPlugin[], plugins: readonly LoadedPlugin[]): ActiveAgentCapture[] {
  return catalog.flatMap(entry => {
    const source = config.agentTailer?.sources?.[entry.agentKind]
    if (entry.state !== 'installed' || !plugins.some(p => p.manifest.id === entry.pluginId && p.status === 'active')) return []
    if (!entry.installationId || source?.installationId !== entry.installationId) return []
    if (source?.enabled !== true || !Number.isSafeInteger(source.startedAt) || source.startedAt! <= 0) return []
    const paths = source.workPaths
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.trim() || !path.isAbsolute(p))) return []
    return [{ agentKind: entry.agentKind, workPaths: [...new Set(paths)], startedAt: source.startedAt! }]
  })
}

export function agentTranscriptRoot(kind: AgentKind, home: string): string {
  return kind === 'claude-code' ? path.join(home, '.claude', 'projects') : kind === 'codex' ? path.join(home, '.codex', 'sessions') : path.join(home, '.local', 'share', 'opencode', 'storage', 'message')
}
