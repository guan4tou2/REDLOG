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
| cost of the relay | **mean 479 ms, p95 496 ms, max 1522 ms** per command; 48.5 s for the engagement — *with pipes*. With the pty relay (#288), two runs: mean 544 ms / p95 616 ms and mean 616 ms / p95 870 ms; still 100 of 100 both times. The spread between runs is as large as the difference from pipes, so this is "tens of ms more", not a measured constant |

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
