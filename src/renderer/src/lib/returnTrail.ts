// The way back from a jump, as the steps the operator took: origin › Timeline
// › Activity, at most. Only the app's own jumps build it (open in Timeline,
// open in Activity); any other move — sidebar, palette, shortcut — ends it.
// This is not a history stack: a jump that does not continue the trail starts
// a new one, and nothing is ever longer than three steps.
//
// The last step is the page on screen. A trail whose last step is not the
// current view is over (the view moved by some route that did not end it
// explicitly), and reads as no trail at all.

const MAX_TRAIL = 3

export type Trail = readonly string[]

const NONE: Trail = Object.freeze([])

/** The trail in force on `view`, or empty. */
export function currentTrail(trail: Trail, view: string): Trail {
  return trail.length > 1 && trail[trail.length - 1] === view ? trail : NONE
}

/** A jump to the Timeline from `view`. From the Timeline itself it is a new
 *  focus, not a step: the way back ends, as it always has. */
export function trailToTimeline(view: string): Trail {
  return view === 'timeline' ? [] : [view, 'timeline']
}

/** A jump to the Activity page from `view` (the Timeline). It continues the
 *  trail that brought the operator to `view`, or starts one there. A trail
 *  that already passed through Activity is not a way back to it: no page is a
 *  step twice. */
export function trailToActivity(trail: Trail, view: string): Trail {
  const base = currentTrail(trail, view)
  const next = [...(base.length > 0 ? base : [view]), 'search']
  return next.length > MAX_TRAIL || base.includes('search') ? [view, 'search'] : next
}

/** The sidebar key that names a step. */
export function trailLabelKey(view: string): string {
  return `sidebar.${view === 'screenshots' ? 'screens' : view}`
}
