# Feature Specification: Terminal Session Rotation Across a Project Switch

**Feature Branch**: `spec/055-terminal-session-rotation`

**Created**: 2026-10-07

**Status**: Draft

**Input**: Keep terminal panes alive across a project switch by rotating their log session instead of killing them. The record has to stop belonging to the old project; the pane does not have to stop existing, and today those two are the same action.

> **Relationship to the leave-project confirmation (PR #278, branch
> `feat/project-switch-confirm`):** that change asks before the recording
> stops, and lists "N open terminal panes close" as one of the consequences
> because today it is true. This feature is what deletes that line. The dialog
> itself stays: stopping the recording is still a thing to ask about.

## Problems (verified on `89b6e102`)

1. **Switching project kills every open pane.** `stopProject()` calls
   `killAllTerminals()` (`src/main/index.ts:1087`), which finalises each
   session and kills its pty (`src/main/terminal-manager.ts:606`). The
   operator loses the shell, its working directory, its history, and whatever
   was running in it — a long scan, an interactive session on a target, a
   port-forward holding a foothold open. Nothing about the record requires
   this. The record requires that the pane's events stop belonging to the old
   project, which is not the same statement as the pane ceasing to exist.

2. **The design already assumed a pane could outlive a switch, and then made
   it impossible.** `src/main/terminal-manager.ts:516` reads "Identity from
   the session, not the module: #114 captures it at spawn so a project switch
   mid-session cannot re-attribute this row." The attribution is pinned per
   session precisely so a mid-session switch is survivable. `killAllTerminals()`
   means that care has never once been exercised.

3. **A surviving shell would follow the switch on its own.** The pane's
   environment carries `REDLOG_TERMINAL` and `REDLOG_TERMINAL_ID`
   (`src/main/terminal-manager.ts:394`) and no engagement id, so a hook event
   from that shell is attributed by whatever is listening, not by anything
   baked into the shell at spawn. Nothing has to be rewritten inside a running
   shell for its commands to start landing in the new project.

4. **What is actually bound to the old project is three things, all of them at
   spawn.** The cast write stream, opened under `<project>/casts/`
   (`src/main/terminal-manager.ts:413`); the `session_start` row, written to
   the old project's database and hash chain
   (`src/main/terminal-manager.ts:505`); and the enrollment file under
   `~/.redlog/terminals/`, which carries the engagement id
   (`src/main/terminal-manager.ts:484`). Three bindings, and the current answer
   to all three is to destroy the process that holds them.

5. **Letting the pane simply keep writing would be worse than killing it.**
   A pane that survived with its old bindings intact produces a session whose
   `session_start` is in one chain and whose `session_end` is in another, with
   a cast file belonging to a project that is closed and a `_causes` reference
   pointing across a boundary. That is a record that cannot be walked, and it
   is why "just don't kill them" is not the feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The work in the pane survives the switch (Priority: P1)

An operator has three panes open: a shell sitting in a loot directory, an
interactive session on a target, and a scan that has been running for twenty
minutes. They switch to another engagement to check something. All three panes
are still there when they come back — same shell, same working directory, same
scrollback, and the scan still running.

**Why this priority**: It is the whole feature. Everything below exists to
make this survivable for the record rather than merely convenient.

**Independent Test**: Open panes, note each one's pid and working directory,
switch project, and check that the pids are unchanged and the panes still
respond.

**Acceptance Scenarios**:

1. **Given** panes open in project A, **When** the operator switches to
   project B, **Then** every pane is still open, the underlying process ids
   are unchanged, and each shell is in the same working directory.
2. **Given** a long-running command in a pane, **When** the project is
   switched, **Then** the command keeps running and its output keeps arriving
   in the pane.
3. **Given** the operator switches back to project A, **When** the panes are
   inspected, **Then** they are the same panes, not restored copies.

---

### User Story 2 - Each project's record of the pane is whole on its own (Priority: P1)

Whatever happened in a pane while project A was open is in project A's record,
complete and verifiable, with nothing in it pointing at a file or a row that
lives somewhere else. The same is true of project B for what happened after.

