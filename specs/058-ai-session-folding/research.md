# Phase 0 Research: AI Session Folding

**Feature**: 058-ai-session-folding | **Date**: 2026-09-30
**Verified against**: `559040a`

Every "NEEDS CLARIFICATION" from Technical Context is resolved below. No
research task remained open at the end of Phase 0.

---

## R-001 — What identifies a session

**Decision**: Group on **agent kind + `session_id`**, read from the event's own
`data`.

**Rationale**: `tailer-host.ts:288-293` already keys its live sessions this
way, with the comment stating why: "two adapters can produce the same bare
sessionId (e.g. Codex + Claude both name a session 'rollout-abc')". The
renderer adopting a different key would be a second implementation of session
identity, which Constitution III forbids. `docs/domain/glossary.md:31` names
this **Agent Session** and distinguishes it from **Capture Session**
(`glossary.md:32`); `SPEC-search-query-semantics.md:54` confirms `session:`
already resolves against it.

**Alternatives considered**:
- *Group by `transcript_uuid` parent chain.* Rejected: the chain answers
  "which line produced this" and breaks explicitly
  (`transcript_parent_missing`), so it is a provenance record, not a grouping
  key. A broken chain must not split a session into two.
- *Group by time proximity on the agent lane.* Rejected: this is what
  `bucketByPixel` already does and is exactly the defect in Problem 2 — two
  concurrent agents would merge into one false session.

---

## R-002 — Where a prompt turn begins

**Decision**: A turn opens at **`agent.user_message` and nothing else**.

**Rationale**: `claude-code.ts:289` maps role `user` to either
`compact_summary` or `user_message`, and lines 224/247 route `tool_result`
blocks that arrive with role `user` to `tool_result`. So the subtype already
encodes the distinction the fold needs, and reading roles instead of subtypes
would open a turn on every tool result — the most common event in a session.
`compact_summary` is a context-window artifact, not an operator instruction;
opening a turn on it would attribute the agent's subsequent actions to a
sentence the operator never wrote, breaching Constitution VII.

**Alternatives considered**:
- *Treat the first `assistant_message` of a run as the turn title.* Rejected:
  it makes the agent's words stand in for the operator's, which is precisely
  the "AI-reported behavior represented as observed" failure in Principle VII.
- *Ask capture to emit an explicit turn marker.* Rejected: spec FR-001, and
  unnecessary — the data already distinguishes the cases.

---

## R-003 — Counting over a capped surface *(the load-bearing decision)*

**Problem**: `docs/domain/INVENTORY-query-completeness.md` §1 records the
Timeline at **200 rows per page**, load-back reading 1,000 at a time.
`Timeline.tsx:556` confirms `PAGE_ROWS = 200`. At ordinary session sizes
(50–150 events) a session frequently straddles that boundary, so a count taken
over loaded members is not the session's count. Printing "47 動作" when 30 are
loaded breaches Constitution II (surface truthfulness) and IV (query
completeness) at once.

**Decision**: A session's counts are a **tri-state**, not a number:

| State | When | What the row shows |
|---|---|---|
| `exact` | Every member is loaded (the session begins and ends inside the loaded window), **or** a canonical count was fetched | The count |
| `atLeast` | `hasMore` is true and the session touches the loaded window's edge, and no count has been fetched | The count marked as a floor |
| `unknown` | A count query was attempted and failed | No number; the failure state |

**Turn count for a closed session** comes from `agent.session_end`'s
`turns_emitted` (`tailer-host.ts:1218`, surfaced today by
`eventTitle.ts:176`), which is authoritative and page-independent whenever that
event is loaded.

**Exact action counts**, when wanted, come from the existing
`window.redlog.events.count(req)` — the call `Timeline.tsx:847` already makes —
with a `session:` condition, which is canonical per
`SPEC-search-query-semantics.md`. This adds no new IPC surface.

**Rationale**: `Timeline.tsx:145` already models `total` as
`pending | ok | failed` rather than as a number defaulting to zero. The fold
follows the pattern the panel already uses for the same class of problem, so
this is consistency, not a new mechanism.

