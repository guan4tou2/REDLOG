# Feature Specification: Timeline on the Shared Filter

**Feature Branch**: `spec/033-timeline-shared-filter`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Timeline on the shared filter: the Timeline answers the same filter as every other event view. Today the FilterBar's Type and Time controls are shown above the Timeline but the Timeline ignores them; the Timeline's `/` filter parses its own syntax instead of going through the Spec 026 query contract (parseQuery → executeEventQuery); "target" means different things in the Timeline, the FilterBar and the Targets view; the tier (chained/logged, auditor view) is a Timeline-only toggle rather than part of the shared filter; and the Timeline reads a time zone (engagement.timezone) that nothing else uses, so its times can disagree with the other views. One filter, one target definition, one query path, one time zone."

The FilterBar sits above Search, the Transcript, HTTP History, Loot and the
Timeline, and its chips read the same on all five. Every view but the Timeline
evaluates them where the events are stored, over the whole project
([SPEC-search-query-semantics](../../docs/domain/SPEC-search-query-semantics.md)).
The Timeline does not:

1. **It ignores Type and Time.** With `Type: shell` or `Time: last 1h` lit, the
   Timeline draws every type and every hour, with no notice. HTTP History and
   the Transcript say when they cannot honour a chip; the Timeline says nothing.
2. **It filters only what it has loaded.** It reads the newest 200 events and
   pages back 200 at a time as the operator scrolls. Target, in-scope,
   personal-traffic and `/` apply to those rows alone, so a match older than
   the loaded range is not found, and nothing says the answer is partial
   ([INVENTORY-query-completeness](../../docs/domain/INVENTORY-query-completeness.md)
   §1, Constitution IV).
3. **Its `/` text means something else.** It is a substring match over ten
   fields of the loaded rows. The same text in Search is parsed by the query
   contract and matched as phrases over all stored content. `10.0.0.5` also
   lights up `10.0.0.50` in the Timeline, and not in Search.
4. **Its target is not the Target.** Target identity is the recorded target
   ([SPEC-target-identity](../../docs/domain/SPEC-target-identity.md)). The
   Timeline's target focus, reached from the Targets page, matches any of seven
   fields, including `host` and `remote_addr`. The Targets page counts one set
   of events and the Timeline shows another.
5. **The tier is a Timeline-only switch.** The auditor view (chained evidence
   only) hides logged rows after loading them, and exists nowhere else, so
   Search and the Transcript cannot ask the same question.
6. **Its clock is its own.** The Timeline offers Local, UTC and "Project"
   times. Every other view prints local time. "Project" reads a time zone that
   nothing lets you set, so it is always local time under another name.

## Clarifications

### Session 2026-09-24

- Q: When the shared filter or the `/` text is set, what happens to events
  that do not match? → A: The shared filter removes them, as in every other
  view. The `/` text dims them, as today, so a match keeps its context. The
  query layer decides both over the whole project.
- Q: Where does "chained only" live? → A: In the shared filter, as an
  "All tiers / Chained only" condition that every event view applies. The
  Timeline's auditor switch moves there, so no control is added. A view that
  cannot honour it says so.
- Q: Which display zones exist? → A: One app-wide setting in
  Settings ▸ General, Local or UTC. Every view, the event detail and the
  FilterBar time chip use it. The "Project" option is dropped. Exports stay
  ISO 8601.
- Q: When the `/` text matches events older than what the Timeline has drawn,
  how does the operator reach them? → A: The Timeline says how many earlier
  matches there are. Clicking that notice loads back to the nearest one. No
  toolbar button is added.
- Q: Does "chained only" survive reopening the project? → A: No. Like the other
  shared-filter conditions, it starts at "All tiers" each time a project
  opens. The Timeline's per-project auditor setting is not carried over.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The shared filter means the same on the Timeline (Priority: P1)

As an operator narrowing an investigation with the FilterBar, I need the
Timeline to answer the chips I set, over the whole project, as the other views
do. Then switching views does not quietly widen or change the question.

**Why this priority**: a lit chip that the view ignores is a false answer.
Screenshots and exports taken from the Timeline currently show events the
operator believes are filtered out.

**Independent Test**: seed events of two types across three hours, with the
newest 200 all of one type. Set `Type` to the other type and `Time` to the
oldest hour. The Timeline shows exactly the events the project holds for
those chips, housekeeping rows excepted, including those older than the first
200 loaded.

**Acceptance Scenarios**:

1. **Given** `Type: dns` is set, **When** the operator opens the Timeline,
   **Then** it shows only DNS events, and its count is the number of DNS
   events the project holds.