**Why this priority**: Constitution I and VII. A session split across two
chains is not two records, it is two broken ones, and the break is invisible
until an export is challenged.

**Independent Test**: Switch project with panes open, then verify each
project's chain and replay the pane's recording in each. Both verify; each
replay covers its own half and nothing else.

**Acceptance Scenarios**:

1. **Given** a pane recording in project A, **When** the project is switched,
   **Then** project A holds a `session_end` for that pane carrying the
   recording's hash over the bytes written while A was open, and the reason it
   ended is that the project was switched — distinguishable from the shell
   exiting and from the pane being closed.
2. **Given** the switch has completed, **When** project A's chain is verified,
   **Then** it verifies, and nothing in project A refers to a file under
   project B.
3. **Given** the switch has completed, **When** a pane's recording in project A
   is replayed, **Then** it covers the period A was open and stops at the
   switch.
4. **Given** the operator types in the pane after the switch, **When** project
   B is inspected, **Then** the commands and output are in project B and are
   absent from project A.

---

### User Story 3 - The two halves name each other (Priority: P2)

Reading project B's record of a pane, it is apparent that this pane did not
begin there — it carries a reference to the session it continues, and to the
project that session is in. Reading project A's record, the pane's end says
where it went.

**Why this priority**: Constitution VII. Without it the operator writing up an
engagement sees a session that starts mid-conversation, with no way to find
the half that explains it. With it, the pane is one story told in two files.

**Independent Test**: Switch project with a pane open, then read the new
session's record and follow the reference back to the old one.

**Acceptance Scenarios**:

1. **Given** a pane rotated from project A to project B, **When** project B's
   record for that pane is read, **Then** it identifies the session it
   continues and the project that session belongs to.
2. **Given** the same pane, **When** project A's record for it is read,
   **Then** it says the session was continued rather than ended, without
   naming anything project B does not want disclosed to a reader of A.
3. **Given** a pane that was opened in project B from the start, **Then** its
   record carries no such reference, and the two cases are distinguishable.

---

### User Story 4 - A rotation that cannot complete is not quietly a working pane (Priority: P2)

The recording in the new project cannot be started — the disk is full, the
project directory is not writable, the database refuses the write. The pane
does not silently become a terminal that records nothing while looking exactly
like one that records.

**Why this priority**: Constitution II and VI. A pane that looks live and is
not is the single worst outcome available here, worse than the current
behaviour, because the operator keeps working in it.

**Independent Test**: Make the new project's recording directory unwritable,
switch, and check what the pane and the capture surfaces say.

**Acceptance Scenarios**:

1. **Given** the new project's recording cannot be opened, **When** the switch
   happens, **Then** the pane states that it is not being recorded, and the
   condition is raised where persistent conditions are raised rather than
   announced once and lost.
2. **Given** that state, **When** the operator types a command, **Then**
   nothing claims the command was recorded.
3. **Given** the rotation fails, **When** project A is inspected, **Then** its
   half is still complete: closing out the old session must not depend on
   opening the new one.

---

### Edge Cases

- **A command is in flight at the moment of the switch.** Its start was
  recorded in project A and its completion will arrive while project B is
  open. See [NEEDS CLARIFICATION: hold or cross — resolved below].
- **There is no new project to rotate into.** Leaving a project returns the
  operator to the project picker, where no project is open at all. See
  [NEEDS CLARIFICATION: what happens to panes on leave — resolved below].
- **The pane's recording was already truncated** by the size cap before the
  switch. The new project's recording starts fresh with its own budget, and
  the old half stays marked as truncated.
- **A pane's shell exits during the switch.** The pane ends in whichever
  project was open when it happened, once, and is not also rotated.
- **The application is quitting** rather than switching. Panes are not
  rotated; the existing shutdown path stands, because there is no project to
  rotate into and nothing survives the process anyway.
- **A pane is opened while the switch is in progress.** It belongs to exactly
  one project and is not a rotation of anything.
- **The same pane is switched twice in quick succession** (A → B → C). Each
  hop is its own rotation; the chain of references is one hop deep per record,
  not an accumulating list.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Switching from one project to another MUST leave every open
  terminal pane running, with its process, working directory, environment and
  scrollback intact.
