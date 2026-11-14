// What each export format can do (docs/domain/SPEC-export-event-selection.md).
// The plan resolver refuses a request a format cannot honour; the export menu
// reads the same table so it does not offer that request in the first place.
//
// No imports: the renderer bundles this file.

export type ExportFormat = 'json' | 'ndjson' | 'bundle' | 'har' | 'timeline'

export interface ExportCapabilities {
  snapshot: boolean
  boundedSubset: boolean
  /** `optional`: the operator chooses. `always`: out-of-scope content is
   *  masked and there is no choice to offer. */
  scopeMasking: 'optional' | 'always'
  piiScrubbing: boolean
  attachments: boolean
}

const CAPABILITIES: Record<ExportFormat, ExportCapabilities> = {
  json: { snapshot: true, boundedSubset: true, scopeMasking: 'optional', piiScrubbing: true, attachments: false },
  ndjson: { snapshot: true, boundedSubset: true, scopeMasking: 'optional', piiScrubbing: true, attachments: false },
  bundle: { snapshot: true, boundedSubset: true, scopeMasking: 'optional', piiScrubbing: false, attachments: true },
  har: { snapshot: true, boundedSubset: true, scopeMasking: 'always', piiScrubbing: false, attachments: false },
  timeline: { snapshot: true, boundedSubset: true, scopeMasking: 'optional', piiScrubbing: true, attachments: false }
}

export function isExportFormat(format: string): format is ExportFormat {
  return Object.hasOwn(CAPABILITIES, format)
}

export function capabilitiesFor(format: ExportFormat): ExportCapabilities {
  return { ...CAPABILITIES[format] }
}
