# Implementation Plan: Loot Rule Switches

## Constitution Check

- **Surface Truthfulness**: the Settings hint states that switched-off rules
  are still masked; a failed rule load is shown, not rendered as an empty list.
- **Architectural Restraint**: one config list, one IPC read, one Settings
  group. No new rule format; plugin rules keep `lootPatterns`.
- **Risk-Based Test-First Verification**: the masking guarantee is a DB-backed
  test through `ingest()`, not only a detector unit test.

## Design

1. Each match carries `ruleId`. `findMatches` still returns every rule's
   matches (redaction input); `scan` returns only reported ones; `emit` skips
   unreported ones.
2. `LootDetector.configure({ disabledRules })`; main applies it on project open
   and config save.
3. `listLootRules()` → `loot:rules` IPC → `LootRulesGroup` in Settings ▸
   Capture, writing `loot.disabledRules`.
4. The structural `LootDetectorLike` type is declared once (ingest) with
   `ruleId`; api-server takes only the `scan` it uses.
