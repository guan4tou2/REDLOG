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
import { redactEventsForExport } from '../../core/redact-export'
import { eventsToNdjson } from '../../core/ndjson-export'
import { buildTargetWalkthrough } from '../../core/walkthrough-export'
import { exportBundle } from '../../core/bundle-export'
import { exportHar } from '../../core/har-export'
import { markerIdsIn, sliceWithAmendments } from '../../core/marker-amend'
import { isInsideDir } from '../../core/paths'

const SCOPE_COUNT_SUBTYPES = new Set(['scope_violation', 'scope_cleared', 'scope_recomputed'])

/**
 * The active project's scope, shaped for redact-export. The layer-4 sanitize
 * swap applies regardless of scope; passing this also masks out-of-scope
 * bodies. Undefined only when no project is open (nothing to export anyway).
 */
function scopeForActiveProject(ctx: IpcContext): { targets: string[]; excludeTargets?: string[] } | undefined {
  const project = ctx.getActiveProject()
  if (!project) return undefined
  const cfg = loadConfig(getProjectPath(project))
  return { targets: snapshotScope(cfg).targets, excludeTargets: cfg.scope?.excludeTargets }
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

export function registerDataExportIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('har:export', (_e, opts?: { since?: number; before?: number; targetId?: string; limit?: number }) => {
    if (!ctx.getActiveProject()) return null
    return exportHar({ ...opts, scope: scopeForActiveProject(ctx) })
  })

  // --- Evidence bundle ---
  ipcMain.handle('data:exportBundle', (_e, opts?: { maskOutOfScope?: boolean }) => {
    const project = ctx.getActiveProject()
    if (!project) return { ok: false, error: 'no-active-project' }
    try {
      const cfg = loadConfig(getProjectPath(project))
      // PRD A2: mask out-of-scope events' captured content in the bundle by
      // DEFAULT. The operator can override (opts.maskOutOfScope === false) to
      // ship the raw out-of-scope content — a deliberate, audited choice the
      // ExportMenu surfaces with a warning. `true`/undefined both mask.
      const maskOutOfScope = opts?.maskOutOfScope !== false
      const snap = snapshotScope(cfg)
      const bundle = exportBundle(cfg.engagement.id, {
        scope: { targets: snap.targets, excludeTargets: cfg.scope?.excludeTargets },
        maskOutOfScope
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
  ipcMain.handle('data:exportJson', () => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const config = loadConfig(projectDir)
    const events = redactEventsForExport(queryEvents({ limit: -1 }), scopeForActiveProject(ctx))
    const data = { config, events, exportedAt: new Date().toISOString() }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  })
  // NDJSON export for a shared log store (ELK / Filebeat): one redacted event
  // per line, ISO `@timestamp` alias, chain columns kept. `scopeOnly` excludes
  // out-of-scope rows entirely (+ no-target noise) rather than only masking
  // their content; `scrubPii` strips the operator's home path / username /
  // hostname. Both default off (single-operator export keeps attribution).
  ipcMain.handle('data:exportNdjson', (_e, opts?: { scopeOnly?: boolean; scrubPii?: boolean }) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const scope = scopeForActiveProject(ctx)
    const events = opts?.scopeOnly && scope
      ? queryScopeFilteredEvents(scope.targets)
      : queryEvents({ limit: -1 })
    const ndjson = eventsToNdjson(events, { scope, scrubOperatorPii: opts?.scrubPii === true })
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${ts}.ndjson`)
    fs.writeFileSync(filePath, ndjson)
    return filePath
  })
  // Per-target Markdown walkthrough — the report skeleton (OSCP write-up, red
  // attack narrative, purple by-target). Data, not a formatted PDF.
  ipcMain.handle('data:exportWalkthrough', (_e) => {
    if (!ctx.getActiveProject()) return null
    const project = ctx.getActiveProject()!
    const projectDir = getProjectPath(project)
    const md = buildTargetWalkthrough({ scope: scopeForActiveProject(ctx), generatedAt: new Date().toISOString() })
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
  ipcMain.handle('data:exportLoot', () => ctx.getActiveProject() ? sliceExport(ctx, 'loot', redactEventsForExport(queryEvents({ agentType: 'loot', limit: 10000 }), scopeForActiveProject(ctx))) : null)
  // All three subtypes, not just violations: an export showing a violation
  // without the record that withdrew it misstates the operator's own
  // conclusion, and the recompute summary is what says under which boundary the
  // retroactive rows were judged.
  ipcMain.handle('data:exportViolations', () => ctx.getActiveProject()
    ? sliceExport(ctx, 'scope-violations', redactEventsForExport(queryEvents({ agentType: 'system', limit: 10000 })
        .filter((e: RedLogEvent) => SCOPE_COUNT_SUBTYPES.has(String(e.data?.subtype))), scopeForActiveProject(ctx)))
    : null)
  // v0.6.87 C2: Timeline slice export. Renderer picks a time window (usually
  // the current visible viewport in Timeline) and gets a filtered JSON slice
  // that a bug-bounty writeup can attach as evidence for a specific attack
  // moment. The export includes the surrounding markers/screenshots for
  // context; the operator can trim in a text editor if too much lands.
  ipcMain.handle('data:exportTimelineSlice', (_e, opts: { from: number; to: number }) => {
    if (!ctx.getActiveProject()) return null
    const from = Number(opts?.from) || 0
    const to = Number(opts?.to) || Date.now()
    if (to <= from) return null
    const all = queryEvents({ limit: -1, since: from })
    const slice = all.filter((e) => e.timestamp >= from && e.timestamp <= to)
    // A correction is always written after the window its marker lives in, so a
    // plain window filter exports the finding with the wording the operator has
    // since retracted, and nothing in the file says so. Pulled in regardless of
    // the window, under their own key so a reader can see they were fetched for
    // context rather than because they fell inside it.
    const markerIds = markerIdsIn(slice)
    const amendments = markerIds.length > 0 ? queryMarkerAmendments(markerIds) : []
    const scope = scopeForActiveProject(ctx)
    return sliceExport(
      ctx,
      `timeline-${new Date(from).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
      { window: { fromMs: from, toMs: to }, ...sliceWithAmendments(redactEventsForExport(slice, scope), redactEventsForExport(amendments, scope)) }
    )
  })

  // --- Scope-filtered export ---
  ipcMain.handle('data:exportScopeFiltered', () => {
    const project = ctx.getActiveProject()
    if (!project) return null
    const projectDir = getProjectPath(project)
    const config = loadConfig(projectDir)
    let scopeTargets = config.scope.targets
    if (config.scope.scopeFile) {
      const loaded = loadScopeFile(config.scope.scopeFile)
      if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
    }
    const events = redactEventsForExport(
      queryScopeFilteredEvents(scopeTargets),
      { targets: scopeTargets, excludeTargets: config.scope?.excludeTargets }
    )
    // Bookmarks are NOT included, and this is the export where that mattered
    // most: the events went through the scope filter and the bookmark rows did
    // not, so a "scope-filtered" file shipped URLs for hosts the operator had
    // deliberately excluded.
    const data = {
      engagement: config.engagement,
      operator: config.operator,
      scope: config.scope,
      events,
      exportedAt: new Date().toISOString(),
      filtered: true,
      scopeTargets
    }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-scope-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  })
}
