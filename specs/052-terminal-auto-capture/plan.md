# Implementation Plan: Terminal Auto-Capture

**Branch**: `052-terminal-auto-capture` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/052-terminal-auto-capture/spec.md`

## Summary

Record the operator's own terminal — command, output, timing, cwd, exit code —
with nothing typed before the command, on Kali + zsh.

The mechanism already exists in this repository and is run by hand:
`redlog-run` (`hooks/shell-common.sh:127`) streams a command's stdout and
stderr through named pipes into temp files, hands the bytes to the terminal
while the command runs, and emits a `command_end` carrying the captured streams
with byte counts and truncation flags. The feature is **not a new recorder**.
It is: make that relay the default path for an eligible command, decide
eligibility, and carry enrollment, mode, and durable stop state per terminal.

Three things are genuinely new: the zsh interception that routes output through
the relay without the operator naming it, the per-command handling class
(relayed / PTY-captured / native), and the enrollment state machine.

## Technical Context

**Language/Version**: zsh (Kali default since 2020) for the adapter;
Python 3 (standard library only, as `hooks/shell-common.sh` and
`hooks/redlog-session.py` already assume) for the relay body; TypeScript for
the RedLog-side install, status and card surfaces.

**Primary Dependencies**: no new ones. `curl` + Python 3 are the existing hook
dependencies; `script(1)` is needed only for the PTY class and only when the
operator puts a command in it.

**Storage**: the existing event store through `POST /api/events`, with the
existing `~/.redlog/pending` spool for back-pressure. Per-terminal recorder
state is a private file under `~/.redlog/`, not in the project database.

**Testing**: vitest for the TypeScript surfaces; a pty-driven interactive zsh
for the adapter — these hooks do not fire under `zsh -c`, and a piped stdout
hides the behaviour most worth testing. Playwright e2e for the install journey
only.

**Target Platform**: Kali Linux + zsh is delivered and verified. Other shells
and platforms are out of scope for this feature (FR-017, FR-019).

**Project Type**: desktop app (Electron + React + SQLite) plus shell adapters
under `hooks/`.

**Performance Goals**: the relay must not be perceptible at the prompt. Budget:
under 50 ms added to a command that produces no output, and no added latency to
the first byte the operator sees (the terminal gets bytes while the command
runs, as `redlog-run` already does).

**Constraints**: job control, terminal modes and signals behave exactly as
without the recorder (FR-006); 100 KB per stream is the current `redlog-run`
bound and truncation must be declared (FR-004); a recorder failure never costs
the operator the command (FR-009).

**Scale/Scope**: an engagement is hundreds to low thousands of commands per
project, a handful of terminals open at once, single operator per machine.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Evidence Integrity | Raw output stored as captured; cleaned text is a projection and labelled (FR-003); truncation and native-class gaps are declared, never silent (FR-004, FR-025) | PASS |
| II. Surface Truthfulness | The card's `terminal` row must not claim the operator's shell is covered while enrollment is manual-mode-off or stopped; "metadata only" keeps its meaning | PASS, with a card task |
| III. Canonical Domain Semantics | The event contract, identifiers and transport stay in `hooks/shell-common.sh`; the relay body is one implementation used by the automatic path and by `redlog-run` | PASS |
| IV. Query Completeness | No new query surface | N/A |
| V. Preview / Execute Consistency | No export change | N/A |
| VI. Explicit Failure | Recording-stopped, spooled, truncated, redirected, native-class and never-enrolled are six distinct states and stay distinct (FR-004, FR-008, FR-009, FR-024) | PASS |
| VII. Evidence Provenance | Output chunks reference their command by id; occurrence time (shell) and receipt time (RedLog) stay separable, as the existing shell events already do | PASS |
| VIII. Test-First Verification | Capture semantics change, so each behaviour starts from a failing pty-driven test | PASS, enforced in tasks |
| IX. Architectural Restraint | No new framework, no new transport, no new store. The relay is the existing `redlog-run` body; the PTY class is the existing `hooks/redlog-session.py` | PASS |

**Affected domain contract**: `docs/domain/SPEC-capture-source-lifecycle.md`.
Updating it is an explicit task, for two reasons:

1. This feature adds states that contract does not have — enrolled vs. not,
   mode, per-terminal stop — and its Coverage checklist ("the UI says what it
   does **not** record") is exactly what FR-025's native class must satisfy.
2. The contract still lists `Active / Idle` as source states. Commit `d6e60e9`
   removed `idle` from the capture model (a source state now answers whether it
   can record, not how recently it did). **The contract is already out of sync
   with main**, and the constitution requires a feature that changes a domain
   invariant to update it. This feature is the first one to touch that area
   since, so it carries the correction.

## Project Structure

### Documentation (this feature)

```text
specs/052-terminal-auto-capture/
├── plan.md              # This file
├── spec.md
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── events.md        # what the adapter emits
│   └── shell-commands.md# what the operator can type
└── checklists/requirements.md
```

### Source Code (repository root)

```text
hooks/
├── shell-zsh-hook.zsh        # EXTEND: lifecycle + enrollment + relay routing (zsh only)
├── shell-common.sh           # EXTEND: transport unchanged; relay body factored out of redlog-run
├── redlog-relay.py           # NEW: the output relay, stdlib only
├── redlog-session.py         # REUSE: PTY class (spec 022), unchanged
└── shell-bash-hook.sh        # UNTOUCHED: bash is not in scope (FR-019)

src/core/
├── hooks-manager.ts          # EXTEND: install/uninstall/detect for the enrolled adapter
└── capture-health.ts         # EXTEND: the `terminal` row reports enrollment + mode

src/renderer/src/components/
├── CaptureHealth.tsx         # EXTEND: the terminal row's own-shell line becomes the install entry
└── settings/HooksPanel.tsx   # EXTEND: mode switch, uninstall

test/
├── terminal-enrollment.test.ts    # NEW: pure state machine (mode, stop, pinning)
├── command-class.test.ts          # NEW: pure classifier (sudo/env/proxychains, REPL argv)
└── zsh-auto-capture.pty.test.ts   # NEW: pty-driven interactive zsh, POSIX-only

e2e/
└── terminal-enrollment.spec.ts    # NEW: install journey from the card (ubuntu CI)
```

**Structure Decision**: the adapter stays under `hooks/` beside the existing
shell adapters, with one file per shell (FR-019). The only shared file remains
`hooks/shell-common.sh`, and only for transport and the event contract (FR-020).
RedLog-side work extends `hooks-manager.ts` and the existing capture surfaces
rather than adding a new capture source id — the `terminal` source already
stands for "commands recorded from a terminal", and spec 051's merge of the two
terminals into one row is what this feature fills in.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A second recorder path (relay *and* PTY) | FR-024/FR-025: a PTY-captured command cannot be suspended, so `nc`'s `Ctrl-Z` upgrade and full-session capture cannot both be had | One path for everything either breaks the shell upgrade (PTY for all) or loses `ssh`/`socat` sessions entirely (relay for all). The split is the product decision, not an abstraction |
| Per-terminal state file | FR-022: a stop must survive the next prompt, and terminals must not interleave | Shell variables alone die with a subshell and cannot be read by RedLog to report status |
