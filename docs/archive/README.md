# Archive

Design documents that were written but whose subject was **never built**, or
was built in a different shape than described. They are kept because the
reasoning is worth reading in the form it was argued; they are moved here so
that nobody plans from them as if they described the code.

Moved 2026-09-06 and 2026-09-23. Nothing in `src/` cites any of these by path.

| Page | What it is | Status |
|---|---|---|
| [Decomposition method](DECOMPOSITION-METHOD.md) | How to decompose a subsystem into a provably complete set of roles | Method only; applications below |
| [Decomposition backlog](DECOMPOSITION-BACKLOG.md) | Gaps the decompositions named | Open, unowned |
| [Capture source taxonomy](CAPTURE-SOURCE-TAXONOMY.md) | 17 capture sources, four-gate lifecycle | Partly reflected in `capture-health.ts`; the table is a proposal |
| [Detector roles](DETECTOR-ROLES.md) · [Plugin roles](PLUGIN-ROLES.md) · [Event type vocabulary](EVENT-TYPE-VOCABULARY.md) | Member catalogues | Catalogues, not code |
| [Control plane faces](CONTROL-PLANE-FACES.md) · [Delivery targets](DELIVERY-TARGETS.md) · [Off-chain content stores](OFF-CHAIN-CONTENT-STORES.md) · [Timeline elements](TIMELINE-ELEMENTS.md) | Surface catalogues | Catalogues, not code |
| [I/O sidecar](SPEC-IO-SIDECAR.md) | Spec | Unbuilt — the shipped `io` field on `command_end` is narrower |
| [Scope-aware lifecycle](SPEC-SCOPE-AWARE-LIFECYCLE.md) | Spec | Unbuilt (its "shipped" claim was corrected 2026-09-04) |
| [Timeline axis](SPEC-TIMELINE-AXIS.md) | Spec | Unbuilt; idle-gap compression shipped in a different shape |
| [AI-era plugins](SPEC-AI-ERA-PLUGINS.md) | Spec | Gap 2 (C2 tailers) shipped as the bundled `plugins/c2-tailers` pack; the rest unbuilt |

### Moved 2026-09-23 — planning snapshots

Superseded by [`specs/`](../../specs/) as the place work is planned, or
describing code that has since changed.

| Page | What it is | Status |
|---|---|---|
| [Roadmap](ROADMAP.md) | Release roadmap v0.9.4 → v1.0 (2026-08-08) | Stale status snapshot; positioning lives in [PRODUCT-POSITIONING](../PRODUCT-POSITIONING.md), work in `specs/` |
| [Handover 2026-09](HANDOVER-2026-09.md) | Handover after PRs #25–#33 (v0.14.3) | Open items mostly closed since; its codebase traps moved to [ARCHITECTURE](../ARCHITECTURE.md) |
| [完善需求 PRD](PRD-COMPLETION.md) | Completion PRD, milestones M1–M4 (2026-09-06) | Mostly delivered; requirement intake moved to `specs/` |
| [Timeline UX deep-dive](UX-TIMELINE-2026-08.md) | Why the timeline feels complex (v0.11.5) | Analysis of a since-refactored component; its plan unbuilt |
| [UX backlog tickets](UX-BACKLOG-TICKETS.md) | Ticket specs F1–F7, T1–T6 (v0.11.6) | Some shipped in other shapes (sidebar order is now fixed, not draggable); T1–T3 unbuilt; status marks stale |
| [Timeline interaction redesign](DESIGN-TIMELINE-INTERACTION.md) | T1–T3 legend / wheel-mode / active-modes draft | Unbuilt |
| [Capture onboarding requirements](DEV-REQUIREMENTS-capture-onboarding.md) | Capture Readiness spec + TDD worked example | Shipped as `lib/captureReadiness.ts`; process superseded by `specs/` |
| [Timeline I/O visibility](timeline-io-visibility.md) | I/O visibility design note (v0.9.6) | T2–T6 shipped; T1 sidecar unbuilt (see [I/O sidecar](SPEC-IO-SIDECAR.md)) |
| [Design-system refactor](DESIGN-SYSTEM-REFACTOR.md) | Four-phase visual-system plan (2026-08-20) | Largely executed; the standard is [UIUX-STANDARD](../UIUX-STANDARD.md) |

Still live, and deliberately **not** archived: [`ALERT-ROLES.md`](../ALERT-ROLES.md)
(cited by `src/core/alert/`), [`DESIGN-PRINCIPLES.md`](../DESIGN-PRINCIPLES.md)
(§1 superseded, the rest in force) and [`TESTING.md`](../TESTING.md).
