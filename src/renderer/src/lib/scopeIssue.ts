import type { IssueTier, IssueFix } from './issues'

// Whether the scope state is something to act on, as a reading rather than a
// component.
//
// The dashboard used to answer this with a stat tile whose four states were
// three different kinds of thing wearing one shape — a violation count, a
// failed read, an undeclared scope, and a green box whose whole content was
// that there was nothing to say. The count belongs on the sidebar badge, next
// to the page that opens it. The other two are conditions, and conditions go
// to the issue store.
//
// Pure, for the reason integrityPulse is: the status bar raises it and the
// dashboard renders it, and a policy written twice is a policy that is about
// to be two policies.

export interface ScopeReading {
  /** The first read has not landed. `configured` is false until it does, and
   *  raising on that would put a counter on screen at every launch. */
  loading: boolean
  configured: boolean
  /** The violation count or the configuration could not be read at all. */
  unknown: boolean
}

export interface ScopeIssue {
  tier: IssueTier
  titleKey: string
  detailKey: string
  fix?: IssueFix
}

/** The scope condition currently true, or null when there is nothing to say. */
export function scopeIssue(r: ScopeReading): ScopeIssue | null {
  if (r.loading) return null
  // A failed read outranks an undeclared scope: one of them means RedLog does
  // not know, and the operator cannot tell the difference from any other
  // surface.
  if (r.unknown) {
    return {
      tier: 'attention',
      titleKey: 'issues.scopeUnknown',
      detailKey: 'issues.scopeUnknownDetail',
      fix: 'recheck-scope'
    }
  }
  if (r.configured) return null
  // Pending, not attention. An engagement minutes old has not declared its
  // targets yet and nothing is wrong with it; a red counter that is right on
  // the first morning of every project is one nobody reads by the second. It
  // clears the moment a target is declared.
  return { tier: 'pending', titleKey: 'issues.scopeUnset', detailKey: 'issues.scopeUnsetDetail' }
}
