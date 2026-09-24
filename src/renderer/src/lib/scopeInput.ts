// Pasted scope → scope entries (Spec 037). The create card takes the
// engagement's CIDRs/hosts as free text; this turns that text into the list
// `scope.targets` / `scope.excludeTargets` stores.
//
// There is no second grammar here. An entry is valid when the canonical
// evaluator (core/scope-evaluator) can match it at all: a CIDR must contain
// its own network address, a wildcard must match its bare domain, an IP must
// match its own /32 or /128, and a host must match itself. Anything else —
// `10.0.0.0/33`, `999.1.1.1`, `host:8080`, a URL — would be stored as a rule
// that never fires, so it is reported instead of saved.

import { matchPattern } from '../../../core/scope-evaluator'

// Hostname characters. matchPattern compares hosts as plain strings, so it
// accepts `a$b` matching itself; this only keeps such typos out of the list.
const HOST_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i

function isValidEntry(entry: string): boolean {
  if (entry.startsWith('*.')) {
    const bare = entry.slice(2)
    return HOST_RE.test(bare) && matchPattern(bare, entry)
  }
  const slash = entry.indexOf('/')
  if (slash !== -1) return matchPattern(entry.slice(0, slash), entry)
  if (entry.includes(':')) return matchPattern(entry, `${entry}/128`)
  if (/^[\d.]+$/.test(entry)) return matchPattern(entry, `${entry}/32`)
  return HOST_RE.test(entry) && matchPattern(entry, entry)
}

export function parseScopeInput(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const entry of text.split(/[\s,]+/)) {
    if (!entry) continue
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ;(isValidEntry(entry) ? valid : invalid).push(entry)
  }
  return { valid, invalid }
}
