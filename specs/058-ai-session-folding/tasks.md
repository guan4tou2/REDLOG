---

description: "Task list for AI Session Folding (058)"
---

# Tasks: AI Session Folding

**Input**: Design documents from `/specs/058-ai-session-folding/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/session-fold.md](./contracts/session-fold.md)

**Tests**: Test tasks are **required**, not optional. Constitution VIII: changes
to evidence semantics, selection or pagination MUST begin with an observable
test that fails for the intended reason. Every phase below leads with its RED
tasks, and the RED reason is recorded in `verification.md` (T065).

**Organization**: Tasks are grouped by user story. The derivation itself is
foundational — it serves all four stories, so it lands in Phase 2 and blocks
everything after it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths in every description

## Path Conventions

Electron desktop app, renderer-only feature (plan §Structure Decision):

- Derivation: `src/renderer/src/lib/`
- Surfaces: `src/renderer/src/components/`, `src/renderer/src/components/timeline/`
- Copy: `src/renderer/src/i18n/{en,zh-TW}.json`
- Unit tests: `test/` · E2E: `e2e/`

---

## Phase 1: Setup

**Purpose**: Open the branch and close the workflow gates the constitution
requires before implementation.

- [ ] T001 Create branch `feat/058-ai-session-folding` from `main`, and confirm `specs/058-ai-session-folding/` is the only spec directory this branch adds (memory: parallel work takes spec numbers — re-check `origin/main specs/` before opening the PR)
- [ ] T002 Run `/speckit-analyze` across spec.md, plan.md and tasks.md; record the outcome in `specs/058-ai-session-folding/verification.md` even when it is clean, since a clean Analyze writes nothing itself
- [ ] T003 Review `specs/058-ai-session-folding/checklists/{evidence,states,ux}.md` and mark the items now answered by FR-017 through FR-020; leave the rest unchecked with a one-line note. Reviewer-owned — do not mark items to clear the gate
- [ ] T004 [P] Create `test/agent-session-fold.test.ts` with the suite skeleton and no assertions, importing from `src/renderer/src/lib/agentSessionFold` so the file fails to resolve — the first intended RED

**Checkpoint**: Workflow gates closed, RED harness in place.

---

## Phase 2: Foundational — the derivation (BLOCKING)

**Purpose**: The pure function both surfaces consume. Nothing in Phase 3+ can
begin until this is green.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests first (RED)

- [ ] T005 [P] Add fixture builders for agent events in `test/fixtures/agent-events.ts` — `session_id`, `subtype`, `transcript_uuid`, monotonic ordering fields — so no test hand-rolls a `RedLogEvent`
- [ ] T006 [P] RED: session identity in `test/agent-session-fold.test.ts` — two adapters sharing the bare `session_id` `'rollout-abc'` produce two folds, keyed `` `${agentKind}:${sessionId}` `` per contract G3 and research R-001
- [ ] T007 [P] RED: turn boundaries in `test/agent-session-fold.test.ts` — a turn opens at `agent.user_message` **only**; `compact_summary` between two tool calls does not open one; a `tool_result` carrying role `user` does not open one (research R-002)
- [ ] T008 [P] RED: partitioning and losslessness in `test/agent-session-fold.test.ts` — every agent event appears in exactly one fold's `memberIds`, no non-agent event appears in any, and concatenating turns' `actionIds` reproduces member order minus prompt events (data-model validation rules 1–2, contract G3/G5)
- [ ] T009 [P] RED: prompt fidelity in `test/agent-session-fold.test.ts` — `promptText` is byte-identical to the source event body, including a multi-line prompt and one containing markup (data-model validation rule 3, contract G6)
- [ ] T010 [P] RED: unattributed leading turn in `test/agent-session-fold.test.ts` — actions before the session's first `user_message` land in a turn with `ordinal: null`, never merged into T1 (FR-010)
- [ ] T011 [P] RED: count completeness in `test/agent-session-fold.test.ts` — with `hasMore: true` and a session touching the window edge the count is `{ state: 'atLeast', value }`; a failed count resolves `{ state: 'unknown' }` and never `0` or `exact` (FR-017, contract G8)
- [ ] T012 [P] RED: `turns_emitted` authority in `test/agent-session-fold.test.ts` — derived turn count **below** `session_end.turns_emitted` sets `loadState: 'edge'`; derived **above** it sets `recordIntegrity.complete = false` with reason `'turn_count_mismatch'` and is neither silently preferred nor discarded (FR-018)
- [ ] T013 [P] RED: severity aggregation in `test/agent-session-fold.test.ts` — a session of three in-scope members and one out-of-scope member reports out-of-scope; never a majority, an average, or the first member's state (FR-019)
- [ ] T014 [P] RED: the four states stay distinct in `test/agent-session-fold.test.ts` — `running`, `recordIntegrity.complete === false`, `loadState: 'edge'` and "no prompt recorded" are independently settable, and a running session never reads as a capture failure (research R-004)
- [ ] T015 [P] RED: degenerate and empty inputs in `test/agent-session-fold.test.ts` — events with absent `session_id` fold into one unattributed group per agent kind; `session_id` present but empty is distinct from absent; a single-event session still folds; a turn with zero actions still appears (data-model §Degenerate session, spec §Edge Cases)
- [ ] T016 [P] RED: totality in `test/agent-session-fold.test.ts` — an unknown `agent.*` subtype continues the current turn rather than opening one, and malformed input returns a degraded fold instead of throwing (contract G2, contracts §3 compatibility note)
- [ ] T017 Confirm every test T006–T016 fails for its intended reason, and capture each RED reason for `verification.md`. A test failing only on the missing import is not yet a valid RED

### Implementation (GREEN)

- [ ] T018 Define `Count` in `src/renderer/src/lib/agentSessionFold.ts` with exactly the three states from data-model: `{ state: 'exact'; value: number }`, `{ state: 'atLeast'; value: number }`, `{ state: 'unknown' }`
- [ ] T019 Define `RecordIntegrity` in `src/renderer/src/lib/agentSessionFold.ts` as `{ complete: true }` or `{ complete: false; reasons: Array<'parent_missing' | 'tool_gap' | 'schema_drift' | 'turn_count_mismatch'> }`
- [ ] T020 Define `AgentSessionFold` and `PromptTurn` in `src/renderer/src/lib/agentSessionFold.ts` with every field and type from data-model, including `memberIds: string[]` as the provenance reference and `loadState: 'complete' | 'edge'`
- [ ] T021 Implement `foldKeyOf(e, pluginTypes)` in `src/renderer/src/lib/agentSessionFold.ts` — returns `` `${agentKind}:${sessionId}` `` for events whose `toLane(...) === 'agent'`, `null` otherwise. Calls `toLane` from `lib/timelineDomain`; defines no lane rule of its own (contract G7)
- [ ] T022 Implement session partitioning in `src/renderer/src/lib/agentSessionFold.ts` using `compareMonotonicNs` from `lib/eventOrder` for ordering — never a raw wall-clock sort (contract G4)
- [ ] T023 Implement turn splitting in `src/renderer/src/lib/agentSessionFold.ts` — open a turn at `agent.user_message` only; every other subtype, known or unknown, continues the current turn; actions preceding the first prompt form the `ordinal: null` turn
- [ ] T024 Implement turn ordinal continuity across `transcript_compacted` in `src/renderer/src/lib/agentSessionFold.ts` — numbering continues rather than restarting at T1, and the reset is recorded on the session (spec §Edge Cases)
- [ ] T025 Implement count resolution in `src/renderer/src/lib/agentSessionFold.ts` per FR-017 and the R-003 table: `exact` only when every member is loaded or `knownCounts` supplied one; `atLeast` when `hasMore` and the session touches the window edge; `unknown` on a resolved failure
- [ ] T026 Implement `turns_emitted` precedence and mismatch detection in `src/renderer/src/lib/agentSessionFold.ts` per FR-018, setting `'turn_count_mismatch'` only when the derived count exceeds the emitted one
- [ ] T027 Implement state derivation in `src/renderer/src/lib/agentSessionFold.ts` — `running`, `recordIntegrity` from `transcript_parent_missing` / `transcript_tool_gap` / `transcript_schema_drift` members, `loadState`, and the no-prompt case, each set independently (research R-004)
- [ ] T028 Implement severity aggregation in `src/renderer/src/lib/agentSessionFold.ts` per FR-019, reading each member's canonical scope result and `computeBadges` output from `lib/timelineDomain`; the module performs no scope evaluation of its own (Constitution III, Invariant 4)
- [ ] T029 Run `npx vitest run test/agent-session-fold.test.ts` and confirm T006–T016 are green with no test weakened to pass
- [ ] T030 Add `test/agent-session-fold-purity.test.ts` asserting the module imports no React, no DOM global and no IPC surface (contract G1), following the source-parsing style of `test/lane-colours.test.ts`

**Checkpoint**: The derivation is green, pure and tested without a DOM (SC-006). User stories can now proceed.

---

## Phase 3: User Story 1 — Read the engagement without the agent drowning it (Priority: P1) 🎯 MVP

**Goal**: One row per agent session in the event log, in place of that session's member events.

**Independent Test**: Open an engagement with two agent sessions (47 and 83 events) and twelve non-agent events; the log shows fourteen rows and no `tool_call`, `tool_result`, `assistant_message` or `thinking` row from inside a folded session.

### Tests first (RED)

- [ ] T031 [P] [US1] RED: log composition in `test/timeline-event-log-fold.test.ts` — given two folds and twelve non-agent events the log renders fourteen rows, and no folded member renders its own row (FR-005)
- [ ] T032 [P] [US1] RED: sizing unchanged in `test/timeline-event-log-fold.test.ts` — `TimelineEventLog` still resolves `18vh` with a selection and `22vh` without (FR-016)

### Implementation

- [ ] T033 [US1] Call `foldAgentSessions` once in `src/renderer/src/components/Timeline.tsx` and pass the result plus `foldKeyOf` down; no component derives folds of its own (FR-015)
- [ ] T034 [US1] Suppress folded members and render one session row in `src/renderer/src/components/timeline/TimelineEventLog.tsx`, keeping the existing row grammar — dot, time, tier, operator, title — rather than inventing a second one (checklist ux CHK012)
- [ ] T035 [US1] Render the session row's required fields in `src/renderer/src/components/timeline/TimelineEventLog.tsx`: agent, first prompt, turn count, action count, and running-vs-closed (FR-006), with the counts rendered through the `Count` renderer from T036
- [ ] T036 [P] [US1] Add a `Count` renderer in `src/renderer/src/components/timeline/` that refuses to print an `atLeast` as a plain number and an `unknown` as `0` (FR-017), with the qualifier composing correctly in both locales
- [ ] T037 [P] [US1] Add session-row copy to `src/renderer/src/i18n/en.json` and `src/renderer/src/i18n/zh-TW.json`, including the count qualifier, the running label and the no-prompt label; no string concatenated in a component
- [ ] T038 [US1] Open the session detail on activation in `src/renderer/src/components/timeline/TimelineEventLog.tsx` without expanding the log in place (US1 acceptance 3)
- [ ] T039 [US1] Give the session row a visible focus state and keyboard activation per `docs/UIUX-STANDARD.md` §117 (checklist ux CHK003)

**Checkpoint**: The event log is readable with agent sessions present. MVP.

---

## Phase 4: User Story 2 — See what each prompt bought (Priority: P1)

**Goal**: The session detail lists prompt turns titled with the operator's own words, each expanding to its actions.

**Independent Test**: Open a three-prompt session; three turns appear in order, each titled with the prompt verbatim; expanding one lists its actions with timestamps; activating an action opens that event's detail.

### Tests first (RED)

- [ ] T040 [P] [US2] RED: turn rendering in `test/timeline-inspector-fold.test.ts` — three turns in time order with per-turn action counts, and the unattributed turn rendered ahead of T1 when present (FR-009, FR-010)
- [ ] T041 [P] [US2] RED: title fidelity in `test/timeline-inspector-fold.test.ts` — the rendered title's `title` attribute carries the full prompt while the visible text may truncate; the stored value is never shortened, reworded or translated (FR-004, UIUX-STANDARD §168)

### Implementation

- [ ] T042 [US2] Render the session detail's turn groups in `src/renderer/src/components/timeline/TimelineEventInspector.tsx` from `fold.turns`, deriving nothing locally
- [ ] T043 [US2] Render each turn's actions in `src/renderer/src/components/timeline/TimelineEventInspector.tsx` in time order with timestamps, each activating its own event detail (FR-009)
- [ ] T044 [US2] Apply §168 truncation to the prompt title in `src/renderer/src/components/timeline/TimelineEventInspector.tsx` — native `title` for the full text, and a multi-line prompt collapsed to its first line in the row (checklist ux CHK007, CHK011)
- [ ] T045 [P] [US2] Add turn and unattributed-group copy to `src/renderer/src/i18n/en.json` and `src/renderer/src/i18n/zh-TW.json`
- [ ] T046 [US2] Decide and implement the initial expand state for turns in `src/renderer/src/components/timeline/TimelineEventInspector.tsx`, and record the choice in a code comment (checklist ux CHK002)

**Checkpoint**: A folded session is fully readable without losing which prompt caused what.

---

## Phase 5: User Story 4 — A fold never hides an exception (Priority: P1)

**Goal**: Scope markings, integrity badges, counts and filters behave identically whether an event is folded or not.

**Independent Test**: A session containing one out-of-scope event reads as out-of-scope; the status bar's out-of-scope count is unchanged by folding; the out-of-scope filter reaches the event in no more steps than for an unfolded event.

### Tests first (RED)

- [ ] T047 [P] [US4] RED: counts unaffected in `test/agent-session-fold-invariants.test.ts` — total events, out-of-scope count and tier counts computed over the same event set are identical with the fold derivation applied and bypassed (FR-011, SC-004)
- [ ] T048 [P] [US4] RED: export selection unaffected in `test/agent-session-fold-invariants.test.ts`, named `"selection unchanged"` so `quickstart.md` Scenario 5 can invoke it by `-t` — the resolved export selection and manifest match with the derivation bypassed; compared as selection and manifest, never as export bytes, which carry generation timestamps (SC-004)
- [ ] T049 [P] [US4] RED: filter semantics in `test/agent-session-fold-invariants.test.ts` — a session with one matching member remains reachable; a session whose members all fail does not appear; the filter never evaluates the fold itself (FR-013)

### Implementation

- [ ] T050 [US4] Surface the aggregated scope marking and integrity badges on the session row in `src/renderer/src/components/timeline/TimelineEventLog.tsx` per FR-012 and FR-019
- [ ] T051 [US4] Apply filters to member events rather than to folds in `src/renderer/src/components/Timeline.tsx`, reusing spec 038's shared filter rather than adding a parallel predicate (FR-013, checklist ux CHK015)
- [ ] T052 [US4] Verify the status bar and any other count surface read from the unfolded event set in `src/renderer/src/components/StatusBar.tsx` and `src/renderer/src/components/Timeline.tsx`; fix any that read from folds (FR-011)

**Checkpoint**: Folding is provably a presentation change and not an evidence change.

---

## Phase 6: User Story 3 — See when the agent was working (Priority: P2)

**Goal**: The `agent` lane draws one band per session instead of clustered dots.

**Independent Test**: Zoom the track across its full range; the agent lane renders exactly one object per session at every step, spanning the session's first and last event.

### Tests first (RED)

- [ ] T053 [P] [US3] RED: band geometry in `test/agent-session-bands.test.ts` — one band per fold spanning `startTs`–`endTs`, a running session extending to the live edge, and the object count invariant to `clusterPx` (SC-003, research R-005)

### Implementation

- [ ] T054 [US3] Add an agent-band builder beside `src/renderer/src/lib/timelineSessionBands.ts`, reusing its greedy interval-colouring pass so concurrent sessions' labels stagger rather than stack (research R-005)
- [ ] T055 [US3] Bypass `bucketByPixel` for the `agent` lane in `src/renderer/src/components/Timeline.tsx` using `foldKeyOf`, and draw bands in its place (FR-007)
- [ ] T056 [US3] Distinguish a running band from a closed one in `src/renderer/src/components/Timeline.tsx` by a non-hue property — hue is reserved for status by `docs/UIUX-STANDARD.md` §1 and `LANE_COLOR` is a single grey (checklist ux CHK008)
- [ ] T057 [US3] Open the same session detail from a band as from a log row in `src/renderer/src/components/Timeline.tsx` (FR-008)
- [ ] T058 [US3] Decide whether agent bands share the shell band row or take their own, and record the choice in a code comment in `src/renderer/src/components/Timeline.tsx` (research R-005, open for Phase 2)

**Checkpoint**: Both surfaces fold, from one derivation.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T059 [P] Add the E2E journey in `e2e/` — fold appears, session opens, turn expands, filter reaches a folded out-of-scope event
- [ ] T060 [P] Confirm no user-facing folding toggle exists and no folding preference is persisted (FR-020) — assert it in `test/agent-session-fold-invariants.test.ts` rather than by inspection
- [ ] T061 [P] Check the log and detail at narrow window widths in `src/renderer/src/components/timeline/TimelineEventLog.tsx` and `src/renderer/src/components/timeline/TimelineEventInspector.tsx`, where both share the panel (checklist ux CHK021)
- [ ] T062 Measure timeline render and zoom before and after on an engagement with two sessions over 200 events; record both numbers in `verification.md` (plan §Performance Goals, checklist ux CHK023)
- [ ] T063 Run the full gate set: `npm test`, `npm run typecheck`, `npm run verify:architecture`, `npm run verify:specs`, `npm run build`, `npm run e2e`
- [ ] T064 Walk `specs/058-ai-session-folding/quickstart.md` Scenarios 2–6 manually against a real engagement and record the outcomes
- [ ] T065 Write `specs/058-ai-session-folding/verification.md` from `.specify/templates/overrides/verification-template.md` — the RED reasons from T017, the final evidence, and the outcome of every workflow gate including Clarify, Checklist, Analyze and Converge, each recorded even when clean
- [ ] T066 Move spec.md `**Status**` from Draft to its verified value only after T063–T065 pass; `npm run verify:specs` rejects a Verified feature whose artifacts do not meet the workflow section

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3)**: Depends on Phase 2
- **US2 (Phase 4)**: Depends on Phase 2; T038 (detail opens) makes it reachable, so run after Phase 3 unless the inspector is driven directly in tests
- **US4 (Phase 5)**: Depends on Phase 2; T050 needs US1's row, T051 is independent of both
- **US3 (Phase 6)**: Depends on Phase 2 only — fully parallel with Phases 3–5
- **Polish (Phase 7)**: Depends on every story intended for this release

### Within Each Story

- RED tasks written and failing for the intended reason before implementation (Constitution VIII)
- Types before the functions that return them (T018–T020 before T021–T028)
- Derivation before surfaces
- No surface re-derives what the derivation already computed

### Parallel Opportunities

- T005–T016: eleven RED tasks, all in test files, all parallel
- T018–T020: three type definitions, parallel
- T036, T037: renderer and copy, parallel with each other and with T034–T035
- **Phase 6 (US3) is parallel with Phases 3–5** — the track and the log share only the derivation, which Phase 2 already froze
- T059–T062: four polish tasks, parallel

---

## Parallel Example: Phase 2 RED

```bash
# All eleven derivation tests can be written together — one file each concern,
# no implementation exists yet, so none of them can pass by accident:
Task: "RED: session identity (T006)"
Task: "RED: turn boundaries (T007)"
Task: "RED: partitioning and losslessness (T008)"
Task: "RED: prompt fidelity (T009)"
Task: "RED: unattributed leading turn (T010)"
Task: "RED: count completeness (T011)"
Task: "RED: turns_emitted authority (T012)"
Task: "RED: severity aggregation (T013)"
Task: "RED: four states distinct (T014)"
Task: "RED: degenerate and empty inputs (T015)"
Task: "RED: totality (T016)"
```

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 Setup
2. Phase 2 Foundational — the derivation, green and pure
3. Phase 3 US1 — the event log folds
4. **STOP and VALIDATE**: quickstart Scenario 2. The log is readable with agent
   sessions present, which is the problem that motivated the feature.

At this point US4's invariants are not yet asserted, so do not ship past this
checkpoint without Phase 5 — an unasserted fold over evidence is the one
outcome the constitution does not permit.

### Incremental Delivery

1. Setup + Foundational → derivation frozen, both surfaces unblocked
2. US1 → log readable → validate
3. US2 → turns readable → validate
4. US4 → invariants asserted → **safe to ship**
5. US3 → track folds → validate
6. Polish → gates, quickstart, verification record

### Parallel Team Strategy

After Phase 2, the track (US3) and the log (US1 → US2 → US4) are independent
work streams sharing one frozen module. Two developers split cleanly there; a
third has nothing to do until Phase 7, because everything else routes through
the same two components.

---

## Notes

- [P] = different files, no dependencies on incomplete tasks
- Every RED task must fail for its stated reason; a failure caused only by a
  missing import is not a valid RED (T017 guards this)
- Commit after each task or logical group
- Checklist markers in `checklists/` are reviewer-owned; `$speckit-implement`
  reads them as a gate and must not modify them
- The feature is renderer-only. If a task appears to require a capture, schema
  or IPC producer change, the design has drifted from FR-001 — stop and revisit
  the plan rather than widening the change
