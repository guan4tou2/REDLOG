# Implementation Plan: AI Session Folding

**Branch**: `feat/058-ai-session-folding` | **Date**: 2026-09-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/058-ai-session-folding/spec.md`

## Summary

Fold an agent run into one object on both timeline surfaces — a band on the
`agent` lane, a row in the event log — with the operator's own prompt titling
each group inside it. The grouping is a projection over events RedLog already
stores (`session_id`, `transcript_uuid`, the `agent.*` subtypes); capture,
schema and IPC producers are untouched.

The one architectural finding of Phase 0 is that the Timeline is a **capped
surface** (200 rows per page, load-back 1,000). A fold computed over a page is
a fold over an incomplete window, so every count a session row reports has to
carry its own completeness signal or come from a canonical count query. That
constraint, not the grouping itself, shapes the design.

## Technical Context

**Language/Version**: TypeScript 5.9, React 19

**Primary Dependencies**: Electron 44, Tailwind 4, better-sqlite3 13 (read path
only — this feature adds no write)

**Storage**: SQLite, read-only for this feature. No schema change, no
migration, no new column or index.

**Testing**: vitest for the derivation (pure, no DOM, following
`test/` conventions established for `timelineGeometry` and
`timelineSessionBands`); Playwright for the timeline journey.

**Target Platform**: Electron desktop — Windows, macOS, Linux

**Project Type**: Desktop app (Electron main + preload + renderer). This
feature is **renderer-only** plus, at most, one existing IPC read
(`window.redlog.events.count`).

**Performance Goals**: The derivation runs O(N) over the loaded page (≤200
rows; ≤1,000 on load-back) and must not add a measurable frame cost to
timeline render or to zoom, which recomputes layout.

**Constraints**: No new event type, field, schema change or migration
(spec FR-001). No second implementation of scope evaluation, event ordering or
query semantics (Constitution III). Counts reported over a capped page must
declare their own completeness (Constitution II, IV).

**Scale/Scope**: A page is 200 events. Agent sessions of 50–150 events are
ordinary, so a single session can exceed a page; the design must assume a
session straddles the page boundary rather than treat it as an edge case.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Bearing on this feature | Verdict |
|---|---|---|
| **I. Evidence Integrity** | Folding is presentation over stored events. Nothing is mutated, dropped or re-attributed; the raw sequence stays readable and exports are untouched (FR-011). | PASS |
| **II. Surface Truthfulness** | A session row reports turn and action counts. Over a capped page those counts can be partial, and a partial count shown as final would breach this directly. Resolved by FR-017 (R-003). | PASS *(by design — FR-017, research §R-003)* |
| **III. Canonical Domain Semantics** | The fold must not re-derive scope, ordering or session identity. It consumes `toLane`/`compareMonotonicNs`, the canonical scope result already on the event, and `sessionKey`'s agent-kind + `session_id` rule. Exactly one derivation module, consumed by both surfaces (FR-015). | PASS |
| **IV. Query Completeness** | `INVENTORY-query-completeness.md` §1 records the Timeline at 200/page with an existing `hasMore`, cursor and tri-state `total`. The fold inherits that boundary and must expose it, not hide it behind a tidy number. Resolved by FR-017 (R-003). | PASS *(by design — FR-017, research §R-003)* |
| **V. Preview / Execute Consistency** | No export path changes. SC-004 asserts the resolved export selection and manifest are identical with the fold derivation bypassed — compared as selection and manifest, not as bytes, since exports carry generation timestamps. | N/A |
| **VI. Explicit Failure** | "Session not fully loaded", "record known incomplete" (`transcript_parent_missing` / `tool_gap` / `schema_drift`), "no prompt recorded" and "session still running" are four distinct states and stay distinct (FR-006, FR-014, FR-018, R-004). The existing tri-state `total` is the pattern to follow. | PASS |
| **VII. Evidence Provenance** | Most load-bearing principle here. A folded session **is** a grouped Activity over AI tool pairs. Every turn and action keeps a reference to its source event id; the fold never presents an agent's reported behaviour as independently observed execution — a `tool_call` stays a tool call. Source time and receipt time are not merged (Invariant 8). | PASS |
| **VIII. Risk-Based Test-First Verification** | This changes how evidence is selected for display, so it is not a styling change. The derivation's failing unit tests come first, then the surfaces. | PASS *(workflow obligation)* |
| **IX. Architectural Restraint** | One new pure module in `src/renderer/src/lib/`, following seams already cut by `timelineGeometry.ts` and `timelineSessionBands.ts`. No new framework, adapter or abstraction layer. | PASS |

**Domain contract references** (Constitution: reference, do not duplicate):

- **Activity** — `docs/domain/glossary.md:12`: "由相關 Events 投影出的 operator
  interaction… Activity 是 projection，不是 DB table." A folded session is an
  Activity. This spec introduces no new domain term for it.
- **Agent Session** — `glossary.md:31`: the session identity the agent records
  in event data, queryable as `session:`. This is the fold's key. It is
  explicitly *not* Capture Session (`glossary.md:32`).
- **Query semantics** — `SPEC-search-query-semantics.md:54-62`: `session:` is
  already a canonical condition, and a tool-use id is unique only within a
  session. The fold reuses this rather than inventing a grouping key.
- **Invariant 5 (Cause Provenance)** and **Invariant 8 (Time Provenance)**
  govern the turn→action references and the timestamps a session row shows.

No domain invariant changes, so no domain-document update task is required.

**Workflow obligation**: the constitution requires Clarify, Checklist and
Analyze for features involving evidence. Clarify ran (spec §Clarifications,
2026-09-30). Checklist and Analyze are still owed before implementation.

## Project Structure

### Documentation (this feature)

```text
specs/058-ai-session-folding/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── session-fold.md  # Phase 1 output — the derivation's contract
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/renderer/src/
├── lib/
│   ├── agentSessionFold.ts        # NEW — the derivation (pure, no React, no DOM)
│   ├── timelineDomain.ts          # read: LANES, BANDS, toLane, badges
│   ├── timelineGeometry.ts        # read: bucketByPixel — agent lane now bypasses it
│   ├── timelineSessionBands.ts    # pattern to follow; agent bands are a sibling
│   └── eventTitle.ts              # read: agent subtype vocabulary
├── components/
│   ├── Timeline.tsx               # agent lane draws bands, not clustered dots
│   └── timeline/
│       ├── TimelineEventLog.tsx   # renders a session row in place of members
│       └── TimelineEventInspector.tsx  # session detail: turns, actions
└── i18n/{en,zh-TW}.json           # session row and turn copy

