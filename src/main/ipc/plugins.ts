import type { IpcMain } from 'electron'
import { shell } from 'electron'
import path from 'path'
import { homedir } from 'os'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
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
    error: p.error
  }))
}

export function registerPluginsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('plugins:list', () => pluginView())
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
    const engagementId = ctx.getCurrentEngagementId()
    const operatorId = ctx.getCurrentOperatorId()
    // No open project means no chain to write to. The state change still
    // happens -- refusing it would be worse -- and the next project to open
    // inherits it, which is the app-wide scope doing what it says.
    if (engagementId && operatorId) {
      try {
        const ev = insertEvent('system', {
          subtype: 'config_changed',
          changed: { [`plugin.${id}.enabled`]: { from: before ? before.status !== 'disabled' : null, to: enabled } },
          description: `Plugin ${enabled ? 'enabled' : 'disabled'}: ${before?.manifest.name ?? id}`
        }, { engagementId, operatorId })
        if (ev) eventBus.publish(ev)
      } catch { /* additive: the state change is not undone by a failed log */ }
    }
    return pluginView()
  })
  ipcMain.handle('plugins:grant', (_e, id: string) => {
    const project = ctx.getActiveProject()
    const opId = project ? loadConfig(getProjectPath(project)).operator.id : 'unknown'
    const r = grantPluginTrust(id, opId); return { ...r, plugins: pluginView() }
  })
  ipcMain.handle('plugins:revoke', (_e, id: string) => { revokePluginTrust(id); return pluginView() })
}
