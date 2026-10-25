import { dialog, shell, type IpcMain } from 'electron'
import { RecentExportStore } from '../services/recent-export'
import type { ExportDelivery } from '../../core/export-delivery'
import { isInsideDir } from '../../core/paths'
import path from 'path'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig, snapshotScope } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { getProjectDir } from '../../core/db/index'
import { queryEvents, queryMarkerAmendments, type RedLogEvent } from '../../core/db/events'
import { redactEventForExport, redactEventsForExport, type RedactExportOpts } from '../../core/redact-export'
import { resolveExportSelection } from '../../core/export-selection'
import { capabilitiesFor } from '../../core/export-capabilities'
import {
  ExportPlanRegistry,
  countExportAttachments,
  countReferencedAttachments,
  countTruncatedOutputs,
  countPauseWindows,
  createExportPlan,
  fingerprintValue,
  normalizeExportRequest,
  takeExportSnapshot,
  type ExportPlan,
  type ExportRequest,
  type ExportSnapshot
} from '../../core/export-plan'
import { getDoNotExportIds } from '../../core/db/do-not-export'
import { isOutOfScope, isPersonalDomain } from '../../core/scope-sanitize'
import { eventsToNdjson } from '../../core/ndjson-export'
import { exportBundle } from '../../core/bundle-export'
import { listExportAttachments, exportAttachmentDigest, withFrozenSizes } from '../../core/export-attachments'
import { exportHar } from '../../core/har-export'
import { markerIdsIn, sliceWithAmendments } from '../../core/marker-amend'
import { scrubOperatorPii } from '../../core/operator-pii'
import { exportableConfig } from '../../core/export-config'
import { defaultExportDir, resolveExportDestination } from '../../core/export-destination'

