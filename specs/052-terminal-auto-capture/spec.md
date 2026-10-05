# Feature Specification: Terminal Auto-Capture

**Feature Branch**: `feat/052-terminal-auto-capture` (not yet opened)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Set up once, then the operator's normal terminal use is recorded — command, output, timing, working directory and exit code — with no per-command prefix and no wrapper to remember. Our own lightweight implementation, not a port of the operator's `tlogger-v2`.

> **Relationship to spec 022 (Explicit External Session Recording):** 022 stands.
> Its PTY recorder, bounded output, pinned project identity and pause semantics
> are what this feature makes *automatic* for the common case. `redlog-session`
> remains the explicit path for a single command or a host where enrollment is
> not wanted.

## Problems (verified on `6afbfc3`)

1. **The transparent path records the command line, not what it did.**
   `hooks/shell-common.sh` sends `command_start` / `command_end` with the
   command, exit code, duration and cwd. stdout and stderr are not in it. A
   timeline of an engagement therefore shows that `nmap -sV 10.10.11.24` ran
   and nothing about what it found.
2. **The path that does record output has to be remembered, per command.**
   `redlog-run <cmd>` (`hooks/shell-common.sh:127`) and `redlog-session`
   (spec 022) both work and both require the operator to type something extra
   before the thing they actually wanted to run. An engagement is hundreds of
   commands; the ones that were not prefixed are silently metadata-only, and
   the operator finds out when they write the report.
3. **The capture card now names the gap and has nowhere good to send anyone.**
   The `terminal` source row says "your own terminal is not in the record —
   install the shell hook and its commands land too". Installing that hook
   delivers problem 1: command lines only.
4. **RedLog already demonstrates the experience it does not offer.** Its own
   terminal panes record command *and* full output as a replayable cast with
   nothing to install. The operator's own terminal — where the work actually
   happens on a Kali box — is the one that cannot.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enroll once, then just work (Priority: P1)

An operator on Kali opens RedLog, opens a project, and chooses the single
offered way to record their own terminal. They approve one install, RedLog
proves capture with a real recorded command, and the setup is over. From then
on they open a terminal the way they always do and run commands the way they
always do; command, output, exit code, working directory and timing arrive in
RedLog by themselves.

**Why this priority**: It is the whole feature. Without it the operator is
still choosing between a prefix they must remember and a record that is
missing its evidence.

**Independent Test**: On a Kali VM with RedLog and a project open: run the
install, open a *new* terminal, run `whoami` and a command with substantial
output (`nmap -sV <host>`), and confirm both appear in the timeline with their
output attached, exit code, cwd and duration — with nothing typed before the
command.

**Acceptance Scenarios**:

1. **Given** an enrolled machine and a newly opened terminal, **When** the
   operator runs a command that writes to stdout and stderr, **Then** the
   timeline shows one command record carrying both streams, the exit code, the
   working directory, the start time and the duration.
2. **Given** an enrolled machine, **When** the operator runs a command with no
   prefix and no wrapper, **Then** the record is indistinguishable in
   completeness from one produced by `redlog-session`.
3. **Given** a terminal opened *before* enrollment, **When** the operator runs
   a command in it, **Then** that terminal is not recorded and does not claim
   to be; the operator is told that already-open terminals are not enrolled.
4. **Given** an enrolled terminal, **When** the operator runs a command whose
   output exceeds the capture bound, **Then** the record carries what was
   captured and is marked truncated, never silently shortened.

---

### User Story 2 - Know what it is recording, and stop it (Priority: P2)

The operator can see, from the terminal itself, which RedLog project the
terminal is recording into, and can pause recording for that terminal — or
for the machine — without closing the terminal or uninstalling anything.

**Why this priority**: A recorder the operator cannot see or stop is one they
will work around, and an engagement contains work that must not be recorded
(a personal password typed into an unrelated service, a client system outside
scope).

**Independent Test**: In an enrolled terminal, read the status indicator,
pause, run a command, confirm nothing was recorded and the operator can tell
that nothing was recorded, resume, run a command, confirm it lands.

**Acceptance Scenarios**:

1. **Given** an enrolled terminal, **When** the operator asks what it is doing,
   **Then** it states the project it is recording into and whether recording is
   currently on.
2. **Given** an enrolled terminal, **When** the operator pauses recording,
   **Then** subsequent commands are not recorded, the terminal keeps working
   normally, and the pause is itself visible in the record as a gap with a
   reason.
3. **Given** a paused machine, **When** the operator resumes, **Then** new
   commands record again and the gap's end is attributable.

