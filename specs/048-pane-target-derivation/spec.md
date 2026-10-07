# Feature Specification: Pane Target Derivation

**Feature Branch**: `048-pane-target-derivation`

**Created**: 2026-10-01

**Status**: Draft

**Input**: Spec 041 (session target binding) was withdrawn on 2026-10-01 because
it asked the operator to declare at write time what the pane's own event
sequence already carries. This feature replaces the declaration with the
derivation.

Domain contract: `docs/domain/SPEC-target-identity.md` (target identity,
assignment precedence, normalization). This feature adds a **projection** over
that identity; it does not change what is stored.

## Background

With Spec 041 withdrawn, attribution at ingest is:

```
explicit producer target > observed/enriched target > active-target fallback > null
```

A shell command whose text names no host gets the active target — whatever the
operator last selected, which may be an unrelated machine. That covers nearly
everything typed after the operator is already inside a box (`whoami`,
`sudo -l`, `cat /etc/shadow`), and markers and screenshots taken while there.

The pane's own stream already answers the question. Events from one built-in
terminal share a `terminalId` and are ordered, and the `ssh user@10.10.11.7`
that opened the session carries `data.detectedTarget`. What is missing is not
information — it is a reader.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Commands run inside a host are grouped under that host (Priority: P1)

An operator opens a terminal, runs `ssh root@10.10.11.7`, and from inside that
session runs `whoami`, `sudo -l` and `cat /etc/shadow`. The current target is
still `10.10.11.5` from earlier recon. When they later read the timeline
filtered to `10.10.11.7`, or open that host on the Targets page, those three
commands are there.

**Why this priority**: This is the whole feature. Post-exploitation commands
carry no host in their text and are the highest-value evidence in the record;
grouping them under the wrong machine makes a report assert something false
about a host.

**Independent Test**: One pane, one `ssh` entry, three host-free commands, a
current target pointing elsewhere. Filtering to the entered host returns the
three commands; filtering to the current target does not.

**Acceptance Scenarios**:

1. **Given** a pane that ran `ssh root@10.10.11.7` and the entry command has not
   ended, **When** a command with no host in its text is recorded in that pane,
   **Then** that row's effective target is `10.10.11.7`.
2. **Given** the same pane, **When** the operator changes the current target to
   an unrelated host, **Then** the effective target of those rows does not
   change.
3. **Given** a command that does name a host (`curl http://10.10.11.200/`),
   **When** it is recorded inside that session, **Then** its effective target is
   the host the command names, not the entered one — what was observed outranks
   what was derived.
4. **Given** the `ssh` entry command itself, **When** it is read, **Then** its
   target is observed, not derived.

---

### User Story 2 - Leaving a nested session returns to the one beneath it (Priority: P2)

From inside `10.10.11.7` the operator pivots onward to `10.10.12.3`, works
there, exits, and keeps working on `.7`.

**Why this priority**: Lateral movement through a jump host is routine on
internal engagements. Getting the exit wrong silently files the rest of the
session under the wrong machine — the same failure the feature exists to
prevent, just later in the sequence.

**Independent Test**: A pane with two nested entries and one exit; commands
before, between and after are read back and each lands on the right host.

**Acceptance Scenarios**:

1. **Given** a pane inside `10.10.11.7` that then enters `10.10.12.3`, **When** a
   host-free command is recorded, **Then** its effective target is `10.10.12.3`.
2. **Given** that inner session ends, **When** a further host-free command is
   recorded in the same pane, **Then** its effective target is `10.10.11.7`
   again.
3. **Given** the outer session also ends, **When** a further host-free command
   is recorded, **Then** nothing is derived for it and it keeps the attribution
   ingest gave it.

---

### User Story 3 - A derived target is never mistaken for an observed one (Priority: P3)

Reading the timeline, the Targets page or an exported bundle, the operator can
tell which rows were attributed because a host was seen in the command and
which were attributed because of where the pane was.

