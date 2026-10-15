# Verification: Terminal Auto-Capture

The spec's **Status** line is the verdict; this is the evidence for it.

> **Incomplete.** Operational Verification is the section this feature cannot
> be Verified without, and two of its items need a real Kali VM — T044 (the
> `nc` upgrade) and T045 (the success criteria). Everything else below is
> done. The spec stays **Draft** until those two are filled in.

## RED

Every behaviour started from a test that failed, and the reason it failed is
recorded because "it went red" is not evidence — a test can fail for the wrong
reason and pass for the wrong reason afterwards.

| Behaviour | Test | Why it failed first |
|---|---|---|
| The harness can witness anything at all | `zsh-pty-harness.test.ts` | With no adapter installed, running commands produced **0 events**. This is the RED the rest of the feature is measured against: a harness that cannot fail cannot witness anything. |
| A RedLog that accepts and never answers must not wedge the prompt (FR-009) | `zsh-hook-unresponsive-redlog.test.ts` | `no prompt after echo still-alive` after the full 45 s driver budget. `--connect-timeout` is satisfied by the handshake, so the unbounded probe waited forever — from `preexec`, on every command. |
| The relay's contract survives extraction (T008) | `relay-contract.test.ts` | `python3: can't open file …/redlog-relay.py` — the relay did not exist yet. |
| Output chunks correlate by id, never by their own bytes (FR-002) | `ingest.test.ts` | `_causes` was `undefined`: nothing correlated a chunk to a command. |
| The classifier (FR-025/FR-026/FR-027) | `command-class.test.ts` | `Cannot find module '../src/core/terminal-class'`. |
| The enrollment state machine (FR-010/FR-021/FR-022) | `terminal-enrollment.test.ts` | Import of a module that did not exist. |
| A plain command is recorded with its output (FR-001) | `zsh-auto-capture.pty.test.ts` | `command_start` reached the collector but carried no `command_id`, no `source: auto-relay`, no `class`; `command_end` carried no `stdout`. The events arrived — the automatic path did not exist. |
| Output that lies about itself (FR-002) | same file | `stdout` was `undefined`, so there was nothing to not-believe yet. The structural half (one `command_start`, one `command_end`) already held, because nothing read the stream. |
| A redirected command is not a silent one (FR-008) | same file | Reported `completeness: complete` / `output_disposition: captured` — the record claimed the command printed nothing. |
| An interactive command says so (FR-025/FR-026) | same file | Reported `not-captured`, which is a failure, for something that was a decision. |
| The bound, when it fires (FR-004) | same file | The body was 200 chars with no cap: `REDLOG_MAX_BYTES` did not exist. |
| `ssh` gets a real PTY recorder (D7) | same file | The collector saw `command_start`/`command_end` and **no `session_start` at all**. Proved by commenting out the wrapper install after it was green. |
| A large body is kept whole (T006) | `ingest.test.ts` | `stdout_ref` was `undefined`; nothing externalised. |
| Uninstall is an inverse (FR-016) | `hooks-manager.test.ts` | Every install/uninstall cycle left one more blank line in the rc, and a file with no trailing newline came back with one. |
| `redlog status` answers from the file (FR-023) | `zsh-redlog-command.pty.test.ts` | `zsh: command not found: redlog`. |
| A stop stays stopped (FR-022) | same file | The commands after `redlog stop` were all recorded. |
| The gap is bracketed (FR-012) | same file | No `capture_stopped` / `capture_resumed` existed. |
| The operator is told once when RedLog is unreachable (FR-009) | `zsh-degradation.pty.test.ts` | Told **zero** times. The commands ran; silence was the bug. |
| The relay declines what it cannot hold (FR-029) | same file | A pipeline ending in a pager classified `relayed`, so the pager's stdout became a pipe. |
| The project switch stops the terminal (FR-010) | same file | Commands after the switch were recorded — under the new project. |
| The spool carries the occurrence time | same file | No `source_timestamp` on any payload: a command run while RedLog was closed arrived claiming the time it was replayed. |

Two tests were written and passed on their first run. Both are recorded as
characterisation rather than claimed as RED:

- **T037** (the relay dying under a running command) — the shell already
  survived and already reported the command's own status to both readers. That
  is T020's design working, now pinned.
- **T019's structural half** — one `command_start`, one `command_end` for a
  command whose output forges a header. It held because nothing read the
  stream; the test is what keeps it holding now that a relay carries bytes.

## GREEN

Final run on `docs/052-verification`, branched from `main` after all four
feature PRs merged.

```
npm run typecheck && npm run verify:specs && npm run verify:architecture \
  && npm run verify:i18n && npm test
