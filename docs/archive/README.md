# Archive

Design documents that were written but whose subject was **never built**, or
was built in a different shape than described. They are kept because the
reasoning is worth reading in the form it was argued; they are moved here so
that nobody plans from them as if they described the code.

Moved 2026-09-06. Nothing in `src/` cites any of these by path.

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

Still live, and deliberately **not** archived: [`ALERT-ROLES.md`](../ALERT-ROLES.md)
(cited by `src/core/alert/`), [`DESIGN-PRINCIPLES.md`](../DESIGN-PRINCIPLES.md)
(§1 superseded, the rest in force) and [`TESTING.md`](../TESTING.md).
