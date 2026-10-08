# Feature Specification: AI Session Folding

**Feature Branch**: `spec/058-ai-session-folding`
**Created**: 2026-09-30
**Status**: Draft
**Renumbered**: written as 049; main took 049 for `049-capture-settings-ia`
while this branch sat local-only and unpushed. T001 below says to re-check
`origin/main specs/` before opening the PR — that check is right, and it is
also not enough: `verify:specs` compares only against origin/main, so a
number another unmerged branch is holding stays invisible to both sides.
**Input**: An agent session is the only thing in an engagement that produces
dozens of events from one human sentence, and it is the only thing the timeline
has no unit for. Fold a session into one object on both surfaces — a band on the
`agent` lane, a row in the event log — and make the operator's own prompt the
title of each group inside it. The grouping is derived from what capture already
stores; nothing new is recorded.

> **Not in scope, and deliberately:** the contrast, tick-colour and focus
> findings from the same design review. `docs/UIUX-STANDARD.md` already sets a
> **6:1** grey floor (stricter than WCAG's 4.5, calibrated for the app's 13px
> base at 0.9 default zoom), a ≥5 L* separation between adjacent tiers enforced
> by `test/design-tokens.test.ts`, and §117's hard gates for focus rings,
> non-text ≥3:1 and `prefers-reduced-motion`. Those findings are already
> covered, and covered more strictly. Only the narrative structure is new.

## Problems (verified on `559040a`)

1. **A prompt turn is not an object anywhere.** `eventTitle.ts:155-181` shows
   the agent lane's vocabulary: `user_message`, `assistant_message`,
   `tool_call`, `tool_result`, `thinking`, one event each. The operator's own
   sentence — the single piece of evidence that says *why* the next 47 actions
   happened — is one row among the 47, distinguishable only by its subtype.
   Nothing in the renderer groups by it.

2. **On the track, a session reads as volume rather than as work.**
   `bucketByPixel` (`timelineGeometry.ts`) collapses a burst into one dot by
   pixel proximity, so a session's events merge with whatever else happens to
   sit nearby, and a zoom step splits them at an arbitrary place. The `agent`
   lane, which sits in the `commands` band beside `shell`, therefore reports
   how many events an agent emitted, not what it was asked to do or when it
   started and stopped.

3. **One session fills the whole event log.** `TimelineEventLog.tsx` is sized
   `18vh` when a row is selected and `22vh` otherwise — roughly five rows at a
   900px window. A single agent session emits `tool_call`/`tool_result` in
   pairs, so an ordinary session pushes every human-issued command out of the
   visible log. The list is where an engagement is read in order, and the agent
   is the thing that makes it unreadable.

4. **Terminals get session boundaries; agents do not.** `buildSessionBands`
   draws a band for every `shell.session_end` and for each
   `system.recording_paused`/`recording_resumed` pair. An agent session has the
   same shape and the same evidentiary weight — `tailer-host.ts:1218` already
   emits `agent.session_end` carrying `turns_emitted` — and draws nothing.

5. **The grouping data is already stored and already unused.** Every agent
   event written by `tailer-host.ts:587` carries `session_id` and
   `transcript_uuid`; the Claude adapter resolves a parent chain per line
   (`claude-code.ts:91-92`) and the host records
   `transcript_parent_missing` with `parent_uuid`/`child_uuid` when it breaks.
   No renderer module reads `session_id`. Every requirement below is a
   derivation over events RedLog already holds.

## Clarifications

### Session 2026-09-30

- Q: Which surface shows the folded session? → A: Both. The grouping is one
  pure function in `lib/`; the track consumes it as a band and the event log
  consumes it as a row. The second surface costs little once the first exists.
- Q: Does the event log grow into a primary reading surface as part of this? →
  A: No. `TimelineEventLog` keeps its `18vh`/`22vh` sizing. Whether the log
  should become a full reading surface is a separate question and overlaps
  spec 046's audit scope.
