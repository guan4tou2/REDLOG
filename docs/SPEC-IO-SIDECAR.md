# Spec — io_ref Sidecar for Full Request/Response Bodies

Written 2026-08-12. The last unshipped piece of the v0.10.0 I/O-visibility work
(ROADMAP: "shipped as v0.11.2 except the sidecar"): store **full** captured HTTP
request/response bodies (and any other large capture payload) in a prunable
on-disk sidecar, keeping only their `sha256` in the hash chain. Today mitmproxy
bodies are inline, truncated previews (`request_body_preview` / `response_preview`,
capped at `REDLOG_MAX_BODY`, raised to 16 KB in b986441). This closes the "the
body was bigger than the cap, so you can't see what actually went over the wire"
gap without bloating the events table or the chain.

## Why (the problem)

1. **Truncation loses evidence.** A 40 KB JSON response or a multipart upload is
   the thing a reviewer most wants, and it's exactly what the inline cap drops.
2. **Inline bodies bloat the chain.** Every byte of an inline preview is hashed
   into the append-only chain and re-walked on every full verify. Bodies are
   large, frequent (every request/response), and — unlike a marker — not the
   operator's assertion; they don't belong in the chain, only their digest does.
3. **The pattern already exists.** Terminal stdout is NOT stored in the chain —
   the `.cast` lives on disk and the event carries a reference
   (`{stream:'cast', ref, off, len, truncated}`), sliced on demand by
   `cast-slice.ts` (`src/core/api-server.ts` ~L409). The io_ref sidecar is the
   same idea, generalized to HTTP (and future) bodies.

## Core invariant (unchanged)

**Bytes never enter the chain — only their `sha256`.** The v0.6.47 revert stands
(`ROADMAP.md`). A body's digest is chained; the bytes live in the sidecar. This
keeps `redlog-verify` and OpenTimestamps meaningful (they attest the digest, and
the sidecar bytes are checkable against it) while the chain stays small.

## The sidecar

- **Location:** `<projectDir>/io/` (peer of `screenshots/`, `terminal/`).
- **Append-only, content-addressed:** a body is written once to
  `io/<sha256>.bin` (dedup by digest — identical bodies stored once). No edits,
  no deletes except retention pruning.
- **Ref shape on the event** (mirrors the io.stdout shape from v0.9.6):
  ```jsonc
  "io": {
    "request":  { "ref": "<sha256>", "len": 40213, "sha256": "<sha256>", "ct": "application/json", "truncated": false },
    "response": { "ref": "<sha256>", "len": 128932, "sha256": "<sha256>", "ct": "text/html", "truncated": false }
  }
  ```
  `ref` is the sidecar filename stem; `len` the full byte length; `truncated`
  true only if capture itself hit a hard ceiling (see limits). The short inline
  `*_preview` fields stay for at-a-glance display and offline bundles; the sidecar
  holds the full body.

## Capture path (who writes the sidecar)

Two options; **(B) is recommended** — it keeps the digest authoritative and the
addon dumb.

- **(A) Addon writes the file.** The mitmproxy addon writes `io/<sha256>.bin`
  directly and posts the ref. Rejected: the addon runs under a HOME that may not
  be the project dir; it would need the project path, and a capture source
  writing into the evidence store is a wider trust surface.
- **(B) Addon posts the full body; the server sidecars it.** *(recommended)* The
  addon posts the full body (up to a generous `REDLOG_MAX_IO` ceiling, e.g.
  2 MB) on a new field; `POST /api/events` computes the `sha256`, writes
  `io/<sha256>.bin` if absent, replaces the body with the `io.*` ref before the
  event is chained, and keeps the short `*_preview` inline. The server is already
  the single DB-write chokepoint (pause gate, `noteDbError`), so this is where
  the sidecar write belongs. Bodies above the post ceiling are marked
  `truncated:true` and only the preview is kept.

## Read path

- **`io:read` IPC** (already named in ROADMAP): `io:read(ref, off?, len?) →
  bytes`, validated to stay within `<projectDir>/io/` (same path-validation
  discipline as screenshot reads). Range args mirror the cast slice API.