---

### User Story 3 - Fail loudly, never take the shell down (Priority: P3)

When RedLog is closed, unreachable, or the recorder breaks, the operator's
terminal keeps working exactly as before and says, once, that recording has
stopped.

**Why this priority**: A recorder that can cost someone their session during a
live engagement will be uninstalled, and an engagement silently recorded into
nothing is worse than one visibly not recorded.

**Independent Test**: With an enrolled terminal mid-session, quit RedLog, run
commands, confirm the shell behaves normally and the operator is told recording
stopped; restart RedLog and confirm recording resumes without re-enrolling.

**Acceptance Scenarios**:

1. **Given** an enrolled terminal, **When** RedLog is not reachable, **Then**
   commands run normally, the operator is told recording has stopped, and the
   message does not repeat on every prompt.
2. **Given** a recorder failure mid-command, **When** the command finishes,
   **Then** the shell reports the command's own exit code, not the recorder's.
3. **Given** recording that stopped and later resumed, **When** the operator
   reads the timeline, **Then** the interruption is visible as a gap rather
   than absent.

---

### Edge Cases

- **Job control must survive.** `nc -lvnp 4444`, then `Ctrl-Z`, `stty raw -echo`,
  `fg` — the standard shell-upgrade sequence — must behave exactly as it does
  without the recorder. This is the first thing an operator does on a reverse
  shell and the first thing a naive output relay breaks.
- **Background output does not belong to the foreground command.** `cmd &`
  writing to the terminal while another command runs must not be attributed to
  that command.
- **Redirected output never reaches the terminal.** `cmd > out.txt` produces a
  record with no output; it must say the output was redirected, not imply the
  command was silent.
- **A project switch must not re-attribute an open terminal.** A terminal
  enrolled against project A keeps writing to A, or stops; it must never
  silently start writing into project B.
- **Interactive full-screen programs** (`vim`, `msfconsole`, `less`) produce
  screen redraws, not a transcript.
- **A PTY-captured command cannot be suspended.** Anything run under a PTY
  wrapper owns its own terminal, so `Ctrl-Z` is handled inside it and the local
  shell never comes back. This is why `nc` must stay native: the capture and the
  shell upgrade cannot both be had.
- **A nested shell inside a recorded terminal** must not be silently folded into
  the parent's record as if it never happened.
- **A REPL launched bare** (`python3`, `mysql`) is a full-screen prompt; the
  same binary given a script or `-c`/`-e` runs and exits, and its output is
  evidence.
- **Binary or control-heavy output** (`cat /bin/ls`, a progress bar) must not
  corrupt the record or the operator's terminal.
- **A remote shell** (`ssh host`) is observed as terminal output of one local
  command, never as individually instrumented remote commands.
- **Two terminals at once**, and a terminal left open for hours, must stay
  distinguishable and must not interleave into one record.

## Requirements *(mandatory)*

### Functional Requirements

**Recording**

- **FR-001**: A command run in an enrolled terminal MUST be recorded with its
  command line, start time, duration, working directory, exit code and output,
  with no prefix, wrapper or other action by the operator.
- **FR-002**: Output MUST be recorded as separate, ordered events correlated to
  the command by a terminal-session identifier, a command identifier and a
  sequence number — never by parsing text out of the terminal stream. Command
  output can forge any in-band marker, so no in-band marker may be the source
  of an evidentiary claim.
- **FR-003**: Raw output MUST be preserved as captured; any ANSI-cleaned form
  MUST be presentation only, and the surface showing it MUST say which it is
  showing.
- **FR-004**: Every record MUST declare its completeness in the existing
  vocabulary — complete, truncated, or metadata only — and truncation MUST
  state what bound was hit.