- Q: Does capture change? → A: No. No new event, no new field, no schema
  change, no migration. If a turn cannot be derived from stored events, the
  spec degrades rather than asking capture for more.

### Session 2026-09-30 (checklist review)

Raised by `checklists/evidence.md` and `checklists/states.md` after Phase 1.

- Q: Is folding user-switchable? SC-004 read as though a control existed, but
  no requirement defined one. → A: **No control.** Folding is how the surfaces
  render agent events, not a preference. SC-004 is restated as an
  implementation-level comparison against the same events with the derivation
  bypassed. Adding a user-facing toggle is a separate product decision
  (FR-020).
- Q: A count must be able to say it is partial — where is that required? → A:
  It was designed in `research.md` §R-003 and required nowhere. Added as
  **FR-017**; FR-006 now defers to it.
- Q: `session_end.turns_emitted` disagrees with the turn count derived from
  loaded members — which wins? → A: `turns_emitted` is authoritative, because
  capture wrote it over the whole transcript while the derivation sees only the
  loaded window. A derived count **exceeding** it is an inconsistency, not
  paging, and marks the record incomplete (**FR-018**).
- Q: Members disagree on scope — what does the row show? → A: The row shows the
  most severe member state. A session with any out-of-scope member reads as
  out-of-scope (**FR-019**).
- Q: Is "byte-identical" export output testable, given exports may embed a
  generation timestamp? → A: No. SC-004 now asserts equality of the resolved
  event selection and the manifest, which is what Principle V actually governs.

## User Scenarios & Testing

### User Story 1 - Read the engagement without the agent drowning it (Priority: P1)

An operator who ran two Claude Code sessions and a dozen manual commands opens
the event log to check the order of the morning's work.

**Why this priority**: This is the failure that makes the log unusable today;
every other story is an improvement on a surface that already works.

**Acceptance Scenarios**

1. **Given** an engagement holding two agent sessions of 47 and 83 events and
   twelve non-agent events, **When** the operator opens the event log,
   **Then** the log shows fourteen rows — twelve events and two session rows —
   and no `tool_call`, `tool_result`, `assistant_message` or `thinking` row
   from inside a folded session.
2. **Given** that log, **When** the operator reads a session row, **Then** it
   states the agent, the operator's first prompt of that session, the number of
   prompt turns and the number of actions.
3. **Given** a session row, **When** the operator activates it, **Then** the
   detail panel opens on that session, and the log does not expand in place.

### User Story 2 - See what each prompt bought (Priority: P1)

The operator needs to know which of their own instructions produced a
particular command, for the report and for their own memory.

**Why this priority**: The prompt is the evidence that distinguishes an
operator-directed action from an agent's own initiative. Without it the fold
hides information instead of organising it.

**Acceptance Scenarios**

1. **Given** a session of three prompt turns, **When** the operator opens it,
   **Then** the detail panel lists three groups in time order, each titled with
   the operator's prompt text verbatim, each showing its own action count.
2. **Given** those groups, **When** the operator expands one, **Then** its
   actions appear in time order with timestamps, and each action opens its own
   event detail.
3. **Given** a prompt title longer than its row, **When** it is shown, **Then**
   it truncates with the full text available per UIUX-STANDARD §168, and is
   never paraphrased, summarised or rewritten.

### User Story 3 - See when the agent was working (Priority: P2)

The operator scans the track to place the agent's work against their own.

**Acceptance Scenarios**

1. **Given** a session spanning 09:22:10–09:28:41, **When** the track renders,
   **Then** the `agent` lane draws one band across that span rather than N
   clustered dots.
2. **Given** a band, **When** the operator activates it, **Then** the same
   session detail opens as from the log row.
3. **Given** a session still running, **When** the track renders, **Then** its
   band extends to the live edge and is distinguishable from a closed one.

### User Story 4 - A fold never hides an exception (Priority: P1)