- **ScannerDetail** lazy-loads: shows the inline preview immediately, and when a
  body is sidecar-backed and larger than the preview, a "load full body
  (`len`)" affordance calls `io:read`. Binary/oversize bodies say so rather than
  dumping raw bytes.
- Generalizes: the same viewer serves any event carrying `io.*` refs (browser
  console payloads, future large captures).

## Export / retention / verify

- **Bundle export** (`redlog-cli export bundle`): copy the referenced
  `io/<sha256>.bin` files into the bundle's `io/`; the manifest already lists
  screenshots + casts, add io refs. Sanitized exports (`redlog-cli sanitize`)
  apply to sidecar bodies too — a sanitized replacement body is written and the
  `system.sanitized` event records the digest swap (per `redaction-design.md`
  Layer 4), so the chain still verifies.
- **Retention** (`src/core/retention.ts`): prune `io/` bodies older than the
  keep window, emitting `system.io_pruned` (already reserved in ROADMAP) so the
  gap is explainable — same arc as `.cast` pruning. The chain (digests only) is
  untouched; a pruned body reads as "pruned by retention" not "missing".
- **`redlog-verify.py`**: when an event carries `io.*` refs, verify the sidecar
  file's `sha256` matches the chained digest (bytes-on-disk match the attested
  hash). A pruned/absent body is reported as pruned, not tampered.

## Limits & config

| Knob | Default | Meaning |
|---|---|---|
| `REDLOG_MAX_BODY` | 16 KB | inline preview cap (unchanged, for at-a-glance) |
| `REDLOG_MAX_IO` | 2 MB | max body posted to the sidecar; above → `truncated`, preview only |
| retention keep-days | project retention | when `io/` bodies are pruned |

## Acceptance criteria

- **A1** A response body larger than `REDLOG_MAX_BODY` but under `REDLOG_MAX_IO`
  is fully retrievable via `io:read`; ScannerDetail shows the full body on
  demand, and `len`/`truncated:false` are correct.
- **A2** The event row + chain contain only the `sha256` (+ short preview), never
  the full bytes; DB size is ~unchanged vs. today for large bodies.
- **A3** Identical bodies across events are stored once (dedup by digest).
- **A4** `redlog-verify.py` confirms the sidecar file matches the chained digest;
  a retention-pruned body verifies as *pruned*, not *tampered*.
- **A5** Bundle export includes referenced io bodies; `ots verify` on the bundle
  still passes (chain unchanged).
- **A6** Pause semantics hold: while recording is paused, no body is sidecarred
  (the gate is at `insertEvent`/`POST /api/events`, which already covers this).
- **A7** Path traversal is impossible — `io:read` refuses any ref outside
  `<projectDir>/io/`.

## Migration & compatibility

- Purely additive: events without `io.*` refs (all historical, and any capture
  under the post ceiling) behave exactly as today via the inline preview.
- No chain migration — old events keep their inline previews; new large bodies
  gain refs. `redlog-verify` handles both.

## Non-goals

- Not a general blob store or attachment system — scoped to capture payloads
  (HTTP bodies first).
- No at-rest encryption of the sidecar (tracked separately as a 1.x item,
  `ROADMAP.md`); the threat model discloses on-disk exposure honestly today.
- No streaming of unbounded bodies — `REDLOG_MAX_IO` is a real ceiling; above it
  the preview + `truncated` flag is the honest record.

## Build order (each testable)

1. Sidecar store module (`src/core/io-store.ts`): `putBody(projectDir, bytes) →
   {ref, len, sha256}` (dedup), `readBody(projectDir, ref, off?, len?)`. Pure-ish
   + fs; unit-testable with a temp dir.
2. `POST /api/events` (option B): sidecar the full-body field, stamp `io.*`,
   drop bytes before chaining. Unit + the existing mitm e2e extended to assert a
   >16 KB body round-trips.
3. `io:read` IPC + path validation.
4. ScannerDetail lazy full-body load.
5. Bundle export + retention prune (`system.io_pruned`) + `redlog-verify.py`.

Cross-references: `redaction-design.md` (Layer 4 sanitize), `event-schema.md`
(io.stdout precedent), `src/core/cast-slice.ts` (the reference-not-bytes model),
`hooks/mitmproxy-addon.py` (`REDLOG_MAX_BODY`), commit b986441 (request-body
display + raised cap).
