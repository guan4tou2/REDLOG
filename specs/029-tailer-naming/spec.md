# Feature Specification: Tailer Naming

**Feature Branch**: `refactor/tailer-naming`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Name the two transcript followers after what they follow, and put the Claude Code adapter next to the other agent adapters.

Two services follow transcript files. `transcriptTailer` follows PowerShell
Start-Transcript output on Windows; `agentTailer` follows AI agent transcripts.
Read side by side in a config file, nothing says which is which.

The agent side had a second confusion. The Codex and OpenCode adapters live in
`services/adapters/`; the Claude Code adapter lived in
`services/agent-transcript-tailer.ts`, a file that also registered all three
adapters and re-exported host internals, under a comment saying it kept
"v0.7.x names so main/index.ts is unchanged".

## User Scenarios & Testing

### User Story 1 - A config says which follower is which (Priority: P1)

As an operator reading a project's config, I need the PowerShell follower's
key to say PowerShell.

**Independent Test**: The default config has `powershellTranscript` and no
`transcriptTailer`.

### User Story 2 - An adapter is where the adapters are (Priority: P2)

As a maintainer adding or fixing an agent format, I need every adapter in
`adapters/`, and the registration kept apart from any one agent's parsing.

**Independent Test**: `adapters/` holds `claude-code`, `codex` and `opencode`;
the wiring file parses no transcript.

### Edge Cases

- `agentTailer` keeps its name: it is already unambiguous, and the capture
  health source id `agent-tailer` and its `configPath` stay unchanged.
- `startAgentTailer` had no caller and is removed rather than moved.

## Requirements

- **FR-001**: The PowerShell follower's config key, service file, functions and
  Settings strings MUST be named `powershellTranscript` / `powershell-transcript`.
- **FR-002**: The Claude Code adapter MUST live in `adapters/claude-code.ts`,
  pure parsing, with a root override like its siblings.
- **FR-003**: Adapter registration MUST live in `agent-tailer.ts`, which parses
  nothing and re-exports no host internals.
- **FR-004**: Tailer behaviour MUST be unchanged.

## Success Criteria

- **SC-001**: The agent tailer, PowerShell transcript, canonical-ingest and
  config suites pass.

## Assumptions

- Pre-release (Spec 006): `transcriptTailer` in an existing config is not
  migrated; the follower stays off, its default.
