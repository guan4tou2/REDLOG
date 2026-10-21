import type { IpcMain } from 'electron'
import { shell } from 'electron'
import path from 'path'
import { homedir } from 'os'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { testSample } from '../../core/plugins/test-sample'
import { getContributionReport } from '../../core/plugins/contributions'
import { createOfficialAgentPluginManager } from '../../core/plugins/official-agents'
import { listPlugins, listEventTypes, setPluginEnabled, grantPluginTrust, revokePluginTrust, reloadPlugins } from '../../core/plugins'
import { invalidateHooksCache } from '../../core/capture-health'
import { invalidateHooksCache as invalidateHooksDetectCache } from '../../core/hooks-manager'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'

// Serialise LoadedPlugin to a UI-friendly shape (drop absolute dirs/hashes we
// don't need in the renderer; keep what the panel renders + acts on).
function pluginView() {
  return listPlugins().map((p) => ({
    id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
    description: p.manifest.description ?? '', author: p.manifest.author ?? '',
    source: p.source, tier: p.tier, status: p.status,
    capabilities: p.manifest.capabilities ?? [],
    contributes: Object.keys(p.manifest.contributes ?? {}),
    error: p.error,
    apiAhead: p.apiAhead === true,
    report: getContributionReport(p.manifest.id) ?? null
  }))
}

/** Write a plugin state change into the open project's record, when there is
 *  one. No open project means no chain to write to; the change still happens
 *  (the flag is app-wide) and the next project inherits it. */
function auditPluginChange(ctx: IpcContext, changed: Record<string, { from: unknown; to: unknown }>, description: string): void {
  const engagementId = ctx.getCurrentEngagementId()
  const operatorId = ctx.getCurrentOperatorId()
  if (!engagementId || !operatorId) return
  try {
    const ev = insertEvent('system', { subtype: 'config_changed', changed, description }, { engagementId, operatorId })
    if (ev) eventBus.publish(ev)
  } catch { /* additive: the state change is not undone by a failed log */ }
}

export function registerPluginsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('plugins:list', () => pluginView())
  const officialAgents = createOfficialAgentPluginManager(path.join(homedir(), '.redlog', 'plugins'))
  ipcMain.handle('plugins:officialAgents', () => officialAgents.list())
  const mutateOfficialAgent = (operation: 'install' | 'uninstall', agentKind: unknown) => {
    const before = officialAgents.list().find(entry => entry.agentKind === agentKind)
    const result = officialAgents[operation](agentKind)
    // A final-directory cleanup failure can follow a successful manifest
    // removal. Refresh in that case too, while keeping the error visible.
    if (result.changed && result.pluginId) {
      reloadPlugins()
      invalidateHooksCache(); invalidateHooksDetectCache(); ctx.onPluginsChanged()
      auditPluginChange(ctx, {
        [`plugin.${result.pluginId}.installed`]: { from: before?.state === 'installed', to: operation === 'install' }
      }, `Official AI capture integration ${operation === 'install' ? 'installed' : 'removed'}: ${result.pluginId}`)
    }
    return result
  }
  ipcMain.handle('plugins:installOfficialAgent', (_e, agentKind: unknown) => mutateOfficialAgent('install', agentKind))
  ipcMain.handle('plugins:uninstallOfficialAgent', (_e, agentKind: unknown) => mutateOfficialAgent('uninstall', agentKind))
  // Dry run on pasted text: writes nothing, emits nothing.
  ipcMain.handle('plugins:testSample', (_e, text: unknown) => {
    const project = ctx.getActiveProject()
    const disabledRules = project ? loadConfig(getProjectPath(project)).loot?.disabledRules ?? [] : []
    return testSample(typeof text === 'string' ? text : '', { disabledRules })
  })
  ipcMain.handle('plugins:eventTypes', () => listEventTypes())
  ipcMain.handle('plugins:reload', () => { invalidateHooksCache(); invalidateHooksDetectCache(); reloadPlugins(); ctx.onPluginsChanged(); return pluginView() })
  // Open the user plugin dir in Finder/Explorer so operators can drop new
  // plugin folders in and reload without hunting for the path.
  ipcMain.handle('plugins:openFolder', async () => {
    const dir = path.join(homedir(), '.redlog', 'plugins')
    try { await fs.promises.mkdir(dir, { recursive: true }) } catch { /* ignore */ }
    shell.openPath(dir)
    return dir
  })
  // Switching a capture source on or off changes what the record will contain
  // from this moment, and it left no trace of itself: `setPluginEnabled`
  // writes ~/.redlog/plugins/state.json and nothing else. config-audit covers
  // packs and pack members, never plugins, so a handed-over record could have
  // a gap in it that nothing in the record explains. The flag is app-wide, so
  // the gap is not even confined to the project it was thrown in.
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) => {
    const before = listPlugins().find((p) => p.manifest.id === id)
    setPluginEnabled(id, enabled)
    invalidateHooksCache(); invalidateHooksDetectCache(); ctx.onPluginsChanged()
    auditPluginChange(ctx, {
      [`plugin.${id}.enabled`]: { from: before ? before.status !== 'disabled' : null, to: enabled }
    }, `Plugin ${enabled ? 'enabled' : 'disabled'}: ${before?.manifest.name ?? id}`)
    return pluginView()
  })
  // Trust decides whether a plugin's code runs, so the grant and the revoke
  // are as much a part of the record as enable/disable are: a handed-over
  // record has to be able to explain why a source started or stopped.
  ipcMain.handle('plugins:grant', (_e, id: string) => {
    const project = ctx.getActiveProject()
    const opId = project ? loadConfig(getProjectPath(project)).operator.id : 'unknown'
    const before = listPlugins().find((p) => p.manifest.id === id)
    const r = grantPluginTrust(id, opId)
    if (r.ok) {
      invalidateHooksCache(); invalidateHooksDetectCache(); ctx.onPluginsChanged()
      auditPluginChange(ctx, {
        [`plugin.${id}.trusted`]: { from: false, to: true },
        [`plugin.${id}.capabilities`]: { from: null, to: before?.manifest.capabilities ?? [] },
        ...(before?.contentHash ? { [`plugin.${id}.content_sha256`]: { from: null, to: before.contentHash } } : {})
      }, `Plugin trusted: ${before?.manifest.name ?? id}`)
    }
    return { ...r, plugins: pluginView() }
  })
  ipcMain.handle('plugins:revoke', (_e, id: string) => {
    const before = listPlugins().find((p) => p.manifest.id === id)
    revokePluginTrust(id)
    invalidateHooksCache(); invalidateHooksDetectCache(); ctx.onPluginsChanged()
    auditPluginChange(ctx, { [`plugin.${id}.trusted`]: { from: true, to: false } }, `Plugin trust revoked: ${before?.manifest.name ?? id}`)
    return pluginView()
  })
}
