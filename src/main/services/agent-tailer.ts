// Shared host only. Optional packages provide parsers; no provider module is
// imported or registered until its installation and project authorization pass.
import fs from 'node:fs'
import os from 'node:os'
import chokidar from 'chokidar'
import { configureHost, registerAdapter, unregisterAdapter, type TailerHostConfig, type TailerAdapter } from './tailer-host'
import { agentTranscriptRoot, type AgentCaptureConfig } from '../../core/agent-capture-policy'
import { createOfficialAgentPluginManager } from '../../core/plugins/official-agents'
import path from 'node:path'
import { noteCaptureError } from '../../core/capture-health'

interface AgentModule { agentKind: string; modulePath: string; root: string }
export interface AgentTailerConfig extends TailerHostConfig { integrations?: AgentModule[] }
const loaded = new Map<string, string>()
function unload(): void {
  // Stop before discarding module instances, including auxiliary watchers.
  for (const [kind, file] of loaded) { unregisterAdapter(kind); delete require.cache[file] }
  loaded.clear()
}
export function configureAgentTailer(next: Partial<AgentTailerConfig>): void {
  const { integrations, ...hostCfg } = next
  if (integrations !== undefined) {
    configureHost({ enabled: false, enabledAgents: [] })
    unload()
    for (const entry of integrations) {
      let cacheKey = entry.modulePath
      try {
        cacheKey = require.resolve(entry.modulePath)
        const plugin = require(cacheKey) as { createAdapter?: (root: string, services: { watch: typeof chokidar.watch }) => TailerAdapter }
        const adapter = plugin.createAdapter?.(entry.root, { watch: chokidar.watch })
        if (!adapter || adapter.agentKind !== entry.agentKind || typeof adapter.parseUnit !== 'function' || typeof adapter.subtypeFor !== 'function' || !(adapter.knownIngestTypes instanceof Set)) throw new Error('AI plugin has no compatible adapter')
        registerAdapter(adapter); loaded.set(entry.agentKind, cacheKey)
      } catch (e) {
        delete require.cache[cacheKey]
        noteCaptureError(`agent-${entry.agentKind}`, e)
      }
    }
  }
  configureHost(hostCfg)
}
export function stopAgentTailer(): void {
  configureHost({ enabled: false, enabledAgents: [] })
  unload()
}
export interface AgentSourceInfo { id: string; label: string; root: string; detected: boolean }
/** Metadata and existence only; never require a module or open a transcript. */
export function describeAgentSources(config: AgentCaptureConfig = {}): AgentSourceInfo[] {
  return createOfficialAgentPluginManager(path.join(os.homedir(), '.redlog', 'plugins')).list().map(entry => {
    const root = agentTranscriptRoot(entry, os.homedir(), config.agentTailer?.sources?.[entry.agentKind])
    return { id: entry.agentKind, label: entry.name, root, detected: fs.existsSync(root) }
  })
}
