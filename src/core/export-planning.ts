import type { ProjectMeta } from './project-manager'
import { loadConfig, snapshotScope } from './config'
import { getDoNotExportIds } from './db/do-not-export'
import { isOutOfScope, isPersonalDomain } from './scope-sanitize'
import { redactEventForExport, type RedactExportOpts } from './redact-export'
import { iterateExportSelection, iterateSnapshotEvents } from './export-selection'
import { capabilitiesFor } from './export-capabilities'
import { listExportAttachments, exportAttachmentDigest, withFrozenSizes } from './export-attachments'
import { countExportAttachments, referencedAttachmentsFold, truncatedOutputsFold, pauseWindowsFold,
  captureGapsFold, interruptedFold, partialHttpFlowsFold, countPartialHttpFlowsOutside, outOfScopeHttpFlowsFold, sequenceFingerprint,
  createExportPlan, fingerprintValue, fingerprintSequence, normalizeExportRequest, takeExportSnapshot, type ExportPlan, type ExportRequest } from './export-plan'

export function buildExportPlan(project: ProjectMeta, rawRequest: ExportRequest): ExportPlan {
  const request = normalizeExportRequest(rawRequest)
  const capabilities = capabilitiesFor(request.format)
  if (request.scrubPii && !capabilities.piiScrubbing) {
    throw new Error(`unsupported-policy: ${request.format} cannot scrub operator PII`)
  }
  if (request.subset.kind !== 'all' && !capabilities.boundedSubset) {
    throw new Error('unsupported-policy: bounded subset')
  }
  const cfg = loadConfig(project.path)
  const scopeSnap = snapshotScope(cfg)
  const scope = {
    targets: scopeSnap.targets,
    excludeTargets: scopeSnap.excludeTargets,
    personalDomains: scopeSnap.personalDomains
  }
  const doNotExportIds = getDoNotExportIds()
  const operation = request.subset.kind === 'activity' || request.subset.kind === 'session' ? request.subset : null
  const bounded = operation !== null
  if (operation && operation.projectId !== project.id) throw new Error('project-changed')
  const snapshot = operation ? operation.snapshot : takeExportSnapshot()
  const events = iterateExportSelection(request, snapshot, scope)
  const rOpts: RedactExportOpts = {
    scope: request.maskOutOfScope ? scope : undefined,
    doNotExportIds
  }
  let excludedDoNotExport = 0
  let excludedPersonal = 0
  let maskedOutOfScope = 0
  let sanitized = 0
  const selectedEventIds: string[] = []
  const selectedIdSet = new Set<string>()
  let examined = 0
  // Everything the plan says about the selected Events is measured here, on the
  // Events as they will be exported, in the one walk that selects them. This
  // used to be eight walks of the whole snapshot, one per figure and one more
  // for the digest, each re-reading and re-redacting every Event. Nothing is
  // retained but the counters and the digest state; Events are not collected.
  const outOfScopeHttpFlows = outOfScopeHttpFlowsFold(scope)
  const referencedAttachments = capabilities.attachments ? null : referencedAttachmentsFold()
  const truncatedOutputs = truncatedOutputsFold()
  const pauseWindows = pauseWindowsFold()
  const captureGaps = captureGapsFold()
  const interrupted = interruptedFold()
  const partialHttpFlows = request.format === 'har' ? partialHttpFlowsFold() : null
  const evidence = sequenceFingerprint()
  const httpView = request.subset.kind === 'selection' && request.subset.projection === 'http'
  const exchangeFlowIds = httpView ? new Set<unknown>() : null
  for (const event of events) {
    examined++
    if (doNotExportIds.has(event.id)) { excludedDoNotExport++; continue }
    if (isPersonalDomain(event.targetId, scope)) { excludedPersonal++; continue }
    const redacted = redactEventForExport(event, rOpts)
    if (!redacted) continue
    selectedEventIds.push(event.id)
    selectedIdSet.add(event.id)
    if (request.maskOutOfScope && isOutOfScope(event.targetId, scope)) maskedOutOfScope++
    if (redacted.data !== event.data) sanitized++
    outOfScopeHttpFlows.add(redacted)
    referencedAttachments?.add(redacted)
    truncatedOutputs.add(redacted)
    pauseWindows.add(redacted)
    captureGaps.add(redacted)
    interrupted.add(redacted)
    partialHttpFlows?.add(redacted)
    exchangeFlowIds?.add(redacted.data.flow_id)
    evidence.add(redacted)
  }
  // The bundle's attachment listing still reads the selected Events more than
  // once (it resolves casts from one pass before attributing them in another),
  // so only the bundle keeps this re-walk.
  const selectedEvents: Iterable<import('./db/events').RedLogEvent> = { *[Symbol.iterator]() {
    for (const event of iterateSnapshotEvents(snapshot)) {
      if (!selectedIdSet.has(event.id)) continue
      const redacted = redactEventForExport(event, rOpts)
      if (redacted) yield redacted
    }
  } }
  const context = { [Symbol.iterator]: () => iterateSnapshotEvents(snapshot) }
  const exclude = new Set(request.excludeAttachments)
  const attachments = request.format === 'bundle'
    ? listExportAttachments(project.path, selectedEvents, { scope, maskOutOfScope: request.maskOutOfScope, exclude,
      bounded, include:new Set(request.includeAttachments), context: bounded ? context : undefined })
    : []
  const attachmentCounts = bounded ? {
    included:attachments.filter(a=>a.status==='included').length,
    missing:attachments.filter(a=>a.status==='missing').length,
    unattributed:attachments.filter(a=>a.status==='included' && a.attribution==='unattributed').length,
    excludedByOperator:attachments.filter(a=>a.status==='excluded-by-operator').length
  } : request.format === 'bundle'
    ? countExportAttachments(project.path, selectedEvents, { scope, maskOutOfScope: request.maskOutOfScope, exclude })
    : { included:0, missing:0, unattributed:0, excludedByOperator:0 }
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
      ...(exchangeFlowIds ? { exchanges: exchangeFlowIds.size } : {}),
      examined,
      included: selectedEventIds.length,
      excludedDoNotExport,
      excludedPersonal,
      outOfScopeHttpFlows: outOfScopeHttpFlows.done(),
      maskedOutOfScope,
      sanitized,
      attachmentsIncluded: attachmentCounts.included,
      attachmentsMissing: attachmentCounts.missing,
      attachmentsUnattributed: attachmentCounts.unattributed,
      attachmentsExcludedByOperator: attachmentCounts.excludedByOperator,
      unsupported: referencedAttachments ? referencedAttachments.done() : 0,
      truncatedOutputs: truncatedOutputs.done(),
      pauseWindows: pauseWindows.done(),
      captureGaps: captureGaps.done(),
      ...(({ recordings, commands }) => ({ interruptedRecordings: recordings, interruptedCommands: commands }))(interrupted.done()),
      ...(request.format === 'har' ? {
        partialHttpFlows: partialHttpFlows!.done(),
        ...(request.subset.kind === 'selection' && httpView ? {
          partialHttpFlowsOutside: countPartialHttpFlowsOutside(
            iterateSnapshotEvents(snapshot, { agentType: 'scanner', tier: 'logged' }), selectedIdSet,
            { ...request.subset.filter, http: request.subset.http },
            event => doNotExportIds.has(event.id) || isPersonalDomain(event.targetId, scope))
        } : {})
      } : {})
    },
    attachments,
    selectedEventIds,
    selectedEvidenceDigest: evidence.done().digest,
    attachmentDigest: request.format === 'bundle' ? exportAttachmentDigest(project.path, attachments) : '',
    policyFingerprint: fingerprintValue(cfg)
  })
  return plan
}


