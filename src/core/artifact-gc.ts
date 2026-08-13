// Artifact rotation planner (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C). Pure: given
// the current io/ bodies and their resolved facts, decide what to WARM
// (compress) and what to PRUNE (delete) this sweep. The fs side effects live in
// retention.ts; the *decision* lives here so it is unit-testable in isolation.
//
// Three properties this function must get right (the restic/borg/IPFS lessons):
//   1. Refcount-gated: a content-addressed, deduped body is prunable only when
//      EVERY referencing event is past its window. The caller encodes this by
//      passing `ageDays` = the age of the NEWEST referencing event, so
//      `ageDays > pruneDays` ⇒ even the most recent use is past ⇒ all are.
//   2. Age OR size: prune when past the age window, OR when the store is over
//      its size cap — whichever hits first (logrotate's daily-vs-size).
//   3. Scope as pin: under size pressure, evict UNPINNED bodies first, ordered
//      by pin score then age. Pinned (in-scope / marker-or-loot / operator)
//      bodies are never size-evicted — only age-pruned once past their window.

export interface ArtifactBody {
  sha: string
  /** On-disk size now (compressed size if already warm). */
  bytes: number
  /** Already warm (compressed)? Warm bodies are not re-compressed. */
  compressed: boolean
  /** Age of the NEWEST referencing event, in days (refcount gate). An orphan
   *  body with no referencing event uses its file age. */
  ageDays: number
  /** Effective prune window for THIS body, in days. `0` = never age-prune. The
   *  caller derives it from scope: out-of-scope gets the short window; in-scope
   *  and `unknown` get the long one (never expire unclassified early, A3). */
  pruneDays: number
  /** Pinned bodies are never size-evicted (isPinned over referencing events). */
  pinned: boolean
  /** Eviction order key for unpinned bodies (lower = evicted first). */
  pinScore: number
}

export interface RotationConfig {
  /** Compress bodies older than this many days. `0` = never compress. */
  warmDays: number
  /** Size cap for the whole io/ store, in bytes. `0` = no cap. */
  maxBytes: number
}

export interface RotationPlan {
  /** shas to warm-compress this sweep. */
  toCompress: string[]
  /** shas to delete this sweep (age-past-window and/or size-evicted). */
  toPrune: string[]
}

export function planArtifactRotation(bodies: ArtifactBody[], cfg: RotationConfig): RotationPlan {
  const pruneSet = new Set<string>()

  // 1. Age prune — past this body's own window (refcount-gated via ageDays).
  for (const b of bodies) {
    if (b.pruneDays > 0 && b.ageDays > b.pruneDays) pruneSet.add(b.sha)
  }

  const survivors = bodies.filter((b) => !pruneSet.has(b.sha))

  // 2. Warm compress — survivors that are old enough and not already warm.
  const toCompress = new Set<string>()
  if (cfg.warmDays > 0) {
    for (const b of survivors) {
      if (!b.compressed && b.ageDays > cfg.warmDays) toCompress.add(b.sha)
    }
  }

  // 3. Size prune — if still over cap, evict UNPINNED survivors first, ordered
  //    by ascending pin score then descending age (least valuable + oldest go
  //    first). Pinned bodies are never size-evicted; in-scope evidence is kept
  //    longest by construction. Compression (step 2) shrinks the store on the
  //    NEXT sweep — we prune on current bytes here to stay conservative (never
  //    assume unrealized savings and under-reclaim).
  if (cfg.maxBytes > 0) {
    let total = survivors.reduce((s, b) => s + b.bytes, 0)
    if (total > cfg.maxBytes) {
      const evictable = survivors
        .filter((b) => !b.pinned)
        .sort((a, b) => (a.pinScore - b.pinScore) || (b.ageDays - a.ageDays))
      for (const b of evictable) {
        if (total <= cfg.maxBytes) break
        pruneSet.add(b.sha)
        toCompress.delete(b.sha)   // don't compress something we're deleting
        total -= b.bytes
      }
    }
  }

  return { toCompress: [...toCompress], toPrune: [...pruneSet] }
}
