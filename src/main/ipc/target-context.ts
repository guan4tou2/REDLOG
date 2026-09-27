import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig, saveConfig } from '../../core/config'
import { configureIngest, ingestEvent } from '../../core/ingest'
import { bindSessionTarget, sessionTargetOf } from '../../core/session-targets'

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

  // #219: a built-in terminal's own target. It outranks the global one for
  // that pane's events. The change is recorded, not written back into earlier
  // rows: what was attributed before stays as it was.
  ipcMain.handle('targetContext:getSession', (_event, terminalId: unknown) => {
    return typeof terminalId === 'string' ? sessionTargetOf(terminalId) : null
  })

  ipcMain.handle('targetContext:bindSession', (_event, terminalId: unknown, requested: unknown) => {
    const engagementId = ctx.getCurrentEngagementId()
    const operatorId = ctx.getCurrentOperatorId()
    if (typeof terminalId !== 'string' || !terminalId || !engagementId || !operatorId) return { ok: false, target: null }
    const { previous, target } = bindSessionTarget(terminalId, cleanTarget(requested))
    if (previous === target) return { ok: true, target }
    ingestEvent('system', {
      subtype: 'session_target_changed',
      terminalId,
      previous_target: previous,
      session_target: target,
      description: target ? `Terminal ${terminalId} bound to ${target}` : `Terminal ${terminalId} follows the current target again`
    }, { engagementId, operatorId, targetId: target ?? undefined, bypassPause: true })
    return { ok: true, target }
  })
}
