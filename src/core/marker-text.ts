// How much text a marker holds. The HUD form has always cut a title at 200
// characters and notes at 10 000 (main/ipc/markers.ts, hudMarkerFields); the
// app's own marker dialog and the API stored whatever they were sent, so a
// 1 MiB title went into the chain. One limit for every door.

export const MARKER_TITLE_MAX = 200
export const MARKER_NOTES_MAX = 10_000

/** A marker text field: strings are cut to `max`, anything else is dropped. */
export function capMarkerText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}
