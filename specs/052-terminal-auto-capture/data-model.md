# Phase 1 Data Model: Terminal Auto-Capture

Four entities. Three of them already exist in some form; the table says which,
so nothing is reinvented.

## Enrollment (machine)

What the installer wrote, and the operator's current mode. Lives in
`~/.redlog/` and in the user's `.zshrc` block, read by
`src/core/hooks-manager.ts` the way the current shell hook is detected.

| Field | Meaning | Notes |
|---|---|---|
| `installed` | the adapter is sourced from `.zshrc` | detected, not remembered |
| `mode` | `auto` \| `manual` | switchable at runtime (FR-021) |
| `shell` | `zsh` | one adapter per shell (FR-019); any other value means this machine is not enrolled for that shell |
| `installedAt` | when | for the card's "set up" line |

**States**: `not installed` → `installed (auto)` ⇄ `installed (manual)` →
`removed`. `removed` MUST leave the `.zshrc` as it was (FR-016).

## Terminal session

One enrolled terminal, from open to close. Created in the adapter's startup,
not by RedLog.

| Field | Meaning | Notes |
|---|---|---|
| `sessionId` | stable id for this terminal | already exists: the shell adapters announce a shell session; reuse that identifier rather than minting a second |
| `engagementId`, `operatorId` | pinned at terminal start | FR-010; spec 022 pins the same pair at launch |
| `recording` | on \| off | `off` is durable for this terminal (FR-022) |
| `startedAt`, `pid`, `tty` | provenance | one record per terminal, so two open terminals never interleave |

**States**: `recording` ⇄ `stopped (by operator)` → `stopped (project switch)`
→ `closed`. The two stopped states are distinct: one is a choice, the other is
a protection, and the record says which (Principle VI).

## Command record

Exists today as the `command_start` / `command_end` pair written by
`hooks/shell-zsh-hook.zsh` with `cwd`, `exit_code`, `duration_sec`. This
feature adds the fields the automatic path needs.

| Field | New? | Meaning |
|---|---|---|
| `commandId` | NEW | correlates output chunks to this command (FR-002) |
| `sessionId` | existing | the terminal it ran in |
| `command`, `cwd`, `exit_code`, `duration_sec` | existing | unchanged |
| `captured_by` | existing (`redlog-run`) | gains `auto-relay` and `auto-pty` |
| `class` | NEW | `relayed` \| `pty` \| `native` — what handling it got (FR-024) |
| `completeness` | NEW | `complete` \| `truncated` \| `metadata-only`, with the bound that was hit (FR-004) |
| `outputDisposition` | NEW | `captured` \| `redirected` \| `interactive` \| `not-captured` — why there is no body, when there is none (FR-008) |

**Rule**: `completeness` and `outputDisposition` are never absent. A command
with no output body carries the reason; "no output" and "output not captured"
are different facts and the timeline must not merge them.

## Output chunk

| Field | Meaning |
|---|---|
| `sessionId`, `commandId` | correlation, by identifier only — never by text in the stream (FR-002) |
| `seq` | ordering within the command; the receiver orders by this, not by arrival |
| `stream` | `stdout` \| `stderr` — kept separate, as `redlog-run` already does |
| `bytes` | raw as captured (FR-003) |
| `truncated`, `bytesTotal` | what was dropped and how much there was |

The cleaned, ANSI-stripped text is a **projection** for reading and search. It
is derived at ingest or at read time from the raw bytes; it is not the stored
evidence, and any surface showing it says so (FR-003, Principle I).

## Relationships

```
Enrollment (machine, 1)
   └── Terminal session (N, one per open terminal)
          └── Command record (N, ordered)
                 └── Output chunk (N, ordered by seq)
```

A terminal session belongs to exactly one engagement for its whole life. A
command record never moves between sessions. An output chunk with no matching
command id is kept and marked unattributed rather than dropped — background
output is the case that produces it (FR-007), and dropping it would be an
evidence loss to hide an attribution problem.
