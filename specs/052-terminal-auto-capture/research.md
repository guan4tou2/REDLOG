# Phase 0 Research: Terminal Auto-Capture

Everything here was settled against code in this repository or against the
README of `guan4tou2/tlogger-v2` (read 2026-10-05, reference only). Where a
question could not be settled by reading, it is listed under **Open** with the
experiment that settles it — those are the first tasks, not implementation
details to discover later.

## D1. How output reaches the relay without a wrapper

**Decision**: redirect the shell's stdout and stderr through the relay for the
duration of a foreground command, from `preexec`, and restore in `precmd`. The
command itself is **not** launched inside a subshell or a PTY.

**Rationale**: it is the only candidate that satisfies FR-006. The command keeps
the original terminal for stdin and keeps job control, which is what the
`Ctrl-Z` / `stty raw -echo` / `fg` upgrade needs. `tlogger-v2` reports the same
arrangement in prose — "keeps ordinary stdin and job control on the original
terminal... they are not launched inside another shell" — and its 73-check
suite covers job control, binary output and descriptor cleanup, so the shape is
field-tested even though no code is being taken.

**Alternatives considered**:

- *Wrap every command in `redlog-run`* (alias or `command_not_found` hook):
  only catches named commands, misses builtins, pipelines, functions and
  anything invoked by path; the operator's own aliases shadow it.
- *PTY for everything* (`script`): loses local suspension for every command —
  rejected by FR-025.
- *Parse the terminal transcript afterwards*: forbidden by FR-002; the output
  can forge any marker.

## D2. Where the relay body lives

**Decision**: factor the existing `redlog-run` relay (`hooks/shell-common.sh`,
the tee-through-named-pipes block and its Python event builder) into
`hooks/redlog-relay.py`, and have both `redlog-run` and the automatic path call
it. The Python already reads the temp files directly, which is how the current
code avoids every quoting, argv-size and binary hazard; keep that property.

**Rationale**: Principle III and IX — one implementation of "capture a
command's output into an event", not two that drift. `redlog-run` keeps working
for the explicit case and for shells with no automatic adapter.

**Alternatives considered**: a second relay written for the automatic path
(drift, two truncation behaviours); leaving the relay in shell (the current
quoting and binary hazards get worse once every command goes through it).

## D3. Command classification

**Decision**: a pure classifier over the command's argv that returns
`relayed | pty | native`, with lists the operator can edit. Defaults follow
what `tlogger-v2` learned in the field:

| Class | Default members | Why |
|---|---|---|
| `native` | `nc`, `ncat`, editors and pagers (`vim`, `vi`, `nvim`, `nano`, `less`, `more`), bare REPLs | `nc` must keep local suspension (FR-025); editors record redraws, not content (FR-026) |
| `pty` | `ssh`, `socat`, `pwncat-cs` | they bring their own TTY, so a PTY capture is lossless; the suspension cost is acceptable for them |
| `relayed` | everything else, including a REPL given a script, `-c`, `-m` or `-e` | FR-027 |

**Rationale**: the deciding constraint is not implementation cost — a
PTY-captured command cannot be suspended, so the list *is* the product
decision. Defaults that record `nc` would silently destroy the shell upgrade
mid-engagement.

**Must hold**: the classification survives `sudo`, `env`, `proxychains` and an
absolute path (FR-027), so the classifier walks prefix wrappers before it looks
at the program name.

**Alternatives considered**: classify by TTY probing at runtime (cannot know
before the command starts, and `isatty` is true for both classes); capture
everything and let the operator exclude (first `nc` upgrade of the engagement
is already broken by then).

## D4. Enrollment, mode and durable stop

**Decision**: one machine-level enrollment (the adapter sourced from the user's
`.zshrc` by the existing `shell-source` install method in
`src/core/hooks-manager.ts`), carrying a mode — `auto` or `manual` — and a
per-terminal state file under `~/.redlog/` keyed by the terminal's session id.
A stop writes that file; the next `preexec` reads it. Mode changes at runtime
without reinstalling.

**Rationale**: FR-021 … FR-023. The state cannot live only in shell variables:
a subshell loses them, and RedLog needs to read status to answer the card.
`tlogger-v2` arrived at the same surface (`tlogger_mode`, `tlogger_start`,
`tlogger_stop` durable in auto mode, `tlogger_status`), which is the evidence
that the two modes are not an unnecessary choice.

**Alternatives considered**: auto-only (an operator who cannot stop one
terminal without uninstalling will not run it); manual-only (this is the
friction the feature exists to remove).

