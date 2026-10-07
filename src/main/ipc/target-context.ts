import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig, saveConfig } from '../../core/config'
import { configureIngest, ingestEvent } from '../../core/ingest'

function cleanTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const target = value.trim()
  return target ? target.slice(0, 253) : null
}

export function registerTargetContextIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('targetContext:get', () => {
    const project = ctx.getActiveProject()
    if (!project) return null
    return cleanTarget(loadConfig(getProjectDir(project)).engagement.activeTarget)
  })

  ipcMain.handle('targetContext:set', (_event, requested: unknown) => {
    const project = ctx.getActiveProject()
    const engagementId = ctx.getCurrentEngagementId()
    const operatorId = ctx.getCurrentOperatorId()
    if (!project || !engagementId || !operatorId) return { ok: false, target: null }

    const projectDir = getProjectDir(project)
    const config = loadConfig(projectDir)
    const previous = cleanTarget(config.engagement.activeTarget)
    const target = cleanTarget(requested)
    if (previous === target) return { ok: true, target }

    config.engagement.activeTarget = target
    saveConfig(projectDir, config)
    configureIngest({ activeTarget: target })
    ingestEvent('system', {
      subtype: 'active_target_changed',
      previous_target: previous,
      active_target: target,
      description: target ? `Current target set to ${target}` : 'Current target cleared'
    }, { engagementId, operatorId, targetId: target ?? undefined, bypassPause: true })
    ctx.send(ctx.getMainWindow(), 'targetContext:changed', target)
    ctx.send(ctx.getOverlayWindow(), 'targetContext:changed', target)
    return { ok: true, target }
  })
}