2. **Given** `Time: last 1h` is set, **When** the Timeline opens, **Then** it
   shows only events inside that hour.
3. **Given** a target, in-scope and personal-traffic filter, **When** matching
   events exist only older than the newest 200, **Then** the Timeline shows
   them without the operator scrolling back to load them first.
4. **Given** any shared filter is set, **When** events outside it exist, **Then**
   the Timeline does not draw them, just as the other views do not list them.
5. **Given** the Timeline shows only part of the matches (the operator has not
   paged back to all of them), **When** the operator reads the view, **Then** it
   says so and shows how to reach the rest (Constitution II, IV).

---

### User Story 2 - One target, whichever page it is picked from (Priority: P1)

As an operator moving from the Targets page to the Timeline, I need the target
I picked to select the same events the Targets page counted.

**Why this priority**: target identity is a domain invariant. A mismatch
between the count on one page and the events on the next makes both look
wrong.

**Independent Test**: record events for `10.0.0.5` with the recorded target
set, and events whose only mention of it is a `host` or `remote_addr` field.
The Targets page's count for `10.0.0.5`, the Timeline's count after "Open in
Timeline", and the FilterBar target chip's result agree.

**Acceptance Scenarios**:

1. **Given** the Targets page lists `10.0.0.5` with N events, **When** the
   operator opens it in the Timeline, **Then** the Timeline shows those N
   events and says it is narrowed to that target.
2. **Given** a target arrives from the Targets page, **When** the operator looks
   at the FilterBar, **Then** the target chip shows it and clears it. There is
   one target control, not a second focus beside the chip.
3. **Given** `10.0.0.5` is the target, **When** events for `10.0.0.50` exist,
   **Then** they are not included.

---

### User Story 3 - `/` in the Timeline means what it means in Search (Priority: P2)

As an operator typing into the Timeline's filter box, I need the text read the
way Search reads it, so the Timeline and Search agree on what matches.

**Why this priority**: "one query text means one thing wherever it is typed"
is the query contract's invariant, and the Timeline is the last surface that
reads text another way.

**Independent Test**: for a set of inputs (a plain word, an IP address,
`session:S1`, a quoted phrase, an unterminated quote), the Timeline and Search
select the same events, and the Timeline shows which tokens it read as
conditions and which as text.

**Acceptance Scenarios**:

1. **Given** the text `10.0.0.5`, **When** it is typed in the Timeline, **Then**
   events that mention only `10.0.0.50` do not match.
2. **Given** text is typed, **When** the Timeline draws, **Then** the events
   Search would return for that text and the same shared filter are the
   matches, and every other event the shared filter admits stays drawn,
   dimmed.
3. **Given** `session:S1`, **When** it is typed, **Then** it is read as a
   condition and matches that agent session's events, as in Search.
4. **Given** unparsable input (an unterminated quote, `session:` with no
   value), **When** it is typed, **Then** the Timeline says it cannot read it,
   distinct from "no match", and draws nothing as matched.
5. **Given** matching events older than what is drawn, **When** the operator
   types the text, **Then** the Timeline says how many earlier matches there
   are. Clicking that notice loads back to the nearest one and selects it.
6. **Given** the operator picks an operator or a host in ⌘K, **When** the
   Timeline opens on it, **Then** it shows that operator's events, or the events
   that host's name matches in Search, not a substring guess.
7. **Given** a failed query, **When** the Timeline evaluates the text, **Then**
   it shows a failure with retry, never an empty or unfiltered view
   (Constitution VI).

---

### User Story 4 - The tier is part of the filter (Priority: P2)

As an auditor reviewing only chained evidence, I need "chained only" to be a
condition of the investigation that the query applies. It should not be a
Timeline-only display switch that hides rows after loading them.

**Why this priority**: the auditor view answers a provenance question. Today
it can only be asked on one page, and its count covers only the loaded rows.

**Independent Test**: with chained and logged events interleaved, and more
than one page of each, "chained only" yields the chained events, complete and
paged. It is visible as an applied condition wherever it applies.

**Acceptance Scenarios**:

1. **Given** "chained only" is on, **When** the Timeline opens, **Then** logged
   events are absent from the view and from its counts, across the whole project.
2. **Given** "chained only" is on, **When** the operator changes view, **Then**
   Search, the Transcript and Loot apply it too, and the FilterBar shows it as
   a chip on each.
