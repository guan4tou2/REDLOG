# Feature Specification: Capture Setup Wizard

**Feature Branch**: `feat/047-capture-setup-wizard`
**Created**: 2026-09-29
**Status**: Draft
**Renumbered**: written as 040; main merged 040-046 from parallel work
before this branch opened its PR, so the folder moved to 047. Commits
earlier in the branch still say 040.
**Input**: The readiness card (036), the first-run screen (037/039) and preflight each answer "can this machine record?" on their own terms. Collapse them into one wizard that lives inside an open project: step 1 prepares the machine by installing what is missing, step 2 proves capture with real events. Skippable, and re-runnable from Capture Health.

> **Supersedes:** the first-launch readiness card of spec 036 (its preflight
> contract, PATH handling, legacy-hook detection and packaging work stand) and
> the shape of spec 037's first-run screen (its scope, personal-traffic and
> nonce-verified terminal work stands). Spec 039's verification contract —
> what counts as a verified shell and a verified HTTP(S) check — is unchanged
> and is what step 2 consumes.

## Problems (verified on `aee0bd9`)

1. **Two readiness surfaces, and the operator meets the worse one first.**
   The picker card lists python3 / curl / shell / mitmdump with a command to
   copy into a terminal; the first-run screen lists the same dependencies with
   an in-app install. Same question, same dependencies, two fidelities.
2. **On a prepared machine the card is all confirmation.** One capture costs a
   section heading, a check row and a green sentence that repeats the row
   ("這台機器可以記錄 shell 指令。"). Its heaviest control, `readiness.start`,
   only closes the card — the real next action, creating a project, is the
   primary button in the picker underneath it.
3. **A preflight check is a prediction shown where proof belongs.** The screen
   that can prove capture, by an arriving event, is the one the operator
   reaches second.
4. **Installing meant leaving RedLog.** From the card the only path was copy a
   command, switch to a terminal, come back, press Re-check.
5. **Setup could not be re-run.** The card is once per install (localStorage),
   so a machine that breaks later has no guided path back; Capture Health can
   only reopen the same read-only card.
