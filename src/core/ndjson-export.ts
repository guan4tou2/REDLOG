import os from 'os'
import { redactEventForExport } from './redact-export'
import type { RedLogEvent } from './db/events'
import type { ScopeForSanitize } from './scope-sanitize'

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Regex replacements applied to each serialized event LINE when
 *  scrubOperatorPii is set. Reads the running machine's identifiers at call
 *  time. Home path and hostname are specific enough to replace verbatim; the
 *  username is guarded by word boundaries and a length floor so a short/common
 *  account name doesn't shred unrelated text. */
export function operatorPiiReplacements(
  ids: { home?: string; user?: string; host?: string } = {}
): Array<[RegExp, string]> {
  const home = ids.home ?? os.homedir()
  const user = ids.user ?? os.userInfo().username
  const host = ids.host ?? os.hostname()
  const reps: Array<[RegExp, string]> = []
  if (home) {
    reps.push([new RegExp(escapeRegExp(home), 'g'), '<home>'])
    // Inside a JSON string a Windows path's backslashes are doubled.
    if (home.includes('\\')) reps.push([new RegExp(escapeRegExp(home.replace(/\\/g, '\\\\')), 'g'), '<home>'])
  }
  if (host) reps.push([new RegExp(escapeRegExp(host), 'g'), '<host>'])
  if (user && user.length >= 3) reps.push([new RegExp('\\b' + escapeRegExp(user) + '\\b', 'g'), '<user>'])
  return reps
}

/** One redacted event → one JSON line. Prepends `@timestamp` (ISO 8601 from the
 *  epoch-ms `timestamp`) for a log store's default time field. */
export function eventsToNdjson(events: RedLogEvent[], opts: NdjsonExportOpts = {}): string {
  const reps = opts.scrubOperatorPii ? operatorPiiReplacements() : []
  const out: string[] = []
  for (const e of events) {
    const red = redactEventForExport(e, opts.scope)
    const withTs = { '@timestamp': new Date(red.timestamp).toISOString(), ...red }
    let line = JSON.stringify(withTs)
    for (const [re, rep] of reps) line = line.replace(re, rep)
    out.push(line)
  }
  return out.length ? out.join('\n') + '\n' : ''
}
