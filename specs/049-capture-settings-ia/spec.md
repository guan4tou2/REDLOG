# Feature Specification: Capture Settings Information Architecture

**Feature Branch**: `049-capture-settings-ia`

**Created**: 2026-10-01

**Status**: Draft

**Input**: The Capture sources group is incoherent. One of its four pages is
titled "Capture packs, screenshots and retention" — three unrelated subjects
joined by commas — and it carries 61 of the settings search index's entries
while most pages carry a dozen. This feature re-parents what is already there.
It adds no setting, removes no setting, and changes no capture behaviour.

## Background

Settings has three groups down the left (`Settings.tsx`, `groups`). The first,
**Capture sources** (`settings.groupCapture`), has four pages:

| Page id | Label | What it actually holds |
| --- | --- | --- |
| `hooks` | Commands and terminals | `HooksPanel`, `ManualStepList`, `WslPanel`, `HookWatchPathsPanel` |
| `browser` | Browser and HTTP capture | `BrowserPage`, `BrowserPanel` |
| `captureControl` | **Capture packs, screenshots and retention** | essential list · 3 packs · external capture · loot rules · screenshots · retention |
| `agents` | AI agent transcripts | `AgentsPanel` |

`captureControl` is the problem, and `agents` is the second half of it.

### The seven defects

**D1 — Retention is deletion, filed under capture.** `settings.retentionGroup`
sets size budgets for the HTTP body, cast and screenshot stores and the age at
which logged-tier rows are dropped. Nothing about it answers "what is being
recorded"; it answers "what stops being kept". It is the last group on a page
inside a group named *Capture sources*.

**D2 — One flag, two switches, two pages.** `packs.aiAgents` is written by
`CaptureControlPage.tsx:98` (as a `CapturePackGroup`) and again by
`AgentsPanel.tsx:24` (as a bare checkbox). They are the same boolean, so they
move together, but an operator who ticks the box on one page then finds an
identical unticked-looking control on the other has no way to know that.

**D3 — The three packs get three different treatments.** `aiAgents` has a pack
block *and* a page of its own. `hostMonitors` has four members, each with its
own switch and tuning, all stacked inside `captureControl`. `windowsOutput` is
a single line with no members shown. The pack model says these are three
instances of one concept; the interface says they are three unrelated things.

**D4 — Loot detection is not a capture source.** `LootRulesGroup` switches
secret-pattern rules on and off. A rule that is off still matches for masking
(`settings.lootHint`) — this is classification of what was already recorded,
not a decision about what to record.

**D5 — Screenshots are a capture source but not a pack.** Interval, JPEG
quality, diff threshold and capture-on-command sit in a bare `FieldGroup` at
the bottom of `captureControl`, outside the pack model that every other
optional source goes through.

**D6 — External capture is a read-out filed among switches.**
`ExternalCaptureGroup` reads what is actually feeding the record from the
events themselves and prints the commands the operator must run; it has no
switch by design. Its own header comment admits the placement is argued from
the operator's question rather than from what it is: "it sits here rather than
on the Plugins page because the question it answers … is this page's question".

It is also machine-level while everything around it is engagement-level — but
that is **not** this feature's problem to solve, and an earlier draft of this
spec got that wrong. Giving one machine-level block its own page hides a split
that runs through four pages (hook watch paths, plugin enablement, operator
identity, HUD position are all machine-level too). Scope is an axis, not a
category; spec 051 carries it. Here, external capture earns a page of its own
for the reason above: it has no switch, only state and instructions.

**D7 — The first screen is a static list.** `settings.essentialGroup` is four
`<li>` elements naming what every project records. No control, no state, no
link — and it is the first thing on the page.

### What constrains the fix

- `test/settings-ia.test.ts` holds a hard-coded `PAGES` list, requires every
  page to be in the union, to be routed, and to be listed in the sidebar.
- The same test forbids a heading over fewer than two pages.
- The same test caps `<FieldGroup title=` across `Settings.tsx` and
  `settings/*.tsx` at **29**. There are **27** today. A redesign that splits
  pages therefore has two groups of slack and must re-parent rather than add.
