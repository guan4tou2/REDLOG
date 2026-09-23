# Feature Specification: Settings Search, Type Names, Clock Meaning

**Feature Branch**: `feat/settings-field-search`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Three places where the app speaks in its own terms instead of the operator's: Settings search only knew page names, the filter bar named types by storage name, and the status-bar clock did not say what it counts.

## Clarifications

### Session 2026-09-23

- Q: What does Settings search match? → A: the text each page renders —
  group titles, field labels and hints — in the displayed language; page names
  still filter the page list.
- Q: How is the index kept current? → A: generated from each page's source
  (`npm run gen:settings-search`); a test fails when a page renders a key the
  index lacks.
- Q: What names do types get? → A: the Timeline's lane names, from one shared
  table; a plugin type with no lane keeps its stored name; the stored name is
  the tooltip.
- Q: Should the clock count this session instead? → A: No. It runs from the
  project's creation on purpose (audit P1 #33: reopening the app reset a
  session clock mid-engagement). It now says so.
- Q: The box was relabelled "Filter categories…" in #143. → A: it searches
  settings again, so it is "Search settings…" again; a test ties the label to
  the search being wired.

## User Scenarios & Testing

### User Story 1 - Find a setting by what it is called (Priority: P1)

**Independent Test**: Typing "loot detection" lists the Loot detection group;
choosing it opens Capture control with the group on screen.

### User Story 2 - Filter by a type's name (Priority: P2)

**Independent Test**: The type picker and chip say "HTTP", not
`http_navigation`; the stored name is the tooltip.

### User Story 3 - Know what the clock counts (Priority: P2)

**Independent Test**: The status-bar clock's tooltip says it runs from the
project's creation date, not this session.

### Edge Cases

- A query matching nothing says "No setting matches …".
- A result whose text is truncated keeps its full text in a tooltip.

## Requirements

- **FR-001**: Settings search MUST match rendered setting text per page and
  open the page of a chosen result, bringing the text into view.
- **FR-002**: The search index MUST fail a test when it falls behind a page.
- **FR-003**: Type names in the filter bar MUST come from the Timeline's lane
  name table.
- **FR-004**: The clock MUST state that it counts from project creation.

## Success Criteria

- **SC-001**: `settings-search`, `agent-type-label`, the new renderer-smoke
  cases and `settings-ia` pass.
