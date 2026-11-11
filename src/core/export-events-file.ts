import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { eventsToNdjson } from './ndjson-export'
import { operatorPiiReplacements } from './operator-pii'
import { redactEventForExport } from './redact-export'
import { iterateSnapshotEvents } from './export-selection'
import type { ExportPlan } from './export-plan'
import type { RedLogEvent } from './db/events'

export type EventFileFormat = 'json' | 'ndjson' | 'timeline'
export interface EventFileMetadata {
  config?: unknown
  exportedAt?: string
  exportPlan: { id: string; fingerprint: string }
  selection?: unknown
  window?: { fromMs: number; toMs: number }
}

/** Writes one approved event file row by row. The JSON envelope, per-row
 * indentation, operator-PII scrubbing per written chunk and the NDJSON line
 * shape are the bytes the earlier main-thread writer produced; changing where
 * this runs must not change them. */
export class EventFileWriter {
  private count = 0
  private suffix = ''
  private readonly replacements: Array<[RegExp, string]>

  constructor(private readonly fd: number, private readonly format: EventFileFormat,
    metadata: EventFileMetadata | null, scrubPii: boolean) {
    this.replacements = scrubPii ? operatorPiiReplacements() : []
    if (format === 'ndjson') return
    const document = JSON.stringify(format === 'timeline'
      ? { ...metadata, events: [], amendments: [] }
      : { config: metadata?.config, events: [], exportedAt: metadata?.exportedAt, exportPlan: metadata?.exportPlan }, null, 2)
    const index = document.lastIndexOf('"events": []') + '"events": '.length
    this.write(document.slice(0, index))
    this.suffix = document.slice(index + 2)
  }

  row(event: RedLogEvent): void {
    if (this.format === 'ndjson') this.write(eventsToNdjson([event], { alreadyRedacted: true }))
    else this.write((this.count ? ',\n' : '[\n') + JSON.stringify(event, null, 2).split('\n').map(line => '    ' + line).join('\n'))
    this.count++
  }

  /** Close the envelope and force the bytes to disk. The caller owns the fd. */
  end(): void {
    if (this.format !== 'ndjson') this.write((this.count ? '\n  ]' : '[]') + this.suffix)
    fs.fsyncSync(this.fd)
  }

  private write(text: string): void {
    for (const [re, value] of this.replacements) text = text.replace(re, value)
    const buffer = Buffer.from(text)
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(this.fd, buffer, offset, buffer.length - offset)
  }
}

/** Read-only worker kernel for JSON / NDJSON / Timeline delivery. Walks the
 * approved snapshot, keeps the approved ids, redacts, digests exactly the rows it
 * writes and refuses (`source-unavailable`) when that digest or count is not the
 * one the operator approved. Nothing here runs on the UI thread. */
export function writeApprovedEvents(plan: ExportPlan, format: EventFileFormat, metadata: EventFileMetadata | null, fd: number): void {
  const selectedIds = new Set(plan.selectedEventIds)
  const redaction = { scope: plan.request.maskOutOfScope ? plan.scopeSnapshot : undefined }
  const writer = new EventFileWriter(fd, format, metadata, plan.request.scrubPii)
  const digest = createHash('sha256').update('[')
  let count = 0
  for (const event of iterateSnapshotEvents(plan.snapshot)) {
    if (!selectedIds.has(event.id)) continue
    const redacted = redactEventForExport(event, redaction)
    if (!redacted) continue
    if (count++) digest.update(',')
    digest.update(JSON.stringify(redacted))
    writer.row(redacted)
  }
  digest.update(']')
  // Verify exactly the bytes written for this delivery, not a second read.
  if (count !== selectedIds.size || digest.digest('hex') !== plan.selectedEvidenceDigest) throw new Error('source-unavailable')
  writer.end()
}
