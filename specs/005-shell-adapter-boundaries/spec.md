# Feature Specification: Shell Adapter Boundaries

**Status**: Verified
**Created**: 2026-09-21

## Goal

Bash, zsh and PowerShell use shell-specific lifecycle integration while
sharing one evidence contract, without duplicating POSIX transport, spool,
identity or explicit output-capture behavior.

## User Story

As an operator, I need supported shells to produce equivalent RedLog evidence
and installation behavior so choosing a shell does not silently weaken capture.

### Acceptance Scenarios

1. **Given** a new bash or zsh hook installation, **when** the profile sources
   its adapter, **then** the adapter can load the installed shared runtime from
   the same directory.
2. **Given** bash or zsh records a command, **when** it sends lifecycle events,
   **then** transport, project identity, spool behavior and `redlog-run` come
   from one common implementation.
3. **Given** an existing built-in terminal, wrapper or legacy hook path sources
   `shell-preexec-hook.sh`, **when** it loads, **then** it delegates to the
   matching bash or zsh adapter.
4. **Given** an unsupported POSIX shell loads the compatibility entry point,
   **when** no adapter matches, **then** it reports the supported-shell boundary
   instead of claiming capture is active.

## Requirements

- **FR-001**: Bash and zsh lifecycle code MUST reside in distinct thin adapter files.
- **FR-002**: POSIX adapters MUST share one sender, spool, identity and `redlog-run` implementation.
- **FR-003**: The hook installer MUST deploy every support file required by an installed adapter.
- **FR-004**: The starter-pack manifest and its fallback MUST declare identical adapter and support-file paths.
- **FR-005**: Historical combined hook entry points MUST remain compatibility delegators and MUST NOT retain a second transport implementation.
- **FR-006**: PowerShell remains a language-native adapter but MUST retain the common shell event and structured-output field contract.

## Failure and Edge Cases

- A missing shared runtime causes a visible source error rather than a false active message.
- Installing one POSIX adapter must not depend on the other adapter.
- Removing an adapter may leave the small shared runtime for another adapter; it must not remove a runtime still in use.
- Existing manual WSL and built-in terminal paths continue through the legacy delegator until separately migrated.

## Success Criteria

- **SC-001**: Boundary tests prove lifecycle and transport code are separated.
- **SC-002**: Existing `redlog-run` behavior and hook-manager tests remain green.
- **SC-003**: Bash and zsh manifest entries each declare the shared support file.
- **SC-004**: Typecheck, build and affected Electron capture setup flow pass.

## Out of Scope

fish, Nushell, cmd.exe, transparent stdout interception, PowerShell transport rewrites, new settings pages and session-wide PTY recording.
