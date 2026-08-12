// Empty-state decision seam (UX-AUDIT / UX-BACKLOG F4).
//
// `Feedback.tsx` ships a CTA-carrying `EmptyState` primitive that had zero
// usages — every view rolled its own actionless "nothing here" dead end. This
// pure function is the first half of the fix: it decides, per view and per
// capture context, WHICH copy the empty state shows and WHAT the single call to
// action is. The wiring step (separate) feeds the result into `<EmptyState />`.
//
// Two deliberate constraints keep this seam collision-free with the live app:
//   1. titleKey / subtitleKey REUSE i18n keys that already exist in en.json.
//      This function never invents an i18n key.
//   2. action.labelKey is a STABLE, non-i18n identifier (e.g.
//      `empty.action.setupCapture`). The real label is added to i18n at wiring
//      time; keeping it out of here means this file never touches en.json.
//
// `target` is the CTA destination identifier the wiring layer routes on: a nav
// target (`dashboard`, `screenshot`, `marker`) or a doc anchor (`doc`).

/** The six views that have an empty state worth wiring a CTA into. */
export type EmptyView = 'timeline' | 'screenshots' | 'targets' | 'loot' | 'marks' | 'transcript'

export interface EmptyStateModel {
  /** existing i18n key for the empty-state title */
  titleKey: string
  /** existing i18n key for the empty-state subtitle */
  subtitleKey: string
  /** the single call-to-action; absent when there is nothing useful to do yet */
  action?: { labelKey: string; target: string }
}

/** Capture context that changes what the most useful next action is. */
export interface EmptyStateCtx {
  /** true when no capture source is feeding events — the timeline stays dark. */
  captureDark: boolean
}

// Stable, non-i18n action identifiers. Resolved to real labels at wiring time.
const SETUP_CAPTURE = { labelKey: 'empty.action.setupCapture', target: 'dashboard' } as const
const CAPTURE_NOW = { labelKey: 'empty.action.captureNow', target: 'screenshot' } as const
const MARK_NOW = { labelKey: 'empty.action.mark', target: 'marker' } as const
const LEARN_MORE = { labelKey: 'empty.action.learnMore', target: 'doc' } as const

// Per-view copy (reused i18n keys) + the action used when capture IS feeding.
// The capture-dark override is applied afterwards for the views where a dark
// timeline is the real reason they're empty (DESIGN-PRINCIPLES §1: without
// capture, nothing lands anywhere).
const BASE: Record<EmptyView, EmptyStateModel> = {
  // Timeline light-capture case has no action: events simply haven't arrived yet
  // and pushing to Dashboard would be noise. The dark override adds the CTA.
  timeline: { titleKey: 'timeline.noEvents', subtitleKey: 'timeline.noEventsDesc' },
  screenshots: {
    titleKey: 'screenshots.empty',
    subtitleKey: 'screenshots.emptyDesc',
    action: { ...CAPTURE_NOW }
  },
  targets: {
    titleKey: 'targets.empty',
    subtitleKey: 'targets.subtitle',
    action: { ...LEARN_MORE }
  },
  loot: {
    titleKey: 'loot.empty',
    subtitleKey: 'loot.emptyDesc',
    action: { ...SETUP_CAPTURE }
  },
  marks: {
    titleKey: 'marks.empty',
    subtitleKey: 'marks.placeholderSub',
    action: { ...MARK_NOW }
  },
  // Transcript has no dedicated subtitle key; it is a second reading of the same
  // event store, so it reuses the timeline's "events will appear here" copy.
  transcript: {
    titleKey: 'transcript.empty',
    subtitleKey: 'timeline.noEventsDesc',
    action: { ...LEARN_MORE }
  }
}

// When capture is dark these views cannot receive anything until a source is
// wired, so their CTA is redirected to "set up capture" regardless of their
// light-capture action. Screenshots is excluded — it IS a capture source, so
// "capture now" is still the right, self-contained action.
const DARK_REDIRECT: ReadonlySet<EmptyView> = new Set<EmptyView>([
  'timeline',
  'loot',
  'targets',
  'transcript',
  'marks'
])

/**
 * Decide the empty-state model for a view under the current capture context.
 * Pure — no i18n resolution, no DOM, no side effects.
 */
export function emptyStateFor(view: EmptyView, ctx: EmptyStateCtx): EmptyStateModel {
  const base = BASE[view]
  if (ctx.captureDark && DARK_REDIRECT.has(view)) {
    return { titleKey: base.titleKey, subtitleKey: base.subtitleKey, action: { ...SETUP_CAPTURE } }
  }
  // Clone the action so callers can't mutate the shared BASE table.
  return {
    titleKey: base.titleKey,
    subtitleKey: base.subtitleKey,
    action: base.action ? { ...base.action } : undefined
  }
}
