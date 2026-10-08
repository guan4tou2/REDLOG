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

## Operational Verification

Risk surface: **capture / packaging**

This feature is a capture source and it ships new files, so both apply. It
also answers `docs/domain/SPEC-capture-source-lifecycle.md`, which T041
extended with the per-terminal axis this spec introduces.

Sections of RELEASE-SMOKE-TEST.md run, and the result:

> **Not yet run — T044/T045.** This is the gap that keeps the spec at Draft.
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
> 3. **A scripted engagement of ≥100 commands** for SC-002/SC-003.
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
