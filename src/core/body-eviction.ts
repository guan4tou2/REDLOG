// Size-pressure eviction for the HTTP body store (docs/DESIGN-core-and-capture.md
// §6, salvaged design from PR #8's artifact-gc/pin).
//
// The body store keeps full captured request/response bodies as
// content-addressed sidecar files (http-body-store.ts). With static assets no
// longer skipped and a 10 MB per-body cap, an active web assessment fills a
// disk that time-based retention alone does not bound: a project three days
// into a keepDays=30 window can still be tens of gigabytes.
//
// ── Why this is safe to do to an evidence tool ──────────────────────────────
//
// Eviction deletes the `.body` FILE. It never touches the event. The event
// carries `{ sha256, size, file }` — the attestation — and the hash chain
// only ever contained the sha256, never the bytes. So an evicted body cannot
// break verification: the chain still proves what the body WAS, the operator
// simply can no longer open it. This is the one property that makes deleting
// captured content acceptable at all, and everything below is built to keep it
// true. An evicted body reads back as "content no longer on disk", never as a
// silent 404 — evidence that shrinks must say so, the same rule retention's
// per-deletion audit events already follow.
//
// ── The policy, made concrete ───────────────────────────────────────────────
//
// 1. Never evict a pinned body. Scope is the pin (the IPFS lesson from the
//    SPEC): a body referenced by an in-scope target, or flagged as evidence
//    (loot/marker), is what the operator is here to keep. Under pressure the
//    unpinned content goes first and the pinned content goes last — never.
// 2. Coldest first among the unpinned. Oldest last-modified, largest as the
//    tiebreak, so the sweep frees the most bytes touching the fewest, oldest
//    things.
// 3. Refcount-gated by content hash. Dedup means one `.body` file backs many
//    events; it is pinned if ANY referencing event pins it, and evictable only
//    when EVERY referencing event agrees. The caller encodes this by OR-ing
//    the pin flag across references before it reaches the planner.
// 4. If evicting every unpinned body still cannot reach the budget, stop and
//    report the shortfall rather than touch a pinned one. A full disk is a
//    problem to surface, not an excuse to delete evidence.

export interface BodyEntry {
  /** The `<sha256>.body` filename — the eviction unit. */
  file: string
  sizeBytes: number
  /** Last-modified, for coldest-first ordering. */
  mtimeMs: number
  /** True if any referencing event is in-scope or evidence-flagged. Pinned
   *  bodies are never evicted. */
  pinned: boolean
}

export interface EvictionPlan {
  /** Files to delete, in the order chosen (coldest, largest first). */
  evict: string[]
  /** Bytes the plan frees. */
  freedBytes: number
  /** Bytes still over budget after evicting everything evictable — >0 only
   *  when the pinned set alone exceeds the budget. Surfaced, never resolved by
   *  evicting a pinned body. */
  shortfallBytes: number
  /** Total store size before the plan. */
  totalBytes: number
}

/**
 * Decide what to evict to bring the store under `budgetBytes`.
 *
 * `budgetBytes <= 0` means unbounded — evict nothing. This is the default, so
 * turning eviction on is a deliberate choice, and a project that never sets a
 * cap behaves exactly as it did before this existed.
 */
export function planEviction(entries: BodyEntry[], budgetBytes: number): EvictionPlan {
  const totalBytes = entries.reduce((n, e) => n + e.sizeBytes, 0)
  if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
    return { evict: [], freedBytes: 0, shortfallBytes: 0, totalBytes }
  }

  // Only the unpinned are candidates. Coldest first, largest as the tiebreak.
  const candidates = entries
    .filter((e) => !e.pinned)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || b.sizeBytes - a.sizeBytes)

  const pinnedBytes = entries.filter((e) => e.pinned).reduce((n, e) => n + e.sizeBytes, 0)

  const evict: string[] = []
  let freedBytes = 0
  let remaining = totalBytes
  for (const e of candidates) {
    if (remaining <= budgetBytes) break
    evict.push(e.file)
    freedBytes += e.sizeBytes
    remaining -= e.sizeBytes
  }

  // If the pinned set alone is over budget, `remaining` cannot reach it no
  // matter what — report the gap honestly rather than evicting a pinned body.
  const shortfallBytes = Math.max(0, remaining - budgetBytes)
  // The shortfall is only real when it is the pinned floor; if candidates
  // remained we would have kept going, so any positive remainder here is
  // pinned weight.
  void pinnedBytes

  return { evict, freedBytes, shortfallBytes, totalBytes }
}
