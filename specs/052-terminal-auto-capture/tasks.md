---

description: "Task list for 052 terminal auto-capture"
---

# Tasks: Terminal Auto-Capture

**Input**: Design documents from `/specs/052-terminal-auto-capture/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required, not optional. Constitution VIII — this feature changes
capture semantics, so every behaviour starts from a test that fails for the
intended reason. The pty-driven suite is where most of them live, because these
hooks do not fire under `zsh -c`.

**This is a refactor.** The output relay exists (`redlog-run`,
`hooks/shell-common.sh:127`) and the PTY recorder exists
(`hooks/redlog-session.py`, spec 022, Verified). Tasks that say "extract" mean
move working code, keep its behaviour, and prove it with the tests that already
cover `redlog-run`. Nothing here ports `tlogger-v2`; research.md D7 lists where
this deliberately differs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 / US2 / US3 from spec.md

---

## Phase 1: Decisions that change the shape of everything after them

**Purpose**: research.md's open questions. Each is an experiment, not an
implementation. Doing these later means writing the adapter twice.

- [x] T001 Decide where the pty-driven suite runs and write the decision into `specs/052-terminal-auto-capture/research.md` (O5): a vitest file skipped on win32 like `test/external-session.test.ts`, or a Playwright journey. CI runs e2e on ubuntu only, and the unit job is where `test.skip(process.platform === 'win32', …)` already lives
- [x] T002 Build the pty harness that drives a real interactive zsh and assert it fails without the adapter — `test/helpers/zsh-pty.py` (the driver, stdlib `pty`), `test/helpers/zsh-pty.ts` (shell discovery, the collector, the job) and `test/zsh-pty-harness.test.ts` (four tests: it drives an interactive shell, it reports the command's own exit status, **it records nothing with no adapter installed**, and the existing command-line hook reaches the collector metadata-only)
- [x] T002a Bound the health probe in `hooks/shell-common.sh:40` and `:47`: `--connect-timeout 1` without `--max-time` waits forever on a RedLog that accepts the connection and never answers, hanging the operator's prompt on every command. FR-009. Found by T002; see research.md
      → both probes now carry `--max-time 2`. Pinned by `test/zsh-hook-unresponsive-redlog.test.ts` against `startBlackHole()`, a port that accepts and never answers: unbounded it fails `no prompt after echo still-alive` after the full 45s driver budget, bounded the prompt returns in ~10s with the command's own output intact.
- [x] T003 [P] Experiment O1: capture `stty -g` before and after a paged command under the harness, and record in research.md whether a relay that forwards raw-mode keys restores terminal settings
- [x] T004 [P] Experiment O2: a command that writes a large burst and exits immediately; record whether ordering can be guaranteed by `seq` alone or needs an explicit flush-before-end handshake
- [x] T005 [P] Experiment O3: a background writer plus a foreground command; record what identifies the background bytes so FR-007 can be enforced rather than hoped for
- [x] T006 Decide the output bound for an always-on relay and record it in research.md: `redlog-run`'s 100 KB per stream was chosen for a wrapper used a few times per engagement, and `nmap -A` will hit it routinely. Decide head-only vs. head+tail, and what `limit_hit` says
- [x] T007 Decide the nested-shell rule (O4) and record it: a `zsh` inside an enrolled terminal gets its own session id, or declines with a reason. Silently folding into the parent's record is not an option

**Checkpoint**: research.md has no open questions. Only now does code change.

---

## Phase 2: Foundational — the pieces every story needs

**⚠️ No user-story work begins until this phase is complete.**

- [x] T008 Write the failing test for the extracted relay in `test/relay-contract.test.ts`: same bytes to the terminal, same truncation flags, same byte counts as `redlog-run` produces today
      → four contracts: bytes reach the terminal while the command runs, the caller gets the command's own status, counts are of everything (not of what survived the cap), and non-UTF-8 becomes U+FFFD rather than an exception. Runs through the WSL target, so it runs on the machine this is written on.
- [x] T009 Extract the relay body from `hooks/shell-common.sh` (the named-pipe tee block and its Python event builder, lines ~160-200) into `hooks/redlog-relay.py`, stdlib only, reading the temp files directly as the current code does — this is the quoting/argv/binary hazard it already avoids
      → the pipes are now `subprocess.PIPE` and a `select` loop, which keeps the no-argv property without the fifo dance. `<event-out>.started` is the new signal: it tells the caller the relay took the command, so a failure to *start* one falls through to running it and a failure to *run* one does not run it twice.
- [x] T010 Rewire `redlog-run` in `hooks/shell-common.sh` to call `hooks/redlog-relay.py`, and confirm `test/shell-redlog-run.test.ts` still passes unchanged — if it needs changing, the extraction changed behaviour
      → unchanged. It is POSIX-only and skipped on win32, so `relay-contract.test.ts` runs the same scenario through WSL and asserts the same `command_end` field for field. Two things the extraction did change, both deliberate: the relay launches a process, so a builtin or function now runs in the shell as before and is recorded `metadata-only` / `not-captured` rather than claiming empty output; and `hooks/redlog-relay.py` is a support file, added to all three `supportFiles` lists, `plugin.json` and `verify-packaged-resources.mjs` — missing, every install would quietly stop capturing output.
- [x] T011 [P] Add `command_id` and `seq` to the event contract in `hooks/shell-common.sh` per `contracts/events.md`, and the `command_output` subtype, keeping the existing envelope (`agent_type: 'shell'`, bearer token, identity block)
      → `_redlog_new_command_id` mints one key per command; `command_start`, the relay's `command_end` and every future chunk carry it. The relay fills `completeness` / `output_disposition` / `limit_hit` from what it actually held. **The chunk PRODUCER is not here**: nothing produces chunks until output is routed from `preexec`, and a producer written before its caller would be written twice. It lands with T020; the ingest side is complete and tested without it (T012/T013).
- [x] T012 [P] Write the failing test for ingest of `command_output` in `test/ingest.test.ts`: chunks correlate to a command by id only, out-of-order arrival is ordered by `seq`, and a chunk whose `command_id` matches no open command is stored `unattributed: true` rather than dropped
      → four tests, including a chunk whose bytes claim to belong to another command. One test had to change shape: `insertEvent`'s 2 s dedup window means two identical `command_start`s cannot both land anyway, so the ambiguity the id fixes is pinned where it is real — a `command_end` whose command text no longer matches the start.
- [x] T013 Implement `command_output` ingest in `src/core/ingest.ts` per T012, including the `completeness` / `output_disposition` fields on `command_end` from `contracts/events.md`
      → `command_id` → `command_start` id in `causes-resolver.ts`, consulted first for `command_end` and consulted *only* for a chunk. An unresolved chunk is marked `unattributed` in `ingest.ts` rather than dropped or attached to whatever was open.
- [x] T014 [P] Write the failing test for the pure classifier in `test/command-class.test.ts`: `relayed | pty | native` for every default in research.md D3, the prefix walk through `sudo`, `env`, `proxychains` and an absolute path (FR-027), and bare-vs-argv REPL forms
- [x] T015 Implement the classifier in `src/core/terminal-class.ts` as a pure function over argv, with the default lists from research.md D3 — `nc`/`ncat` native (FR-025), `ssh`/`socat`/`pwncat-cs` pty, editors and pagers native (FR-026)
      → the wrapper walk consumes flags with values (`sudo -u root nc`) and `env`'s assignments, so `sudo nc` classifies as `nc` and not as `sudo`. An empty argv is `native`, not `relayed`: a bare Enter must not route the prompt through a relay.
- [x] T016 [P] Write the failing test for the enrollment state machine in `test/terminal-enrollment.test.ts`: mode `auto` ⇄ `manual`, a stop that survives the next prompt (FR-022), identity pinned at terminal start, and a project switch that stops rather than re-attributes (FR-010)
- [x] T017 Implement the enrollment and per-terminal state in `src/core/terminal-enrollment.ts` plus its state file under `~/.redlog/`, readable by both the shell and RedLog so `redlog status` and the capture card answer from one source
      → one file per terminal under `~/.redlog/terminals/`, written whole and renamed into place. Transitions are one `applyTerminalAction`, because the rules only hold together: a project switch outranks both `start` and `mode auto`, or FR-010's pin is one keystroke deep.
      → **the architecture gate was right about this one.** Most of the module had no production caller, because in the finished design the shell is what reads and writes it. Two real callers exist now and are wired: RedLog's own panes enroll like any other terminal (`terminal-manager.ts`), and the capture card counts them (`capture-health.ts` — T028's core half, which is what makes "RedLog's panes only" distinguishable from "this machine's terminals too"). Three exports are allowlisted with the task that consumes each: `readTerminalEnrollment` (T029), `applyTerminalAction` (T031/T032/T035), `captureDecision` (T020). The gate fails when an allowlist entry stops matching, so each entry removes itself.

**Checkpoint**: the relay, the contract, the classifier and the state machine
exist and are tested without a shell involved.

---

## Phase 3: User Story 1 — Enroll once, then just work (P1) 🎯 MVP

**Goal**: a command run in a new terminal is recorded with its output, with
nothing typed before it.

**Independent test**: on Kali, install from the card, open a new terminal, run
`whoami` and `nmap -sV 127.0.0.1`; both appear with output, exit code, cwd and
duration (quickstart.md §3b).

- [x] T018 [US1] Write the failing pty test in `test/zsh-auto-capture.pty.test.ts`: an enrolled interactive zsh records command, output, exit code and cwd for a plain command with nothing typed before it (FR-001)
      → **red by design until T020** — the suite does not go green again until the routing lands, so T018/T019/T020 are one commit. It fails in the four places it should: `command_start` reaches the collector but carries no `command_id`, no `source: auto-relay` and no `class`, and `command_end` carries no `stdout`. The events themselves already arrive, so the failure is the missing automatic path and not the harness.
      → Decided while writing it: for output this size the body stays INLINE on `command_end`, exactly where `redlog-run` has always put it. `command_output` chunks are the mechanism for output that does not fit (T021, research.md T006) — not a second representation of the same bytes. Two places to read a command's output would be two places for them to disagree, and `ingest.ts:373` (loot scanning) and `TimelineEventDetails.tsx` both read the inline one today.
- [x] T019 [US1] Write the failing pty test for FR-002 in the same file: output arrives as `command_output` chunks correlated by id, and a command whose *output* prints a convincing fake header does not move or split any record
      → the command prints one line that is a plausible RedLog event, a plausible correlation key and a plausible end-of-command marker at once. Four properties: one `command_start` and one `command_end` (a honoured marker would make two), the bytes recorded verbatim, the key still the adapter's own, and the next command's output not dragged into the forged one — nor the forged bytes into the next command's.
      → **the chunk half of this task moved to T021.** For output this size the body is inline on `command_end` (see T018), so "correlated by id" is asserted where correlation actually happens: the id on both ends of the command, minted out of band, never the one the output named. Chunk correlation is already covered without a shell in `test/ingest.test.ts` (T012).
      → Worth noting what already passes: the `toHaveLength(1)` assertions are green today. Nothing in the current adapter reads the stream, so the structural half of FR-002 holds — this test is what keeps it holding once a relay is carrying the bytes.
- [x] T020 [US1] Extend `hooks/shell-zsh-hook.zsh` to route a `relayed` command's stdout and stderr through `hooks/redlog-relay.py` from `preexec` and restore in `precmd`, per research.md D1 — the command itself is not launched in a subshell or a PTY (FR-006)
      → `preexec` saves fds 1 and 2, points them at two `redlog-relay.py pipe` processes through process substitution, and `precmd` puts them back — which is what gives the relays their EOF. The relays are started *before* the diversion so their pass-through lands on the real terminal.
      → O2's contract is honoured by `redlog-relay.py finish`, not by `precmd`: it waits (bounded) for both part files, each written whole and renamed into place, and a part that never arrives is reported `truncated` + `limit_hit: drain-timeout` rather than as empty output.
      → **the class policy got one home**, `hooks/command-class.json`. `src/core/terminal-class.ts` imports it; `redlog-relay.py classify` reads it beside itself; the adapter splits the line with zsh's own `${(z)…}` so the classifier sees the argv zsh will run. Added to all three `supportFiles` lists, `plugin.json` and `verify-packaged-resources.mjs` — missing, every command falls back to `native` and capture stops with no error anywhere.
      → **the walks are still two implementations, and the new agreement test caught a real one immediately.** `classify` was reading its own `--` separator as the program, so *every* command classified `relayed` — `nc` and `vim` included, which is precisely FR-025/FR-026 inverted. `test/command-class.test.ts` now runs all 25 defaults through both sides and compares.
      → **contract replaced, not follow-up work**: `test/zsh-pty-harness.test.ts` asserted `stdout` was *undefined* on a hook-recorded `command_end` — "the gap this spec exists to close". The gap is closed, so the assertion is inverted in this commit (CLAUDE.md, *Changing behaviour*).
      → Noted, not fixed: a relayed command now costs four `python3` spawns (classify, two pipes, finish) plus the existing payload build and `curl`. On a native Kali that is cheap; through WSL from Windows it is ~3 s per command in the harness. If it shows up on a real prompt, the classify spawn is the one to remove first — a shell-side fast path for the common case, with the relay as the authority.
- [x] T021 [US1] Write the failing pty test for truncation (FR-004) with the bound decided in T006, then make `command_end` carry `completeness` and `limit_hit`
      → T006 decided not to pick a bigger number but to externalise, so the bound changed meaning rather than value. 100 KB → 8 MiB per stream, and what is left is a **memory** bound on the relay (two are resident while a command runs) so a runaway `yes` is stopped rather than growing until something else fails. It is overridable by `REDLOG_MAX_BYTES`, which is how the pty test hits it without producing eight megabytes through a pty.
      → anything over the inline threshold is kept **whole** on ingest, in the body store HTTP bodies already use, with `{sha256, size, file, encoding}` on the event. `nmap -A` arrives routinely now; a truncation limit would have to be re-argued the first time someone ran a full-port scan.
      → **the ref fields were the real work.** A body-store reference has to be known to four things that are nowhere near each other: the FTS index, the retention sweep (a file nothing pins is evicted out from under its event), the export plan and the attachment manifest. They each carried their own literal list, so adding two fields meant editing four lists correctly or losing evidence quietly. They now read one `BODY_REF_FIELDS` from `http-body-store.ts`. Doing that also fixed a pre-existing gap: the two export sites listed only `request_body_ref` and `response_body_ref`, so **ws and tcp bodies were never in a bundle**.
      → the renderer reads the refs too (`RefBackedStream`, at module scope — a component declared inside another is a new type every render). Without it everything over 4 KB would simply vanish from the detail pane, which is a worse bug than the one being fixed.
      → the store directory is still called `http-bodies` although it is now the body store for command output as well. Renaming it would orphan every existing project's files for a cosmetic gain.
- [x] T022 [US1] Write the failing pty test for `cmd > out.txt` (FR-008), then record `output_disposition: redirected` — a redirected command is not a silent one
      → `looks_redirected()` in the relay reads the command LINE — what the operator typed, never the command's output — and only reports `redirected` when no stdout arrived either. The pty test also reads the file back, because a capture tool that swallowed the operator's redirection would be worse than one that mislabelled it.
      → the distinctions are fiddly and each one is silent when wrong, so `relay-contract.test.ts` carries the table: `2>`/`2>>` leave stdout alone, `>&2` is a dup onto a descriptor the relay still holds, `&>` takes both, `| tee f` is not a redirection, `echo 2 > out.txt` is (the `2` is a word, not a descriptor), and `>` inside either kind of quote is not.
      → `redlog-run cmd > f` is unaffected and still `captured`: there the relay is upstream of the file, so it holds the bytes on their way through.
- [x] T023 [US1] Write the failing pty test for a `native`-class command (FR-025/FR-026), then emit the command with `output_disposition: interactive` and `completeness: metadata-only`; the body is absent and the record says why
      → `interactive` is a decision, `not-captured` is a failure, and collapsing them would make every deliberate silence look like a broken capture and every broken capture look deliberate (Principle VI). The `pty` class reports `interactive` too until T024 routes it to the session recorder.
      → the test uses `vim --version` so the thing exits; classification is on the program name, so it is the same `vim` that would have been left alone with a file open.
      → **the harness hit its own limit here and it had to be fixed to trust the result.** Five test files now drive a shell, vitest starts them in parallel, and on Windows each one is `wsl.exe`. The interop service starts refusing sessions — `Wsl/Service/0x8007274c` — and returns that text on stdout in the console code page, which arrives spliced into the next command line as mojibake: a `python3` that cannot open a garbled path, naming everything except what went wrong. Worse, a refused *probe* made `findShellTarget` return null and the whole file skip, which reads as green. Three changes, all in `test/helpers/zsh-pty.ts`: `wslpath` is gone (the translation is `C:\x` → `/mnt/c/x`, and spawning a Linux process to do it was most of the storm), the capability probe is one retried `wsl.exe` instead of two unretried, and the remaining WSL work is serialised across processes by a lock directory. On Linux no lock is taken, so CI is unaffected — and the files got faster: `relay-contract` went from 22 s to 7 s.
- [x] T024 [US1] Wire the `pty`-class path to `hooks/redlog-session.py` rather than `script(1)` (research.md D7), reusing its bounded output, pinned identity and pause-at-receipt
      → **the mechanism had to be decided here, and it is not `preexec`.** zsh gives `preexec` no way to replace the command that is about to run, and the PTY class is the one case that needs replacing rather than diverting. So: one shell function per program in the policy's `pty` list, installed at startup from `redlog-relay.py policy --field pty`. That is precisely what research.md D3 rejected for the *general* case — a function misses builtins, pipelines and anything invoked by path — and for a short explicit list it is the right tool. The limitation is honest rather than hidden: `sudo ssh` and `/usr/bin/ssh` miss the wrapper, classify as `pty`, and are recorded `interactive` like any other command whose body was never held.
      → wrappers are installed only for programs that are actually on the machine; a function named `ssh` on a box without ssh turns "command not found" into a python traceback.
      → **`redlog-session.py` gained `--best-effort`**, and it is the difference between a logger and a gate. The recorder refuses to start when capture is paused or RedLog is unreachable, which is right when an operator *asked* to record — but under the automatic wrapper this path is reached by an `ssh` the operator typed for their own reasons. Refusing to run it would be the audit tool deciding what the engagement may do. With the flag it prints why and `execvp`s the command, so the operator's exit status is the command's own; the same flag turns "already inside a redlog-session" from an error into the ordinary case it now is.
      → proved red before green by commenting out the wrapper install: without it the collector sees only `command_start`/`command_end` and no `session_start` at all.
- [ ] T025 [P] [US1] Add the install action to the capture card's `terminal` row in `src/renderer/src/components/CaptureHealth.tsx`, replacing the "your own terminal is not in the record" line with the one-action install (FR-014)
- [ ] T026 [P] [US1] Extend `src/core/hooks-manager.ts` to install, detect and uninstall the enrolled adapter through the existing `shell-source` method, and to leave `.zshrc` byte-identical on uninstall (FR-016)
- [ ] T027 [US1] Make setup prove itself: the install flow is not "done" until a real recorded command has arrived (FR-015), reusing the first-run verification contract from spec 039 rather than a second one
- [ ] T028 [US1] Report enrollment on the `terminal` source in `src/core/capture-health.ts` so the card distinguishes "RedLog's panes only" from "this machine's terminals too"

**Checkpoint**: US1 is the MVP. Everything after this is control and honesty.

---

## Phase 4: User Story 2 — Know what it is recording, and stop it (P2)

**Goal**: the terminal says what it is doing, and the operator can stop it.

**Independent test**: quickstart.md §3e — status, stop, a command that is not
recorded, status again, start, a command that is.

- [ ] T029 [US2] Write the failing pty test: `redlog status` prints recording state, mode and bound project, read from the state file and not from a shell variable (FR-023, contracts/shell-commands.md)
- [ ] T030 [US2] Write the failing pty test: `redlog stop`, then a command, then a *new prompt*, then another command — neither is recorded (FR-022, the durable stop)
- [ ] T031 [US2] Implement the single `redlog` shell function with subcommands `status`, `start`, `stop`, `mode`, `class` in `hooks/shell-zsh-hook.zsh` — one name defined, which is what makes uninstall verifiable (contracts/shell-commands.md)
- [ ] T032 [US2] Write the failing test then implement `redlog mode auto|manual` switching at runtime without reinstalling (FR-021), with `auto` the installed default
- [ ] T033 [US2] Write the failing test then implement `redlog class list|add|remove`, reading the policy RedLog wrote rather than a shell array (research.md D7), and warning that moving a command into the pty class costs local suspension (FR-028)
- [ ] T034 [P] [US2] Surface mode and the class policy in `src/renderer/src/components/settings/HooksPanel.tsx` so the card, Settings and the shell all read one policy
- [ ] T035 [US2] Write the failing pty test then implement the pause gap: a stop is visible in the record as an attributable gap, not as silence (FR-012)

---

## Phase 5: User Story 3 — Fail loudly, never take the shell down (P3)

**Goal**: a broken recorder costs the operator nothing but the recording.

**Independent test**: quickstart.md §3 — kill RedLog mid-session, keep working,
one message, spool fills, restart and recording resumes without re-enrolling.

- [ ] T036 [US3] Write the failing pty test: with RedLog unreachable, commands run normally, the operator is told once, and the message does not repeat on every prompt (FR-009)
- [ ] T037 [US3] Write the failing pty test: the shell reports the *command's* exit status, never the relay's, including when the relay dies mid-command
- [ ] T038 [US3] Implement the stand-down path in `hooks/shell-zsh-hook.zsh`: no Python 3, a failed `mkfifo`, an unwritable temp dir, recording off, a pipeline, or a redirection — run the command untouched (FR-029), the shape `redlog-run` already uses when `mkfifo` fails
- [ ] T039 [US3] Write the failing test then implement the project-switch stop (FR-010): `session_end` with a reason, no writes into the new project, and the terminal says so
- [ ] T040 [P] [US3] Confirm spool behaviour end to end with the existing `~/.redlog/pending` replay — a test that fills the spool while RedLog is down and asserts the events arrive on next project open, with their original occurrence times

---

## Phase 6: Polish, domain contracts, and the things only Kali can prove

- [ ] T041 Update `docs/domain/SPEC-capture-source-lifecycle.md` with the states this feature introduces — enrolled vs. not, mode, per-terminal stop — and make its Coverage checklist name the native class explicitly, since "the UI says what it does **not** record" is exactly what FR-025 has to satisfy. (The part of this task that was *already overdue* — the retired `Active / Idle` pair from `d6e60e9` — was corrected on 2026-10-05, with the reasoning recorded under "Quiet is not a state".)
- [ ] T042 [P] Update `docs/USER-GUIDE.md` and `README.md` for the new setup path, naming what is *not* recorded (native class) as plainly as what is (Coverage checklist in the lifecycle contract)
- [ ] T043 [P] Add the e2e install journey in `e2e/terminal-enrollment.spec.ts` (ubuntu CI): card → install → verification arrives → card says enrolled
- [ ] T044 Run quickstart.md §3 by hand on a real Kali VM, including the `nc` → `Ctrl-Z` → `stty raw -echo` → `fg` upgrade (SC-004). **A run that cannot do this is not a verified feature**, whatever the unit suite says
- [ ] T045 Measure SC-001 (under 5 minutes, one install action) and SC-002/SC-003 over a scripted engagement of ≥100 commands, and record both in `specs/052-terminal-auto-capture/verification.md`
- [ ] T046 Write `specs/052-terminal-auto-capture/verification.md` from `.specify/templates/overrides/verification-template.md`: the RED failure reason for each behaviour, the final evidence, and the outcome of every workflow gate including the ones that ran clean
- [ ] T047 Run the four gates before the PR — `npm run typecheck && npm run verify:specs && npm run verify:architecture && npm test` — then `npm run build && npx playwright test e2e/terminal-enrollment.spec.ts`

---

## Dependencies

```
Phase 1 (decisions)  ─────────────► blocks everything
        │
