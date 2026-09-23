# Implementation Plan: One Retention Model

## Constitution Check

- **Surface Truthfulness**: the option reference stops documenting `io.*`
  settings that do not exist; the undeclared `agentTranscripts` knob is
  declared where operators will find it.
- **Architectural Restraint**: a rename and a move. No new knob, no new UI;
  the size budgets the Settings page already edited are the only UI touched.
- **Risk-Based Test-First Verification**: retention deletes evidence. The
  sweep suites move to the new shape first and fail; a new test pins the
  declared shape, the absence of the old spellings, and that an old config
  deletes nothing.

## Design

1. `RedLogConfig.retention` gains `casts`, `screenshots`, `httpBodies`
   (`keepDays`, `maxBytes`) and `agentTranscripts` (`keepDays`), all
   defaulting to `0`. `terminal` keeps only `maxCastBytes`; the top-level
   `screenshots` and `httpBodies` sections are removed.
2. `sweepRetention`, `sweepBodyStore` and `sweepArtifactStore` take
   `Pick<RedLogConfig, 'retention'>` instead of their own ad-hoc shapes.
3. The Settings size-budget fields write `retention.<store>.maxBytes`.
4. `docs/TESTING.md` §2.6 is rewritten from the real keys; live design docs
   use the new names, and the logged-tier design doc gets a note. Dated audit
   documents are left as records.
