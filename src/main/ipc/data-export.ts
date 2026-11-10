import { runExportTask, type ExportTaskRunner } from '../services/export-runner'
import { dialog, shell, type IpcMain } from 'electron'
import { RecentExportStore } from '../services/recent-export'
import type { ExportDelivery } from '../../core/export-delivery'
import { isInsideDir } from '../../core/paths'
import path from 'path'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { getProjectDir, getReadonlyDB } from '../../core/db/index'
import { createHash } from 'node:crypto'
import { type RedLogEvent } from '../../core/db/events'
import { redactEventForExport, type RedactExportOpts } from '../../core/redact-export'
import { iterateSnapshotEvents } from '../../core/export-selection'
import { ExportPlanRegistry, fingerprintValue, type ExportPlan, type ExportRequest } from '../../core/export-plan'
import { getDoNotExportIds } from '../../core/db/do-not-export'
import { writeApprovedEventExport } from '../../core/export-stream'
import { exportableConfig } from '../../core/export-config'
import { defaultExportDir, resolveExportDestination } from '../../core/export-destination'

function sanitizationRevision(): string {
  const hash = createHash('sha256')
  for (const row of getReadonlyDB().prepare('SELECT source_event_id,field,replacement_sha256 FROM sanitized_events ORDER BY source_event_id,field').iterate()) hash.update(JSON.stringify(row))
  return hash.digest('hex')
}

async function resolveExportPlan(ctx: IpcContext, rawRequest: ExportRequest, plans: ExportPlanRegistry, runTask: ExportTaskRunner): Promise<ExportPlan> {
  const project = ctx.getActiveProject()
  if (!project) throw new Error('no-active-project')
  const revision = sanitizationRevision()
  const result = await runTask({ kind: 'plan', project, request: rawRequest }, () => ctx.getActiveProject()?.id === project.id)
  if (!('plan' in result)) throw new Error('Invalid export plan result')
  const plan = result.plan
  if (ctx.getActiveProject()?.id !== project.id) throw new Error('project-changed')
  if (sanitizationRevision() !== revision) throw new Error('source-unavailable')
  if (fingerprintValue(loadConfig(getProjectPath(project))) !== plan.policyFingerprint) throw new Error('policy-changed')
  const ids = new Set(plan.selectedEventIds)
  if ([...getDoNotExportIds()].some(id => ids.has(id))) throw new Error('policy-changed')
  plans.put(plan)
  return plan
}

// `scopeSnapshot` travels with the preview: the export menu has to be able to
// name the boundary this plan was resolved against. Without it the menu could
// only say whether masking was on, which is a policy, not the scope — and it
// filled the gap with `hasScope: false`, a value it had simply made up.
// `selectedEventIds` and the digests stay behind; the renderer confirms by
// planId and never needs them.
function exportPlanPreview(plan: ExportPlan): Pick<ExportPlan,
  'id' | 'fingerprint' | 'expiresAt' | 'request' | 'snapshot' | 'capabilities' | 'counts' | 'scopeSnapshot' | 'attachments'> {
  return {
    attachments: plan.attachments,
    id: plan.id,
    fingerprint: plan.fingerprint,
    expiresAt: plan.expiresAt,
    request: plan.request,
    snapshot: plan.snapshot,
    capabilities: plan.capabilities,
    counts: plan.counts,
    scopeSnapshot: plan.scopeSnapshot
  }
}

