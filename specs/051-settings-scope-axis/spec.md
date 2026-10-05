# Feature Specification: Settings Scope Axis

**Feature Branch**: `051-settings-scope-axis`

**Created**: 2026-10-01

**Status**: Draft

**Input**: Settings mixes machine-level and engagement-level values with nothing
marking which is which. An operator handing a project to a verifier cannot tell
what travels with it. Burp and VS Code both make scope a first-class axis of the
settings interface; RedLog has the same split and hides it.

Companion to spec 049 (capture settings information architecture), which
re-parents the Capture sources group. 049 is one axis — subject. This is the
other — scope. They are independent: either can land first.

## Background

RedLog already stores settings at two levels, and nothing in the interface says
so.

| Level | Where | What lives there |
| --- | --- | --- |
| Engagement | `<project>/config.yaml` | packs · packMembers · screenshot · retention · loot · scope · agentTailer |
| Machine | `~/.redlog/hook-config.json` | hook watch paths |
| Machine | `~/.redlog/plugins/state.json` | plugin enablement |
| Machine | `~/.redlog/active-identity.json` | operator identity |
| Machine | `~/.redlog/overlay-position.json` | HUD position |

They are interleaved across pages. The Commands and terminals page renders
`HookWatchPathsPanel` — machine-level — directly beneath project-level hook
settings. Nothing distinguishes them.

**No setting exists at both levels.** There is no override layer today; each
setting has exactly one home.

### Why this matters here more than in a text editor

A project is handed over. "Which of these settings travel with the evidence"
is not a convenience question for RedLog — a verifier reading a handed-over
project sees the capture configuration that produced it, and the operator has
no way to know which parts of what they configured are in that picture.

### Prior art

- **Burp Suite** (reorganised 2022 after UX research): a category tree plus
  **All / User / Project** filter buttons over one list, and a per-setting
  "Override options for this project only" toggle. Project settings live in the
  project file; user settings apply to every project on the machine.
- **VS Code**: **User / Workspace** as *tabs*, not filters — the active tab is
  where a change is written. A "modified elsewhere" indicator marks a setting
  overridden in another scope. `@modified` filters to settings that depart from
  their default; `@haspolicy` marks settings an administrator has locked. A
  per-setting gear menu resets to default and copies the setting id.

Tabs beat filters for RedLog for the same reason they beat them for VS Code:
with a filter, the operator must still work out where their change will be
written. With a tab, the question is answered before they touch anything.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know what travels with the project (Priority: P1)

An operator finishing an engagement checks what the verifier will see. Every
setting is marked as belonging to this engagement or to this machine, and the
two are not interleaved.

**Why this priority**: This is the whole feature. Everything below is a
refinement of it.

**Independent Test**: Render Settings; every rendered setting resolves to
exactly one scope, and no page mixes the two without marking them.

**Acceptance Scenarios**:

1. **Given** the Settings view, **When** the scope tabs are read, **Then** there
   are exactly two: this engagement, and this machine.
2. **Given** the machine tab, **When** `HookWatchPathsPanel` is looked for,
   **Then** it is there and not on an engagement page.
3. **Given** either tab, **When** a setting is changed, **Then** it is written to
   that tab's store and nowhere else.

### User Story 2 - See what this engagement departed from (Priority: P1)

An operator, or a verifier reading over their shoulder, filters Settings to
what this engagement changed from the defaults — and gets the same list the
evidence chain holds.

**Why this priority**: `config-audit.ts` already writes every departure into
the chain. The data exists and is unreachable from the place it describes.
This is the step that makes the scope axis worth building rather than merely
tidy.

**Independent Test**: With two settings changed from default, the departures
view lists exactly those two, and each corresponds to a config-change event.

**Acceptance Scenarios**:

1. **Given** a project with defaults untouched, **When** the departures filter
   is applied, **Then** it reports none.
2. **Given** a project where `packs.aiAgents` was turned on, **When** the
   departures filter is applied, **Then** that setting is listed.
3. **Given** a listed departure, **When** it is opened, **Then** the operator
   reaches the event in the chain that recorded the change.
4. **Given** a departure in a setting `config-audit` does not watch, **When**
   the filter is applied, **Then** it is listed and marked as not audited —
   the filter MUST NOT imply chain coverage it does not have.

