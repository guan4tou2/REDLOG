// One decision, three surfaces (`ALERT-ROLES.md` A.3, G-A3).
//
// StatusBar, IPStatusCard and the overlay HUD each style themselves differently
// — tailwind classes, HUD hex, neon frame — but they must never DISAGREE about
// what the verdict is. Before this, `settling` and `stale` were not even
// declared on the renderer's IPStatus, so no surface could show them: a badge
// could sit on green while the reading behind it was 40 seconds dead. The
// styling stays local; the decision lives here.

export type IPBadgeTone = 'safe' | 'exposed' | 'unknown'

export interface IPBadge {
  /** What colour the surface should use. */
  tone: IPBadgeTone
  /** The verdict is not backed by a current reading — render it de-emphasised
   *  (dimmed / outlined / no flash), never at full confidence. */
  qualified: boolean
  reason: 'stale' | 'settling' | null
}

interface BadgeInput {
  ipSafety?: IPBadgeTone
  settling?: boolean
  stale?: boolean
}

export function ipBadge(status: BadgeInput | null | undefined): IPBadge {
  const tone = status?.ipSafety ?? 'unknown'
  // `stale` wins over `settling`: no reading at all is a stronger statement than
  // an unconfirmed one. Tone is forced rather than trusted — the main process
  // already decays it, and a surface must not out-run that if the two ever drift.
  if (status?.stale) return { tone: 'unknown', qualified: true, reason: 'stale' }
  if (status?.settling) return { tone, qualified: true, reason: 'settling' }
  return { tone, qualified: false, reason: null }
}