An out-of-scope request or a failed command inside a folded session must not
become less visible than the same event outside one.

**Why this priority**: Folding is a presentation change over evidence. A fold
that suppresses a scope violation would be a correctness defect, not a UX one.

**Acceptance Scenarios**

1. **Given** a session containing an out-of-scope event, **When** the log
   renders, **Then** the session row carries the same out-of-scope marking an
   individual row would, and the status bar's out-of-scope count is unchanged
   by folding.
2. **Given** the out-of-scope filter, **When** it is applied, **Then** the
   matching events inside sessions are reachable, and a session with no
   matching event does not appear.
3. **Given** a session carrying a chain-integrity or evidence-integrity badge
   on any member event, **When** the session row renders, **Then** the badge
   surfaces on the row.

### Edge Cases

- **`compact_summary` must not open a turn.** It arrives with role `user`
  (`claude-code.ts:289`) and is not an operator prompt. Only
  `agent.user_message` opens a turn.
- **A `tool_result` arriving as role `user`** is already mapped to
  `tool_result` by the adapter (`claude-code.ts:224,247`); the derivation reads
  subtypes, never roles.
- **A session with no `user_message`** — reached by catch-up, or beginning
  mid-transcript — folds with an explicit "no prompt recorded" title rather
  than borrowing an assistant message as one.
- **Actions before the first `user_message`** belong to an unattributed group
  shown ahead of T1, never silently merged into it.
- **A running session** has no `session_end`; its counts are live and its row
  says so.
- **`transcript_compacted` mid-session** resets the transcript; turn numbering
  continues rather than restarting, and the reset is visible in the session.
- **`transcript_parent_missing` / `transcript_tool_gap`** inside a session mean
  the fold is over a known-incomplete record; the session says so instead of
  presenting a clean count.
- **Two agents in one engagement** — sessions key on agent kind plus
  `session_id`, matching `tailer-host.ts`'s own `sessionKey`, because Codex and
  Claude can both produce a session named `rollout-abc`.
- **A single-event session** still folds; a fold that applies only above a
  threshold would make the log's shape depend on session size.
- **A turn with zero actions** (a prompt the agent answered without tools)
  still appears, with a zero count.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST derive agent sessions and prompt turns from
  stored events alone. No new event type, field, schema change or migration.
- **FR-002**: A session MUST be identified by agent kind together with
  `session_id`, matching the key capture already uses.
- **FR-003**: A prompt turn MUST begin at an `agent.user_message` event and
  MUST NOT begin at any other subtype, `compact_summary` included.
- **FR-004**: A turn's title MUST be the operator's prompt text verbatim.
  The system MUST NOT paraphrase, summarise, translate or otherwise rewrite it.
- **FR-005**: The event log MUST show one row per agent session in place of
  that session's member events, and MUST keep every non-agent event as its own
  row.
- **FR-006**: A session row MUST state the agent, the session's first prompt,
  the turn count and the action count, and MUST distinguish a running session
  from a closed one. Both counts are subject to FR-017.
- **FR-007**: The `agent` lane MUST draw one band per session over the
  session's own span, and MUST NOT draw that session's member events as
  separate dots on that lane.
- **FR-008**: Activating a session on either surface MUST open the same session
  detail.
- **FR-009**: The session detail MUST list every turn in time order with its
  action count, MUST allow each turn to expand to its actions in time order,
  and MUST allow each action to open its own event detail.
- **FR-010**: Actions recorded before the session's first prompt MUST appear in
  a distinct unattributed group rather than inside the first turn.
- **FR-011**: Folding MUST NOT change any count the product reports elsewhere —
  total events, out-of-scope count, tier counts, export contents.
- **FR-012**: A session row MUST surface the scope state and the integrity
  badges of its member events, and MUST NOT present a session as clean when a
  member event is not. Aggregation of disagreeing members is FR-019.
- **FR-013**: A filter MUST apply to member events, not to the fold: a session
  whose members all fail the filter MUST NOT appear, and a session with a
  matching member MUST remain reachable.