6. **The first-run screen could not be reached at all on a fresh install.**
   `visibility:signals` answers null while no project is open, and the renderer
   read that null as "every gate already unlocked" on a single mount-time
   fetch — the answer to a question asked before a project could exist. Fixed
   separately as a defect (UIUX-STANDARD §22 already requires null to mean "not
   asked yet"); this feature depends on that fix.

## Clarifications

### Session 2026-09-29

- Q: Where does the wizard live? → A: Entirely inside an open project. The
  project picker shows nothing but the picker.
- Q: Linear like OBS's auto-configuration wizard, or a passive checklist like a
  VS Code walkthrough? → A: Linear. It runs itself on the first engagement and
  is re-runnable from Capture Health afterwards.
- Q: Does a linear flow reintroduce the ordering #217 removed? → A: No. The
  line is Prepare then Prove, which nobody disputes. Inside step 2 Commands and
  HTTP(S) stay side by side and neither waits on the other.
- Q: Does UIUX-STANDARD §22 forbid this, having retired guided tours? → A: §22
  retires explaining concepts the operator has not met. Every step here either
  installs something or waits for a real event; no step is explanation.
- Q: What does a second engagement on an already-prepared machine see? → A:
  Step 1 completes itself and the wizard opens on step 2. Preparation is a fact
  about the machine; verification is a fact about the engagement.
- Q: Are copy-paste install commands removed entirely? → A: They survive only
  as the fallback shown after an in-app install fails. They are never the first
  offer.

## User Scenarios & Testing

### User Story 1 - Prove capture in the first engagement (Priority: P1)

The operator opens their first project and lands on step 2: the built-in
terminal beside two cards, Commands and HTTP(S). Running one command lights
Commands; a verification check lights HTTP(S). Neither card waits for the
other, and either one alone is enough to start working.

**Why this priority**: This is the product's first promise — that it records.
Everything else in the wizard exists to get here.

**Independent Test**: With every dependency present, opening a project with no
events shows both cards pending; a command event verifies Commands while HTTP
is still pending, and an HTTP(S) check verifies HTTP while Commands is still
pending. Neither transition depends on the other.

**Acceptance Scenarios**:

1. **Given** a prepared machine and a project with no events, **When** the
   operator opens the project, **Then** the wizard opens on step 2 with both
   cards visible and pending.
2. **Given** step 2 with both cards pending, **When** only an HTTP(S) check
   succeeds, **Then** HTTP(S) shows verified, Commands stays pending, and the
   operator can start working.
3. **Given** step 2, **When** the operator chooses to leave before either card
   verifies, **Then** they reach the timeline and the dashboard keeps naming
   what is still unverified.

---

### User Story 2 - Install what is missing without leaving RedLog (Priority: P1)

A machine missing python3, curl or mitmproxy shows step 1 listing exactly what
is missing, each with an install action that runs in place and reports its own
outcome. When nothing is missing, step 1 completes itself.

**Why this priority**: It removes the only reason the operator would leave the
app during setup, and it makes one install path canonical instead of two.

**Independent Test**: With mitmdump absent, step 1 lists mitmproxy with an
install action; running it and succeeding advances to step 2 with HTTP(S)
available. With nothing absent, step 1 is already complete and the wizard opens
on step 2.

**Acceptance Scenarios**:

1. **Given** a machine missing mitmproxy, **When** the wizard opens, **Then**
   step 1 lists mitmproxy and only mitmproxy, with an install action.
2. **Given** a failed install, **When** the operator looks at that row, **Then**
   it states the failure and offers the equivalent manual command.
3. **Given** a machine where preflight itself cannot run, **When** the wizard
   opens, **Then** step 1 says the check failed and offers a retry, and never
   reports the machine as prepared.

---

### User Story 3 - Come back to setup later (Priority: P2)

Weeks later mitmproxy is gone, or a shell hook stops firing. Capture Health
offers to run capture setup again, in a project that already holds evidence,
and the wizard opens at the step that has something to do.

**Why this priority**: The current card is once per install, so today the only
recovery is reading documentation.

**Independent Test**: In a project with events, the wizard does not open by
itself; invoking it from Capture Health opens it, and leaving it returns to the
dashboard with no loss of state.

**Acceptance Scenarios**:

1. **Given** a project with events, **When** the operator opens the dashboard,
   **Then** the wizard does not open by itself.
2. **Given** that project, **When** the operator runs capture setup from
   Capture Health, **Then** the wizard opens and reflects the machine's current
   state.

---

### User Story 4 - A clean project picker (Priority: P2)

The picker shows projects and nothing else — no floating readiness card, no
button whose only effect is to dismiss a card.

**Why this priority**: It removes a primary action that does nothing and stops
covering the real one.

**Independent Test**: On first launch with no project, the picker renders with
no readiness surface and no dependency list.

**Acceptance Scenarios**:

1. **Given** a fresh install, **When** the app launches, **Then** the picker
   shows only the picker; the legacy-hook banner still appears when a legacy
   hook line exists.

### Edge Cases

- **Preflight cannot run**: shown as a failed check with a retry, never as a
  prepared machine and never as a missing dependency (Constitution VI).
- **An install fails** (no network, no package manager, no permission): the row
  keeps the failure text and the manual command; the wizard does not advance on
  its own.
- **A dependency disappears mid-engagement**: the wizard does not take the
  screen; Capture Health flags it and the operator re-runs setup.
- **A legacy hook line exists**: named in step 1 alongside the missing
  dependencies; the existing banner behaviour is unchanged.
- **The operator skips both steps**: the dashboard keeps naming the unverified
  capture until it is verified — the existing "later" behaviour.
- **Events arrive while the wizard is open**: a card that verifies stays
  verified; the wizard must not unmount at the moment it is meant to show.
- **A second project is created while the first is still unverified**:
  verification is per engagement, so the new project starts at step 2 again;
  preparation is not asked twice.

## Requirements

### Functional Requirements

- **FR-001**: The project picker MUST NOT present runtime readiness,
  dependency state, or an action whose only effect is to dismiss such a
  surface.
- **FR-002**: The wizard MUST open by itself on the dashboard of a project that
  has captured nothing, and MUST NOT open by itself once that project holds
  evidence.
- **FR-003**: Step 1 MUST list only what needs an action — missing
  dependencies and legacy hook lines — and MUST complete itself, without a
  click, when there is nothing to act on.
- **FR-004**: Every step-1 row MUST offer an in-app install action that reports
  its own outcome in place. The equivalent manual command MUST appear only
  after that action fails.
- **FR-005**: Step 2 MUST present Commands and HTTP(S) at the same time, each
  verified independently by an arriving event per spec 039, with neither
  blocking the other; a missing shell dependency MUST block only Commands.
- **FR-006**: The operator MUST be able to leave the wizard at any step and
  reach the app; the dashboard MUST keep naming capture that is not yet
  verified.
- **FR-007**: Capture Health MUST offer a re-run that reaches the same wizard,
  including in a project that already holds evidence.
- **FR-008**: A failed environment check MUST be reported as a failed check
  with a retry, and MUST NOT be rendered as a prepared machine, as a missing
  dependency, or as silence.
- **FR-009**: Dependency installation MUST have exactly one implementation and
  one entry point in the product; no other surface may offer a second, weaker
  install path for the same dependency.
- **FR-010**: The wizard MUST NOT gate any view: every page reachable without
  it before this feature stays reachable during and after it.
- **FR-011**: Wizard progress MUST derive from observable state — what the
  machine has installed and what the project has captured — and MUST NOT
  persist a per-install "seen" flag as the reason to skip setup.

### Key Entities

- **Preparation state**: a property of the machine — which dependencies are
  present, which hooks are current. Shared by every project on that machine.
- **Verification state**: a property of the engagement — whether a command
  event and an HTTP(S) check have arrived in this project. Not shared.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a prepared machine, a new operator reaches their first
  recorded event within 30 seconds of opening their first project, without
  leaving RedLog (the §22 target, now measurable on one screen).
- **SC-002**: On a machine with no mitmproxy, the operator reaches verified
  HTTP(S) capture without typing a command or switching applications.
- **SC-003**: A second engagement on a prepared machine reaches the
  verification step with no clicks spent on preparation.
- **SC-004**: Exactly one surface in the product offers to install a capture
  dependency.
- **SC-005**: A fresh install with no project shows no dependency information
  before a project is open.
- **SC-006**: New behaviour tests, the full suite, the first-run E2E journey,
  typecheck, gates and build all pass.

## Assumptions

- The one-click install shipped on `feat/mitmproxy-one-click-install` is the
  template for every step-1 row; this feature generalises it rather than
  inventing a second mechanism (Constitution III, IX).
- The `visibility:signals` null defect is fixed independently and landed before
  this feature; without it the wizard cannot open on a fresh install.
- Spec 039's definitions of a verified shell and a verified HTTP(S) check are
  unchanged and are consumed as-is.
- Spec 037's scope, personal-traffic and nonce-verified terminal work is
  unchanged; only the screen that hosts it changes.
- The built-in terminal remains the zero-install path to a first command, and
  connecting the operator's own shell remains a step that follows verification
  rather than preceding it.
- No new framework, state library or window layer is introduced; the wizard is
  the existing first-run view with a preparation step in front of it.
