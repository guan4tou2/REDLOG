# Quickstart: Validating AI Session Folding

**Feature**: 058-ai-session-folding | **Date**: 2026-09-30

How to prove the feature works end to end. Scenario numbers map to the spec's
user stories; gate commands are the repo's existing scripts. Implementation
belongs in `tasks.md`, not here.

---

## Prerequisites

```bash
npm install
npm rebuild better-sqlite3
```

> The `pretest` / `pree2e` scripts rebuild `better-sqlite3` for the right ABI.
> On Windows, run `npm test` (which triggers `pretest`) before `npm run e2e`,
> since the two targets need different builds of the same native module.

An engagement with at least one Claude Code session is needed for the manual
scenarios. Either open an existing project, or record one:

1. Create a project and install the Claude Code hook from **擷取來源 / Capture
   sources**.
2. Run a short Claude Code session with **three distinct prompts** against an
   in-scope target, so T1/T2/T3 exist.
3. Let the session end, so `agent.session_end` carries `turns_emitted`.

---

## Gate commands

```bash
npm test                      # unit — includes the new derivation suite
npm run typecheck
npm run verify:architecture
npm run verify:specs
npm run build
npm run e2e                   # timeline journey
```

`npm run verify:specs` also enforces the constitution's artifact rules, so it
fails while `verification.md` is missing or the status value is unknown.

---

## Scenario 1 — The derivation, without a DOM (spec US1, US2; SC-006)

The primary validation. Runs with no Electron, no database, no app.

```bash
npx vitest run test/agent-session-fold.test.ts
```

**Expected**: every edge case from spec §Edge Cases has a named case, and the
four validation rules from [data-model.md](./data-model.md#validation-rules)
hold. Specifically:

- a `compact_summary` between two tool calls does **not** open a turn;
- a `tool_result` carrying role `user` does **not** open a turn;
- actions before the first `user_message` land in the unattributed turn, not
  in T1;
- two agents sharing a bare `session_id` produce two folds, not one;
- a session with `hasMore: true` at the window edge reports `atLeast`, never
  `exact`;
- a failed count resolves to `unknown`, never to `0`.

See the guarantees table in
[contracts/session-fold.md](./contracts/session-fold.md#guarantees) for what
each assertion is defending.

---

## Scenario 2 — The event log reads in order (spec US1)

```bash
npm run dev
```

Open the engagement from Prerequisites and look at the event log beneath the
track.

**Expected**: one row for the agent session, and every manually issued command
visible without scrolling past agent rows. No `tool_call`, `tool_result`,
`assistant_message` or `thinking` row from inside that session appears in the
log. The row names the agent, quotes the first prompt, and states the turn and
action counts.

**Fails if**: the log still shows per-message agent rows, or the session row
shows a bare number while earlier events remain unloaded.

---

## Scenario 3 — A prompt's actions are reachable (spec US2)

From Scenario 2, activate the session row, then expand T2 in the detail panel.

**Expected**: three turns in time order, each titled with the operator's prompt
**verbatim** — compare against the text actually typed, character for
character. Expanding a turn lists its actions with timestamps; activating an
action opens that event's own detail.

**Fails if**: a prompt is truncated in the data rather than in the display,
reworded, or translated.

---

## Scenario 4 — The track shows one object per session (spec US3; SC-003)

With the same engagement open, zoom the track in and out across its full range.

**Expected**: the `agent` lane draws one band per session at every zoom level.
The band's span matches the session's first and last event. A still-running
session extends to the live edge and is visually distinct from a closed one.

**Fails if**: the band splits into multiple objects at any zoom step — that is
`bucketByPixel` still being applied to the agent lane (R-005).

---

## Scenario 5 — A fold never hides an exception (spec US4; SC-004, SC-005)

Needs a session containing at least one out-of-scope request. Either run one
against an out-of-scope host, or add a scope rule that puts an existing
recorded target out of scope.

1. Note the status bar's out-of-scope count.
2. Confirm the session row carries the out-of-scope marking, even though most
   of its members are in scope (FR-019: most severe member state wins).
3. Apply the out-of-scope filter and confirm the offending event is reachable.
4. Export the engagement.

**Expected**: the count in step 1 matches the count computed directly from the
events; the marking in step 2 is present; the event in step 3 is reachable in
no more steps than an out-of-scope event outside a session; the export in step
4 resolves the same event selection and manifest as one taken with the fold
derivation bypassed.

> There is no folding toggle to compare against (FR-020). The "bypassed"
> comparison in step 4 is an implementation-level assertion, so it belongs in
> the test suite rather than in this manual pass:
>
> ```bash
> npx vitest run test/agent-session-fold.test.ts -t "selection unchanged"
> ```

**Fails if**: any count changes, or the marking is absent from the row. Either
is a Constitution I/II defect, not a display preference — stop and fix before
continuing.

---

## Scenario 6 — Degraded records say so (spec FR-014; R-004)

Hard to produce on demand; validate from a fixture instead.

```bash
npx vitest run test/agent-session-fold.test.ts -t "incomplete"
```

**Expected**: a session whose members include
`transcript_parent_missing`, `transcript_tool_gap` or
`transcript_schema_drift` reports `recordIntegrity.complete === false` with
the reason, and this stays distinct from `loadState: 'edge'` and from
`running: true`. Three different problems, three different signals.

---

## What does not need validating

Capture, chain, persistence, search and export are untouched by this feature.
If a change to any of them appears necessary during implementation, the design
has drifted from spec FR-001 — revisit the plan rather than widening the
change.
