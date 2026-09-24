# Verification: Capture Packs

## RED

`test/capture-packs.test.ts` against unchanged code failed to load:
`Cannot find module '/src/core/capture-packs'` — no pack model existed, the
default config had the six member `enabled` keys and no `packs`, and no pack
manifests shipped.

## GREEN

- `capture-packs`: 7 pass — defaults (packs off, member keys gone); no source
  file reads a removed key; each pack ships a bundled manifest; `isPackOn`
  needs both the project switch and an active plugin; health switches member
  rows through `packs.<id>` and drops a pack whose plugin is not active.
- `capture-pack-group`: 2 pass — the switch writes `packs.<id>`, member tuning
  shows only while on, a plugin-disabled pack says so instead of a switch.
- `capture-health` (15), `config`, `tailer-naming`, capture readiness and
  onboarding fixtures updated to `packs.*`; e2e `connection-capture` uses the
  pack switch and `packs.hostMonitors`.
- Full suite outside the sandbox: 217 files pass. Typecheck, production build,
  `verify:architecture` and `verify:specs` pass. E2E runs in CI.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 4 answered (split, pack switches only, screenshots stay a setting, per-project switch + global plugin) — in spec.md | 2026-09-24 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-24 |
| Analyze | 2 findings fixed: the health-omission test passed vacuously because tests load no plugins (now mocks active and disabled packs explicitly); the old AI switch applied only on project reopen (now applied on save) | 2026-09-24 |
| Converge | 2 findings fixed: the architecture gate flagged an unused `CAPTURE_PACK_IDS` export; the e2e connection test still toggled the removed switch | 2026-09-24 |