/** Recheck the approved evidence on a worker-owned, consistent read snapshot. */
export function validateExportSources(project: ProjectMeta, plan: ExportPlan) {
  const refused = (error: 'source-unavailable' | 'policy-changed', check: string) => ({ ok: false as const, error, check })
  const selectedIds = new Set(plan.selectedEventIds)
  if ([...getDoNotExportIds()].some(id => selectedIds.has(id))) return refused('policy-changed', 'do-not-export')
  const approvedNow = { *[Symbol.iterator]() {
    for (const event of iterateSnapshotEvents(plan.snapshot)) {
      if (!selectedIds.has(event.id)) continue
      const redacted = redactEventForExport(event, { scope: plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined })
      if (redacted) yield redacted
    }
  } }
  const currentEvidence = fingerprintSequence(approvedNow)
  if (currentEvidence.count !== plan.selectedEventIds.length) return refused('source-unavailable', 'event-count')
  if (currentEvidence.digest !== plan.selectedEvidenceDigest) return refused('source-unavailable', 'event-content')
  if (fingerprintValue(loadConfig(project.path)) !== plan.policyFingerprint) return refused('policy-changed', 'config')
  if (plan.request.format === 'bundle') {
    const bounded = plan.request.subset.kind === 'activity' || plan.request.subset.kind === 'session'
    const currentFiles = listExportAttachments(project.path, approvedNow, {
      scope: plan.scopeSnapshot, maskOutOfScope: plan.request.maskOutOfScope,
      exclude: new Set(plan.request.excludeAttachments), bounded, include:new Set(plan.request.includeAttachments),
      context:bounded ? { [Symbol.iterator]: () => iterateSnapshotEvents(plan.snapshot) } : undefined
    }).filter(a=>!bounded || plan.attachments.some(approved=>approved.id===a.id))
    if (exportAttachmentDigest(project.path, withFrozenSizes(currentFiles, plan.attachments)) !== plan.attachmentDigest) {
      return refused('source-unavailable', 'attachment-content')
    }
    const attachments = bounded ? {
      included:currentFiles.filter(a=>a.status==='included').length,
      missing:currentFiles.filter(a=>a.status==='missing').length,
      unattributed:currentFiles.filter(a=>a.status==='included' && a.attribution==='unattributed').length,
      excludedByOperator:currentFiles.filter(a=>a.status==='excluded-by-operator').length
    } : countExportAttachments(project.path, approvedNow, {
      scope: plan.scopeSnapshot,
      maskOutOfScope: plan.request.maskOutOfScope,
      exclude: new Set(plan.request.excludeAttachments)
    })
    if (attachments.included !== plan.counts.attachmentsIncluded || attachments.missing !== plan.counts.attachmentsMissing || attachments.unattributed !== plan.counts.attachmentsUnattributed || attachments.excludedByOperator !== plan.counts.attachmentsExcludedByOperator) {
      return refused('source-unavailable', 'attachment-count')
    }
  }
  return { ok: true as const }
}