- `settingsSearchIndex.ts` is **generated** (`npm run gen:settings-search`)
  from `PAGE_SOURCES` in `scripts/settings-search-sources.mjs`.
  `test/settings-search.test.ts` fails if the committed index and the
  generator disagree, so the source map is the thing to edit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A page title names one subject (Priority: P1)

An operator opening Settings to change how often screenshots are taken reads
the sidebar and goes to one page. They do not read a title with three nouns in
it and guess which of the three their question belongs to.

**Why this priority**: This is the reported complaint. A title joined by commas
is the interface admitting it does not know what the page is for, and every
visit pays for that.

**Independent Test**: No page label in the Capture sources group contains a
list separator ("、", ",", " and ", " & ").

**Acceptance Scenarios**:

1. **Given** the Capture sources group, **When** its page labels are read,
   **Then** each names a single capture source or a single subject.
2. **Given** a search for a screenshot setting, **When** the result is opened,
   **Then** it lands on a page whose label the operator could have predicted.

### User Story 2 - One switch per decision (Priority: P1)

An operator turning agent transcript capture on finds exactly one control that
does it, and every setting that tunes it is beneath that control.

**Why this priority**: Two controls over one boolean is not a layout problem.
An operator who ticks one and sees the other cannot tell whether capture is on,
and "is anything actually recording" is the question this whole group exists to
answer.

**Independent Test**: Grep the settings directory for writes to
`packs.aiAgents`; exactly one component writes it.

**Acceptance Scenarios**:

1. **Given** the settings source, **When** `packs.aiAgents` assignments are
   counted, **Then** there is one.
2. **Given** the AI agents page, **When** it is rendered with the pack off,
   **Then** the pack switch, the thinking switch, the watch-path list and the
   self-exclusion note are all on it.
3. **Given** the same page with the pack off, **When** the member controls are
   inspected, **Then** they are disabled rather than hidden, as today.

### User Story 3 - What is recorded and what is discarded are different questions (Priority: P2)

An operator looking for retention budgets does not find them under Capture
sources, and an operator auditing what the engagement records is not shown a
deletion policy in the middle of it.

**Why this priority**: Lower than the two above because it misleads rather than
blocks — but it misleads about evidence destruction, which is the worst subject
to be casual about.

**Independent Test**: Retention and loot-rule keys resolve to a page outside the
Capture sources group.

**Acceptance Scenarios**:

1. **Given** a search for a retention setting, **When** the hit is opened,
   **Then** it is on a page under Scope and evidence.
2. **Given** a search for a loot rule, **When** the hit is opened, **Then** it
   is on a page under Scope and evidence.

### Edge Cases

- A pack whose plugin is not active still renders its page; the switch is
  unavailable with the existing reason, not missing. (`usePackAvailability`)
- `packMembers` absent means on (`config.ts`). Re-parenting members to a new
  page must not write a `packMembers` key that was previously absent, or every
  existing project gains an explicit value it did not have.
- Settings search deep-links by page id (`lib/navigation.ts`,
  `settingsTarget`). A renamed page id breaks saved links and the
  `StatusBar` issue → settings jump.
- The onboarding and capture-wizard flows (specs 037, 047) point at capture
  pages. Any page id they name must keep resolving.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Capture sources group MUST contain only pages that answer
  "what is being recorded". Retention and loot detection MUST move to the Scope
  and evidence group.
- **FR-002**: Exactly one component MUST write `packs.aiAgents`. The AI agents
  page MUST hold that switch together with every setting that tunes it.
- **FR-003**: Each optional capture source MUST be reachable as one row of the
  capture-sources list, with its switch and its tuning on that row — not as a
  sidebar entry of its own. *(Part B.)*
- **FR-004**: No page label in the Capture sources group may name more than one
  subject.
- **FR-005**: The static "essential capture" list MUST be removed. The same
  four sources already appear in the capture inventory with live state; a
  fourth copy as four nouns with no control MUST NOT occupy the first screen.
- **FR-006**: The total `<FieldGroup title=` count MUST NOT increase. Groups are
  re-parented, not added.
- **FR-007**: `scripts/settings-search-sources.mjs` MUST be updated and
  `settingsSearchIndex.ts` regenerated, not hand-edited.
- **FR-008**: No capture behaviour, config key, default, or stored value may
  change. This is a re-parenting of existing controls.
