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

**Found while building the harness (T002), and it is live on main:** the
health probe in `_redlog_resolve_host` (`hooks/shell-common.sh:40`, `:47`) runs
`curl --noproxy '*' -sf --connect-timeout 1` with **no `--max-time`**. A
`--connect-timeout` bounds the handshake, not the wait for a reply — so a
RedLog that accepts the connection and then never answers hangs the operator's
prompt **forever**, on every command. The send itself is bounded
(`--connect-timeout 1 --max-time 2`, `:116`); only the probe is not.

This is reachable today: anything that binds the API port and stalls does it —
the harness hit it by accident, because a collector living in the same process
as a synchronous `spawnSync` cannot answer until the shell it is waiting for
has exited. A half-dead RedLog is the realistic version.

It is an FR-009 violation in the code 052 builds on ("if recording fails, the
shell keeps working"), so the fix belongs with this feature: bound the probe
the way the send already is. Carried as a task.

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

**Settled 2026-10-07 (T006): do not pick a bigger number — externalise.**
`redlog-run`'s 100 KB per stream was chosen for a wrapper used on purpose a few
times per engagement. Once every command is relayed, `nmap -A`, `ffuf` and
`gobuster` hit it routinely, and a truncated scan is the evidence the operator
most wanted.

RedLog already solves exactly this for HTTP bodies, and the answer is not a
truncation limit: `src/core/http-body-store.ts` keeps anything under 4 KB
inline and writes the rest to a file in the project directory, referenced by
`{ sha256, size, file, encoding, truncated }`, with eviction
(`body-eviction.ts`) and the retention sweep already wired. Command output
takes the same path:

- under the inline threshold, the bytes ride on the event as they do today;
- over it, the event carries a reference and `completeness: complete`;
- a hard cap stays, but it becomes a **disk-pressure** cap — a runaway process
  must not fill the operator's disk — and when it fires the event says
  `truncated` with the bound it hit (FR-004), as it does now.

The alternative — raise 100 KB to 1 MB and keep truncating — would have had to
be re-argued the first time someone ran a full-port scan.

## Open questions (settled by experiment, first tasks)

All three of O1-O3 were measured on 2026-10-07 against a **toy relay** — D1's
shape in six lines of zsh, redirecting the shell's own descriptors in
`preexec` and restoring them in `precmd`, with `tee` into a log through
process substitution — driven by the T002 harness on Kali/zsh 5.9. The point
was to learn what the shape does before building on it, and it moved two of
the three answers.

- **O1. Terminal modes — SETTLED (T003): the redirection does not disturb
  them, and `stty sane` is not a restore.** `stty -g` before and after a
  command under the relay is byte-identical, so diverting descriptors costs
  nothing in line discipline — the command keeps the terminal itself, which is
  the whole reason D1 refused a PTY for the ordinary path. Job control came
  through the same way: `sleep 30 &`, `jobs` and `kill %1` all behave.

  The second half is a trap for the PTY class rather than the relay:
  `stty raw -echo; stty sane` leaves settings that **differ** from the
  original. `sane` is a known-good default, not what was there. Anything that
  changes modes has to save `stty -g` and put that back.

- **O2. End-of-output ordering — SETTLED (T004): complete by the next command,
  not provably complete at `precmd`.** A 300 KB burst written straight to the
  terminal is fully in the log — 300,000 bytes, exactly — when the *next*
  command reads it. That rules out the cheap failure where the body lands
  under the following command.

  It does **not** establish that the bytes are there at `precmd` time, which
  is where a naive implementation would send `command_end`, and the experiment
  cannot distinguish the two. So the contract is the stronger one:
  **`command_end` is emitted by the component that owns the bytes, after it
  has drained** — not by `precmd` racing the relay. `tlogger-v2` reports the
  same arrangement ("the relay writes cleaned output before acknowledging the
  end of a foreground command"), which is some evidence the race is real.

- **O3. Background output — SETTLED (T005): the relay cannot tell, so the
  record must say so.** A job started with `&` inherits the relay's descriptor
  at fork time, so its output goes to the `tee` of whichever command was
  running when it started, and arrives inside whichever command is running
  when it writes. Measured twice: a writer started before `echo FOREGROUND_ONE`
  surfaced inside the following `sleep 1`, and one sleeping two seconds
  surfaced inside `sleep 3`, both landing in the log.

  There is no fd-level signal to separate them — the bytes are
  indistinguishable from the foreground command's own. FR-007 therefore cannot
  be met by attribution logic in the relay. The data model's
  `unattributed: true` chunk is not a defensive extra; it is the only honest
  representation, and the UI has to be able to show output that belongs to the
  terminal rather than to a command.
- **O4. Nested shell — SETTLED 2026-10-07 (T007): its own session, with the
  nesting recorded.** The adapter is sourced from `.zshrc`, so a nested `zsh`
  runs it again and naturally mints a second terminal session; the work is to
  write `parent_session_id` on it rather than to prevent it. Declining would
  lose those commands outright, which is worse than either alternative, and
  letting the child inherit the parent's session is what `tlogger-v2` does —
  its README records the cost: "the file will not tell you a subshell was
  involved". Principle VII says the record must be able to.

  One guard carries over from spec 022: the explicit PTY recorder sets
  `REDLOG_EXTERNAL_SESSION=1` and `hooks/shell-zsh-hook.zsh` returns early on
  it, so the child of a PTY capture does not emit a second, unpinned stream.
  The relay marks its own children the same way.
- **O5. CI reach — SETTLED 2026-10-07.** The pty suite is a **vitest** file,
  not a Playwright spec. It needs a shell, the hook files and somewhere for the
  events to land; it does not need Electron, and putting it in the e2e job
  would tie a shell test to a six-minute Electron round.

  It drives zsh through a **Python pty driver** (`pty` is stdlib) rather than
  `node-pty`: node-pty is a native module this repo already fights with
  (`electron-rebuild -w` fails on it), and a shell test that cannot run until a
  native rebuild succeeds is a shell test nobody runs.

  Where it runs:

  | | |
  |---|---|
  | Linux (CI ubuntu job, a Kali box) | directly, `zsh -i` on a pty |
  | This Windows box | through `wsl -d kali-linux`, which is **Kali Rolling with zsh 5.9, python3 and `script(1)` already installed** — the target platform, locally |
  | Anything else | skips with its reason, the way `test/external-session.test.ts` already skips |

  Proved before deciding: a probe `.zshrc` registering `preexec`/`precmd`
  through `add-zsh-hook`, driven by the Python pty driver inside
  `wsl -d kali-linux`, fires both hooks for every command. That is the thing
  that does not happen under `zsh -c`, and it is the whole reason this suite
  cannot be an ordinary unit test.

  The Windows unit job skips it, and that is honest rather than a gap: FR-019
  makes the adapter POSIX-only by design.