## D5. Project identity and the switch hazard

**Decision**: pin engagement and operator identity at terminal start, the way
spec 022 pins it at launch. On a project switch, an already-open terminal stops
recording and says so; it never writes into the new project.

**Rationale**: FR-010, and spec 022 already has this contract verified — this
feature must not weaken it. `hooks/shell-common.sh` already reads an identity
file at send time, so the change is to capture identity once per terminal and
compare, not to invent a mechanism.

**Open**: whether a stopped-by-switch terminal should offer a one-command
re-bind to the new project, or require a new terminal. Decided in tasks; the
safe default (new terminal) ships first.

## D6. Honest degradation

**Decision**: reuse the existing spool. If the POST fails the event goes to
`~/.redlog/pending` and RedLog replays it on next project open — already built
(`hooks/shell-common.sh:102`). If the *relay* cannot run (no Python 3, a failed
`mkfifo`, an unwritable temp dir), the command runs untouched and the terminal
says recording stopped, once, not on every prompt.

**Rationale**: FR-009 and Principle VI. The current `redlog-run` already falls
through to `command "$@"` when `mkfifo` fails; the automatic path inherits that
shape.

**Must hold**: the shell reports the command's own exit status, never the
relay's.

## D7. Where this deliberately diverges from `tlogger-v2`

This is a refactor of RedLog's own capture path, not a port. `tlogger-v2`
settled questions about *shell behaviour* — what breaks job control, what a
PTY costs, how REPLs should be classified — and those answers are taken. Its
answers about *where things live* were made for a tool that writes a text log,
and RedLog has an evidence store, so they are not.

| `tlogger-v2` | This feature | Why |
|---|---|---|
| Capture list is a `TLOGGER_PTY_CMDS` array the operator edits in `.zshrc` | Class policy lives in RedLog's config; the shell reads what RedLog wrote | Principle III: one canonical policy that the card can show, Settings can change, and every adapter reads. An array per shell drifts per shell |
| PTY capture via `script(1)` | PTY class uses `hooks/redlog-session.py` | Spec 022's recorder is already verified: bounded output, pinned identity, pause honoured at receipt. `script` would be a second recorder with different semantics and no identity pinning |
| Writes `~/Desktop/logs/session_*.log` | Writes events only | A second plaintext record that is not chained is a liability, not a backup — it is exactly the "two records that disagree" problem this product exists to avoid |
| `tlogger_note` writes `### NOTE ###` into the log | Dropped unless it maps onto RedLog's existing marker path | RedLog already has operator-attributed markers in the chained store |
| `tlogger_grep` searches log files | Dropped | RedLog has search over the event store |
| State is shell-local | State file RedLog can read | So `redlog status` in the terminal and the capture card answer from one source (Principle II) |
| Markers in the stream carry meaning (its README says so, and says they are forgeable) | No in-band marker is ever read | FR-002. This is the single most important divergence |

**Open**: `redlog-run`'s current bound is 100 KB per stream. That was chosen for
a wrapper used on purpose, a few times per engagement. Once every command is
relayed, an `nmap -A` or a `ffuf` run will hit it routinely. Revisit the bound
(and whether a bounded head+tail beats a bounded head) before this ships —
listed as a task, not assumed here.

## Open questions (settled by experiment, first tasks)

- **O1. Descriptor restore across an interactive pager.** A pager such as Git's
  `less` may put the output terminal into raw/cbreak mode. The relay must
  forward those keys and restore terminal settings on exit. Experiment: drive
  `git log` with a real pty, check `stty -g` before and after.
- **O2. End-of-output ordering.** `command_end` must not be written before the
  relay has flushed the command's output, or the body lands under the next
  command. Experiment: a command that writes a large burst and exits
  immediately; assert ordering by sequence number, not by wall clock.
- **O3. Background output.** Output from `cmd &` must not be attributed to the
  foreground command (FR-007). Experiment: start a background writer, run a
  foreground command, assert the background bytes carry no command id.
- **O4. Nested shell.** A `zsh` inside an enrolled terminal must not silently
  fold into the parent's record (spec Edge Cases). Decide: a nested shell gets
  its own terminal session id, or is declined with a reason.
- **O5. CI reach.** The adapter tests need an interactive zsh on a pty. CI runs
  e2e on ubuntu only, and this repo's POSIX-fixture specs already carry
  `test.skip(process.platform === 'win32', …)`. Decide where the pty suite runs
  (unit job on ubuntu vs. the e2e job) before writing it, so it is not written
  twice.
