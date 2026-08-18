// The pure decision behind <SplitPane>'s drag (DESIGN-SYSTEM.md §6.2). Given a
// desired pixel size for the resizable pane, clamp it so it (a) stays within the
// component's [min, max], and (b) never starves the OTHER pane below `otherMin`
// px of the current container. Lifting this out of the drag handler makes the
// bounds written down and testable, mirroring lib/timelineWheel.ts.
//
// Callers compute `px` (start size + pointer delta) and `containerPx` (the split
// container's measured extent along the drag axis) and apply the returned size.

export function splitPaneClamp(
  px: number,
  min: number,
  max: number,
  containerPx: number,
  otherMin = 120
): number {
  // The largest the resizable pane may grow to: its own `max`, but never so far
  // that the other pane drops below `otherMin`. Floor it at `min` so a tiny
  // container can't invert the range (hardMax < min) — in that degenerate case
  // `min` wins and the other pane simply gets whatever is left.
  const hardMax = Math.max(min, Math.min(max, containerPx - otherMin))
  return Math.max(min, Math.min(px, hardMax))
}
