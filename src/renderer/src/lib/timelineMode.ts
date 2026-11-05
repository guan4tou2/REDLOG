/** Spec 069 FR-008. "standard" is the default; anything unreadable or unknown
 * in storage falls back to it rather than to the denser view. */
export type TimelineMode = 'standard' | 'lanes'

export function parseTimelineMode(raw: string | null): TimelineMode {
  return raw === 'lanes' ? 'lanes' : 'standard'
}
