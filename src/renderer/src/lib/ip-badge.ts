// One decision, three surfaces (`ALERT-ROLES.md` A.3, G-A3).
//
// StatusBar, IPStatusCard and the overlay HUD each style themselves differently
// — tailwind classes, HUD hex, neon frame — but they must never DISAGREE about
// what the verdict is. Before this, `settling` and `stale` were not even
// declared on the renderer's IPStatus, so no surface could show them: a badge
// could sit on green while the reading behind it was 40 seconds dead. The
// styling stays local; the decision lives here.

import { ipSeverity, type Severity } from './alertSeverity'

export interface IPBadge {
  /** Where this verdict sits on the SHARED scale the scope alarm also uses
   *  (G-C1). Fewer levels than verdicts on purpose: `presumed_safe` is `ok`
   *  like `safe`, and `qualified` is what separates them. */
  severity: Severity
  /** Render de-emphasised (hollow / unglowing / no flash), never at full
   *  confidence. Two different things land here and both must: the READING is
   *  not current (`stale`, `settling`), or the reading is current but the
   *  JUDGEMENT is an inference (`presumed`). */
  qualified: boolean
  reason: 'stale' | 'settling' | 'presumed' | null
}

interface BadgeInput {
  ipSafety?: 'safe' | 'presumed_safe' | 'off_profile' | 'exposed' | 'unknown'
  settling?: boolean
  stale?: boolean
}

export function ipBadge(status: BadgeInput | null | undefined): IPBadge {
  const verdict = status?.ipSafety ?? 'unknown'
  const severity = ipSeverity(verdict)

  // Precedence runs from "how much do we know" outward. No reading at all beats
  // an unconfirmed reading, which beats a confirmed reading we can only draw an
  // inference from. All three qualify the badge; they differ in what to say.
  if (status?.stale) return { severity: 'unknown', qualified: true, reason: 'stale' }
  if (status?.settling) return { severity, qualified: true, reason: 'settling' }
  if (verdict === 'presumed_safe') return { severity, qualified: true, reason: 'presumed' }
  return { severity, qualified: false, reason: null }
}