export function registerDataExportIpc(
  ipcMain: IpcMain,
  ctx: IpcContext,
  options: { planRegistry?: ExportPlanRegistry; recentExports?: RecentExportStore; runTask?: ExportTaskRunner } = {}
): void {
  const runTask = options.runTask ?? runExportTask
  const exportPlans = options.planRegistry ?? new ExportPlanRegistry()
  const recentExports = options.recentExports ?? new RecentExportStore()
  ipcMain.handle('data:recentExport', () => {
    const project = ctx.getActiveProject()
    if (!project) return { ok: false as const, error: 'no-active-project' }
    try { return { ok: true as const, delivery: recentExports.get(project.id, getProjectPath(project)) } }
    catch (error) { return { ok: false as const, error: (error as Error).message } }
  })
  // Folders the operator picked in the system dialog this session. Only these
  // can be named as an export destination.
  const approvedDestinations = new Set<string>()

  ipcMain.handle('data:exportDestination', () => {
    const project = ctx.getActiveProject()
    return project ? defaultExportDir(getProjectPath(project)) : null
  })

  ipcMain.handle('data:pickExportDir', async () => {
    const win = ctx.getMainWindow()
    const options = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const dir = path.resolve(result.filePaths[0])
    approvedDestinations.add(dir)
    return dir
  })
  ipcMain.handle('data:resolveExportPlan', async (_e, request: ExportRequest) => {
    try {
      return { ok: true as const, plan: exportPlanPreview(await resolveExportPlan(ctx, request, exportPlans, runTask)) }
    } catch (error) {
      return { ok: false as const, error: (error as Error)?.message ?? String(error) }
    }
  })

  // Show an export the operator just made in the file manager. Only a path
  // inside the open project's folder — the renderer names the file, it does
  // not get to open arbitrary locations (UI/UX audit F12).
  ipcMain.handle('data:revealExport', (_e, target: unknown) => {
    const project = ctx.getActiveProject()
    if (!project || typeof target !== 'string') return false
    const resolved = path.resolve(target)
    const inApproved = [...approvedDestinations].some((dir) => isInsideDir(dir, resolved))
    try {
      const knownResult = !isInsideDir(getProjectPath(project), resolved) && !inApproved
        ? recentExports.get(project.id, getProjectPath(project))?.artifactPath === resolved : true
      if (!knownResult || !fs.existsSync(resolved)) return false
      shell.showItemInFolder(resolved)
      return true
    } catch { return false }
  })

  ipcMain.handle('data:executeExportPlan', async (_e, input?: { planId?: string; destDir?: string }) => {
    const project = ctx.getActiveProject()
    if (!project) return { ok: false as const, error: 'no-active-project' }
    if (!input?.planId) return { ok: false as const, error: 'invalid-request' }
    // Checked before the plan is claimed: a plan is single-use, and a refused
    // destination must not spend it.
    const destination = resolveExportDestination(getProjectPath(project), input.destDir, approvedDestinations)
    if (!destination.ok) return destination
    const claimed = exportPlans.claim(input.planId, project.id)
    if (!claimed.ok) return claimed
    const plan = claimed.plan
    // `check` names which comparison refused. The operator sees `error`; a
    // test that fails once in fourteen needs to know which of the three
    // source-unavailable checks it was (#344).
    try {
      const selectedIds = new Set(plan.selectedEventIds)
      if ([...getDoNotExportIds()].some(id=>selectedIds.has(id))) return { ok: false as const, error: 'policy-changed', check: 'do-not-export' }
      const available: Iterable<RedLogEvent> = { *[Symbol.iterator]() {
        for (const event of iterateSnapshotEvents(plan.snapshot)) if (selectedIds.has(event.id)) yield event
      } }
      const planRedaction: RedactExportOpts = {
        scope: plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined
      }
      const approvedNow: Iterable<RedLogEvent> = { *[Symbol.iterator]() {
        const digest = createHash('sha256').update('[')
        let count = 0
        for (const event of available) {
          const redacted = redactEventForExport(event, planRedaction)
          if (!redacted) continue
          if (count++) digest.update(',')
          digest.update(JSON.stringify(redacted))
          yield redacted
        }
        digest.update(']')
        // Verify exactly the bytes read for this delivery, not a second read.
        if (count !== selectedIds.size || digest.digest('hex') !== plan.selectedEvidenceDigest) throw new Error('source-unavailable')
      } }
      const checked = await runTask({ kind: 'validate', project, plan }, () => ctx.getActiveProject()?.id === project.id)
      if (!('validation' in checked)) throw new Error('Invalid export validation result')
      if (!checked.validation.ok) return checked.validation
      if (ctx.getActiveProject()?.id !== project.id) throw new Error('project-changed')
      let artifactPath: string | null = null
      const redactionRevision = sanitizationRevision()
      const deliveryAllowed = (completed = false) => {
        if (ctx.getActiveProject()?.id !== project.id) return false
        if (!completed) return true
        if ([...getDoNotExportIds()].some(id => selectedIds.has(id))) throw new Error('policy-changed')
        if (fingerprintValue(loadConfig(getProjectPath(project))) !== plan.policyFingerprint) throw new Error('policy-changed')
        if (sanitizationRevision() !== redactionRevision) throw new Error('source-unavailable')
        return true
      }
      if (plan.request.format === 'json') {
        const projectDir = getProjectPath(project)
        const config = loadConfig(projectDir)
        // The rows just verified against the plan's digest, not a second read.
        const events = approvedNow
        const outDir = destination.dir
        artifactPath = await writeApprovedEventExport(outDir, 'json', events, {
          config: exportableConfig(config), exportedAt: new Date().toISOString(), exportPlan: { id: plan.id, fingerprint: plan.fingerprint }
        }, plan.request.scrubPii, deliveryAllowed)
      } else if (plan.request.format === 'ndjson') {
        artifactPath = await writeApprovedEventExport(destination.dir, 'ndjson', approvedNow, null,
          plan.request.scrubPii, deliveryAllowed)
      } else if (plan.request.format === 'bundle') {
        const cfg = loadConfig(getProjectPath(project))
        const result = await runTask({ kind: 'bundle', project, approvedPlan: plan, engagementId: cfg.engagement.id, options: {
          scope: plan.scopeSnapshot,
          maskOutOfScope: plan.request.maskOutOfScope,
          snapshot: plan.snapshot,
          includeEventIds: new Set(plan.selectedEventIds),
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint, counts: plan.counts, request: plan.request },
          excludeAttachments: new Set(plan.request.excludeAttachments),
          attachments: plan.attachments,
          outRoot: destination.dir
        }, attachmentDigest: plan.attachmentDigest }, deliveryAllowed)
        if (!('artifactPath' in result)) throw new Error('Invalid bundle result')
        artifactPath = result.artifactPath
      } else if (plan.request.format === 'har') {
        const subset = plan.request.subset
        const result = await runTask({ kind: 'har', project, approvedPlan: plan, outDir: destination.dir, options: {
          ...(subset.kind === 'time-range' ? { since: subset.since, before: subset.before, targetId: subset.targetId } : {}),
          snapshot: plan.snapshot,
          scope: plan.scopeSnapshot,
          includeEventIds: selectedIds,
          doNotExportIds: new Set()
        } }, deliveryAllowed)
        if (!('artifactPath' in result)) throw new Error('Invalid HAR result')
        artifactPath = result.artifactPath
      } else if (plan.request.format === 'timeline') {
        const subset = plan.request.subset
        artifactPath = await writeApprovedEventExport(destination.dir, 'timeline', approvedNow, {
          ...(subset.kind === 'time-range' ? { window: { fromMs: subset.since, toMs: subset.before } } : {}),
          selection: subset,
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint }
        }, plan.request.scrubPii, deliveryAllowed)
      } else {
        return { ok: false as const, error: 'unsupported-format' }
      }
      if (artifactPath && plan.request.format !== 'bundle') {
        fs.writeFileSync(`${artifactPath}.manifest.json`, JSON.stringify({
          exportPlan: {
            id: plan.id,
            fingerprint: plan.fingerprint,
            request: plan.request,
            snapshot: plan.snapshot,
            scopeSnapshot: plan.scopeSnapshot
          },
          actualCounts: plan.counts,
          artifactPath: path.basename(artifactPath),
          completedAt: new Date().toISOString()
        }, null, 2), { flag: 'wx' })
      }
      if (!artifactPath) return { ok: false as const, error: 'export-artifact-missing' }
      const delivery: ExportDelivery = { artifactPath, format: plan.request.format, completedAt: Date.now(), availability: 'available' }
      const warnings: string[] = []
      try { recentExports.remember(project.id, getProjectPath(project), delivery) }
      catch { warnings.push('recent-export-not-saved') }
      return { ok: true as const, planId: plan.id, fingerprint: plan.fingerprint, artifactPath, counts: plan.counts, warnings, delivery }
    } catch (error) {
      return { ok: false as const, planId: plan.id, fingerprint: plan.fingerprint, error: (error as Error)?.message ?? String(error) }
    }
  })

}
