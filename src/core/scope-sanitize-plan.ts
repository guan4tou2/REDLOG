// Scope-aware sanitize planner (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B, G3). Pure:
// given candidate events and a pure scope classifier, decide which events'
// bodies to sanitize for a client-deliverable export. The actual byte
// replacement reuses sanitize.ts (inline fields) + the io sidecar; this function
// only produces the PLAN (a dry-run), which the operator confirms.
//
// Two safety rules the spec is emphatic about:
//   - `unknown`-target events are NEVER auto-sanitized — sanitize removes content
//     from a *reviewable copy*, so an absent verdict surfaces for operator
//     decision (default unchecked), never a silent strip (A2).
//   - The plan MUST cover the event's io_ref sidecar body, not just inline
//     fields — an out-of-scope response body lives in `io/<sha>.bin` and would
//     leak through the side door otherwise (A1, §3 "critical").

import type { ScopeVerdict } from './artifact-pin'

/** Minimal event shape the planner needs — decoupled from the DB row type. */
export interface SanitizeCandidate {
  id: string
  targetId?: string | null
  data: Record<string, unknown>
}

export type SanitizeAction = 'sanitize' | 'flag_unknown' | 'keep'

export interface ScopeSanitizeItem {
  eventId: string
  target: string | null
  scope: ScopeVerdict
  action: SanitizeAction
  /** Inline body fields present on the event, proposed for sanitization. */
  fields: string[]
  /** io sidecar body digests referenced by the event (must be sanitized too). */
  ioRefs: string[]
}

export interface ScopeSanitizePlan {
  items: ScopeSanitizeItem[]
  /** action === 'sanitize' — out-of-scope / excluded, auto-checked. */
  toSanitize: ScopeSanitizeItem[]
  /** action === 'flag_unknown' — surfaced for operator decision, default off. */
  unknown: ScopeSanitizeItem[]
  /** count of in-scope events left untouched. */
  keptInScope: number
}

// Body/content fields that can carry out-of-scope bytes. Deliberately excludes
// `command` and target metadata: the *fact* a host was touched (and by what
// action) must survive in a client deliverable — only the captured content of
// the out-of-scope exchange is stripped (A1: the scope_violation + host remain).
const BODY_FIELDS = ['response_preview', 'request_body_preview', 'output', 'output_preview', 'stdout', 'stderr'] as const

/** Resolve the host/target a candidate event is about, for scope classification.
 *  Mirrors the extraction the capture path uses; null when none is present. */
export function resolveEventTarget(c: SanitizeCandidate): string | null {
  const d = c.data
  const direct = c.targetId || (d.dest_host as string) || (d.host as string) || (d.detectedTarget as string)
  if (direct) return direct
  const url = d.url as string | undefined
  if (typeof url === 'string') {
    try { return new URL(url).hostname || null } catch { /* not a full URL */ }
  }
  return null
}

function ioRefsOf(data: Record<string, unknown>): string[] {
  const io = data.io as { request?: { ref?: unknown }; response?: { ref?: unknown } } | undefined
  if (!io) return []
  const out: string[] = []
  for (const slot of ['request', 'response'] as const) {
    const ref = io[slot]?.ref
    if (typeof ref === 'string') out.push(ref)
  }
  return out
}

export function planScopeSanitize(
  events: SanitizeCandidate[],
  classify: (target: string | null) => ScopeVerdict
): ScopeSanitizePlan {
  const items: ScopeSanitizeItem[] = []
  for (const e of events) {
    const target = resolveEventTarget(e)
    const scope = classify(target)
    const fields = BODY_FIELDS.filter((f) => typeof e.data[f] === 'string' && (e.data[f] as string).length > 0)
    const ioRefs = ioRefsOf(e.data)
    // Nothing to strip on this event → don't list it at all (keeps the preview
    // focused on events that actually carry content).
    if (fields.length === 0 && ioRefs.length === 0) continue

    let action: SanitizeAction
    if (scope === 'out_of_scope' || scope === 'excluded') action = 'sanitize'
    else if (scope === 'unknown') action = 'flag_unknown'
    else action = 'keep'   // in_scope

    items.push({ eventId: e.id, target, scope, action, fields, ioRefs })
  }
  return {
    items,
    toSanitize: items.filter((i) => i.action === 'sanitize'),
    unknown: items.filter((i) => i.action === 'flag_unknown'),
    keptInScope: items.filter((i) => i.action === 'keep').length
  }
}