3. **Given** "chained only" is on, **When** the operator opens HTTP History,
   whose flows are all recorded in the logged tier, **Then** it says that the
   condition leaves it nothing to show. It does not show an unexplained empty
   list, and it does not ignore the chip.
4. **Given** the Timeline's auditor switch, **When** this feature ships, **Then**
   the switch is this shared condition. There is no second control.
5. **Given** "chained only" was on, **When** the project is closed and opened
   again, **Then** every view starts at "All tiers", as it does for the other
   shared-filter conditions.

---

### User Story 5 - One clock across the app (Priority: P3)

As an operator comparing a Timeline event with the same event in Search or
the Transcript, I need both to print the same time.

**Why this priority**: two views printing different wall times for one event
undermines the record. It matters most in screenshots and write-ups.

**Independent Test**: set the display zone, then read one event's time in the
Timeline, the event detail, Search, the Transcript and a FilterBar time chip.
All five agree.

**Acceptance Scenarios**:

1. **Given** the display zone is set, **When** any view prints an event time,
   **Then** it uses that zone. A UTC time carries its `Z`, so it is never read
   as local. A local time stays unmarked, as it is today.
2. **Given** the Timeline's zone choice, **When** this feature ships, **Then**
   it becomes one setting in Settings ▸ General, Local or UTC, that every view
   uses. An operator who chose UTC on the Timeline keeps UTC.
3. **Given** the Timeline offered "Project", **When** the setting moves,
   **Then** "Project" is not offered. Nothing can set a project zone, so it was
   local time under another name (Constitution II).

---

### Edge Cases

- A filter that matches nothing: the Timeline shows an empty state that names
  the filter responsible, distinct from an empty project and from a failed
  query.
- A filter change while older pages are still loading: results for the old
  filter never appear under the new one.
- A live event arriving while a filter is set: it appears only if it satisfies
  the filter, and counts update without a reload.
- Housekeeping rows (RedLog talking to itself) stay excluded, as they are today,
  and are not counted as matches.
- Folded displays (a command start folded into its end, agent turns collapsed,
  a marker folded with its amendments) do not change what matches. A marker
  whose amended title matches is found as that marker.
- Target case: `Example.COM` and `example.com` are one target on the Targets
  page. Picking it selects both spellings.
- An event opened in the Timeline from another view, or selected before a
  filter change: if it is older than what is drawn, the Timeline loads back to
  it. If the shared filter excludes it, the Timeline says so and clears the
  selection. It is never silently shown as if it matched, and never silently
  missing.
- The Timeline's own display choices (lane visibility, session dividers, zoom,
  follow mode) are not filters, and do not change counts or matches.
- The Timeline's "Visible time range" export: export selection is unchanged
  and exports every event in that range
  ([SPEC-export-event-selection](../../docs/domain/SPEC-export-event-selection.md)).
  While a shared filter hides events on the Timeline, the export's label says
  the filter is not applied, so the export is never read as "what I see".

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Timeline MUST apply every shared-filter condition the other
  event views apply (target, type, time range, in-scope only, personal traffic)
  over the whole project, with the same meaning.
- **FR-002**: Shared-filter conditions MUST be evaluated before any page limit,
  so no matching event is missed because it is older than what is loaded.
- **FR-003**: When the Timeline draws only part of the matching events, it
  MUST say so and give the total or a way to reach the rest.
- **FR-004**: Events outside the shared filter MUST NOT be drawn on the
  Timeline, as the other views do not list them. Text in the Timeline's filter
  box MUST NOT remove events. The events the shared filter admits but the text
  does not match stay drawn, dimmed, so a match keeps its context. The query
  layer decides the matches, over the whole project. The Timeline's counts MUST
  describe the events the shared filter admits and, when text is set, how many
  of them match. When text matches events older than the drawn range, the
  Timeline MUST say how many. That notice MUST load back to the nearest earlier
  match when clicked. No other control is added for it.
- **FR-005**: The Timeline's target MUST be the canonical target identity
  ([SPEC-target-identity](../../docs/domain/SPEC-target-identity.md)). Arriving
  from the Targets page MUST set the shared target, so the Targets page count,
  the Timeline and the FilterBar chip agree.
- **FR-006**: There MUST be one target control on the Timeline: the shared
  target chip. The separate target focus MUST go.
- **FR-007**: Text typed in the Timeline's filter box MUST be parsed and
  evaluated by the query contract, with the same conditions, text matching,
  parse failures and token display as Search
  ([SPEC-search-query-semantics](../../docs/domain/SPEC-search-query-semantics.md)).
