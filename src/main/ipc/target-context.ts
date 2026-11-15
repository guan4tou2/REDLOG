import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig, type RedLogConfig } from '../../core/config'
import { ingestEvent } from '../../core/ingest'

function cleanTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const target = value.trim()
  return target ? target.slice(0, 253) : null
}

/** The operator's selected target of the open project, from the config last
 *  APPLIED to it (main/config-apply.ts `applied()`), not from the file: the
 *  config the project is running with. Null when no project is open, nothing is
 *  applied yet (the window inside a project open), or what is applied belongs
 *  to another open (its generation differs): never a previous project's. */
export function selectedTargetOf(
  open: { generation: number } | null,
  applied: { generation: number; input: { config: { engagement: { activeTarget?: string | null } } } } | null
): string | null {
  if (!open || !applied || applied.generation !== open.generation) return null
  return cleanTarget(applied.input.config.engagement.activeTarget)
}

/** The fields an in-app action hands the writer for `selected` (from
 *  IpcContext.getSelectedTarget): the row's target, and that it came from the
 *  operator's selection (Spec 071 `_ingest.target_via`). Nothing selected gives
 *  nothing, and the row has no target. Not for a row a tool or a timer writes. */
export function operatorSelectedTarget(selected: string | null | undefined): { targetId?: string; targetVia?: 'operator-selected' } {
  const target = cleanTarget(selected)
  return target ? { targetId: target, targetVia: 'operator-selected' } : {}
}

export interface TargetContextDeps {
  /** Writes the open project's config and applies it (main/config-apply.ts:
   *  a changed current target has no subsystem to reach; in-app actions read it
   *  when they write a row). False when no project is open. */
  commit: (next: RedLogConfig, prev: RedLogConfig) => boolean
}

export function registerTargetContextIpc(ipcMain: IpcMain, ctx: IpcContext, deps: TargetContextDeps): void {
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
    const prev = loadConfig(projectDir)
    const previous = cleanTarget(prev.engagement.activeTarget)
    const target = cleanTarget(requested)
    if (previous === target) return { ok: true, target }

    const next = loadConfig(projectDir)
    next.engagement.activeTarget = target
    if (!deps.commit(next, prev)) return { ok: false, target: null }
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