**Why this priority**: Constitution II (Surface Truthfulness) and VII (Evidence
Provenance). A derived attribution is an inference about evidence, and a report
that cannot distinguish the two overstates what was observed. Lower priority
only because stories 1 and 2 are useless without it being correct, while this
is about how it is presented.

**Independent Test**: A pane with both kinds of row; each is read back and
reports which kind it is, and a derived one names the entry event it came from.

**Acceptance Scenarios**:

1. **Given** a row whose target was derived, **When** it is read on any surface,
   **Then** that surface distinguishes it from an observed attribution.
2. **Given** a derived row, **When** its provenance is inspected, **Then** it
   references the entry event the derivation came from.
3. **Given** a pane where nothing could be derived, **When** its rows are read,
   **Then** "could not be derived" is distinguishable from "derived as the
   current target".

---

### User Story 4 - A host's bundle contains what happened inside it, and the operator stays in control (Priority: P3)

The operator exports the evidence for `10.10.11.7`. The bundle contains the
post-exploitation commands run inside that host, each marked as attributed by
derivation and naming the session that established it. Before running the
export they can drop any of those rows — a command they judge too weakly
attributed to hand over does not have to go.

**Why this priority**: The report is why the grouping matters at all. It is P3
rather than P1 because stories 1 and 2 are what make the grouping right, and a
bundle built on a wrong grouping would only export the error faithfully.

**Independent Test**: A host with both observed and derived rows is exported;
the manifest distinguishes them, and a row left out in the preview is absent
from the produced bundle.

**Acceptance Scenarios**:

1. **Given** a target with rows attributed by derivation, **When** its evidence
   is exported, **Then** those rows are included and the manifest marks each as
   derived, naming the entry event.
2. **Given** the export preview, **When** the operator leaves out a derived row,
   **Then** that row is absent from the produced bundle and its omission is
   visible in the manifest.
3. **Given** the preview and the executed export, **When** both resolve the same
   target, **Then** they resolve the same set of derived rows.

### Edge Cases

- **An entry with no observable boundary.** A reverse shell (`nc -lvnp 4444`),
  an msf session, `evil-winrm`: the operator is on another host but no event
  says so — the peer address appears only inside captured output, and the
  command has no end that corresponds to leaving. Nothing is derived; rows keep
  what ingest gave them and are marked as not derived. Reading output to
  discover the peer is out of scope here.
- **An entry whose host could not be extracted.** `ssh myboxalias` where no
  extractor yields a host: treated as no entry at all, not as an entry to an
  unknown host.
- **Rows with no `terminalId`.** Markers and screenshots taken from the app
  chrome rather than from a pane. Never derived.
- **Rows recorded before this feature existed.** They carry no record of
  whether their target came from the fallback or from an explicit producer, so
  derivation cannot tell which rows it may correct. They are left alone.
- **A session still open when the project closes.** The entry has no end event;
  rows after it in the same pane, in the same project, still derive from it.
  Pane identity is not reused across runs.
- **Case differences.** `Example.COM` and `example.com` are one host, through
  the shared comparison helper (Spec 038).
- **Two panes, same host.** Derivation is per pane; two panes inside the same
  host both derive to it without interfering.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST compute a pane's effective target from events of
  that same pane, and MUST NOT rewrite the `target_id` stored on any event as a
  result. Derivation is a projection over stored rows (Constitution I).
- **FR-002**: The derivation MUST have one canonical implementation, consumed by
  the per-target aggregate, the event query, the timeline and export alike.
  No surface may compute it independently (Constitution III).
- **FR-003**: A pane's derived context MUST open on an **entry event** — a
  recorded command that places the operator in an interactive session on
  another host — and MUST close when that command ends. Entry is narrower than
  pivot: establishing a tunnel or a route is not entry.
- **FR-004**: Nested entries MUST behave as a stack. Leaving the innermost
  session MUST return the pane to the one beneath it.
- **FR-005**: Derivation MUST apply only to rows whose stored target came from
  the active-target fallback. To make that knowable, ingest MUST record on each
  row that the fallback supplied its target. This is additive provenance, not
  re-attribution (Constitution VII).
