# Feature Specification: One Secret Pattern Table

**Feature Branch**: `refactor/one-secret-pattern-table`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Define every recognised secret shape once, so transcript redaction and loot detection read the same definitions and any difference between them is visible in one place.

Two consumers recognise secrets. Transcript redaction masks them in AI agent
transcripts before storage; loot detection records them as loot when they
appear in captured output. Each carried its own list of regular expressions,
and the lists had drifted:

| Shape | Redacted in transcripts | Detected as loot |
|---|---|---|
| GitHub, GitLab, Slack, npm, Hugging Face, `sk-`, Google OAuth tokens | yes | no |
| NTLM hash, crypt `$6$` hash, `/etc/shadow` line | no | yes |
| JWT | any three `eyJ…` segments | payload segment must also be `eyJ…` |
| PEM private key | the whole block | the header line only |

Nothing showed this, because each list looked complete from inside its own
file.

## Clarification (2026-09-23)

- **Coverage**: the operator chose to consolidate the definitions **without
  changing what either consumer does**. Aligning coverage — whether a hash in a
  transcript should be masked, whether a found GitHub token is loot — is a
  separate policy decision, now made in one place when it is made.
- **CTF flags**: the built-in `(flag|ctf|HTB){…}` loot pattern is removed. The
  product records engagements; proof flags belong to exam and training work it
  does not target.

## User Scenarios & Testing

### User Story 1 - See what each consumer covers, in one place (Priority: P1)

As a maintainer, I need every secret shape and both consumers' coverage in one
file, so a difference between them is something I can see and decide on rather
than discover.

**Independent Test**: Verify both consumers take their shapes only from the
table, and every shape in the table is used by at least one consumer.

### User Story 2 - Nothing I rely on changes (Priority: P1)

As an operator, I need transcripts to be redacted exactly as before and loot to
be detected exactly as before, in the same order, because loot events are
chained and their content is hashed.

**Independent Test**: A golden corpus captured from the previous code produces
identical redaction output and identical loot matches in identical order.

### User Story 3 - A new shape cannot be silently skipped (Priority: P2)

As a maintainer adding a redaction shape, I need to be told if the transcript
prefilter would skip it.

**Independent Test**: Every redacted shape's sample passes the prefilter.

### Edge Cases

- Loot already stored with type `flag` still displays with its colour.
- A shape used by both consumers with an identical expression is defined once.
- Plugin-contributed loot patterns keep their own registry and are unaffected.
- Structural credential detection (command-line password flags, URI userinfo,
  `Authorization` headers) stays in `credential-detector.ts`: it answers where a
  credential was used, not what a secret token looks like.

## Requirements

- **FR-001**: Every built-in secret shape MUST be defined once, in
  `src/core/secret-patterns.ts`.
- **FR-002**: Transcript redaction and loot detection MUST take their shapes
  only from that table, via explicit ordered coverage lists in the same file.
- **FR-003**: Redaction output and loot matches, including match order, MUST
  be unchanged except for the removed flag pattern.
- **FR-004**: Each caller MUST receive its own RegExp instance.
- **FR-005**: The transcript prefilter MUST live beside the redaction list and
  MUST pass every redacted shape.
- **FR-006**: The CTF flag pattern MUST be removed; stored flag loot MUST still
  display.

## Success Criteria

- **SC-001**: The golden corpus is byte-identical for redaction and
  match-identical for loot, flag aside.
- **SC-002**: Neither consumer contains an inline shape definition.
- **SC-003**: No shape in the table is unused.

## Assumptions

- Pre-release (Spec 006).