**Alternatives considered**:
- *Count loaded members and print it.* Rejected — the breach described above.
- *Always fetch an exact count per session on render.* Rejected: N queries per
  page for a number often already known, and it converts a render into an
  async cascade. The tri-state lets the common case (session fully inside the
  window) answer synchronously.
- *Refuse to fold a session that is not fully loaded.* Rejected: the log's
  shape would then depend on the scroll position, and the surface would flip
  between folded and unfolded as the operator pages back.

---

## R-004 — The four states a session can be in, kept distinct

**Decision**: Model them as independent facts, never collapsed into one
"degraded" flag (Constitution VI):

1. **Running** — no `agent.session_end` loaded. Span extends to the live edge.
2. **Record known incomplete** — a member carries
   `transcript_parent_missing`, `transcript_tool_gap` or
   `transcript_schema_drift`. The fold is over a record capture itself flagged
   as lossy.
3. **Not fully loaded** — the paging state from R-003.
4. **No prompt recorded** — the session holds no `user_message`, e.g. it was
   reached by `catchUpSession` mid-transcript.

**Rationale**: These have different causes and different operator responses.
"Still running" is normal, "record incomplete" is a capture defect worth
investigating, "not fully loaded" is a UI boundary, "no prompt" is an
attribution limit. Principle VI names exactly this class of conflation.

**Alternatives considered**: a single `isPartial` boolean — rejected; it would
make a running session look like a capture failure.

---

## R-005 — How the agent lane draws a session

**Decision**: The `agent` lane draws **one band per session** over the
session's own span, sibling to `buildSessionBands`, and its member events
**bypass `bucketByPixel`** on that lane.

**Rationale**: `timelineGeometry.ts`'s `bucketByPixel` buckets by
`floor(x / clusterPx)`, so the objects it produces change identity at every
zoom step. SC-003 requires one object per session independent of zoom, which
pixel bucketing cannot satisfy by construction. `timelineSessionBands.ts`
already solves the same shape for terminals — including the greedy
interval-colouring pass that staggers overlapping labels, which concurrent
agent sessions need for the same reason.

**Open for Phase 2**: whether an agent band renders in the same row as shell
bands or its own. Tasks decide; both satisfy the spec.

**Alternatives considered**:
- *Keep dots, colour them by session.* Rejected: `UIUX-STANDARD.md` §1 reserves
  hue for status, and `timelineDomain.ts:48-52` implements that rule with a
  single `LANE_COLOR`. Session identity may not consume hue.

---

## R-006 — How filters meet a fold

**Decision**: Filters evaluate against **member events**. A session appears if
any member matches; a session whose members all fail does not appear. The fold
is never itself the filter subject.

**Rationale**: FR-013 and spec US4. The alternative — filtering the session row
by aggregated properties — would let an out-of-scope member vanish because its
session as a whole looked in-scope, which is a correctness defect under
Constitution I, not a display preference. Scope state is read from the
canonical evaluation already on each event; the fold performs no scope
evaluation of its own (Constitution III, Invariant 4).

**Alternatives considered**: unfolding a session when a filter is active —
rejected as a second behaviour to specify and test for no gain; the session row
carrying its members' markings covers the need.

---

## R-007 — What the two surfaces share

**Decision**: One module, `lib/agentSessionFold.ts`, exporting a pure
derivation from an ordered event array to sessions and turns. The event log
maps it to rows, the track maps it to bands, the inspector maps it to groups.
No component re-derives anything.

**Rationale**: FR-015, and the precedent in the header comment of
`timelineGeometry.ts`: logic tangled with React state and closures could not be
unit-tested, which is why these seams exist at all. SC-006 requires the edge
cases to be tested without a DOM, which is only possible on this side of the
seam.

**Alternatives considered**: deriving in `Timeline.tsx` and passing results
down — rejected; it reproduces the condition those seams were cut to fix.

---

## Resolved unknowns

| Unknown from Technical Context | Resolution |
|---|---|
| Does capture need to change? | No — R-001, R-002. Every field required is stored today. |
| Is a page-local fold truthful? | No — R-003 is the design that makes it so. |
| Can the agent lane reuse dot clustering? | No — R-005. |
| Is there an existing domain term for a fold? | Yes — **Activity**, `glossary.md:12`. No new term introduced. |
| Does this feature change a domain invariant? | No. No domain-document update task needed. |
