# Delivery Targets — how evidence leaves RedLog

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to the delivery/export
subsystem (`bundle-export`, `cloud-share`, `deconfliction`, `signing`). It also
absorbs the boundary that `CONTROL-PLANE-FACES.md` split out: delivery ops
(`export/bundle`, `sanitize`, `deconfliction`, cloud-share) are **not** control
ops — they live here. Its job: **every way evidence leaves RedLog is one of two
roles, declares a sanitize profile by audience, and carries a shape-appropriate
integrity contract — so "add a delivery target" is filling a template, and no path
can leak un-sanitized or unverifiable evidence.**

## The two roles (mechanism axis: timing / cardinality)

```
Produce a complete, self-verifiable artifact of the store at a point in time? → SNAPSHOT
Forward selected events in real time as they happen?                          → STREAM
```

Everything else (destination, audience, sanitize level) is a *classification*, not
a role — see the axes below.

## Master table

| Target | Role | Audience | Sanitize profile | Timing | Transport | Integrity | Source |
|---|---|---|---|---|---|---|---|
| **Evidence bundle** | Snapshot | third-party / court / client | layer-4 sanitized (raw→sanitized swap) or full (opt-in) | batch | local file (out dir) | Ed25519 sig + OTS anchor + manifest + sanitized-reconciliation | `bundle-export.ts` |
| **Cloud share** | Snapshot | operator / shareable link | redaction-gated (`RedactionPreview`) | batch | remote PUT (Worker/S3) + `expiresAt` | manifest + sanitize counts (verify it also signs/anchors — gap #3) | `cloud-share.ts` + `-uploader.ts` |
| **Deconfliction feed** | Stream | blue team | subtype-filtered (`scope_violation` default) + `includeData` flag | real-time per-event | signed webhook (HTTP POST) | HMAC per body | `deconfliction.ts` |

## The two classifying axes

- **Audience** → sets the **sanitize profile** (the tier axis): third-party (must
  not leak out-of-scope/PII) / blue-team (filtered subset only) / operator-link
  (redaction-gated). Audience is *why* a profile is chosen.
- **Transport** → local file / remote upload+expiry / webhook. Independent of role.

## The uniform contract every target fills

1. **Declare audience → sanitize profile.** Not ad-hoc per target — one of the
   named profiles (see Gaps #1). A Snapshot for a third party runs the scope-aware
   sanitize planner (`SPEC-SCOPE-AWARE-LIFECYCLE.md` Part B); a Stream declares its
   event/subtype filter.
2. **Carry shape-appropriate integrity.** Snapshot → signed + anchored + a manifest
   that reconciles every sanitized swap (a stripped bundle is *detectable*, not
   silently smaller). Stream → per-body signature so each forwarded event is
   authenticable.
3. **Append an audit event for the delivery action** (export/upload/flush), so the
   act of delivering is itself on the chain.
4. **Test seam:** the artifact/payload builder is pure — `build(store, profile) →
   artifact` — testable without the transport (cloud-share already splits builder
   from uploader "to keep the redaction gate testable", `cloud-share.ts` L16).

## Per-role reference

### Snapshot — a complete, self-verifiable artifact

- **Produces:** the whole store (or a scoped slice) as a signed, anchored,
  manifest-described artifact a third party can verify **without RedLog**
  (`bundle-export` ships `signerPubKey` for `tools/redlog-verify.py`, L122).
- **Sanitize:** runs the profile before write — layer-4 raw→sanitized swap
  (`bundle-export` L86–101), each swap reconciled by a paired `system.sanitized`
  event so tampering (stripping bytes) is detectable.
- **Transport variants:** local file (bundle) vs remote upload with expiry
  (cloud-share) — same role, different transport.
- **Instances:** evidence bundle, cloud share. **Plugin face:** the reserved 🔴
  `exporters` role (`PLUGIN-ROLES.md`) — a plugin-contributed Snapshot format; its
  first instance is the scope-sanitized client bundle.

### Stream — a real-time per-event feed

- **Produces:** selected events forwarded as they land, each independently signed.
- **Sanitize:** by *filter*, not redaction — only whitelisted subtypes
  (`scope_violation` default, `deconfliction.ts` L21) and an `includeData` toggle
  decide what leaves. Buffered with a shutdown flush (L158).
- **Transport:** signed webhook. Config (URL/secret/filter) is frozen per batch to
  avoid mid-batch drift (L137).
- **Instances:** deconfliction feed. **Plugin face:** none yet — a plugin SIEM/
  blue-team forwarder would be a gated plugin Stream (Gap #4).

## Gaps this framework surfaces

| # | Gap | Role | Fix |
|---|---|---|---|
| 1 | Sanitize is ad-hoc per target (bundle: layer-4 `sanitized_events`; cloud-share: own `RedactionPreview`; deconfliction: subtype filter) | both | unify into **named sanitize profiles** (`full` / `scope-sanitized` / `filtered`) shared across all targets — the same planner as lifecycle Part B |
| 2 | Delivery ops sit on the REST control face | — | move `export/bundle`, `sanitize`, `deconfliction`, cloud-share off the §7 control catalog onto a Delivery face (`CONTROL-PLANE-FACES.md` gap #3) |
| 3 | Cloud-share integrity may be weaker than bundle | Snapshot | verify cloud-share carries the same Ed25519 + OTS as `bundle-export`; a "verifiable snapshot" contract should be uniform, not per-transport |
| 4 | No plugin path for either role | both | `exporters` (🔴, reserved) = plugin Snapshot; add a gated plugin Stream for SIEM/blue-team forwarders |
| 5 | Snapshot scope-sanitize planner not wired | Snapshot | implement `SPEC-SCOPE-AWARE-LIFECYCLE.md` Part B as the third-party Snapshot's default profile |

## Cross-references

- The method: `DECOMPOSITION-METHOD.md`
- Sanitize/retention/rotation this shares profiles with: `SPEC-SCOPE-AWARE-LIFECYCLE.md`
- The plugin Snapshot role: `PLUGIN-ROLES.md` (Exporter)
- The control-plane boundary this closes: `CONTROL-PLANE-FACES.md` gap #3
- Bundle threat model + verify: `audit-trail.md`, `CLOUD_SHARE_BUNDLE.md`
