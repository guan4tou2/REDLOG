import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ProjectMeta } from './project-manager'
import type { ExportPlan, ExportRequest } from './export-plan'
import { exportAttachmentDigest } from './export-attachments'
import { buildExportPlan, validateExportSources } from './export-planning'
import { exportBundle, type ExportBundleOpts } from './bundle-export'
import type { exportHar } from './har-export'
import { writeApprovedHar } from './har-export-stream'
import { writeApprovedEvents, type EventFileFormat, type EventFileMetadata } from './export-events-file'

export type ExportTask =
  | { kind: 'plan'; project: ProjectMeta; request: ExportRequest }
  | { kind: 'validate'; project: ProjectMeta; plan: ExportPlan }
  | { kind: 'bundle'; project: ProjectMeta; engagementId: string; options: ExportBundleOpts; approvedPlan?: ExportPlan; attachmentDigest: string }
  | { kind: 'har'; project: ProjectMeta; outDir: string; options: NonNullable<Parameters<typeof exportHar>[0]>; approvedPlan?: ExportPlan }
  /** JSON / NDJSON / Timeline slice: selection, redaction, digest and file writing
   * all happen inside the worker. `outDir` is the final folder; the runner swaps
   * in the private staging file (`file`, already open as `fd`) before dispatch. */
  | { kind: 'events'; project: ProjectMeta; plan: ExportPlan; format: EventFileFormat; metadata: EventFileMetadata | null; outDir: string; file?: string; fd?: number }
export type ExportTaskResult = { plan: ExportPlan } | { validation: ReturnType<typeof validateExportSources> } | { artifactPath: string }

/** Core-only kernel: production runs this against a worker-owned read-only DB.
 * Tests may inject this same kernel at the IPC seam without changing policy. */
export function executeExportTask(task: ExportTask): ExportTaskResult {
  if (task.kind === 'plan') return { plan: buildExportPlan(task.project, task.request) }
  if (task.kind === 'validate') return { validation: validateExportSources(task.project, task.plan) }
  if (task.kind === 'events') {
    if (task.file === undefined || task.fd === undefined) throw new Error('Export task requires a staged file')
    writeApprovedEvents(task.plan, task.format, task.metadata, task.fd)
    return { artifactPath: task.file }
  }
  if (task.approvedPlan) {
    const validation = validateExportSources(task.project, task.approvedPlan)
    if (!validation.ok) throw new Error(validation.error)
  }
  if (!task.options.snapshot || !task.options.includeEventIds) throw new Error('Export task requires an approved snapshot')
  if (task.kind === 'bundle') {
    const artifactPath = exportBundle(task.engagementId, task.options).outDir
    if (exportAttachmentDigest(artifactPath, task.options.attachments ?? []) !== task.attachmentDigest) throw new Error('source-unavailable')
    return { artifactPath }
  }
  const artifactPath = path.join(task.outDir, `redlog-${randomUUID()}.har`)
  writeApprovedHar(artifactPath, task.options)
  return { artifactPath }
}
