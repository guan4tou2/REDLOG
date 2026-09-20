import type { IpcMain } from 'electron'
import { shell } from 'electron'
import path from 'path'
import { homedir } from 'os'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig, loadScopeFile, snapshotScope } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { getProjectDir } from '../../core/db/index'
import { queryEvents, queryMarkerAmendments, queryScopeFilteredEvents, type RedLogEvent } from '../../core/db/events'
import { listBookmarks } from '../../core/db/bookmarks'
import { redactEventForExport, redactEventsForExport, type RedactExportOpts } from '../../core/redact-export'
import {
  ExportPlanRegistry,
  capabilitiesFor,
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
import { buildTargetWalkthrough } from '../../core/walkthrough-export'
import { exportBundle } from '../../core/bundle-export'
import { exportHar } from '../../core/har-export'
import { markerIdsIn, sliceWithAmendments } from '../../core/marker-amend'
import { scrubOperatorPii, operatorPiiReplacements } from '../../core/operator-pii'
import { isInsideDir } from '../../core/paths'

const SCOPE_COUNT_SUBTYPES = new Set(['scope_violation', 'scope_cleared', 'scope_recomputed'])

/** The sharing-mode flags the renderer sends with every export call. */
export interface SharingOpts {
  /** "For sharing" preset: masks metadata, scrubs operator PII, excludes
   *  operator-infra events. Off by default ("For my records"). */
  sharing?: boolean
}

/**
 * The active project's scope, shaped for redact-export. The layer-4 sanitize
 * swap applies regardless of scope; passing this also masks out-of-scope
 * bodies. Undefined only when no project is open (nothing to export anyway).
 */
function scopeForActiveProject(ctx: IpcContext): { targets: string[]; excludeTargets?: string[]; personalDomains?: string[] } | undefined {
  const project = ctx.getActiveProject()
  if (!project) return undefined
  const cfg = loadConfig(getProjectPath(project))
  return { targets: snapshotScope(cfg).targets, excludeTargets: cfg.scope?.excludeTargets, personalDomains: cfg.scope?.personalDomains }
}

/** Build RedactExportOpts from the sharing flag and project config. */
function redactOpts(ctx: IpcContext, sharing?: boolean): RedactExportOpts {
  const scope = scopeForActiveProject(ctx)
  const doNotExportIds = getDoNotExportIds()
  if (!sharing) return { scope, doNotExportIds }
  const project = ctx.getActiveProject()
  const cfg = project ? loadConfig(getProjectPath(project)) : undefined
  return {
    scope,
    doNotExportIds,
    maskMetadata: true,
    blacklist: cfg?.network?.blacklist ?? []
  }
}

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

function exportPlanPreview(plan: ExportPlan): Pick<ExportPlan, 'id' | 'fingerprint' | 'expiresAt' | 'request' | 'snapshot' | 'capabilities' | 'counts'> {
  return {
    id: plan.id,
    fingerprint: plan.fingerprint,
    expiresAt: plan.expiresAt,
    request: plan.request,
    snapshot: plan.snapshot,
    capabilities: plan.capabilities,
    counts: plan.counts
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

  ipcMain.handle('har:export', (_e, opts?: { since?: number; before?: number; targetId?: string; limit?: number }) => {
    if (!ctx.getActiveProject()) return null
    return exportHar({ ...opts, scope: scopeForActiveProject(ctx), doNotExportIds: getDoNotExportIds() })
  })

  // --- Evidence bundle ---
  ipcMain.handle('data:exportBundle', (_e, opts?: { maskOutOfScope?: boolean; snapshot?: ExportSnapshot }) => {
    const project = ctx.getActiveProject()
    if (!project) return { ok: false, error: 'no-active-project' }
    try {
      const cfg = loadConfig(getProjectPath(project))
      // PRD A2: mask out-of-scope events' captured content in the bundle by
      // DEFAULT. The operator can override (opts.maskOutOfScope === false) to
      // ship the raw out-of-scope content — a deliberate, audited choice the
      // ExportMenu surfaces with a warning. `true`/undefined both mask.
      const maskOutOfScope = opts?.maskOutOfScope !== false
      const scopeSnap = snapshotScope(cfg)
      const bundle = exportBundle(cfg.engagement.id, {
        scope: { targets: scopeSnap.targets, excludeTargets: cfg.scope?.excludeTargets, personalDomains: cfg.scope?.personalDomains },
        maskOutOfScope,
        snapshot: opts?.snapshot
      })
      return { ok: true, outDir: bundle.outDir, manifest: bundle.manifest }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
  })

  // Renderer button "Reveal in Finder / Show in Explorer" wants shell access
  // without exposing the whole Electron shell module to preload. This handler
  // opens the containing directory of an exported bundle/file. Rejects any
  // path that isn't a string — belt+braces against renderer bugs.
  // Operator tokens are written to a file rather than handed to the operator
  // as text to copy (UIUX-STANDARD §10). Two reasons, and the second is the
  // one that matters: a token on the clipboard is a token in every clipboard
  // manager on the machine, and a token the operator pastes into a note is a
  // token in whatever that note gets backed up to. Writing it means there is
  // exactly one copy and the app knows where it is.
  //
  // `~/.redlog/tokens/` sits deliberately outside the project directory, so
  // no bundle export or evidence package can ever sweep it up —
  // those walk the project tree, and a credential is not evidence.

  ipcMain.handle('data:revealPath', async (_e, target: string) => {
    if (typeof target !== 'string' || !target) return false
    try {
      // Containment: `target` comes from the renderer, and shell.openPath on a
      // directory opens it — a macOS `.app` bundle IS a directory, so an
      // unconstrained path is a renderer→app-launch primitive. Only reveal
      // inside the app's own roots: the active project dir, or ~/.redlog (where
      // the tokens dir lives). Everything RedLog reveals is under one of these.
      const resolved = path.resolve(target)
      const redlogHome = path.join(homedir(), '.redlog')
      const project = ctx.getActiveProject()
      const projectDir = project ? getProjectPath(project) : null
      const allowed = (projectDir && isInsideDir(projectDir, resolved)) || isInsideDir(redlogHome, resolved)
      if (!allowed) return false
      // If `target` is a file, open its parent directory; if it's a directory,
      // open it directly. shell.openPath returns an empty string on success.
      const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null
      const toOpen = stat && stat.isFile() ? path.dirname(resolved) : resolved
      const err = await shell.openPath(toOpen)
      return err === ''
    } catch {
      return false
    }
  })

  // --- Data Export (minimal JSON dump) ---
  ipcMain.handle('data:exportJson', (_e, opts?: SharingOpts & { snapshot?: ExportSnapshot }) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const config = loadConfig(projectDir)
    const rOpts = redactOpts(ctx, opts?.sharing)
    const events = redactEventsForExport(queryEvents({ limit: -1, snapshot: opts?.snapshot }), rOpts)
    const payload = { config, events, exportedAt: new Date().toISOString() }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${ts}.json`)
    let content = JSON.stringify(payload, null, 2)
    if (opts?.sharing) content = scrubOperatorPii(content)
    fs.writeFileSync(filePath, content)
    return filePath
  })
  // NDJSON export for a shared log store (ELK / Filebeat): one redacted event
  // per line, ISO `@timestamp` alias, chain columns kept. `scopeOnly` excludes
  // out-of-scope rows entirely (+ no-target noise) rather than only masking
  // their content; `scrubPii` strips the operator's home path / username /
  // hostname. Both default off (single-operator export keeps attribution).
  ipcMain.handle('data:exportNdjson', (_e, opts?: { scopeOnly?: boolean; scrubPii?: boolean; snapshot?: ExportSnapshot } & SharingOpts) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const scope = scopeForActiveProject(ctx)
    const shouldScrub = opts?.scrubPii === true || opts?.sharing === true
    const events = (opts?.scopeOnly || opts?.sharing) && scope
      ? queryScopeFilteredEvents(scope.targets).events
      : queryEvents({ limit: -1, snapshot: opts?.snapshot })
    const ndjson = eventsToNdjson(events, { scope, scrubOperatorPii: shouldScrub, doNotExportIds: getDoNotExportIds() })
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${ts}.ndjson`)
    fs.writeFileSync(filePath, ndjson)
    return filePath
  })
  // Per-target Markdown walkthrough — the report skeleton (OSCP write-up, red
  // attack narrative, purple by-target). Data, not a formatted PDF.
  ipcMain.handle('data:exportWalkthrough', (_e, opts?: SharingOpts) => {
    if (!ctx.getActiveProject()) return null
    const project = ctx.getActiveProject()!
    const projectDir = getProjectPath(project)
    let md = buildTargetWalkthrough({ scope: scopeForActiveProject(ctx), doNotExportIds: getDoNotExportIds(), generatedAt: new Date().toISOString() })
    if (opts?.sharing) md = scrubOperatorPii(md)
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-walkthrough-${ts}.md`)
    fs.writeFileSync(filePath, md)
    return filePath
  })
  // Per-view slice exports — audit finding #80. Same target directory + naming
  // as the full export so the operator has one place to look. Each returns a
  // path or null (no active project). Callers open the containing dir via
  // shell.openPath after a successful save.

  // Not `sliceExport`: that writes into <project>/exports/ beside the evidence
  // bundle and the scope-filtered export, where a file called
  // `redlog-marks-*.json` reads as part of the delivery. Bookmarks are the
  // operator's own notes — they get their own directory and say what they are.
  ipcMain.handle('data:exportMarks', () => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const outDir = path.join(getProjectPath(project), 'bookmarks')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-bookmarks-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify({
      _note: 'Private bookmarks. Not chained, not signed, not attributed to an operator, editable in place, and not covered by `redlog-cli sanitize`. Not evidence.',
      bookmarks: listBookmarks()
    }, null, 2))
    return filePath
  })
  ipcMain.handle('data:exportLoot', (_e, opts?: SharingOpts) => ctx.getActiveProject() ? sliceExport(ctx, 'loot', redactEventsForExport(queryEvents({ agentType: 'loot', limit: 10000 }), redactOpts(ctx, opts?.sharing))) : null)
  // All three subtypes, not just violations: an export showing a violation
  // without the record that withdrew it misstates the operator's own
  // conclusion, and the recompute summary is what says under which boundary the
  // retroactive rows were judged.
  ipcMain.handle('data:exportViolations', (_e, opts?: SharingOpts) => ctx.getActiveProject()
    ? sliceExport(ctx, 'scope-violations', redactEventsForExport(queryEvents({ agentType: 'system', limit: 10000 })
        .filter((e: RedLogEvent) => SCOPE_COUNT_SUBTYPES.has(String(e.data?.subtype))), redactOpts(ctx, opts?.sharing)))
    : null)
  // v0.6.87 C2: Timeline slice export. Renderer picks a time window (usually
  // the current visible viewport in Timeline) and gets a filtered JSON slice
  // that a bug-bounty writeup can attach as evidence for a specific attack
  // moment. The export includes the surrounding markers/screenshots for
  // context; the operator can trim in a text editor if too much lands.
  ipcMain.handle('data:exportTimelineSlice', (_e, opts: { from: number; to: number } & SharingOpts) => {
    if (!ctx.getActiveProject()) return null
    const from = Number(opts?.from) || 0
    const to = Number(opts?.to) || Date.now()
    if (to <= from) return null
    const all = queryEvents({ limit: -1, since: from })
    const slice = all.filter((e) => e.timestamp >= from && e.timestamp <= to)
    const markerIds = markerIdsIn(slice)
    const amendments = markerIds.length > 0 ? queryMarkerAmendments(markerIds) : []
    const rOpts = redactOpts(ctx, opts?.sharing)
    return sliceExport(
      ctx,
      `timeline-${new Date(from).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
      { window: { fromMs: from, toMs: to }, ...sliceWithAmendments(redactEventsForExport(slice, rOpts), redactEventsForExport(amendments, rOpts)) }
    )
  })

  // --- Scope-filtered export ---
  ipcMain.handle('data:exportScopeFiltered', (_e, opts?: SharingOpts) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const config = loadConfig(projectDir)
    let scopeTargets = config.scope.targets
    if (config.scope.scopeFile) {
      const loaded = loadScopeFile(config.scope.scopeFile)
      if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
    }
    const { events: scopeEvents, truncated } = queryScopeFilteredEvents(scopeTargets)
    const rOpts: RedactExportOpts = {
      scope: { targets: scopeTargets, excludeTargets: config.scope?.excludeTargets },
      doNotExportIds: getDoNotExportIds(),
      ...(opts?.sharing ? { maskMetadata: true, blacklist: config.network?.blacklist ?? [] } : {})
    }
    const events = redactEventsForExport(scopeEvents, rOpts)
    const payload = {
      engagement: config.engagement,
      operator: config.operator,
      scope: config.scope,
      events,
      exportedAt: new Date().toISOString(),
      filtered: true,
      truncated,
      eventCount: events.length,
      scopeTargets
    }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-scope-${ts}.json`)
    let content = JSON.stringify(payload, null, 2)
    if (opts?.sharing) content = scrubOperatorPii(content)
    fs.writeFileSync(filePath, content)
    return filePath
  })

  // --- Export preview (dry-run stats) ---
  ipcMain.handle('data:exportPreview', (_e, opts?: SharingOpts) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const scope = scopeForActiveProject(ctx)
    const doNotExportIds = getDoNotExportIds()
    const snapshot = takeExportSnapshot()
    const events = queryEvents({ limit: -1, snapshot })
    let total = events.length
    let dropped = 0
    let personalDropped = 0
    let blacklisted = 0
    let outOfScope = 0
    let inScope = 0
    let sanitized = 0

    const cfg = loadConfig(getProjectPath(project))
    const bl = opts?.sharing ? (cfg.network?.blacklist ?? []) : []
    const rOpts: RedactExportOpts = {
      scope, doNotExportIds,
      ...(opts?.sharing ? { maskMetadata: true, blacklist: bl } : {})
    }

    let withBodyRefs = 0
    let screenshotEvents = 0

    for (const e of events) {
      if (doNotExportIds.has(e.id)) { dropped++; continue }
      if (isPersonalDomain(e.targetId, scope)) { personalDropped++; continue }
      if (opts?.sharing && bl.length > 0 && e.targetId && bl.includes(e.targetId)) { blacklisted++; continue }
      const r = redactEventForExport(e, rOpts)
      if (!r) { dropped++; continue }
      if (isOutOfScope(e.targetId, scope)) outOfScope++
      else inScope++
      if (r.data !== e.data) sanitized++
      if (e.agentType === 'screenshot') screenshotEvents++
      if (e.data.request_body_ref || e.data.response_body_ref) withBodyRefs++
    }

    return {
      total,
      included: total - dropped - personalDropped - blacklisted,
      dropped,
      personalDropped,
      blacklisted,
      outOfScope,
      inScope,
      sanitized,
      doNotExportCount: doNotExportIds.size,
      hasScope: !!scope && scope.targets.length > 0,
      sharing: !!opts?.sharing,
      withBodyRefs,
      screenshotEvents,
      snapshot
    }
  })
}