- **FR-002**: On a switch, each pane's recording in the outgoing project MUST
  be closed out as a complete session — ended, hashed over what it contains,
  and attributable — before anything is written for that pane in the incoming
  project.
- **FR-003**: The reason a session ended MUST distinguish a project switch
  from the shell exiting and from the operator closing the pane.
- **FR-004**: After a switch, a pane's subsequent activity MUST be recorded in
  the incoming project and MUST NOT appear in the outgoing one.
- **FR-005**: No record in a project MAY refer to a recording file, event or
  chain entry belonging to another project.
- **FR-006**: The incoming project's record for a rotated pane MUST identify
  the session it continues and the project that session belongs to; the
  outgoing project's record MUST indicate that the session was continued.
- **FR-007**: A pane that cannot be recorded in the incoming project MUST say
  so on the pane itself and MUST raise it as a persistent condition, not a
  single notification.
- **FR-008**: A failure to begin recording in the incoming project MUST NOT
  prevent the outgoing project's half from being completed, and MUST NOT kill
  the pane.
- **FR-009**: The operator MUST NOT have to do anything for rotation to
  happen; it is a consequence of switching, not a setting or a prompt.
- **FR-010**: Rotation MUST apply to every surface that switches project —
  the title-bar control, the command palette's project list, and any later
  one — through one shared path rather than per entry point.
- **FR-011**: Pane survival MUST NOT change what the operator is told about
  the switch: leaving a project still stops the recording, and that remains
  the thing the confirmation asks about.
- **FR-012**: The number of panes rotated MUST be observable in the record of
  both projects, so that an export can account for the boundary.

### Key Entities

- **Terminal pane**: what the operator sees and types in. Survives a switch.
  Identified stably across projects so the two halves can be related.
- **Recording session**: the recorded span of one pane inside one project —
  its start, its end, its recording file and its hash. Belongs to exactly one
  project, and a switch ends one and begins another.
- **Continuation reference**: what the incoming project's session carries to
  name the session it continues, and the project that session is in.
- **Rotation outcome**: for each pane, whether its outgoing half completed and
  whether its incoming half began. Both halves are reported, because they fail
  independently.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a project switch with panes open, 100% of panes are still
  usable, and no running process in them was terminated.
- **SC-002**: Both projects' hash chains verify after a switch, with no
  cross-project reference in either.
- **SC-003**: Replaying a rotated pane in the outgoing project reproduces
  everything that happened while that project was open and nothing after;
  replaying it in the incoming project reproduces everything after and nothing
  before. The two together reproduce the whole, with no gap and no overlap.
- **SC-004**: From the incoming project's record of a rotated pane, the
  outgoing half can be located without knowing the switch happened.
- **SC-005**: A switch with ten panes open completes without the operator
  perceiving the application as unresponsive.
- **SC-006**: When the incoming project cannot record, the pane is identifiable
  as not-recording from the pane itself, without consulting any other surface.
- **SC-007**: The confirmation shown when leaving a project no longer lists
  pane closure among its consequences, and nothing else in it becomes false.

## Assumptions

- A running shell does not need to be told which project it belongs to:
  attribution happens where the event is received, so a surviving shell
  follows the switch without its environment being rewritten. Verified against
  the pane environment on `89b6e102`.
- Closing out the outgoing half and beginning the incoming half are separate
  steps that can fail separately, and the outgoing one is the one that must
  not be lost.
- Panes opened by RedLog are in scope. Shells the operator runs outside RedLog
  are attributed by the receiving side already and are not sessions this
  feature rotates.
- Quitting the application is not a switch and keeps its current behaviour.
- The size cap on a recording is per session, so a rotated pane's new half
  starts with a fresh budget. This is a consequence, not a goal.
- The existing per-session pinned attribution (#114) is the mechanism this
  feature relies on, not something it replaces.

## Dependencies

- `docs/domain/SPEC-capture-source-lifecycle.md` governs how a capture source
  reports its state; a pane that cannot record after a rotation reports
  through that contract rather than inventing a state.
- The leave-project confirmation on branch `feat/project-switch-confirm`
  (PR #278) owns the copy that SC-007 changes.
