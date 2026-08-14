# Spec — Scope-Aware Sanitize + Retention + Artifact Rotation

> **Implementation status (2026-08-13).**
> - ✅ **Part C — artifact lifecycle (G1, G2, G4):** shipped. `config.io` gains
>   `warmDays` + `maxBytes` (G1); `artifact-pin.ts` pin score (G4);
>   `artifact-gc.ts` `planArtifactRotation` — age-or-size, refcount-gated,
>   pin-ordered (G2); `io-store` warm compress (gzip, original-digest-preserving)
>   + transparent read/verify; `retention.ts` `sweepIoLifecycle` wires it, with
>   marker/loot `_causes` pinning; `redlog-verify.py` + bundle-export handle warm
>   bodies. 42 unit tests (A4/A5/A6/A7).
> - ✅ **Part B — decision core + scope wiring (G3 partial):** `classifyTarget`
>   (pure, side-effect-free scope verdict) and `planScopeSanitize` (Part B
>   planner incl. io-sidecar coverage + `unknown` flagging, A1/A2) shipped and
>   unit-tested; the classifier is wired into retention so scope-priority eviction
>   is **live** (A5 fully). 8 more tests.
> - ✅ **Part B execution (G3 complete):** shipped. `scope-sanitize.ts`
>   `runScopeSanitize` applies the plan — whole-body placeholder for out-of-scope
>   inline fields (`sanitized_events`) **and** io sidecar bodies (new
>   `sanitized_io` table), refcount-safe (a body cited by any kept in-scope event
>   is never sanitized), appending one chained `system.sanitized` with
>   `io_replacements`. `bundle-export` serves the redacted bodies under their
>   original names; `redlog-verify.py` reads the swap and reports them
>   *sanitized*, never *tampered* (A1/A6). `internal` vs `client-deliverable`
>   export profiles wired through `exportBundle` + the `data:exportBundle` IPC
>   (§9). `unknown` targets are never auto-sanitized unless the operator opts in
>   (A2). Pure placeholder + DB round-trip tests added.
>
> **The full spec (Parts A/B/C) is now implemented.** The one deliberate scope
> boundary: the CLI/HTTP export path stays internal-profile; the client-
> deliverable profile is exposed through the app (IPC) export.

Written 2026-08-13. Unifies three previously-separate storage concerns into one
mechanism: **the hash chain is a small, immutable WORM spine; every heavy capture
artifact is a refcounted, scope-prioritized, lifecycle-managed store.** It extends
`SPEC-IO-SIDECAR.md` (the prunable io sidecar) and `redaction-design.md` (layer-4
export sanitize) with (a) a scope-aware verdict on both sanitize and retention,
(b) a three-stage artifact lifecycle (hot → warm/compressed → pruned) with
size *and* age triggers, and (c) a per-capture-type coverage matrix that states
honestly where scope does and does not apply.

## Why (the problem)

1. **Capture broad, sanitize/prune later** (DESIGN-PRINCIPLES §2) makes broad
   capture safe *only if* the detect/sanitize/prune machinery is strong. Today
   sanitize is manual per-event and retention is time-only per artifact type.
2. **Client deliverables must not leak out-of-scope / adjacent-client content**,
   but the *fact* a target was touched (`scope_violation`) must survive. Sanitize
   must be able to key on scope, not just on hand-picked fields.
3. **Disk pressure is real** for long engagements — but the heavy artifacts
   (`.cast`, screenshots) are exactly the ones a host-based scope predicate
   cannot classify. Retention needs a size ceiling and a compression tier, not
   just an age cutoff, and rotation order needs a priority signal.

## Core invariant (unchanged)

**The chain is sacred and small.** Only `sha256` digests, previews, and event
metadata (who/when/which host/verdict) enter the hash chain; they are **never**
rotated, compressed away, or pruned. Everything below acts on *artifact bytes*
(`io/*.bin`, `*.cast`, screenshot `*.jpg`) — the prunable payload — and every
lifecycle action **appends** a chained `system.*` audit event, so a rotated or
sanitized store is itself tamper-evident (a missing artifact reads as *pruned*,
never *tampered*; a stripped bundle is detectable). This is the Schneier–Kelsey /
WORM split the prior art converges on (see Prior art).

## Part A — Per-capture-type coverage matrix

Scope is a **host/target predicate**. Not every `agent_type` carries a host, so
scope-aware handling is **not** uniform. Three tiers:

| Tier | agent_types | Has target? | io body? | Scope-aware sanitize | Scope-aware retention |
|---|---|---|---|---|---|
| **1 — target-clean** | `http`, `http_navigation`, `scanner`, `dns`, `browser`, `pivot` | yes (`dest_host`/`url`/`route`) | yes (Tier-1 only) | ✅ verdict via `ScopeMonitor.checkTarget` | ✅ pin=in-scope, GC=out-of-scope first |
| **2 — target-partial** | `shell`/`terminal`, `file_transfer`, `cleanup`, `agent`, `loot`, `marker` | sometimes | no | ⚠️ only when target present; else `unknown` bucket | ⚠️ `unknown` → in-scope window |
| **3 — no host** | `screenshot`, `clipboard`, `process`, `.cast` recordings | no | no | ❌ scope N/A — time/size retention only | ❌ scope N/A — time/size retention only |

**Consequence stated plainly:** scope-aware retention reclaims Tier-1 io bodies
only, which are the *small* artifacts after dedup + the 2 MB ceiling. The disk
hogs (`.cast`, screenshots) are Tier 3 and must be handled by Part C's
size/compression rotation, **not** by scope. Do not let the UI imply "scope-aware
retention on = disk handled."

### The `unknown` fallback (Tier 2) — asymmetric by design

Scope verdict is an *inference* (DESIGN-PRINCIPLES §3), so an absent/ambiguous
target must not silently drive a destructive default. The safe default differs
between the two actions because their failure modes differ:

- **Sanitize** (removes content from a *deliverable copy* — recoverable): an
  `unknown` event is **neither auto-stripped nor auto-passed**; it surfaces in the
  dry-run preview flagged for operator decision (default unchecked). Failure =
  over/under-redacting a reviewable copy.
- **Retention** (deletes *local bytes* — irreversible): an `unknown` event gets
  the **in-scope (longest) window**. Never silently expire unclassified evidence.
  Failure = permanent loss, so bias to keep.

## Part B — Scope-aware sanitize

Extends layer-4 export sanitize (`src/core/sanitize.ts`). Reuses the existing
`sanitize()` machinery (per-event, `dryRun`, chained `system.sanitized`,
tamper-detectable) — adds a **scope planner** in front of it.

1. **Planner** walks candidate events; for each, resolves its target
   (`target_id`/`dest_host`/`url`) and calls `ScopeMonitor.checkTarget`.
   Verdict ∈ {`in_scope`, `out_of_scope`, `excluded`, `unknown`}.
2. **Plan** = every `out_of_scope`/`excluded` event's body + sensitive fields
   proposed for sanitization; `unknown` flagged; `in_scope` untouched. This is a
   `dryRun` result — no writes yet.
3. **Sidecar coverage (critical):** the plan must include the event's io_ref
   sidecar body, not just inline event fields. A Tier-1 out-of-scope response
   body lives in `io/<sha>.bin`; sanitize writes a sanitized replacement body and
   the bundle serves that (per `SPEC-IO-SIDECAR.md` "Export/retention"). Missing
   this leaks out-of-scope bytes through the side door.
4. **Operator confirm gate**, then `sanitize --confirm` runs, appending one
   `system.sanitized` per event with `reason: "scope:<verdict>"`.
5. **Export profiles** (§9 progressive disclosure): `internal` (full) vs
   `client-deliverable` (scope-sanitized). Default deliverable profile runs the
   scope planner; full content is the advanced opt-out.

## Part C — Artifact rotation (the lifecycle)