- **FR-008**: An empty filter box MUST mean "no text condition": the Timeline
  shows every event the shared filter admits. This differs from Search, where
  an empty query answers nothing, and the domain contract MUST record the
  difference.
- **FR-009**: An operator or host picked in ⌘K MUST land on the Timeline
  narrowed by the query contract's meaning of that operator or host. It MUST NOT
  be a substring match.
- **FR-010**: A query failure MUST show as a failure with retry. An unparsable
  input MUST show as unparsable. Neither may show as no match or as the
  unfiltered view.
- **FR-011**: The tier MUST be a shared-filter condition, "All tiers" or
  "Chained only". Every event view MUST apply it (Search, the Transcript, HTTP
  History, Loot and the Timeline), by the query over the whole project, and the
  FilterBar MUST show it as a chip. The Timeline's auditor switch MUST become
  this condition and MUST NOT remain as a second control. Like the other
  shared-filter conditions, it MUST start at "All tiers" each time a project
  opens, and a stored Timeline auditor setting MUST NOT narrow a view.
- **FR-012**: A view that cannot honour a shared condition MUST say so where
  the condition is shown, as HTTP History and the Transcript do today.
- **FR-013**: Every view MUST print event times in one display zone, chosen
  once in Settings ▸ General as Local or UTC. This covers the Timeline, the
  event detail and the FilterBar time chip. A time printed in UTC MUST carry
  its zone marker, so it is never read as local. The Timeline MUST NOT keep a
  zone setting of its own, and an operator's existing Timeline choice of UTC
  MUST carry over.
- **FR-014**: The "Project" zone MUST NOT be offered. Nothing can set a project
  zone, so it can never differ from Local.
- **FR-015**: Display folding (command pairs, agent turns, marker amendments)
  and the Timeline's layout controls MUST NOT change which events match or how
  many.
- **FR-016**: While a shared filter is set, the Timeline's time-range export
  MUST say that it does not apply the filter. Export selection itself is
  unchanged.

### Key Entities *(include if feature involves data)*

- **Shared filter**: the conditions the FilterBar sets and every event view
  answers: target, type, time range, in-scope only, personal traffic and tier.
  Defined by the query contract, not by any one view.
- **Timeline query text**: what the operator types in the Timeline's box, read
  as conditions and text by the query contract, and combined with the shared
  filter.
- **Target**: the canonical target identity, the recorded target of an event.
  Observations such as `host` or `remote_addr` are not the Target.
- **Display zone**: the one time zone every view prints event times in, Local
  or UTC.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any combination of shared-filter conditions, the events the
  Timeline draws once paged back to the start are exactly the events the project
  holds for that filter, housekeeping rows excepted. Checked over a fixture of
  at least 1,000 events spanning more than five pages. (Search cannot be the
  reference: a query with no text answers nothing.)
- **SC-002**: For every target on the Targets page, the Targets count, the
  Timeline count after "Open in Timeline", and the FilterBar-chip count are
  equal.
- **SC-003**: For the query contract's scenario inputs, the Timeline and
  Search select the same events. This includes conditions, quoted phrases,
  IP addresses and the two parse failures.
- **SC-004**: No shared-filter chip is lit on the Timeline without being
  applied or disclosed as unapplied. This is checked for every chip.
- **SC-005**: One event's time is printed identically in every view that shows
  it.
- **SC-006**: Applying or changing a filter on a project of 100,000 events
  updates the Timeline within 2 seconds, with the operator told while it loads.
- **SC-007**: With "chained only" set, no event view lists a logged event, and
  each view's count equals the chained-tier count for the same filter.

## Assumptions

- The FilterBar keeps its controls and the views that show it, and gains the
  tier condition moved from the Timeline. Otherwise this feature changes what
  the Timeline does with the filter, not the FilterBar.
- Lane visibility, session dividers, zoom, follow mode, agent-turn collapse and
  the anomaly and causal-chain highlights stay Timeline display controls. They
  are not shared-filter conditions.
- "Picked from ⌘K" covers the operator and host picks that set the Timeline's
  filter box today. An operator match is by recorded operator. The query
  contract has no operator condition yet, so this feature adds one to the
  contract, and the domain document says so.
- Housekeeping rows stay excluded from the Timeline as today.
- The display zone is a per-machine viewing preference, not project evidence.
  Exports stay ISO 8601 with the offset, whatever the display zone.
- Depends on the query contract (Specs 017, 018, 026) and target identity as
  documented. Both domain documents are updated where this feature changes
  them: the Timeline joins the surfaces the query contract lists, FR-008's empty
  text rule, and the operator condition.