Phase 2 (foundational) ───────────► blocks all user stories
        │
        ├── Phase 3 US1 (MVP) ────► independently shippable
        │        │
        │        ├── Phase 4 US2 ─► needs US1's state file, not its UI
        │        └── Phase 5 US3 ─► needs US1's relay, not US2
        │
        └── Phase 6 (polish) ─────► T041 can start any time; T044-T047 last
```

**Story independence**: US1 ships alone and delivers the feature. US2 and US3
each extend it and are independently testable against an enrolled machine. US3
does not depend on US2.

## Parallel opportunities

- Phase 1: T003, T004, T005 are three separate experiments under one harness
- Phase 2: T011, T012, T014, T016 touch different files — the contract, ingest, the classifier, the state machine
- Phase 3: T025 and T026 (renderer and hooks-manager) run beside the shell work
- Phase 6: T041, T042, T043 are three different documents and one spec file

## Implementation strategy

Ship US1 alone first. It is the whole user-visible promise — install once, then
work — and it is testable on a Kali VM the day it lands. US2 and US3 make it
safe to leave installed; without them an operator who needs to stop recording
has to uninstall, and a broken recorder is a mystery. Do not start Phase 3
before Phase 1 is answered: every one of those open questions changes the
adapter's shape, and the adapter is the expensive part to rewrite.
