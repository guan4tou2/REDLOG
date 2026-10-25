/** Delivery metadata, not evidence or a reusable export selection. */
export interface ExportDelivery {
  artifactPath: string
  format: 'json' | 'ndjson' | 'bundle' | 'har' | 'timeline'
  completedAt: number
  availability: 'available' | 'missing' | 'unavailable'
}