- **FR-006**: A host named in a row's own text MUST outrank any derived value.
  Observation outranks inference.
- **FR-007**: Rows carrying no pane identity MUST NOT be derived.
- **FR-008**: Every surface that shows a target MUST distinguish an observed
  attribution from a derived one, and a derived row MUST reference the entry
  event it was derived from (Constitution II, VII).
- **FR-009**: "Could not be derived" MUST remain distinct from "derived" and
  from "no target at all" across every layer (Constitution VI).
- **FR-010**: Scope classification MUST be unaffected. Scope judges what a
  command touched, which derivation does not change.
- **FR-011**: The per-target count on the Targets page MUST equal the number of
  rows the detail view returns for that target, with derivation applied
  consistently to both.
- **FR-012**: An export scoped to a target MUST include the rows attributed to
  it by derivation, and the operator MUST be able to leave any of those rows out
  before the export runs. Today an operator can exclude an attachment but not an
  event, so extending operator exclusion to events is part of this feature.
- **FR-013**: For every included row whose attribution was derived, the export
  manifest MUST say so and MUST name the entry event the derivation came from.
  An evidence bundle has to describe what it actually contains (Constitution II,
  VII).
- **FR-014**: The export preview and the executed export MUST resolve the same
  derived rows and the same exclusions. A row shown as included in the preview
  MUST NOT be absent from the bundle, and the reverse (Constitution V).
- **FR-015**: Reading any target-filtered view MUST remain responsive on a
  full-length engagement record; derivation MUST NOT make a target view
  perceptibly slower to open than it is today.

### Key Entities

- **Pane**: One built-in terminal, identified for the life of the project. Its
  events are ordered and share its identity.
- **Entry event**: A recorded command that puts the operator in an interactive
  session on another host, carrying the host it entered.
- **Derived target**: The host a row is attributed to because of where its pane
  was, together with a reference to the entry event that established it. Not
  stored on the row; computed when the row is read.
- **Effective target**: What a surface groups and filters by — the observed
  target when there is one, otherwise the derived target, otherwise what ingest
  stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a pane that entered a host through an observable entry, 100%
  of the host-free commands recorded until that session ends are grouped under
  the entered host, regardless of the current target.
- **SC-002**: For every host, the count shown on the Targets page equals the
  number of rows the detail view returns for it — no case where the two differ.
- **SC-003**: Zero stored events change their recorded target as a result of
  this feature, verified by comparing stored attribution before and after on
  the same record.
- **SC-004**: An operator reading any row can tell whether its target was
  observed or derived without opening another view.
- **SC-005**: Opening a target-filtered view on a full-length engagement record
  is no more than 10% slower than the same view before this feature.
- **SC-006**: Scope classification results are byte-identical before and after
  this feature on the same record.
- **SC-007**: In a target-scoped export, 100% of included rows whose attribution
  was derived are identified as such in the manifest, and every row the operator
  left out is absent from the bundle.

## Assumptions

- Grouping, filtering, the Targets page and export all consume the derivation;
  it is not a label applied in place while the queries ignore it.
- Operator exclusion exists today for attachments only (`export-attachments.ts`
  resolves an `excluded-by-operator` status per attachment). Extending that
  control to events is scoped into this feature by FR-012, not assumed to be
  already available.
- A derived attribution is good enough to export by default because the
  alternative — dropping the post-exploitation record from a host's bundle —
  misrepresents the engagement more than an inference that is labelled as one.
- A pane's identity is stable for the life of a project and never reused, so a
  derived context cannot outlive the pane it describes.
- Entry detection reuses what the record already extracts from command text;
  this feature does not add tool knowledge, and a tool the extractors do not
  know simply yields no entry.
- Discovering a peer address by reading captured output (reverse shells, msf)
  is a separate feature and is assumed out of scope.
- Rows predating this feature are left as they are; no backfill, consistent
  with not re-attributing stored evidence.