function writeExportFile(outDir: string, name: string, extension: string, content: string): string {
  fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (let suffix = 1; ; suffix++) {
    const filePath = path.join(outDir, `${name}-${timestamp}${suffix === 1 ? '' : `-${suffix}`}.${extension}`)
    if (fs.existsSync(`${filePath}.manifest.json`)) continue
    try {
      // Never truncate a previous delivery, even when the directory is read-only.
      fs.writeFileSync(filePath, content, { flag: 'wx' })
      return filePath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function sliceExport(ctx: IpcContext, name: string, payload: unknown, scrubPii = false, outDir?: string): string | null {
  const project = ctx.getActiveProject()
  if (!project) return null
  outDir ??= defaultExportDir(getProjectPath(project))
  const content = JSON.stringify(payload, null, 2)
  return writeExportFile(outDir, `redlog-${name}`, 'json', scrubPii ? scrubOperatorPii(content) : content)
}

function resolveExportPlan(ctx: IpcContext, rawRequest: ExportRequest, plans: ExportPlanRegistry): ExportPlan {
  const project = ctx.getActiveProject()
  if (!project) throw new Error('no-active-project')
  const request = normalizeExportRequest(rawRequest)
  const capabilities = capabilitiesFor(request.format)
  if (request.scrubPii && !capabilities.piiScrubbing) {
    throw new Error(`unsupported-policy: ${request.format} cannot scrub operator PII`)
  }
  if (request.subset.kind !== 'all' && !capabilities.boundedSubset) {
    throw new Error('unsupported-policy: bounded subset')
  }
  const cfg = loadConfig(getProjectPath(project))
  const scopeSnap = snapshotScope(cfg)
  const scope = {
    targets: scopeSnap.targets,
    excludeTargets: scopeSnap.excludeTargets,
    personalDomains: scopeSnap.personalDomains
  }
  const doNotExportIds = getDoNotExportIds()
  const snapshot = takeExportSnapshot()
  const events = resolveExportSelection(request, snapshot, scope)
  const rOpts: RedactExportOpts = {
    scope: request.maskOutOfScope ? scope : undefined,
    doNotExportIds
  }
  let excludedDoNotExport = 0
  let excludedPersonal = 0
  let maskedOutOfScope = 0
  let sanitized = 0
  const selectedEventIds: string[] = []
  const selectedEvents: RedLogEvent[] = []
  for (const event of events) {
    if (doNotExportIds.has(event.id)) { excludedDoNotExport++; continue }
    if (isPersonalDomain(event.targetId, scope)) { excludedPersonal++; continue }
    const redacted = redactEventForExport(event, rOpts)
    if (!redacted) continue
    selectedEventIds.push(event.id)
    selectedEvents.push(redacted)
    if (request.maskOutOfScope && isOutOfScope(event.targetId, scope)) maskedOutOfScope++
    if (redacted.data !== event.data) sanitized++
  }
  const exclude = new Set(request.excludeAttachments)
  const attachmentCounts = request.format === 'bundle'
    ? countExportAttachments(getProjectPath(project), selectedEvents, { scope, maskOutOfScope: request.maskOutOfScope, exclude })
    : { included: 0, missing: 0, unattributed: 0, excludedByOperator: 0 }
  // One row per file for the preview, so the operator can see which cast or
  // screenshot is about to leave and drop any of them (#222).
  const attachments = request.format === 'bundle'
    ? listExportAttachments(getProjectPath(project), selectedEvents, { scope, maskOutOfScope: request.maskOutOfScope, exclude })
    : []
  const plan = createExportPlan({
    projectId: project.id,
    request,
    snapshot,
    scopeSnapshot: {
      targets: scopeSnap.targets,
      excludeTargets: scopeSnap.excludeTargets,
      personalDomains: scopeSnap.personalDomains,
      ...(scopeSnap.scopeFileSha256 ? { sourceHash: scopeSnap.scopeFileSha256 } : {})
    },
    counts: {
      ...(request.subset.kind === 'selection' && request.subset.projection === 'http' ? { exchanges: new Set(selectedEvents.map(event => event.data.flow_id)).size } : {}),
      examined: events.length,
      included: selectedEventIds.length,
      excludedDoNotExport,
      excludedPersonal,
      maskedOutOfScope,
      sanitized,
      attachmentsIncluded: attachmentCounts.included,
      attachmentsMissing: attachmentCounts.missing,
      attachmentsUnattributed: attachmentCounts.unattributed,
      attachmentsExcludedByOperator: attachmentCounts.excludedByOperator,
      unsupported: capabilities.attachments ? 0 : countReferencedAttachments(selectedEvents),
      truncatedOutputs: countTruncatedOutputs(selectedEvents),
      pauseWindows: countPauseWindows(selectedEvents)
    },
    attachments,
    selectedEventIds,
    selectedEvidenceDigest: fingerprintValue(selectedEvents),
    attachmentDigest: request.format === 'bundle' ? exportAttachmentDigest(getProjectPath(project), attachments) : '',
    policyFingerprint: fingerprintValue(cfg)
  })
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
  options: { planRegistry?: ExportPlanRegistry; recentExports?: RecentExportStore } = {}
): void {
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
  ipcMain.handle('data:resolveExportPlan', (_e, request: ExportRequest) => {
    try {
      return { ok: true as const, plan: exportPlanPreview(resolveExportPlan(ctx, request, exportPlans)) }
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

  ipcMain.handle('data:executeExportPlan', (_e, input?: { planId?: string; destDir?: string }) => {
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
    try {
      const selectedIds = new Set(plan.selectedEventIds)
      const available = queryEvents({ limit: -1, snapshot: plan.snapshot }).filter((event) => selectedIds.has(event.id))
      const planRedaction: RedactExportOpts = {
        scope: plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined
      }
      const approvedNow = redactEventsForExport(available, planRedaction)
      if (approvedNow.length !== plan.selectedEventIds.length || fingerprintValue(approvedNow) !== plan.selectedEvidenceDigest) {
        return { ok: false as const, error: 'source-unavailable' }
      }
      if (fingerprintValue(loadConfig(getProjectPath(project))) !== plan.policyFingerprint) {
        return { ok: false as const, error: 'policy-changed' }
      }
      if (plan.request.format === 'bundle') {
        const currentFiles = listExportAttachments(getProjectPath(project), approvedNow, {
          scope: plan.scopeSnapshot, maskOutOfScope: plan.request.maskOutOfScope,
          exclude: new Set(plan.request.excludeAttachments)
        })
        if (exportAttachmentDigest(getProjectPath(project), withFrozenSizes(currentFiles, plan.attachments)) !== plan.attachmentDigest) {
          return { ok: false as const, error: 'source-unavailable' }
        }
        const attachments = countExportAttachments(getProjectPath(project), approvedNow, {
          scope: plan.scopeSnapshot,
          maskOutOfScope: plan.request.maskOutOfScope,
          exclude: new Set(plan.request.excludeAttachments)
        })
        if (attachments.included !== plan.counts.attachmentsIncluded || attachments.missing !== plan.counts.attachmentsMissing || attachments.unattributed !== plan.counts.attachmentsUnattributed || attachments.excludedByOperator !== plan.counts.attachmentsExcludedByOperator) {
          return { ok: false as const, error: 'source-unavailable' }
        }
      }
      let artifactPath: string | null = null
      if (plan.request.format === 'json') {
        const projectDir = getProjectPath(project)
        const config = loadConfig(projectDir)
        const events = redactEventsForExport(queryEvents({ limit: -1, snapshot: plan.snapshot }), planRedaction)
          .filter((event) => selectedIds.has(event.id))
        const outDir = destination.dir
        let content = JSON.stringify({ config: exportableConfig(config), events, exportedAt: new Date().toISOString(), exportPlan: { id: plan.id, fingerprint: plan.fingerprint } }, null, 2)
        if (plan.request.scrubPii) content = scrubOperatorPii(content)
        artifactPath = writeExportFile(outDir, 'redlog', 'json', content)
      } else if (plan.request.format === 'ndjson') {
        const scope = plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined
        const events = queryEvents({ limit: -1, snapshot: plan.snapshot }).filter((event) => selectedIds.has(event.id))
        const content = eventsToNdjson(events, { scope, scrubOperatorPii: plan.request.scrubPii, doNotExportIds: new Set() })
        const outDir = destination.dir
        artifactPath = writeExportFile(outDir, 'redlog', 'ndjson', content)
      } else if (plan.request.format === 'bundle') {
        const cfg = loadConfig(getProjectPath(project))
        const result = exportBundle(cfg.engagement.id, {
          scope: plan.scopeSnapshot,
          maskOutOfScope: plan.request.maskOutOfScope,
          snapshot: plan.snapshot,
          includeEventIds: new Set(plan.selectedEventIds),
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint, counts: plan.counts, request: plan.request },
          excludeAttachments: new Set(plan.request.excludeAttachments),
          attachments: plan.attachments,
          ...(destination.custom ? { outRoot: destination.dir } : {})
        })
        artifactPath = result.outDir
      } else if (plan.request.format === 'har') {
        const subset = plan.request.subset
        const content = exportHar({
          ...(subset.kind === 'time-range' ? { since: subset.since, before: subset.before, targetId: subset.targetId } : {}),
          snapshot: plan.snapshot,
          scope: plan.scopeSnapshot,
          includeEventIds: selectedIds,
          doNotExportIds: new Set()
        })
        const outDir = destination.dir
        artifactPath = writeExportFile(outDir, 'redlog', 'har', content)
      } else if (plan.request.format === 'timeline') {
        const subset = plan.request.subset
        const events = available
        const markerIds = markerIdsIn(events)
        const amendments = markerIds.length > 0 ? queryMarkerAmendments(markerIds).filter(event => selectedIds.has(event.id)) : []
        artifactPath = sliceExport(ctx, 'timeline-selection', {
          ...(subset.kind === 'time-range' ? { window: { fromMs: subset.since, toMs: subset.before } } : {}),
          selection: subset,
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint },
          ...sliceWithAmendments(redactEventsForExport(events, planRedaction), redactEventsForExport(amendments, planRedaction))
        }, plan.request.scrubPii, destination.dir)
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