- **FR-014**: A session derived over an incomplete record — one carrying
  `transcript_parent_missing`, `transcript_tool_gap` or
  `transcript_schema_drift` — MUST say so rather than presenting its counts as
  complete.
- **FR-015**: The derivation MUST be a pure function in `lib/`, testable
  without a DOM, consumed by both surfaces — following the seams already
  established by `timelineGeometry.ts` and `timelineSessionBands.ts`.
- **FR-016**: `TimelineEventLog`'s sizing MUST be unchanged by this feature.
- **FR-017**: Every count a session reports MUST carry its own completeness.
  A count MUST be presented as exact only when the system knows it to be exact
  — every member loaded, or a canonical count resolved. A count taken over an
  incompletely loaded session MUST be presented as a floor, and a count whose
  resolution failed MUST be presented as unknown. A floor MUST NOT be rendered
  as a plain number and an unknown MUST NOT be rendered as zero.
- **FR-018**: When `agent.session_end` carries `turns_emitted`, that value is
  the authoritative turn count. A derived turn count **below** it means the
  session is not fully loaded and MUST resolve per FR-017. A derived turn count
  **above** it is an inconsistency between capture and derivation, and MUST
  mark the session's record incomplete per FR-014 rather than being silently
  preferred or discarded.
- **FR-019**: Where member events disagree on a state the session row reports,
  the row MUST show the most severe member state: any out-of-scope member makes
  the session read out-of-scope, and any member carrying an integrity badge
  makes the session carry it. The row MUST NOT report a majority, an average,
  or the state of the first member.
- **FR-020**: Folding is not user-switchable. The system MUST NOT present a
  control that turns folding on or off, and MUST NOT persist a per-operator
  folding preference. (Whether such a control should exist is a product
  decision outside this feature.)

### Key Entities

- **AgentSession** — one agent run. Identified by agent kind plus `session_id`.
  Holds its span, its member events in order, its turns, whether it is still
  running, and whether its record is known to be incomplete.
- **PromptTurn** — one operator prompt and everything the agent did before the
  next prompt. Holds the prompt text verbatim, its ordinal within the session,
  its span and its member actions. An unattributed leading group is a turn with
  no prompt.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In an engagement holding two agent sessions and twelve manual
  events, every manual event is visible in the event log without scrolling past
  agent rows — the count of log rows is 14, not 142.
- **SC-002**: From a session row, the operator reaches the command that a named
  prompt produced in two activations (open session, expand turn).
- **SC-003**: The `agent` lane's rendered object count for a session is one,
  independent of zoom level.
- **SC-004**: For the same event set, the resolved export selection and the
  resulting manifest are identical whether produced through the folded surfaces
  or with the fold derivation bypassed, and the engagement's total event count
  and out-of-scope count are unchanged by folding. Compared as resolved
  selection and manifest, not as export bytes, which carry generation
  timestamps.
- **SC-005**: An out-of-scope event inside a session is reachable in no more
  steps than the same event outside one.
- **SC-006**: The derivation has unit tests covering every edge case listed
  above, running without a DOM.
- **SC-007**: New behaviour tests, the full suite, typecheck, gates and build
  all pass.

## Assumptions

- Agent events already carry `session_id` on every row written by
  `tailer-host.ts`; sessions that predate that field fold as a single
  unattributed group rather than failing to render.
- `agent.user_message` is the operator's prompt for all three adapters
  (`claude-code`, `codex`, `opencode`). If an adapter routes an operator prompt
  through another subtype, that adapter's mapping is the defect, not this
  derivation.
- Folding is a presentation decision over stored evidence. The stored events,
  the chain and the export are untouched, so a reader who disagrees with the
  fold can still read the raw sequence.
- Spec 046's audit remediation and this feature both touch the timeline; 046
  owns token and control corrections, this owns the agent's narrative unit.
