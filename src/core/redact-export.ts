import { getSanitizedFields } from './sanitize'
import { scopeMaskReplacements, isPersonalDomain, type ScopeForSanitize } from './scope-sanitize'
import type { RedLogEvent } from './db/events'

// The redaction every export MUST funnel through before event data leaves
// RedLog. Until now only the evidence bundle (bundle-export.ts) applied it, so
// Export JSON / HAR / loot / scope-filtered / marks / timeline-slice shipped
// raw `events.data` — an operator-sanitized secret (four-layer redaction,
// layer 4) leaked through all of them, and any API token holder could pull
// out-of-scope bytes via GET /api/export/har. This is the single choke point.
//
// - The layer-4 sanitize swap (getSanitizedFields) ALWAYS applies: the operator
//   explicitly redacted these bytes; they must never leave in ANY export.
// - Scope masking applies only when a scope is supplied: out-of-scope hosts'
//   captured bytes are masked, their metadata kept.
// The source DB row is never touched — only the exported copy is rewritten, so
// the hash chain still refers to the original bytes (reconciled via the source
// DB or the paired system.sanitized event, exactly as the bundle does).

// A masked HTTP body field also has a sha256 body-store pointer (`*_ref`); a
// consumer that follows the ref (HAR's readBody) would fetch the full original
// bytes and defeat the mask. So when a body field is masked, drop its ref too.
export const BODY_REF_FOR: Record<string, string> = {
  request_body: 'request_body_ref',
  request_body_preview: 'request_body_ref',
  response_body: 'response_body_ref',
  response_body_preview: 'response_body_ref',
  response_preview: 'response_body_ref',
  ws_body: 'ws_body_ref',
  ws_preview: 'ws_body_ref',
  tcp_body: 'tcp_body_ref',
  tcp_preview: 'tcp_body_ref',
  output: 'output_ref',
  stdout: 'stdout_ref',
  stderr: 'stderr_ref'
}

export interface RedactExportOpts {
  scope?: ScopeForSanitize
  /** Row-level "don't export this event" flags. Loaded once by the caller. */
  doNotExportIds?: Set<string>
}

/** Redact one event's data for export. Returns the same object when nothing
 *  changed, so callers can cheaply skip re-serialization.
 *  Returns null when the event should be EXCLUDED entirely (do-not-export or personal). */
export function redactEventForExport(e: RedLogEvent, scopeOrOpts?: ScopeForSanitize | RedactExportOpts): RedLogEvent | null {
  const opts: RedactExportOpts = scopeOrOpts && 'targets' in scopeOrOpts
    ? { scope: scopeOrOpts }
    : (scopeOrOpts as RedactExportOpts | undefined) ?? {}
  const { scope, doNotExportIds } = opts

  if (doNotExportIds?.has(e.id)) return null

  // Personal/local traffic: always dropped — these rows should never leave
  // the local machine regardless of export mode (merge or delivery).
  if (isPersonalDomain(e.targetId, scope)) return null

  const maskedFields: string[] = []
  let data: Record<string, unknown> = e.data

  const replacements = getSanitizedFields(e.id)
  if (Object.keys(replacements).length > 0) {
    data = { ...e.data }
    for (const [f, v] of Object.entries(replacements)) { data[f] = v; maskedFields.push(f) }
  }

  if (scope) {
    const scopeRepl = scopeMaskReplacements(data, e.targetId, scope)
    if (scopeRepl) {
      if (data === e.data) data = { ...e.data }
      for (const [f, v] of Object.entries(scopeRepl)) { data[f] = v; maskedFields.push(f) }
    }
  }

  // Drop the body-store pointer for any masked body field, so a ref-following
  // consumer can't fetch the un-redacted original.
  for (const f of maskedFields) {
    const ref = BODY_REF_FOR[f]
    if (ref && ref in data) { if (data === e.data) data = { ...e.data }; delete data[ref] }
  }

  return data === e.data ? e : { ...e, data }
}

/** Redact a whole list for export (map of the above, filtering out nulls). */
export function redactEventsForExport(events: RedLogEvent[], scopeOrOpts?: ScopeForSanitize | RedactExportOpts): RedLogEvent[] {
  return events.map((e) => redactEventForExport(e, scopeOrOpts)).filter((e): e is RedLogEvent => e !== null)
}