- **FR-009**: Every existing page id that onboarding, the capture wizard,
  `lib/navigation.ts` or an issue link resolves MUST keep resolving.

### Target structure

The sidebar is **not** one entry per capture source. OBS lists every source as a
row in one Sources dock; Elastic Fleet lists every integration in one list; VS
Code lists extensions and filters them with `@ext:`. None of them spends a tree
node per instance of the same kind of thing. Burp does give Proxy, Intruder and
Repeater their own nodes — but those are tools, not N instances of one concept,
and an earlier draft of this spec copied the wrong half of Burp.

```
Capture sources
  Capture sources      the source list (see below)
  Commands and terminals   hook install · manual steps · WSL
  Browser and HTTP         launch browser · proxy start/stop · CDP port

Scope and evidence
  Scope rules
  IP exposure and own traffic
  Loot detection       ← moved from capture
  Retention and cleanup ← moved from capture
  Chain verification
```

The two that keep their own page are the two that are **operations, not
switches**: hooks are installed into a shell rc with manual steps and a WSL
path; the browser launches a process and starts a proxy. Neither fits a row.

#### The source list already exists

`CaptureHealth.tsx` renders it. Its "All sources (N)" control
(`capture.manageWithHidden`) expands to every source — including the ones that
are off, not installed, or plugin-contributed — each with its state, its last
event, and **turn on / turn off** and **install / uninstall** buttons that write
`packs.*` and `packMembers.*` through the row's own `configPath`.

So the capture settings page is not merely disorganised: it is a **second
interface over the same config paths**, and that is the actual root of D3, D5,
D6 and D7. The fix is to extract that inventory into a shared component and let
the settings page be it, not to rebuild a list beside it.

That extraction is **not done in this feature**. `CaptureHealth.tsx` is under
active refactor in a parallel session, and moving its largest block out from
under that is the one change most likely to be lost. This spec therefore ships
in two parts:

- **Part A (this change)** — everything that does not touch
  `CaptureHealth.tsx`: retention and loot leave the capture group, the static
  essential list is deleted, the duplicate `packs.aiAgents` switch is removed
  and the AI agents page folds into capture sources, and the page is renamed
  for what is left on it.
- **Part B** — extract the inventory from `CaptureHealth.tsx` into a shared
  source list and render it as the capture-sources page. Screenshots, the three
  packs and the external captures all become rows there, and D5/D6/D7 close.

`captureControl` keeps its page id through both parts, so every saved deep link
into it keeps resolving (FR-009).

### Key Entities

None. No stored shape changes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `captureControl` carries 50 settings search index entries after
  Part A (61 before), and no more than 20 after Part B.

  Measured, not aspirational, and worth recording honestly: `hooks` carries 51.
  Entry count was never the diagnosis — the three-subject title was, and a page
  that installs hooks for four shells is legitimately long. Part A removes six
  essential-list entries, moves nine to Loot and Retention, and absorbs seven
  from the folded AI agents page.
- **SC-002**: `packs.aiAgents` is written in exactly one place.
- **SC-003**: The `<FieldGroup title=` count is ≤ 27 after the change — the
  count before it, not the 29 cap.
- **SC-004**: `npm run gen:settings-search` produces no diff against the
  committed index.
- **SC-005**: Every page id reachable before the change still resolves to a
  page after it.

## Assumptions

- Splitting `captureControl` into four entries is acceptable sidebar growth.
  The Capture sources group goes from four entries to six; `settings-ia`'s only
  numeric guard is on groups, not on entries per group.
- The Scope and evidence group growing to five entries needs no sub-grouping.
- "Screen capture" is a capture source and belongs in this group even though it
  is not a pack. Bringing it into the pack model is a separate question and is
  explicitly **not** part of this feature.
- The essential-capture list is removed rather than made live. Live capture
  state already exists in `CaptureHealth` and the status bar; a third copy is
  the kind of duplication D2 is about. If it is kept, it must link to that
  state rather than restate it.

## Out of scope

- Any change to what is captured, when, or how it is stored.
- Bringing screenshots into the capture-pack model.
- Re-wording labels and hints beyond what FR-004 requires.
- The `.redlog-app-root` self-exclusion behaviour.