```

<!-- T047 fills the final numbers here. The last full run before this branch
     was opened, on feat/052-us3-degradation: 3140 passed, 25 skipped, 0
     failed; four gates green; full e2e 101 passed, 4 skipped (5.4 min). -->

Per PR, each with its own full five-gate round and a local e2e round before
pushing:

| PR | Tasks | Unit | e2e |
|---|---|---|---|
| #268 | T001–T017 | 3052 passed | 100 passed, 4 skipped |
| #276 | T018–T028 | 3106 passed | 101 passed, 4 skipped |
| #281 | T029–T035 | 3126 passed | 101 passed, 4 skipped |
| #282 | T036–T040 | 3140 passed | 101 passed, 4 skipped |

CI was green on all four, including both legs of the unit matrix — which
matters here because `test/shell-redlog-run.test.ts` is POSIX-only and skipped
on the Windows development machine, so ubuntu is the first place it runs.

### Where the suite found real defects

Worth naming, because they are the argument for the tests that found them:

- **`classify` read its own `--` separator as the program name**, so *every*
  command classified `relayed` — `nc` and `vim` included, which is FR-025 and
  FR-026 exactly inverted. Found by the first run of the cross-implementation
  agreement test.
- **The same agreement test caught a `NameError`** when the class policy
  became overlay-aware. The adapter suppresses the relay's stderr, so capture
  would have stopped entirely with no error anywhere. Python has no typecheck;
  that test is the one.
- **A comment broke the payload builder twice in one edit.** It is a
  double-quoted shell string: backticks around a function name *ran* it, and
  the follow-up comment quoting the resulting error message ended the string
  early, so **no event was sent at all**.
- **`write_json` never created its parent directory**, so the first terminal
  on a machine wrote no state file and `redlog status` answered "not enrolled"
  forever.
- **ws and tcp bodies had never been in an export bundle.** Both export sites
  listed only `request_body_ref` and `response_body_ref`; consolidating the
  four literal lists into one `BODY_REF_FIELDS` closed a gap that predated
  this spec.
- **A cached capture-health reading outlived the event it should have
  reflected.** `getCaptureHealth()` caches for 750 ms and nothing cleared it on
  a write, while the card does not poll — it re-reads once per batch of new
  events. So if anything else had asked in the previous 750 ms, the card's one
  read showed the state from *before* the event and stayed there until the next
  one. The worst moment is the one this spec is built around: the first command
  from a freshly installed hook, with the card still saying "open a new
  terminal" (FR-015). Found by `e2e/terminal-enrollment.spec.ts`, which passed
  on a quiet machine and failed four times on a busy CI runner on identical
  code. Fixed in #287 by clearing the cache on every publish.
- **The pty driver gave its shell no controlling terminal.** `setsid` without
  `TIOCSCTTY` means Ctrl-Z is only a byte and there is no job control. No
  earlier test needed a signal, so none could find it; the first test that did
  failed identically with and without the adapter, which is what the
  bare-shell baseline is for.
- **A test that could not show its own subject mattered.** The `nc` upgrade
  test passed every behavioural assertion with `nc` moved *out* of the native
  class — suspend, resume and the peer's data all work through a relay too.
  Only `/proc/<nc>/fd/{0,1,2}` told them apart (`tty/tty/tty` against
  `tty/pipe/pipe`). Found by mutating the policy and watching what stayed
  green.

## Operational Verification

Risk surface: **capture / packaging**

This feature is a capture source and it ships new files, so both apply. It
also answers `docs/domain/SPEC-capture-source-lifecycle.md`, which T041
extended with the per-terminal axis this spec introduces.

Sections of RELEASE-SMOKE-TEST.md run, and the result:

- **The relay gave every command a pipe, so a relayed shell was a different
  shell** (#288). `[ -t 1 ]` false, `ls` one name per line and uncoloured,
  `os.get_terminal_size()` raising ENOTTY — all with the adapter loaded and none
  without. Not one of the 3,100 tests could say so: each asserted what was
  *recorded*, and the record was fine. Found by the first run of a differential
  test (same keystrokes, bare zsh against adapter) that was written to look for
  exactly this. Fixed by giving the command a pseudo-terminal per stream.
- **The first pty relay hung `git log`.** `less` takes its keyboard from
  stderr, which was now a pty nobody types into: it drew a page and never read
  a key. Found by a probe that ran a pager, not by reasoning about one — and
  the pipe it replaced had prevented it by accident. The pagers are switched
  off for a relayed command; a mutation that makes that a no-op reproduces the
  hang (`no prompt after sh $HOME/pager.sh`).
- **A `command_end` over about 128 KB is dropped without a trace.**
  `_redlog_send_event` hands the whole event to `python3 -c` as one argv
  string; Linux caps one argument at 128 KiB and the output cap is 8 MiB. The
  exec fails, `|| return 0` hides it, and nothing is spooled — a `seq 40000`
  has no `command_end`, no exit code and no row. It is on `main` too (verified
  with main's hooks), and research.md D2 had said the relay avoids exactly this
  ("argv-size … hazard"). **Not fixed in this change**; it is a separate
  defect in `shell-common.sh`.
  **Update 2026-10-13: fixed in #302.** The body now travels in files, never as
  an argument (`_redlog_send_event` says why at the top), and
  `test/zsh-large-body.pty.test.ts` holds it. The paragraph above is the
  finding as it stood and is kept as history.

### Transparency against a bare zsh (2026-10-12, #288)

`test/zsh-transparency.pty.test.ts`: the same keystrokes in a bare zsh and with
the adapter, on a 30×100 pty, compared. 19 tests.

| | Result |
|---|---|
| `isatty` on 0, 1, 2 | `tty tty tty` in both |
| `ls --color=auto` | coloured in both (checked on the raw bytes, not the cleaned text) |
| `ls` columns, `stty size`, `tput cols`, `os.get_terminal_size()` | identical |
| UTF-8, exit status, aliases, pipeline, redirection | identical |
| Ctrl-C on a relayed `sleep` | `rc=130`, prompt returns — same |
| Ctrl-Z, `jobs`, `fg` on a relayed command | same; the output that arrives after the resume still reaches the terminal |
| stored text | colour removed, a progress line reduced to the line it ended on, stdout and stderr apart, `stdout_bytes` is what the command wrote |
| **different, on purpose** | a pager started by the command is switched off, and `echo $PAGER` on a relayed line reads `cat` — both asserted, with the reason |

Mutation-checked: with cleaning disabled two RECORD assertions fail; with the
slave's `OPOST` left on the byte-count assertion fails (`6` against `4`); with
the pager switch a no-op the pager test fails by timeout.

Not covered: `vim` and `less` typed at the prompt (native class — no relay in
the way, so the only claim is that nothing changed, which the `nc` test's
`/proc` check already makes for `native`), `sudo` and an absolute path (the
classifier's unit tests cover the names; nothing here runs them on a pty), and
anything on a real Kali VM or in the packaged build.

### Done at the pty level (2026-10-12)

Real zsh 5.9 on Kali (WSL), driven through a pty, with the adapter loaded and a
collector standing in for RedLog. This is evidence about the **adapter**; it is
not the packaged build and not a person at a VM.

| | Result |
|---|---|
| quickstart §3(c), the `nc` upgrade (SC-004) | Ctrl-Z suspends, `jobs` shows it stopped, `fg` resumes, the peer's data arrives through the resumed connection, `stty -g` identical before and after — **the same as a bare zsh, compared step for step** |
| `nc` in the record | `class: native`, `completeness: metadata-only`, `output_disposition: interactive`, no `stdout` |
| `nc` holds the terminal itself | `/proc/<nc>/fd/{0,1,2}` are all the pty; relayed they are `tty/pipe/pipe` |
| SC-002/SC-003, a 100-command engagement | **100 of 100** recorded exactly once, with output, stderr, exit code and `redirected` where redirected; one id per start/end pair; **none prefixed**; order preserved |
| cost of the relay | **mean 479 ms, p95 496 ms, max 1522 ms** per command; 48.5 s for the engagement — *with pipes*. With the pty relay (#288), two runs: mean 544 ms / p95 616 ms and mean 616 ms / p95 870 ms; still 100 of 100 both times. The spread between runs is as large as the difference from pipes, so this is "tens of ms more", not a measured constant. **Superseded 2026-10-13 — see "What the adapter costs against a bare shell" below: these were the driver's `ms`, which includes its own 250 ms drain after every prompt, and there was no bare shell beside them. They measured the harness more than the adapter.** |

Both were mutation-checked rather than trusted green. Moving `nc` out of the
native class turns three assertions red (`nc's fd 0/1/2 are tty/pipe/pipe`);
making the relay drop stdout fails the engagement with `#1: stdout lost —
wanted "line-b-1", got ""`.