RedLog "log rotate" ≠ syslog overwrite. It is a three-stage lifecycle over the
artifact stores, with **age *and* size triggers** (whichever hits first —
logrotate's `daily` vs `size`).

```
HOT  ──(age > warmDays  OR  store > sizeCap)──▶  WARM  ──(age > pruneDays  OR  still > sizeCap)──▶  PRUNED
uncompressed,                                    zstd in place,                                     bytes deleted,
instant read                                     read = decompress,                                 sha256 + row kept,
                                                 verify = re-hash original                          system.*_pruned appended
```

- **Warm (compress) is pure win and must exist before prune.** io bodies and
  `.cast` are text-shaped (JSON/HTML/timing) → ~5–10×. Compression is reversible:
  keep the **original** `sha256` (not a compressed-hash) so `redlog-verify`
  decompresses and re-hashes to confirm bytes-on-disk match the attested digest.
- **Prune** reuses `retention.ts`; extend it from age-only to age-or-size, and
  add an `io/` keep-window (today's config has cast/screenshot/agentTranscript
  windows but **no io window** — see gap G1).

### Refcount-gated deletion (restic/borg lesson)

`io/<sha>.bin` is content-addressed + deduped, so a body may be referenced by
many events. **A body is prunable only when *every* referencing event is past its
window.** Deletion is a mark-and-sweep GC over event→sha refs, not a per-event
`rm`. Getting this wrong either leaks disk (never delete) or deletes a body still
cited by live in-scope evidence. (borg's `prune`-doesn't-`compact` trap: dropping
the reference must actually reclaim the bytes, in one attributable step.)

### Scope as pin (IPFS lesson) — where A, B, C merge

Rotation **order** under size pressure is driven by a pin score:

- **Pinned (evicted last):** `in_scope` bodies; anything referenced by a `loot` or
  `marker` event; anything an operator explicitly pinned.
- **Unpinned (evicted first):** `out_of_scope` / `excluded` / `unknown`, unmarked.

So when `io/` exceeds its cap, GC compresses then prunes out-of-scope/unmarked
bodies first and keeps in-scope evidence longest — the single mechanism that
answers both "how does broad capture not fill the disk" and "where does scope
attach": scope attaches to **rotation priority**, never to capture.

## Prior art

- **Schneier–Kelsey hash-chain audit logs / WORM** — retention acts on content,
  never on the tamper-evident chain. ([finqub], [emergentmind])
- **Teleport session recording** — audit events and heavy recordings split across
  backends; recordings run an explicit S3 lifecycle, are **not** auto-deleted,
  default 1-year retention; rotated keys are decrypt-only. ([teleport-recording],
  [teleport-backends])
- **restic vs borg** — generational retention (keep N daily/weekly/monthly), and
  the reclaim gotcha: borg `prune` drops refs but needs `compact`; restic
  `forget --prune` repacks in one step. Deletion must actually free space.
  ([restic-borg])
- **IPFS pin + GC** — content-addressed store GCs unpinned blocks; pinning
  protects. Maps to scope/marker = pin. ([ipfs-gc])
- **SIEM hot/warm/cold + WORM** — tier down (compress) before delete; ~85–90%
  cost cut; PCI-DSS 10.7: 12-month retention, recent 3 months immediately
  available. ([logsentinel], [scality-tiers])

## Acceptance criteria

- **A1** Export `client-deliverable` profile: a Tier-1 out-of-scope response body
  (event field *and* io sidecar) is sanitized; the `scope_violation` event and
  the touched host remain in the bundle. `in_scope` bodies are untouched.
- **A2** `unknown`-target events are never auto-sanitized; they appear in the
  dry-run preview flagged, default unchecked.
- **A3** Retention never expires an `unknown`-scope artifact before the in-scope
  window; out-of-scope artifacts expire on the short window.
- **A4** Warm stage: a compressed io body is still retrievable via `io:read`, and
  `redlog-verify.py` confirms the decompressed bytes match the chained (original)
  `sha256`.
- **A5** Size trigger: with `io/` over its cap, GC compresses then prunes
  unpinned (out-of-scope/unmarked) bodies first; a body referenced by any event
  still inside its window is never deleted (refcount-gated).
- **A6** Every rotation/sanitize action appends a chained `system.*` event
  (`io_pruned`/`cast_pruned`/`screenshot_pruned`/`sanitized`); a pruned artifact
  verifies as *pruned*, a sanitized one as *sanitized*, never as *tampered*.
- **A7** Tier-3 artifacts (`.cast`, screenshot, `clipboard`, `process`) are
  governed by time/size retention only; no scope verdict is computed or implied
  for them in the UI.

## Gaps to close (implementation order)

- **G1** Wire an `io` keep-window + size cap into `config.ts` retention block
  (today: cast/screenshot/agentTranscript only). Prerequisite for Part C.
- **G2** Extend `retention.ts` from age-only to age-or-size, add the warm
  (compress) stage, and make deletion refcount-gated over event→sha refs.
- **G3** Add the scope planner + `unknown` bucket in front of `sanitize.ts`, with
  sidecar-body coverage and export profiles.
- **G4** Compute the pin score (scope verdict + marker/loot reference) as the
  rotation eviction key.

## Non-goals

- **Not** scope-gated *capture*. Capture stays broad (§2); scope only drives
  sanitize, retention priority, and export — never a capture blind spot, which
  would also disable `scope_violation` recording.
- **Not** rotating, compressing, or pruning the hash chain, event rows, previews,
  or `sha256` digests. Only artifact bytes move through the lifecycle.
- **Not** scope-slicing a single `.cast` or screenshot by host (Tier 3 is
  time/size only). Visual/stream artifacts are out of scope's reach by construction.
