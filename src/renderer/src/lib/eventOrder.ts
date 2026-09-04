// Which of two events happened first, when the wall clock cannot say.
//
// `monotonic_ns` is written as `${bootEpochMs}-${nanoseconds}`, both halves
// zero-padded to fixed width (src/core/db/events.ts). The boot prefix is what
// makes it comparable across process restarts: two rows from different runs
// have unrelated nanosecond counters, so the boot epoch has to break that tie
// first.
//
// The obvious `BigInt(monotonicNs)` was in the timeline for months and never
// once ran: the hyphen makes it throw, so every same-millisecond pair silently
// fell through to comparing UUIDs. That is invisible — the events are ordered,
// just not in the order they happened — which is why this now lives in one
// place with a test, rather than being written out twice.

/** Split `bootMs-ns` into its two numbers. Rows written before the boot prefix
 *  landed carry the padded nanoseconds alone; they take boot 0 so they sort
 *  ahead of anything from a later run, which is where they belong. */
function split(mono: string | null | undefined): { boot: bigint; ns: bigint } | null {
  if (!mono) return null
  const dash = mono.indexOf('-')
  try {
    if (dash < 0) return { boot: 0n, ns: BigInt(mono) }
    return { boot: BigInt(mono.slice(0, dash)), ns: BigInt(mono.slice(dash + 1)) }
  } catch {
    return null
  }
}

/**
 * Compare two monotonic stamps. Returns 0 when either is missing or malformed,
 * so a caller can fall through to its own next key rather than inventing an
 * order out of nothing.
 */
export function compareMonotonicNs(a: string | null | undefined, b: string | null | undefined): number {
  const am = split(a)
  const bm = split(b)
  if (!am || !bm) return 0
  if (am.boot !== bm.boot) return am.boot < bm.boot ? -1 : 1
  if (am.ns !== bm.ns) return am.ns < bm.ns ? -1 : 1
  return 0
}
