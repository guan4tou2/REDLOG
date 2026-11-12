import fs from 'node:fs'
import path from 'node:path'
import { getDB, getProjectDir } from './db/index'
import { insertEvent } from './db/events'
import { getPrimaryOperator } from './db/operators'
import { eventBus } from './event-bus'
import type { EvidenceBundle } from './bundle-export'
import type { ExportTask, ExportTaskResult } from './export-task'
import type { ProjectMeta } from './project-manager'
import type { ScopeForSanitize } from './scope-sanitize'

/** Same shape as main's runExportTask (services/export-runner.ts). */
export type ExportTaskRunnerLike = (task: ExportTask, isAllowed?: (completed?: boolean) => boolean) => Promise<ExportTaskResult>
export type DirectBundleExporter = (engagementId: string, opts: { scope?: ScopeForSanitize }) => Promise<EvidenceBundle>

/** POST /api/export/bundle off the main thread (#695). The in-process
 *  exportBundle scans the whole logged tier, chains a
 *  `system.logged_tier_digest` event, then dumps both tiers. The worker's
 *  database is read-only, and a second writer would fork the chain head main
 *  holds, so the work is split in three:
 *
 *  1. worker: digest the logged tier up to a rowid captured here;
 *  2. main:   insert the chained digest event (synchronous, as before) and,
 *             in the same tick, capture the chained tier's highest rowid;
 *  3. worker: the bundle, bounded on both tiers by those two rowids, with the
 *             stage-1 digest recorded in the manifest. Its one chained row,
 *             the export seal, is inserted by main at the worker's request
 *             once every file is written (export-runner.ts), and appended as
 *             the last line; rows recorded after the stage-2 boundary are
 *             not in the bundle even though the seal follows them.
 *
 *  Rows written between the stages land above a boundary and are not in the
 *  bundle; chained rows written before the digest event are below it and are.
 *  A logged row removed between stages 1 and 3 (retention) leaves the manifest
 *  digest describing more rows than events_logged.jsonl holds, which marks the
 *  bundle a projection; the digest event and the manifest still agree.
 *
 *  Requests run one at a time. Two interleaved requests would each carry the
 *  other's digest event in their chain, with a manifest naming only one. */
export function createDirectBundleExporter(run: ExportTaskRunnerLike, activeProject: () => Readonly<ProjectMeta> | null): DirectBundleExporter {
  let queue: Promise<unknown> = Promise.resolve()
  return (engagementId, opts) => {
    const next = queue.then(() => exportDirectBundle(run, activeProject, engagementId, opts))
    queue = next.catch(() => undefined)
    return next
  }
}

async function exportDirectBundle(run: ExportTaskRunnerLike, activeProject: () => Readonly<ProjectMeta> | null,
  engagementId: string, opts: { scope?: ScopeForSanitize }): Promise<EvidenceBundle> {
  const opened = activeProject()
  if (!opened) throw new Error('no-active-project')
  const project: ProjectMeta = { ...opened }
  const same = (): boolean => activeProject()?.id === project.id && getProjectDir() === project.path
  if (!same()) throw new Error('project-changed')
  const maxRowId = (table: 'events' | 'events_logged'): number =>
    (getDB().prepare(`SELECT coalesce(max(rowid),0) AS m FROM ${table}`).get() as { m: number }).m

  const loggedMaxRowId = maxRowId('events_logged')
  const digested = await run({ kind: 'logged-digest', project, loggedMaxRowId }, same)
  if (!('loggedDigest' in digested)) throw new Error('Invalid logged-tier digest result')
  const loggedDigest = digested.loggedDigest
  if (!same()) throw new Error('project-changed')

  // The same event, under the same conditions, as exportBundle's direct path.
  const primary = getPrimaryOperator()
  if (loggedDigest.count > 0 && primary) {
    const ev = insertEvent('system', {
      subtype: 'logged_tier_digest',
      count: loggedDigest.count,
      sha256: loggedDigest.sha256,
      oldest_at: loggedDigest.oldest,
      newest_at: loggedDigest.newest,
      reason: 'export',
      description: `export: logged-tier snapshot — ${loggedDigest.count} row(s), sha256 ${loggedDigest.sha256.slice(0, 12)}…`
    }, { engagementId, operatorId: primary.id })
    if (ev) eventBus.publish(ev)
  }
  const snapshot = { chainedMaxRowId: maxRowId('events'), loggedMaxRowId, takenAt: Date.now() }

  const built = await run({
    kind: 'direct-bundle', project, engagementId,
    options: { scope: opts.scope, outRoot: path.join(project.path, 'exports'), snapshot, loggedDigest }
  }, same)
  if (!('artifactPath' in built)) throw new Error('Invalid bundle result')
  const manifest = JSON.parse(fs.readFileSync(path.join(built.artifactPath, 'manifest.json'), 'utf8')) as EvidenceBundle['manifest']
  return { outDir: built.artifactPath, manifest }
}