One result is not RedLog's and is recorded so it is not re-diagnosed: with the
peer connecting two seconds after `fg`, a **bare** zsh leaves `nc` alive after
the peer hangs up (3 of 3). Five seconds and zero are fine. The same happens
with the adapter loaded and with recording stopped, so it is the host — the
socket sits ESTABLISHED with the peer's FIN unacknowledged — and the test ends
`nc` from outside rather than waiting on it.

### What the adapter costs against a bare shell (2026-10-13, #288 / #317 B)

`test/zsh-latency.pty.test.ts` (opt-in, `REDLOG_PERF=1`): the same command run
in a bare zsh and in one with the adapter, through the same driver, timed from
the line being sent to the next prompt being drawn (`prompt_ms` — taken before
the driver's own 250 ms drain). Two rounds each, a cold first command and then
the steady ones. Real zsh 5.9 on Kali (WSL) with a local collector; the adapter
and the harness, **not** the packaged build and not a VM.

Milliseconds at the median; "added" is adapter minus bare, the harness's own
cost being in both:

| shape | n | bare | adapter | **added** | added, mean | added, p95 | cold, adapter |
|---|---|---|---|---|---|---|---|
| prints nothing (`true`) | 60 | 0 | 308 | **308** | 313 | 372 | 355 |
| one line | 60 | 0 | 303 | **303** | 305 | 331 | 350 |
| 2 000 lines (~9 KB) | 40 | 2 | 312 | **310** | 312 | 347 | 357 |
| 200 000 lines (~1.3 MB) | 12 | 78 | 455 | **377** | 396 | 576 | 543 |

(Two independent runs: the first read 315 / 304 / 312 added for the first three
rows, so the figure is stable to about ten milliseconds.)

What this says:

- **The adapter adds about 300 ms to every command, whatever it prints.** Output
  size barely moves it up to ~9 KB; the cost is per command, not per byte. The
  1.3 MB case adds more (about 380 ms) and is the only one that does.
- **plan.md's budget is "under 50 ms for a command that produces no output".
  It is missed by roughly six times.** The earlier "mean 479–616 ms" figure
  could not show this, and had no baseline to subtract.
- A bare shell returns in under a millisecond, so this is the whole of what an
  operator waits for, on this host. It is not a statement about other hosts:
  process start is much cheaper on native Linux than through WSL.

Where the 300 ms goes (a stage profile run in the same shell, a collector that
answers on loopback; medians, ms):

| stage | cost | times per command |
|---|---|---|
| `python3 redlog-relay.py policy` (the class lookup in `_redlog_class_of`) | ~80 | 1 |
| `_redlog_send_event` (a `python3` payload builder + a `curl` POST) | ~51 | 2 (`command_start`, `command_end`) |
| the relay processes and `finish` for a relayed command | ~130 **by subtraction** (315 − 80 − 2 × 51), not timed on its own | 1 |
| `python3 -c pass`, the floor for any `python3` | ~19 | — |

Everything above is a process start. The levers, in the order they are likely
to pay: do the class lookup once per shell rather than once per command; build
the payload without starting `python3` where it can be done in the shell; and
a persistent relay rather than two processes and a `finish` per command. The
first two are done below; the third is not. `NO_OUTPUT_CEILING_MS` in the test
is a line to hold, not the goal — lower it as the gap closes, until it is the
plan's own 50.

#### After the first two levers (2026-10-13)

- **The payload is built by the shell** (`_redlog_build_payload_fast` in
  `shell-common.sh`) for plain events and handed to the python builder, which
  is still the reference, for anything it cannot be sure of: non-ASCII or
  control characters, a body over 32 KB, an `extra` that is not one object, an
  identity file that is not one flat object. `test/shell-payload-fast.test.ts`
  sends 38 events through `_redlog_send_event` once with the python builder
  forced and once without, in bash **and** zsh, and requires the parsed JSON to
  be identical — and requires the shell to take the plain cases and decline the
  hard ones, because a corpus that all fell through to python would pass the
  first half and speed up nothing. Dropping the backslash escape turns eight of
  those red.
- **The class is remembered per command line** (`_redlog_class_of`, zsh), and
  forgotten when the shipped policy or the operator's overlay is replaced: the
  signature is inode, size, mtime and ctime of both, read with zsh's own
  `zstat`, no process. `redlog class` writes the overlay by rename, so its inode
  changes even inside one clock tick. No `zstat`, no cache. An empty answer
  (python failing) is never kept. `test/zsh-class-cache.test.ts` holds the
  cached answer to python's over lines that are hostile as array keys, that a
  hit starts no process, and that an overlay written, replaced or deleted under
  a warm cache is seen; a signature that never changes turns two of those red.
  An overlay edited **in place**, keeping its inode, size and second, would be
  missed; the writer does not do that.

Measured as one command's worth of adapter (`preexec` + `precmd`) in a single
zsh process, the three variants interleaved so machine noise is shared, a live
loopback collector, hooks on the distro disk; 24 runs each, ms:

| variant | median | min | max |
|---|---|---|---|
| before (python payload, class asked every time) | 426 | 338 | 592 |
| + payload built in the shell | 270 | 243 | 394 |
| + class remembered | **196** | 179 | 248 |

That is a bit over half gone (about 230 ms of 426), and still four times the
plan's 50. The pty harness reads 150–240 for the same adapter from one run to
the next on this machine — wider than the steps above — so the table is the
evidence for the steps and the pty test is the line to hold. What is left is
the `python3` that holds the terminal (`pty`), the `python3` that collects it
(`finish`), `mktemp`, and two `curl`s: a persistent relay is the next lever,
and the one that touches job control.

Not measured: time to the first byte of a long-running command's output (the
plan's second budget), and anything on a platform other than this one.

### When recording fails around a command (2026-10-13, #288 / #317 B)

`test/zsh-recorder-failure.pty.test.ts`, on top of what `zsh-degradation`
already holds for a closed RedLog, a dead relay and a RedLog that answers
nothing. Four more ways for the recorder to fail with a command on its way,
each judged by what the operator would notice — the command ran **once** (it
appends to a file and the count is read back), it printed, `$?` is its own, and
the next prompt came back:

| failure | result |
|---|---|
| the payload builder fails every time (`python3` returns 1) | commands run once, output and status intact |
| nowhere to write the spool (a file where the directory should be), RedLog closed | the same |
| a temporary directory cannot be made (`TMPDIR` unusable), so the relay has nowhere to stand | the same |
| RedLog up and answering every event with a 500 | the same, and the adapter did try to deliver |

Mutation-checked: making each of the three silent `return 0` / `2>/dev/null`
paths in `shell-common.sh` end the shell instead turns the matching scenario
red (`pty closed during echo ran >> $HOME/runs; echo first-ok`).

### Still owed

> **Not run — needs a real VM and a person.** This is the gap that keeps the
> spec at Draft. Steps (a), (f), (g) and SC-001's stopwatch are not covered by
> anything above.
>
> What has to happen on a real Kali VM, with the packaged build:
>
> 1. **INSTALL** — from the capture card, one action, and the card must not say
>    "included" until a command from the operator's own terminal has arrived
>    (FR-015). Measures SC-001: under five minutes, one install action.
> 2. **EXTERNAL SHELL** — a plain command recorded with its output and nothing
>    typed in front of it; then `nc` → `Ctrl-Z` → `stty raw -echo` → `fg`
>    (SC-004). **A run that cannot complete that upgrade is not a verified
>    feature, whatever the unit suite says.** The `nc` rows must read
>    `class: native`, `completeness: metadata-only`,
>    `output_disposition: interactive`, with no `stdout`.
> 3. **A scripted engagement of ≥100 commands** for SC-002/SC-003 — done above
>    against a stand-in collector; repeating it against the real RedLog is what
>    this would add.
> 4. **Uninstall** — and `.zshrc` byte-identical afterwards (FR-016). The unit
>    test proves the inverse property; this proves it on a file RedLog wrote.
>
> A partial attempt on 2026-10-08 showed `zsh: suspended nc` and
> `[1] + continued nc`, so job control survived — but the adapter version in
> play was not confirmed and the timeline rows were not read, so it does not
> count. It needs redoing after a reinstall from a packaged build.

## Release Impact

| | |
|---|---|
| User-visible | **yes** — zsh terminals now record command output automatically, and `redlog status\|stop\|start\|mode\|class` are new |
| Breaking | **no** for an operator; `redlog-run` keeps working unchanged, and bash is untouched |
| Packaging affected | **yes** — `hooks/redlog-relay.py` and `hooks/command-class.json` are new support files, in all three `supportFiles` lists, `plugin.json` and `verify-packaged-resources.mjs` |
| CHANGELOG updated | **no — required before this spec is Verified** |
| Upgrade note required | **yes** — an operator with the hook already installed must reinstall to get the adapter that records output; the old one keeps working as metadata-only and says so |
| Packaged smoke required | **yes** — see Operational Verification |

Two contracts were replaced rather than left for someone to find later, which
is the CLAUDE.md rule about changing behaviour:

- `zsh-pty-harness.test.ts` asserted that a hook-recorded `command_end`
  carried **no** `stdout` — "the gap this spec exists to close". Inverted.
- `capture.terminalOwnShellIncluded` read "commands only, redlog-run adds
  stdout/stderr". Rewritten.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | not required: the spec was written from a direction the user stated in full (`terminal-auto-capture-direction`), and Phase 0 turned the open questions into seven experiments (O1–O5, T003–T007) rather than questions | 2026-10-05 |
| Checklist | `checklists/requirements.md` written with the spec | 2026-10-05 |
| Analyze | | |
| Converge | | |

<!-- Analyze and Converge are run before the spec moves to Verified, together
     with T044/T045 and the CHANGELOG entry. An empty row reads as never run,
     and that is the correct reading today. -->


## 2026-10-14 installation follow-up: embedded provenance

A real macOS package recorded an embedded Zsh command as `auto-relay`, losing
its `.cast` enrichment and built-in health provenance. Regression reproduced
this with a real PTY/collector before the fix. `source` now retains
`builtin-terminal`; `captured_by` still names the relay. Ordinary external Zsh
retains `auto-relay`.

`test/zsh-builtin-source.test.ts` (2), `test/zsh-auto-capture.pty.test.ts` (8)
and `test/wsl-manager.test.ts` (9): 19 PASS. The PTY driver now resolves Zsh
from PATH instead of assuming Linux's /usr/bin/zsh on macOS. This is a harness
portability correction, not an excuse to remove behavior assertions.


## 2026-10-14 offline durability and terminal control

Same-second BSD date spool names previously overwrote events. An actual shell
regression reproduces three sends becoming one; the final sender keeps the
time prefix and adds its unique mktemp work ID. All three events and exit 3 now
remain, and large-body tests preserve 229KB / 4MB output. The final installed
macOS copy matches the source hooks and policy byte-for-byte.

The shared native class includes stty so it operates on the controlling terminal.
The transparency harness compares BSD/GNU ls using each platform's real color
options, sanitizes inherited pager settings, and waits for the requested job in
this PTY (not a global process match). Darwin terminal writes are drained while
waiting and closing. All 19 transparency checks pass, including Ctrl-C=130,
Ctrl-Z/jobs/fg, dimensions, separated streams and recorded text.

Full unit suite: 3540 PASS / 23 SKIP. Skipped nc-upgrade and platform tests are
not promoted to pass. A fresh Kali Rolling 2026.3 container also records real
ordinary Zsh stdout/stderr/exit 3/shell/completeness, and Bash 5 fast payloads.
This is a container capture check, not Kali GUI/package or native WSL acceptance.
#332 tracks the offline durability defect; this local diff is not released.


## 2026-10-14 packaged recording follow-up

A fresh installed macOS candidate (DMG SHA-256 61e175daa81fed2077ce2d9f5a417d3f3864f8e2e86be6421106ef14cbac5875)
runs 100 ordinary Zsh commands through the installed adapter and writes to
the actual App project. All 100 command_end rows are unique and retain
stdout; 90 preserve exit 0, 10 preserve exit 3; 20 exercise stderr, including 10 direct builtin writes. The 100-command
recording interval took 55,146ms. This is an already-prepared macOS host,
not SC-001's fresh Kali install or a native Kali GUI acceptance claim.

The explicit PTY helper now confirms child exit before closing the master
on EOF/EIO. Fault-injected first reads with a real child, actual PTY and HTTP
recorder were RED (no terminal/recorded output) and GREEN (both streams,
exit 7, session_end byte counts). All 10 external-session tests PASS, including
Ctrl-C, geometry, pause and truncation. Installed smoke preserves all five
short echo sessions in display, store and search, then ordinary Zsh capture
and profile uninstall.

The original single no-output package failure is retained in #333: its DB
contains session_start and exit-0 session_end with zero bytes, which excludes
helper-not-started/installer delivery hypotheses. Its precise system-call
trace was not captured; the transient-read regression proves a real loss
path, not retrospective certainty about that particular run.


### Automatic relay boundary hardening

The same read-side EOF/EIO assumption also closed automatic stream masters
while their writers were still open. Actual PTY fault-injection was RED: the
next write failed with EIO. A shell completion marker after descriptor restore
now preserves both writable streams and their saved bytes; both fault cases
are GREEN. A retired incomplete work directory ends evidence collection, but
does not close output terminals still held by suspended/background jobs. Part
files must not be recreated after retirement.

The full regression caught an initial cleanup implementation interrupting
Ctrl-Z/fg resumed output; that cleanup was corrected. Final unit run: 349 files
PASS, 4 files SKIP; 3552 tests PASS, 23 tests SKIP. All 19 transparency tests
pass, including Ctrl-C, Ctrl-Z/fg, TTY geometry and direct streams. The explicit
helper's 10 tests and automatic relay boundary's 3 tests also pass.

An earlier full run had one direct-stderr command return exit 1 and lose its
output. Original terminal bytes were not saved. Future failures now include
the exact terminal output in zsh-engagement-100 assertions. No claim is made
that a later green run alone proves that particular run's root cause.

## 2026-10-14 receiving profile and local closeout

Both Bash/Zsh and automatic/Python payload builders previously embedded the
stale Linux HOME identity even when the transport had resolved a different
receiving RedLog profile (four RED cases). Both now use that resolved directory;
161 focused payload/provenance checks PASS. This is a simulated directory
boundary, not native WSL acceptance.

Final local gates: 352 files PASS / 4 SKIP; 3,581 tests PASS / 23 SKIP;
typecheck/spec/architecture/i18n/build PASS. Terminal enrollment and setup
journeys PASS. T047 is complete. The real Kali VM job-control run and full
first-enrollment/100-command measurements (T044/T045) remain explicitly open;
the installed macOS 100-command run is not a substitute for those platform
acceptance criteria.

## 2026-10-15 actual installed Kali ARM64 follow-up

An experimental ARM64 DEB from bae0415 was installed by the operator in an
isolated Kali 2026.3 desktop VM. The published Linux architecture remains x64;
this result does not validate that installer. App/profile fixtures use temporary
homes and the guest network remains disabled.

The actual installed app records 100/100 unique ordinary Zsh commands with
their stdout, 20 stderr writes and correct exits (90 zero / 10 exit 3).
Recording took 52,670ms; enrollment plus verification took 52,828ms. Neither
includes DEB installation or the operator's setup time. Five explicit PTY
sessions, search, profile removal and live-pane project rotation/privacy pass.

The native installed-app nc journey compares real bare/enrolled Linux PTYs:
Ctrl-Z stops the listener, jobs confirms it, raw/fg resumes, peer data arrives,
all descriptors remain terminal descriptors and terminal settings match.
The first journey failed because it asserted start-only `class` on command_end;
the corrected journey checks start classification and end completeness and
passes. No product schema was changed to accommodate the test.

The operator separately completed quickstart step (c) in the visible terminal
and supplied a screenshot. The controller independently observed stop, resume,
terminal descriptors and a valid local chain. Its acknowledgement marker
arrived after its ten-minute limit, so raw `completed: false` is preserved;
human confirmation is separate evidence. Offline remote timestamp anchoring
fails explicitly and is not counted as local-chain failure or anchoring success.

SC-004 has native automated and human evidence. T044 still requires the rest
of the manual quickstart, and T045 still requires SC-001's whole first-enrollment
stopwatch. The feature remains Draft; neither task is blanket-checked.

Final installed Kali group: five journeys PASS in one run, now explicitly
isolating Electron user data and asserting app.isPackaged. It includes actual
HTTP/HTTPS, projection export with the shipped verifier and restart in addition
to ordinary capture, native nc, PTY helper and project rotation. The repeat
100-command interval is 83,956ms (84,047ms enrollment plus verification), under
concurrent host checks; it is not a clean-host performance comparison. HTTP
tools were prepared separately, not installed through the offline guest UI.