test/
├── agent-session-fold.test.ts     # NEW — derivation, every spec edge case
└── ...                            # existing timeline suites

e2e/                               # timeline journey: fold, open, expand, filter
```

**Structure Decision**: Renderer-only, single new pure module in `lib/`
consumed by three existing components. This mirrors the seams already pulled
out of `Timeline.tsx` (`timelineGeometry.ts`, `timelineTimeMap.ts`,
`timelineSessionBands.ts`), whose own header comments record why: the panel is
~2,600 lines and logic tangled with React state could not be unit-tested. The
derivation therefore lands in `lib/` and the components stay presentational,
which is also what makes FR-015's "one function, two surfaces" cheap.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

The two entries below are *constraints absorbed*, not violations — recorded
because they are the parts a later reader will most want justified.

| Decision | Why | Simpler alternative rejected because |
|---|---|---|
| Session counts may require one `events.count({session:…})` call | A page-local count is wrong whenever a session straddles the 200-row boundary, which is ordinary at these session sizes | Counting loaded members only would print a confidently wrong "47 動作"; Constitution II and IV both forbid it |
| The agent lane bypasses `bucketByPixel` | A session is a semantic group; pixel-proximity clustering would keep splitting and merging it at every zoom step | Leaving the agent lane clustered would make SC-003 (one object per session, independent of zoom) unachievable |
