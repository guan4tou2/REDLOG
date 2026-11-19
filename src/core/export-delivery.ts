import type { ExportCounts } from './export-plan'

/** Delivery metadata, not evidence or a reusable export selection. */
export interface ExportDelivery {
  artifactPath: string
  format: 'json' | 'ndjson' | 'bundle' | 'har' | 'timeline'
  completedAt: number
  counts?: Pick<ExportCounts, 'included' | 'excludedDoNotExport' | 'excludedPersonal' | 'maskedOutOfScope' | 'maskedUnclassified' | 'exchanges' | 'attachmentsIncluded'>
  availability: 'available' | 'missing' | 'unavailable'
}
