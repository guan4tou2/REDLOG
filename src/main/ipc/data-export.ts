import type { IpcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig, snapshotScope } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { getProjectDir } from '../../core/db/index'
import { queryEvents, queryMarkerAmendments, type RedLogEvent } from '../../core/db/events'
import { redactEventForExport, redactEventsForExport, type RedactExportOpts } from '../../core/redact-export'
import { capabilitiesFor } from '../../core/export-capabilities'
import {
  ExportPlanRegistry,
  countExportAttachments,
  countReferencedAttachments,
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
import { exportHar } from '../../core/har-export'
import { markerIdsIn, sliceWithAmendments } from '../../core/marker-amend'
import { scrubOperatorPii } from '../../core/operator-pii'

function sliceExport(ctx: IpcContext, name: string, payload: unknown): string | null {
  const project = ctx.getActiveProject()
  if (!project) return null
  const projectDir = getProjectPath(project)
  const outDir = path.join(projectDir, 'exports')
  fs.mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = path.join(outDir, `redlog-${name}-${ts}.json`)
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
  return filePath
}

function resolveExportPlan(ctx: IpcContext, rawRequest: ExportRequest, plans: ExportPlanRegistry): ExportPlan {
  const project = ctx.getActiveProject()
  if (!project) throw new Error('no-active-project')
  const request = normalizeExportRequest(rawRequest)
  const capabilities = capabilitiesFor(request.format)
  if (request.scrubPii && !capabilities.piiScrubbing) {
    throw new Error(`unsupported-policy: ${request.format} cannot scrub operator PII`)
  }
  if (request.subset.kind !== 'all' && !['har', 'timeline'].includes(request.format)) {
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
  const formatQuery = request.format === 'har' ? { agentType: 'scanner', tier: 'logged' as const } : {}
  const query = request.subset.kind === 'time-range'
    ? { limit: -1, snapshot, since: request.subset.since, before: request.subset.before, targetId: request.subset.targetId, ...formatQuery }
    : { limit: -1, snapshot, ...formatQuery }
  const events = queryEvents(query)
  const blacklist = request.sharing ? (cfg.network?.blacklist ?? []) : []
  const rOpts: RedactExportOpts = {
    scope: request.maskOutOfScope ? scope : undefined,
    doNotExportIds,
    ...(request.sharing ? { maskMetadata: true, blacklist } : {})
  }
  let excludedDoNotExport = 0
  let excludedPersonal = 0
  let excludedBlacklist = 0
  let maskedOutOfScope = 0
  let sanitized = 0
  const selectedEventIds: string[] = []
  const selectedEvents: RedLogEvent[] = []
  for (const event of events) {
    if (doNotExportIds.has(event.id)) { excludedDoNotExport++; continue }
    if (isPersonalDomain(event.targetId, scope)) { excludedPersonal++; continue }
    if (request.sharing && event.targetId && blacklist.includes(event.targetId)) { excludedBlacklist++; continue }
    const redacted = redactEventForExport(event, rOpts)
    if (!redacted) continue
    selectedEventIds.push(event.id)
    selectedEvents.push(redacted)
    if (request.maskOutOfScope && isOutOfScope(event.targetId, scope)) maskedOutOfScope++
    if (redacted.data !== event.data) sanitized++
  }
  const attachmentCounts = request.format === 'bundle'
    ? countExportAttachments(getProjectPath(project), selectedEvents, { scope, maskOutOfScope: request.maskOutOfScope })
    : { included: 0, missing: 0, unattributed: 0 }
  const plan = createExportPlan({
    projectId: project.id,
    request,
    snapshot,
    scopeSnapshot: {
      targets: scopeSnap.targets,
      excludeTargets: scopeSnap.excludeTargets,
      personalDomains: scopeSnap.personalDomains,
      blacklist,
      ...(scopeSnap.scopeFileSha256 ? { sourceHash: scopeSnap.scopeFileSha256 } : {})
    },
    counts: {
      examined: events.length,
      included: selectedEventIds.length,
      excludedDoNotExport,
      excludedPersonal,
      excludedBlacklist,
      maskedOutOfScope,
      sanitized,
      attachmentsIncluded: attachmentCounts.included,
      attachmentsMissing: attachmentCounts.missing,
      attachmentsUnattributed: attachmentCounts.unattributed,
      unsupported: capabilities.attachments ? 0 : countReferencedAttachments(selectedEvents)
    },
    selectedEventIds,
    selectedEvidenceDigest: fingerprintValue(selectedEvents),
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
  'id' | 'fingerprint' | 'expiresAt' | 'request' | 'snapshot' | 'capabilities' | 'counts' | 'scopeSnapshot'> {
  return {
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
  options: { planRegistry?: ExportPlanRegistry } = {}
): void {
  const exportPlans = options.planRegistry ?? new ExportPlanRegistry()
  ipcMain.handle('data:resolveExportPlan', (_e, request: ExportRequest) => {
    try {
      return { ok: true as const, plan: exportPlanPreview(resolveExportPlan(ctx, request, exportPlans)) }
    } catch (error) {
      return { ok: false as const, error: (error as Error)?.message ?? String(error) }
    }
  })

  ipcMain.handle('data:executeExportPlan', (_e, input?: { planId?: string }) => {
    const project = ctx.getActiveProject()
    if (!project) return { ok: false as const, error: 'no-active-project' }
    if (!input?.planId) return { ok: false as const, error: 'invalid-request' }
    const claimed = exportPlans.claim(input.planId, project.id)
    if (!claimed.ok) return claimed
    const plan = claimed.plan
    try {
      const selectedIds = new Set(plan.selectedEventIds)
      const available = queryEvents({ limit: -1, snapshot: plan.snapshot }).filter((event) => selectedIds.has(event.id))
      const planRedaction: RedactExportOpts = {
        scope: plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined,
        ...(plan.request.sharing ? { maskMetadata: true, blacklist: plan.scopeSnapshot.blacklist ?? [] } : {})
      }
      const approvedNow = redactEventsForExport(available, planRedaction)
      if (approvedNow.length !== plan.selectedEventIds.length || fingerprintValue(approvedNow) !== plan.selectedEvidenceDigest) {
        return { ok: false as const, error: 'source-unavailable' }
      }
      if (plan.request.format === 'json' && fingerprintValue(loadConfig(getProjectPath(project))) !== plan.policyFingerprint) {
        return { ok: false as const, error: 'policy-changed' }
      }
      if (plan.request.format === 'bundle') {
        const attachments = countExportAttachments(getProjectPath(project), approvedNow, {
          scope: plan.scopeSnapshot,
          maskOutOfScope: plan.request.maskOutOfScope
        })
        if (attachments.included !== plan.counts.attachmentsIncluded || attachments.missing !== plan.counts.attachmentsMissing || attachments.unattributed !== plan.counts.attachmentsUnattributed) {
          return { ok: false as const, error: 'source-unavailable' }
        }
      }
      let artifactPath: string | null = null
      if (plan.request.format === 'json') {
        const projectDir = getProjectPath(project)
        const config = loadConfig(projectDir)
        const events = redactEventsForExport(queryEvents({ limit: -1, snapshot: plan.snapshot }), planRedaction)
          .filter((event) => plan.selectedEventIds.includes(event.id))
        const outDir = path.join(projectDir, 'exports')
        fs.mkdirSync(outDir, { recursive: true })
        artifactPath = path.join(outDir, `redlog-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
        let content = JSON.stringify({ config, events, exportedAt: new Date().toISOString(), exportPlan: { id: plan.id, fingerprint: plan.fingerprint } }, null, 2)
        if (plan.request.scrubPii) content = scrubOperatorPii(content)
        fs.writeFileSync(artifactPath, content)
      } else if (plan.request.format === 'ndjson') {
        const scope = plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined
        const events = queryEvents({ limit: -1, snapshot: plan.snapshot }).filter((event) => plan.selectedEventIds.includes(event.id))
        const content = eventsToNdjson(events, { scope, scrubOperatorPii: plan.request.scrubPii, doNotExportIds: new Set() })
        const outDir = path.join(getProjectPath(project), 'exports')
        fs.mkdirSync(outDir, { recursive: true })
        artifactPath = path.join(outDir, `redlog-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.ndjson`)
        fs.writeFileSync(artifactPath, content)
      } else if (plan.request.format === 'bundle') {
        const cfg = loadConfig(getProjectPath(project))
        const result = exportBundle(cfg.engagement.id, {
          scope: plan.scopeSnapshot,
          maskOutOfScope: plan.request.maskOutOfScope,
          snapshot: plan.snapshot,
          includeEventIds: new Set(plan.selectedEventIds),
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint, counts: plan.counts }
        })
        artifactPath = result.outDir
      } else if (plan.request.format === 'har') {
        const subset = plan.request.subset
        const content = exportHar({
          ...(subset.kind === 'time-range' ? { since: subset.since, before: subset.before, targetId: subset.targetId } : {}),
          snapshot: plan.snapshot,
          scope: plan.scopeSnapshot,
          doNotExportIds: new Set()
        })
        const outDir = path.join(getProjectPath(project), 'exports')
        fs.mkdirSync(outDir, { recursive: true })
        artifactPath = path.join(outDir, `redlog-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.har`)
        fs.writeFileSync(artifactPath, content)
      } else if (plan.request.format === 'timeline') {
        const subset = plan.request.subset
        if (subset.kind !== 'time-range') return { ok: false as const, error: 'invalid-request' }
        const events = queryEvents({ limit: -1, since: subset.since, before: subset.before, targetId: subset.targetId, snapshot: plan.snapshot })
          .filter((event) => plan.selectedEventIds.includes(event.id))
        const markerIds = markerIdsIn(events)
        const amendments = markerIds.length > 0 ? queryMarkerAmendments(markerIds) : []
        artifactPath = sliceExport(ctx, `timeline-${new Date(subset.since).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, {
          window: { fromMs: subset.since, toMs: subset.before },
          exportPlan: { id: plan.id, fingerprint: plan.fingerprint },
          ...sliceWithAmendments(redactEventsForExport(events, planRedaction), redactEventsForExport(amendments, planRedaction))
        })
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
        }, null, 2))
      }
      return { ok: true as const, planId: plan.id, fingerprint: plan.fingerprint, artifactPath, counts: plan.counts, warnings: [] }
    } catch (error) {
      return { ok: false as const, planId: plan.id, fingerprint: plan.fingerprint, error: (error as Error)?.message ?? String(error) }
    }
  })

}
