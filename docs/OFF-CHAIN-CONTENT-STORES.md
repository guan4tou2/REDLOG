# Off-Chain Content Stores — one pattern, two shapes

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to the heavy content RedLog
keeps *off* the hash chain. Today this is **four stores** across separate
implementations — `.cast` recordings, agent transcripts, io_ref bodies,
screenshots — with separate directories, **three live retention paths** (io_ref is
spec-only, never implemented), and parallel reference conventions. This doc shows
they are **one off-chain-content pattern in two shapes (Blob / Stream)**, unified
by a single invariant and a single lifecycle engine (per the cross-session
consensus + code audit with the transcript/log sessions, 2026-08-13).

## The core invariant (from `SPEC-IO-SIDECAR.md`)

**Bytes never enter the chain — only their `sha256`.** The event carries a
reference + digest; the bytes live in an off-chain store; a pruned/absent object
reads as **pruned, not tampered** (`redlog-verify` semantics). This is the same
invariant already stated for the io sidecar — the decomposition just recognises it
governs *all* heavy content, not only HTTP bodies.

## The two roles (mechanism axis = content shape)

```
Is the content one opaque object (read whole or by byte-range)?   → BLOB
Is it a time-indexed sequence (read by time-slice)?               → STREAM
```

## Master table

| Store | Role | Addressing | Dir / layout | Reference on event | Read | Retention today |
|---|---|---|---|---|---|---|
| **io_ref bodies** | Blob | **content-addressed** | `io/<sha256>.bin`, dedup by digest | `io.*` ref + `sha256` | whole or ranged (`io:read`, path-validated) | **spec-only — never implemented** (no runtime code; only `SPEC-IO-SIDECAR.md` et al.) |
| **Screenshots** | Blob | **path-addressed** | `screenshots/${ts}_${trigger}.jpg`; `sha256` = integrity only, not location/dedup (`screenshot-agent.ts`) | `filename` (basename) + `sha256` | whole (image) | `screenshots.keepDays` → `screenshot_pruned` |
| **Cast recordings** | Stream | path-addressed | `casts/` per session; integrity `castSha256` | `castPath` + `castSha256` | **time-slice** `readCastSlice(path, startMs, endMs)` (asciicast v2 JSON-lines) | `terminal.castKeepDays` → `cast_pruned` |
| **Agent transcripts** | Stream | path-addressed | `agent-transcripts/${agentKind}-${sessionId}.jsonl`, append-only; integrity `cumulative_sha256` | `snapshot_path` + `cumulative_sha256` (`transcript_snapshot` event) | whole / tail | `agentTranscripts.keepDays` → `agent_transcript_pruned` |

## The two classifying axes

- **Shape** (mechanism) → **Blob** (opaque object) vs **Stream** (time-indexed
  sequence). This is the role.
- **Addressing** → **content-addressed** (dedup by digest, location = the hash) vs
  **path-addressed** (per-session/per-capture name, digest is integrity only).
  Independent of shape.

**These two axes give three valid combinations, not two** (per the code audit,
2026-08-13):

| | content-addressed | path-addressed |
|---|---|---|
| **Blob** | io_ref bodies | screenshots |
| **Stream** | — (a time sequence *is* its position; content-addressing is nonsensical) | `.cast`, agent transcripts |

So the honest classification is **Blob-content / Blob-path / Stream-path** — see
gap #3.

## The uniform contract every off-chain store must satisfy

The payoff — three ad-hoc stores collapse to one interface + two shape adapters:

1. **Digest on chain, bytes off chain.** The event holds `ref` + `sha256`; the
   store holds bytes. Verify checks bytes-match-digest; a missing object is
   *pruned*, never *tampered*.
2. **Referenced, not embedded.** The store resolves `ref → bytes` behind a
   **path-traversal guard** (stay inside the store dir — `io:read` already does
   this; the guard should be shared, not re-implemented per store).
3. **One lifecycle engine.** hot → warm (compress) → pruned, **refcount-gated**,
   **scope/marker as pin** — all from `SPEC-SCOPE-AWARE-LIFECYCLE.md`. Every store
   plugs into *one* retention/rotation engine, not three keep-day knobs.
4. **Shape-appropriate read.** Blob → whole or byte-range; Stream → time-slice.
   Both **lazy** (never loaded to scroll the timeline; a preview/glyph stands in,
   per `TIMELINE-ELEMENTS.md`).

## Completeness

Heavy content is either **one opaque object** (Blob) or a **time-indexed
sequence** (Stream) — there is no third shape. Every current store maps to one
role. Future heavy captures slot in by shape without a new subsystem:

- **Blob:** pcap files, memory dumps, downloaded artefacts, binary loot.
- **Stream:** screen-recording video, keystroke timelines, packet streams.

## Gaps this framework surfaces

| # | Gap | Fix |
|---|---|---|
| 1 | **io_ref is spec-only** — no runtime code exists (grep hits docs only); it is *never implemented*, not "wired but retention-less" | implement the Blob store, then wire its keep-window as the first store to prove the unified interface |
| 2 | **Three parallel retention branches** — `config.terminal.castKeepDays` + `config.screenshots.keepDays` + `config.agentTranscripts.keepDays`, each a separate branch in `retention.ts` `sweepRetention()` | a `contentStore.<name>.keepDays` registry turns 3 branches into **one loop over registered stores** — a real code convergence, not just a doc one |
| 3 | **Addressing is three-way, not two** — the audit found screenshots are path-addressed (filename = `${ts}_${trigger}`, `sha256` integrity only), not content-addressed | classify deliberately as **Blob-content / Blob-path / Stream-path** (Stream-content is nonsensical); document why each store sits where it does |
| 4 | **`isInsideDir()` traversal guard duplicated in 3 places** (tailer sidecar, screenshot delete, terminal replay) | extract one shared traversal guard + one shared "bytes-match-digest / pruned≠tampered" verify, used by every adapter |
| 5 | **Compression/pin not applied uniformly** | the warm-compress + scope-as-pin from the lifecycle spec should cover `.cast`, agent transcripts (both compress well) and screenshots, not just io bodies |
| 6 | **Four stores, one missing from the taxonomy until now** — agent transcripts (`transcript_snapshot` + `cumulative_sha256`) is a Stream store parallel to `.cast` | route it through the same Stream adapter; it already has the `snapshot_path` + `cumulative_sha256` shape |

## Note on formats

The `.cast` on-disk format (asciicast v2 today; a v3 greenfield move is under
discussion in the transcript session) is the **Stream adapter's concern**, not this
layer's — the decomposition is about the store contract (digest, ref, lifecycle,
read), not the byte format. See that session for the format decision.

## Cross-references

- The Blob store's detailed spec: `SPEC-IO-SIDECAR.md`
- The lifecycle engine all stores share: `SPEC-SCOPE-AWARE-LIFECYCLE.md`
- Which capture items produce which content: `CAPTURE-SOURCE-TAXONOMY.md`
- How content surfaces on the timeline (glyph/preview, lazy): `TIMELINE-ELEMENTS.md`
- The method: `DECOMPOSITION-METHOD.md`
