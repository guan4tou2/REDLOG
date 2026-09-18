import { redactEventForExport } from './redact-export'
import { operatorPiiReplacements } from './operator-pii'
import type { RedLogEvent } from './db/events'
import type { ScopeForSanitize } from './scope-sanitize'

// Re-export for backward compat — existing callers import from here.
export { operatorPiiReplacements } from './operator-pii'

// NDJSON (newline-delimited JSON) export — one redacted event per line, the
// native shape for a shared log store (ELK / Filebeat / Logstash), where the
// full evidence bundle (report, verifier, sidecars) is the wrong artifact and a
// pretty-printed JSON array is not line-ingestable. The chain columns
// (hash / prev_hash) survive so integrity is still verifiable after ingestion,
// and an ISO `@timestamp` alias is added so the store's time field maps without
// a Logstash filter. Redaction is the same boundary rule as every other export
// (§10): the layer-4 sanitize swap always applies, and passing `scope` masks
// out-of-scope CONTENT. For a multi-user store, prefer feeding this the
// already-scope-FILTERED event set (out-of-scope rows excluded, not just masked)
// and set `scrubOperatorPii`.

export interface NdjsonExportOpts {
  scope?: ScopeForSanitize
  /** Scrub identifiers that reveal the operator's real-world identity beyond
   *  their pseudonymous operator name — OS home path, account username, machine
   *  hostname — so a log shared into a multi-user store can't be traced past
   *  the pseudonym. Off by default: a single-operator export keeps attribution. */
  scrubOperatorPii?: boolean
}

/** One redacted event → one JSON line. Prepends `@timestamp` (ISO 8601 from the
 *  epoch-ms `timestamp`) for a log store's default time field. */
export function eventsToNdjson(events: RedLogEvent[], opts: NdjsonExportOpts = {}): string {
  const reps = opts.scrubOperatorPii ? operatorPiiReplacements() : []
  const out: string[] = []
  for (const e of events) {
    const red = redactEventForExport(e, opts.scope)
    if (!red) continue
    const withTs = { '@timestamp': new Date(red.timestamp).toISOString(), ...red }
    let line = JSON.stringify(withTs)
    for (const [re, rep] of reps) line = line.replace(re, rep)
    out.push(line)
  }
  return out.length ? out.join('\n') + '\n' : ''
}
