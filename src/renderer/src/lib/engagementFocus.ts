// Which capture the first-run screen leads with.
//
// The screen asks for one thing — type a command — and once that lands it
// offers the next step. Until now that step was always "connect the terminal
// you actually work in", with HTTP capture beneath it as a dismissable extra.
// That order is right for a host engagement and wrong for a web one: an
// operator whose whole assessment is requests and responses is led through
// wiring a shell hook they may never use, and told in the layout that the
// thing they came for is optional.
//
// The engagement decides, so the operator says which one this is. The default
// is `both`, which keeps the order the screen has always had — nobody is asked
// to make a decision before making one, and an operator who ignores the choice
// gets today's screen.

export type EngagementFocus = 'terminal' | 'web' | 'both'

export const ENGAGEMENT_FOCUSES: readonly EngagementFocus[] = ['terminal', 'web', 'both']

export function isEngagementFocus(v: unknown): v is EngagementFocus {
  return typeof v === 'string' && (ENGAGEMENT_FOCUSES as readonly string[]).includes(v)
}

/** Read the stored focus, defaulting to `both` for anything unset or stale. */
export function readFocus(config: unknown): EngagementFocus {
  const engagement = (config as { engagement?: { focus?: unknown } } | null)?.engagement
  return isEngagementFocus(engagement?.focus) ? engagement.focus : 'both'
}

export type FirstRunStep = 'terminal' | 'http'

/** The two setup steps, in the order this engagement should meet them.
 *
 *  `both` leads with the terminal because that is the step already proven on
 *  this screen — the operator has just watched a command they typed appear in
 *  the strip, and connecting their own shell is the same thing one step out.
 *  Leading a web engagement with it instead makes the operator do a task they
 *  may never need before the one they came for. */
export function stepOrder(focus: EngagementFocus): readonly [FirstRunStep, FirstRunStep] {
  return focus === 'web' ? ['http', 'terminal'] : ['terminal', 'http']
}
