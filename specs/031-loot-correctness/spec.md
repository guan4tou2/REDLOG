# Feature Specification: Loot Detection Correctness

**Feature Branch**: `fix/loot-correctness`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Make the loot detector record and mask what it finds correctly, before changing which rules it ships or letting operators add their own.

Spec 025 put every secret shape in one table without changing behaviour. The
behaviour it preserved had these faults:

1. **A recorded secret stopped being masked.** The scan dropped values it had
   already recorded, and that same scan fed redaction — so the second time a
   secret appeared, its event got no redaction span and was shown and exported
   in clear.
2. **Different secrets were merged.** Dedup keyed on the value's first 32
   characters, and ignored the target.
3. **The recorded value was guessed.** `m[1] || m[0]` took capture group 1
   whenever one existed. The private-key rule's group 1 is the algorithm
   (`RSA `), so every RSA key was the same value.
4. **A rule that can match the empty string hung the scan.**
5. **A failed loot write was lost silently.** The value was marked seen before
   the write, and the error was swallowed, so it was never retried and nothing
   reported it.
6. **PTY session output was never scanned.** `session_output` rows carry
   stdout but no `command`, and the scan only ran for rows with one.

## User Scenarios & Testing

### User Story 1 - Every occurrence of a secret is masked (Priority: P1)

As an operator handing over an evidence bundle, I need a secret masked every
time it appears, not only the first time.

**Independent Test**: Two command outputs containing the same key both carry a
redaction span; one loot row is recorded.

### User Story 2 - Loot means distinct secrets on distinct targets (Priority: P1)

As an operator reading the Loot page, I need two keys to be two findings, and
a key found on a second host to be a second finding.

**Independent Test**: Two tokens sharing a 40-character prefix are two matches;
one key seen on two targets is two rows; two private keys with the same header
are two rows.

### User Story 3 - PTY session output is scanned (Priority: P1)

As an operator recording an external session with `redlog-session`, I need a
secret printed there detected like one in a command's output.

**Independent Test**: A key in `session_output` produces a loot row caused by
that row, and a key split across two chunks of one session is found.

### User Story 4 - A lost loot write is visible and recovers (Priority: P2)

**Independent Test**: With the DB closed, `emit` returns false and capture
health records a `loot` error; after reopening, the same match is recorded.

### Edge Cases

- Output chunks from different sessions, or across a session end, are not
  joined.
- A secret split across two chunks is detected, but each chunk's redaction
  masks only what that chunk holds — the halves are not masked.
- A clipboard copy or `/api/loot/scan` of an already-recorded secret now
  reports its type/finding again; the loot row is still written once.

## Requirements

- **FR-001**: The scan MUST return every occurrence; recording dedup MUST
  happen at write time, keyed by type, target and a digest of the full value.
- **FR-002**: Each built-in loot rule MUST declare which part of the match is
  the value; plugin `lootPatterns` MAY declare `group`, defaulting to the whole
  match.
- **FR-003**: A zero-length match MUST NOT stall the scan or produce a value.
- **FR-004**: A value MUST be marked recorded only after its loot row is
  written; a write failure MUST be reported to capture health.
- **FR-005**: PTY `session_output` MUST be scanned, joined with the tail of the
  same session's previous chunk; the tail MUST be dropped at session start and
  end.

## Success Criteria

- **SC-001**: `test/loot-correctness.test.ts` passes; its RED run is recorded.
- **SC-002**: The golden corpus differs from Spec 025 only in the private-key
  value.

## Assumptions

- Pre-release (Spec 006): a plugin pattern that relied on group 1 being taken
  implicitly must now say `"group": 1`. No bundled or example plugin does.
- Rule defaults (`jwt`, `generic_api_key`), per-rule switches and a project
  rule list are the next spec; this one changes what a rule records, not which
  rules run.
