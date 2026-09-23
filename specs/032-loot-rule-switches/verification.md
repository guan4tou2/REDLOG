# Verification: Loot Rule Switches

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/loot-rule-switches.test.ts` against unchanged code: all 5 failed — no
`loot` config section, no `listLootRules`, `configure` ignored
`disabledRules` so a switched-off `jwt` was still reported and recorded.

`test/loot-rules-group.test.tsx` was written with the component (there was no
component to fail against); it covers the switches, the edit of
`disabledRules`, and the load-failure message.

## GREEN

- Matches carry `ruleId`; `scan`/`emit` skip switched-off rules;
  `findMatches` still returns them, so masking is unchanged (proved through
  `ingest()`: no loot row, redaction span present).
- `loot.disabledRules` defaults to `['jwt', 'generic_api_key']` and is applied
  on project open and config save.
- Settings ▸ Capture has a Loot detection group fed by `loot:rules`.
- The settings-IA guard caps groups at 29. The new group is paid for by merging
  the size-budget group and the row-retention group into one "Retention and disk
  budgets" group — the two halves of Spec 028's single retention model. The
  smoke test's title lookup follows the rename.

## Evidence

- New suites: 5 + 3 pass; existing loot, golden and config suites pass.
- Full suite outside the sandbox: one run had a single failure that did not
  reproduce and whose file was not captured; the next two runs passed
  204/204 files.
- Typecheck, production build and `verify:specs` pass.
