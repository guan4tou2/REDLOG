// Renderer-side mask helper for layer 3 of four-layer redaction (see
// docs/redaction-design.md). The raw text stays in event.data.output; this
// composes the masked view for display. Mirrors maskText in
// src/core/redaction.ts — we can't import from core in the renderer, and
// this is a pure function short enough to duplicate.
//
// The reveal action is the counterpart: on click, timeline unmasks a single
// event and logs a chained system.secret_revealed event so the audit trail
// records that raw bytes were viewed.

export interface RedactionSpan {
  field: string
  start: number
  end: number
  pattern?: string
  hint?: string
}

export function maskText(text: string, spans: RedactionSpan[], char = '•'): string {
  if (!spans.length) return text
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.start < cursor) continue
    parts.push(text.slice(cursor, s.start))
    parts.push(char.repeat(Math.max(1, s.end - s.start)))
    cursor = s.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/** Copy of event.data with masked string fields when data.redactions has spans
 *  for those fields. Non-string fields are passed through untouched. */
export function maskEventData(
  data: Record<string, unknown>,
  spans: RedactionSpan[] | undefined
): Record<string, unknown> {
  if (!spans || spans.length === 0) return data
  // Group spans by field for O(fields) rebuilds instead of O(spans*fields).
  const byField = new Map<string, RedactionSpan[]>()
  for (const s of spans) {
    if (!byField.has(s.field)) byField.set(s.field, [])
    byField.get(s.field)!.push(s)
  }
  const out: Record<string, unknown> = { ...data }
  for (const [field, fieldSpans] of byField) {
    const val = out[field]
    if (typeof val === 'string') out[field] = maskText(val, fieldSpans)
  }
  return out
}

/** Which fields in this event have detected redaction spans. Used to label
 *  the reveal button ("Reveal 2 secrets in output, command") and to attribute
 *  the resulting system.secret_revealed event. */
export function fieldsWithRedactions(spans: RedactionSpan[] | undefined): string[] {
  if (!spans || spans.length === 0) return []
  const set = new Set<string>()
  for (const s of spans) set.add(s.field)
  return [...set]
}
