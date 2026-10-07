# Feature Specification: Per-Agent Capture Members

**Feature Branch**: `050-per-agent-capture-members`

**Created**: 2026-10-01

**Status**: Draft

**Input**: The AI agents pack has one member, `agentTailer`, and that member
watches three different agents' transcript locations. An operator who uses
Claude Code on an engagement cannot turn it on without also recording every
Codex and OpenCode session on the machine. The host monitors pack solved this
exact problem by splitting into per-source members; the agents pack did not.

## Background

`configureAgentTailer` registers three adapters in one call
(`src/main/services/agent-tailer.ts:31`):

| `agentKind` | Watches |
| --- | --- |
| `claude-code` | `~/.claude/projects/<slug>/*.jsonl` |
| `codex` | `~/.codex/sessions/**` |
| `opencode` | `~/.local/share/opencode/storage/**` |

The capture-pack model already has the right shape for this. Host monitors
declares four members and each carries its own switch, its own
`packMembers` key and its own capture-health source:

```
hostMonitors → processMonitor · connectionMonitor · fileWatcher · clipboard
aiAgents     → agentTailer
```

The reason host monitors was split is recorded at
`CaptureControlPage.tsx:31`: bundling the clipboard with three monitors meant
"an operator who wanted those three took it without deciding to". Bundling
three agents behind one switch is the same defect.

The identity to split on already exists and is already in the record:
`TailerAdapter.agentKind` lands in every emitted event's `data.agent`
(`tailer-host.ts:153`). Nothing new has to be inferred.

### What an operator cannot do today

- Record Claude Code sessions for this engagement without also recording
  Codex and OpenCode sessions, including personal ones unrelated to the work.
- See, in capture health, which agent is feeding the record. There is one
  source, `agent-tailer`, for all three.
- Account afterwards for which agents the engagement was configured to watch.
  `config-audit` records `packMembers.agentTailer` — one boolean for three.

The existing mitigations do not cover it. `.redlog-app-root` excludes a repo,
not an agent. `hookConfig.watchPaths` narrows by directory, not by agent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record one agent, not all three (Priority: P1)

An operator running an engagement with Claude Code turns on agent capture for
Claude Code and leaves Codex and OpenCode off. Codex sessions started on the
same machine during the engagement produce no events.

**Why this priority**: This is the feature. It is also a scope question, not a
preference — a Codex session about unrelated work is third-party content in an
engagement record.

**Independent Test**: With only the Claude Code member on, write a unit to each
of the three watched locations; only the Claude Code one produces events.

**Acceptance Scenarios**:

1. **Given** the pack on and only `claudeCode` on, **When** a Claude Code
   transcript line is appended, **Then** an `agent.*` event is recorded.
2. **Given** the same state, **When** a Codex rollout line is appended,
   **Then** no event is recorded.
3. **Given** the pack off, **When** any of the three is appended, **Then** no
   event is recorded, whatever the member switches say.

### User Story 2 - See which agent is feeding the record (Priority: P2)

An operator reading capture health sees each enabled agent separately, so a
Claude Code tailer that has gone quiet is not hidden by a busy Codex one.

**Why this priority**: The existing single `agent-tailer` source reports healthy
whenever *any* agent is producing, which is the failure mode capture health
exists to catch.

**Independent Test**: With two members on and only one producing, capture health
reports one feeding and one idle.

**Acceptance Scenarios**:

1. **Given** two members on, **When** capture health is read, **Then** it lists
   two sources with independent last-event times.
2. **Given** a member off, **When** capture health is read, **Then** that source
   reports off with its own config path, not missing.

### User Story 3 - Upgrading changes nothing (Priority: P1)

An operator opens an existing project after upgrading. What it records does not
change, and nothing in the record claims it did.

**Why this priority**: `packMembers` means **absent = on**. Getting this wrong
either silently narrows an engagement's capture or writes a config-change event
for a change nobody made — both are evidence-integrity faults, not bugs.

**Independent Test**: Open a project whose `config.yaml` has no `packMembers`
key; all three members read as on and no config-change event is written.

**Acceptance Scenarios**:

1. **Given** a `config.yaml` with no `packMembers`, **When** it is loaded,
   **Then** all three agent members are on.
2. **Given** a `config.yaml` with `packMembers.agentTailer: false`, **When** it
   is loaded, **Then** all three agent members are off.
3. **Given** either, **When** the project is opened, **Then** no config-change
   event is recorded for the migration.

### Edge Cases

- An adapter registered by a plugin rather than bundled. Members are declared
  in `CAPTURE_PACKS`; a plugin-contributed adapter has no member and must
  either be rejected or default to on with a stated rule.
- All three members off with the pack on. The pack switch stays on and the
  watchers do not run; capture health must not report the pack as feeding.
- `.redlog-app-root` self-exclusion and `watchPaths` still apply per session,
  independently of the member switches, and are checked after them.
- Settings search index entries for the retired `agentTailer` key.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `CAPTURE_PACKS.aiAgents.members` MUST name one member per
  registered bundled adapter: `claudeCode`, `codex`, `opencode`.
- **FR-002**: A turn MUST be emitted only when its adapter's member is on AND
  the pack is on. The member check MUST happen before the self-exclusion and
  watch-path gates, so a disabled agent is never read.
- **FR-003**: `packMembers.agentTailer` MUST migrate to the three new keys with
  its value, and the retired key MUST be removed — not left as a shim
  (constitution: v0 ships no compatibility shims).
- **FR-004**: The migration MUST NOT write a config-change event.
- **FR-005**: Capture health MUST expose one source per agent member, each with
  its own `configPath` and the shared `packPath: 'packs.aiAgents'`.
- **FR-006**: `config-audit` MUST record each member switch separately. This
  requires no new code — `PACK_MEMBERS` derives from `CAPTURE_PACKS`
  (`config-audit.ts:15`).
- **FR-007**: The AI agents settings page MUST render one `PackMember` per
  agent, in the same shape host monitors uses.
- **FR-008**: Per-agent tuning MUST sit under its own member: `emitThinking`
  stays pack-wide only if it genuinely is; otherwise it moves under the agents
  it applies to.

### Key Entities

- **Agent capture member** — `claudeCode | codex | opencode`. One per
  `TailerAdapter.agentKind`, with the same absent-means-on semantics as every
  other `packMembers` key.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one member on, events are produced for that agent only —
  asserted per agent, not once.
- **SC-002**: A project with no `packMembers` key records exactly what it
  recorded before the change.
- **SC-003**: Capture health reports three agent sources when three members are
  on, and the correct one goes idle when one stops.
- **SC-004**: Turning one member off writes one config-change event naming that
  member.
- **SC-005**: `packMembers.agentTailer` appears nowhere in the source after the
  change.

## Assumptions

- Three members, matching the three bundled adapters. A fourth adapter ships
  with a fourth member; this is not an open registry.
- `emitThinking` stays pack-wide. Thinking blocks are a property of what the
  operator wants recorded, not of which agent produced them — but FR-008 leaves
  the door open if the implementation finds otherwise.
- Members default on, so an operator who wants only one turns two off rather
  than one on. This matches every other pack and keeps upgrades inert; the
  alternative (default off) would silently narrow existing engagements.

## Out of scope

- Per-agent transcript paths as user-facing config. `claudeProjectsDir`,
  `codexSessionsDir` and `opencodeStorageDir` stay test-only overrides.
- Agent-level scope rules (recording some sessions of an agent and not others).
  `watchPaths` and `.redlog-app-root` already address that axis.
- The settings information architecture, which is spec 049.