### User Story 3 - Set a machine default, depart from it per engagement (Priority: P3)

An operator who always excludes the same directories sets that once on the
machine, and a single engagement departs from it without editing the machine
value.

**Why this priority**: P3 because it is the only part that changes what a
config value *means*, and the two stories above deliver without it.

**Independent Test**: A setting with a machine value and no project value reads
through to the machine value; adding a project value shadows it; removing the
project value restores the machine value.

**Acceptance Scenarios**:

1. **Given** a machine-level value and no engagement value, **When** the
   effective value is read, **Then** it is the machine value.
2. **Given** both, **When** the effective value is read, **Then** it is the
   engagement value, and the machine tab marks the setting as overridden here.
3. **Given** an engagement override, **When** it is reset, **Then** the machine
   value applies again and the reset is recorded as a config change.

### Edge Cases

- No project is open. Machine settings are reachable; engagement settings are
  not offered rather than offered and silently discarded.
- A setting moves scope in a later version. An existing value must not be
  stranded in a store nothing reads.
- `packMembers` means **absent = on** (`config.ts`). A departures view must not
  report an absent key as a departure, and an override layer must not
  materialise absent keys.
- Settings search (`lib/settingsSearch.ts`) spans both scopes. A hit must say
  which scope it is in before the operator navigates to it.
- Spec 049 moves pages between groups. Both specs touch `Settings.tsx` groups
  and `test/settings-ia.test.ts` `PAGES`; whichever lands second rebases.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every setting MUST declare exactly one scope: engagement or
  machine.
- **FR-002**: Settings MUST present scope as tabs, not as a filter over a mixed
  list. The active tab MUST be where a change is written.
- **FR-003**: No page may render settings from both scopes without marking each.
- **FR-004**: A departures view MUST list the settings that differ from their
  defaults, per scope.
- **FR-005**: A departure that `config-audit` records MUST link to the chain
  event that recorded it. A departure it does not record MUST be marked as such.
- **FR-006**: Settings search results MUST state the scope of each hit.
- **FR-007** *(P3)*: An engagement value MUST shadow a machine value of the same
  setting; absence MUST read through, and a reset MUST restore read-through.
- **FR-008** *(P3)*: An override and a reset MUST each be recorded as config
  changes. Reading through to a machine value MUST NOT be.
- **FR-009**: The `<FieldGroup title=` budget in `test/settings-ia.test.ts`
  (≤29, 27 today) still applies. Scope tabs re-parent groups; they do not add
  them.
- **FR-010**: Existing page ids MUST keep resolving (`lib/navigation.ts`,
  onboarding, the capture wizard, status-bar issue links).

### Key Entities

- **Scope** — `engagement | machine`. A property of a setting's definition, not
  of its value.
- **Departure** — a setting whose effective value differs from its default,
  with the scope it was set in and, when `config-audit` watches it, the chain
  event id that recorded the change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every setting rendered in Settings resolves to exactly one scope;
  a test enumerates them and fails on an unclassified one.
- **SC-002**: No page renders both scopes unmarked.
- **SC-003**: For a project with N audited departures, the departures view lists
  N entries and each resolves to a chain event.
- **SC-004**: `<FieldGroup title=` count does not increase.
- **SC-005** *(P3)*: Round-trip — set machine, read through, override, read
  override, reset, read through again — holds for every setting that supports
  both scopes.

## Assumptions

- Two scopes, not three. Burp has user/project; VS Code has user/workspace/
  folder. RedLog has no folder-equivalent.
- The departures view is a filter over the existing settings search, not a new
  page. The search index is generated (`npm run gen:settings-search`), so the
  scope of each key is declared where the index is generated from.
- P3 is severable. P1 and P2 ship and stand on their own; if P3 is cut, every
  setting keeps exactly one home and FR-007/FR-008 drop out.

## Out of scope

- Any change to what is captured.
- Syncing settings between machines.
- A policy/lock mechanism (VS Code's `@haspolicy`). Nothing in RedLog
  administers another operator's install.
- Per-setting JSON import/export (Burp's configuration library).
- The subject-axis re-parenting, which is spec 049.
