# Verification: Command Artifact Linking

## RED

`test/causes-resolver.test.ts` initially failed both positive attribution cases:
watched file events returned no causes because active command cwd state did not
exist.

## GREEN

- Shell syntax: bash and zsh adapters passed syntax checks.
- Focused: 31 tests passed across causal resolution, ingest, adapter boundaries and `redlog-run`.
- Full suite: 182 files passed; 2,099 tests passed and 2 skipped.
- TypeScript typecheck passed.
- Production Electron build passed.
- `git diff --check` passed.
- Desktop E2E: `e2e/command-artifact-correlation.spec.ts` passed (1 test).

## Convergence Review

- Inside-cwd create/modify: implemented and tested.
- Outside, delete, directory, ended command: remain unlinked.
- Nested cwd: unique most-specific command wins.
- Equal-depth ambiguity: remains unlinked.
- Existing `_causes`: preserved and deduplicated by canonical ingest.
- Project close/test reset: clears correlation state to prevent cross-project links.
- Plain PowerShell history remains an explicit limitation because it observes a command only after execution.

No unbuilt requirement remains in Spec 016.