- **FR-005**: The recorder MUST NOT record input keystrokes (spec 022's rule):
  output and command lines only.

**Not breaking the shell**

- **FR-006**: Job control, terminal modes and signal handling MUST behave as
  they do without the recorder, including the `Ctrl-Z` / `stty` / `fg`
  sequence on an interactive listener.
- **FR-007**: Output written while no foreground command is running, or by a
  background job, MUST NOT be attributed to a command.
- **FR-008**: A command whose output was redirected away from the terminal MUST
  be recorded as such rather than as a command that produced nothing.
- **FR-009**: If recording fails for any reason, the command MUST still run,
  the shell MUST remain usable, the operator MUST be told once that recording
  stopped, and the shell MUST report the command's own exit status.

**Identity and control**

- **FR-010**: A terminal MUST pin the project and operator identity it was
  enrolled against; after a project switch it MUST stop recording rather than
  write into the newly active project.
- **FR-011**: The operator MUST be able to see, from the terminal, which
  project it is recording into and whether recording is on.
- **FR-012**: The operator MUST be able to pause and resume recording without
  closing the terminal, and a pause MUST be visible in the record as an
  attributable gap.
- **FR-013**: Enrollment MUST apply to terminals opened after it; terminals
  already open MUST NOT be silently recorded, and the operator MUST be told so
  at install time.
- **FR-021**: Enrollment MUST offer two modes, switchable at runtime without
  reinstalling: **automatic**, where every new terminal records, and
  **manual**, where a terminal records only after the operator starts it.
  Automatic is the default, because it is the mode that delivers "set it up
  once and then just work".
- **FR-022**: Stopping recording in one terminal MUST be durable for that
  terminal even in automatic mode — a stop is an instruction, not a pause until
  the next prompt re-enables it.
- **FR-023**: The operator MUST be able to ask a terminal what it is doing and
  get: recording on or off, the mode, and the project it is bound to.

**Setup**

- **FR-014**: Installing MUST be one action, reachable from the capture card's
  `terminal` row and from first-run setup, and MUST be the single main option
  offered for recording the operator's own terminal.
- **FR-015**: Setup MUST prove itself with a real recorded command before
  declaring success, and MUST NOT report success from the presence of an
  installed file.
- **FR-016**: Uninstalling MUST be one action and MUST leave the operator's
  shell configuration as it was.

**Interactive programs**

- **FR-024**: Every command MUST fall into one of three handling classes, and
  the record MUST say which one it fell into:
  1. **relayed** — the ordinary path: output recorded, job control untouched;
  2. **PTY-captured** — the program gets its own terminal and its session is
     recorded, at the cost of local suspension (`Ctrl-Z` no longer returns to
     the shell);
  3. **native** — run untouched, with the command, timing, cwd and exit code
     recorded and the output marked *metadata only*.
- **FR-025**: `nc` and `ncat` MUST default to **native**. The shell upgrade —
  `Ctrl-Z`, `stty raw -echo`, `fg` — is worth more than the transcript, and a
  PTY capture cannot have both. The record MUST say the session body was not
  captured rather than leaving a silent command.
- **FR-026**: Full-screen editors and pagers MUST default to **native**:
  capturing them records screen redraws, not content.
- **FR-027**: A REPL-style program MUST be classed by how it was invoked —
  bare is a full-screen prompt (native), the same binary given a script,
  `-c`, `-m` or `-e` runs and exits (relayed) — and that classification MUST
  hold through `sudo`, `env`, `proxychains` and an absolute path.
- **FR-028**: The operator MUST be able to move a command between classes, and
  MUST be told what it costs when they move one into **PTY-captured** (loss of
  local suspension).
- **FR-029**: The recorder MUST stand down and run the command untouched when
  it cannot record faithfully — recording off, the command in a pipeline, its
  input or output redirected, or a required runtime missing — rather than
  changing what the command does.

**Scope of delivery**

- **FR-017**: Kali with zsh MUST be delivered and verified on real hardware or
  a real VM, not only in unit tests.
- **FR-018**: A platform that is not verified MUST NOT be offered as if it
  were; the capture surfaces MUST say what the current machine can actually do.
- **FR-019**: Each shell MUST have its own recorder script. One script MUST NOT
  be written to serve several shells.

  The mechanisms are not the same thing wearing different names: zsh has
  `preexec`/`precmd`, bash has a `DEBUG` trap plus `PROMPT_COMMAND`, fish has
  events. A script that claims to cover them is exercised in one shell and
  assumed in the rest, and the difference does not announce itself as an error
  — it arrives as a command recorded twice, or a command whose output belongs
  to the previous one, in someone's engagement record. The existing adapters
  already carry the hazard: `hooks/shell-bash-hook.sh` and
  `hooks/shell-zsh-hook.zsh` are separate for exactly this reason, while
  `hooks/shell-common.sh` holds shared transport that both source.
- **FR-020**: What MAY be shared between shells is the event contract and the
  transport (the field set, the identifiers, the local API call, the spool).
  Anything that observes the shell — when a command starts, when it ends, what
  its output was, what the terminal state is — MUST live in that shell's own
  script and be verified in that shell.

### Key Entities

- **Terminal session**: one enrolled terminal from open to close. Carries the
  pinned project and operator, a stable identifier, and its own pause state.
- **Command record**: one command in a session — line, times, cwd, exit code,
  completeness.
- **Output chunk**: an ordered slice of a command's output, correlated to the
  command record, carrying the raw bytes as captured.
- **Enrollment**: the machine-level state that makes new terminals record,
  which the operator can install, inspect and remove.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a fresh Kali box with RedLog installed and a project open, an
  operator goes from "my terminal is not recorded" to a verified recorded
  command in under 5 minutes and one install action.
- **SC-002**: After enrollment, 100% of commands run in a new terminal are
  recorded with command, output, exit code, working directory and timing —
  measured over a scripted engagement of at least 100 commands including
  output-heavy, failing, and long-running ones.
- **SC-003**: Zero commands in that engagement require a prefix, a wrapper, or
  any other action before the command.
- **SC-004**: The `Ctrl-Z` / `stty raw -echo` / `fg` shell-upgrade sequence on a
  live listener completes with the recorder enrolled, with the same keystrokes
  as without it.
- **SC-005**: When recording stops for any reason, the operator learns within
  one command, and no command fails because of it.
- **SC-006**: Every record in the resulting timeline states its own
  completeness; a reviewer can tell a silent command from a redirected one from
  a truncated one from a natively-run interactive one, without leaving the
  event.
- **SC-007**: An operator can stop recording in one terminal, keep working in
  it, and have the other enrolled terminals keep recording — verified with at
  least two terminals open at once, and the stopped one still stopped after the
  next prompt.

## Assumptions

- Kali + zsh is the delivered target, as its own script. Other shells are
  extended one at a time, each with its own script and its own verification;
  native Windows PowerShell keeps its existing Start-Transcript path and is out
  of scope here. "POSIX-compatible" is not a platform claim this feature makes.
- RedLog is running on the same machine and reachable on its local API port,
  the way `hooks/shell-common.sh` already assumes, including its spool for
  back-pressure.
- The operator has a project open; a terminal with no project to record into
  says so rather than queueing indefinitely.
- `tlogger-v2` is a reference for the experience and for the limits it already
  found. It is not a dependency, and none of its code or its in-band text
  format is carried into RedLog.
- Spec 022's bounded-output, pause-at-receipt and project-pinning contracts are
  reused rather than reinvented.

## Clarifications

### Session 2026-10-05

- Q: Does enrollment record **every** new terminal on the machine, or only
  terminals the operator opts into? → A: Both, as a mode chosen at install and
  switchable at runtime — automatic by default, manual available, and a stop
  in one terminal is durable (FR-021 … FR-023). This is the shape `tlogger-v2`
  arrived at (`tlogger_mode auto|manual`, `tlogger_start` / `tlogger_stop` /
  `tlogger_status`), and the reason to follow it is that an operator who cannot
  stop recording in one terminal without uninstalling will not run it at all.
- Q: What does an enrolled terminal do with a full-screen interactive program
  (`vim`, `msfconsole`)? → A: Neither all nor nothing: three handling classes
  with a per-command list (FR-024 … FR-029). The deciding constraint is not
  implementation cost — it is that a PTY-captured command cannot be suspended,
  so capturing `nc` would destroy the `Ctrl-Z` / `stty raw -echo` / `fg`
  upgrade. `tlogger-v2` found this the hard way and keeps `nc` native while
  capturing `socat` and `pwncat-cs`, which bring their own TTY.

### Reference: what `tlogger-v2` already established

Read at `guan4tou2/tlogger-v2` (README, 2026-10-05). It is a reference, not a
dependency: no code and no log format is carried over. What it settled, and
what this spec therefore does not have to rediscover:

- The two-mode enrollment above, and one log per terminal so several open at
  once never interleave.
- PTY capture costs local suspension; `nc` native, `socat` / `pwncat-cs`
  captured.
- Editors and pagers are not worth capturing — redraws, not content.
- REPLs are classified by invocation, and the classification has to survive
  `sudo` / `env` / `proxychains`.
- The relay must keep stdin and job control on the original terminal, keep
  colour on screen while storing cleaned text, and stand down for pipelines and
  redirections.
- Background output arrives wherever it arrives; its position in the file is
  not its position in time.
- A hand-written `precmd()` that prints can land inside the previous command's
  record — hook ordering is part of correctness.
- **Its own markers are forgeable by command output**, which its README states
  plainly ("your own record rather than tamper-evident evidence"). That is the
  one thing this feature must not inherit: FR-002 exists because RedLog's
  records are evidence, so the correlation lives in structured events, not in
  text the target's program could print.
