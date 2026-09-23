# Verification: One Scope Classifier

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/scope-one-classifier.test.ts` failed 11 tests for the intended reasons
before implementation:

- every non-bare form of an adjacent host (uppercase, mixed case, trailing dot,
  host:port, URL, URL with userinfo and port) classified `unrelated` rather than
  `adjacent_domain` / `adjacent_subnet`, and so at `notice` severity rather than
  `warning`;
- an allowlist entry written in capitals broke adjacency for every subject;
- an exclude-only project classified non-excluded targets `unrelated`, and the
  filter and distance views disagreed on it;
- export masking left an explicitly excluded target unmasked in an
  exclude-only project;
- the structural guards: no `classifyScope` in `scope-evaluator.ts`,
  `matchPattern` and the adjacency helpers inside `alert/policies.ts`,
  `scope-sanitize.ts` importing from `./alert`, `ScopeSnapshot` declared twice.

Five tests passed before implementation and were kept as guards: they cover
scope configurations on which the two classifiers already agreed.

## GREEN

- `classifyScope` in `scope-evaluator.ts` is the one decision procedure;
  `evaluateScope` is its status view and normalises once before every rung.
- `classifyScopeTarget` in `alert/policies.ts` maps a distance to authority and
  severity and decides nothing itself. `matchesDomain`, dead since the matcher
  was unified, and the now-unused `isIPv4` there are removed.
- `scope-sanitize.ts` imports only from `scope-evaluator.ts`; its early exit
  for "no allowlist" is removed.
- `ScopeSnapshot` has one declaration, in `alert/policies.ts`, since it carries
  the alert floor.
- `docs/domain/SPEC-scope-evaluation.md` names the one procedure, its two
  views and its rungs, and corrects rule 5: IPv6 CIDR uses prefix arithmetic,
  which the implementation already did.

## Evidence

- Scope, alert, recompute and sanitize suites: 186 tests pass.
- `npm run typecheck` passes. Production build passes.
- Full suite: the only failures are the three sandbox-bound suites
  (`api-server`, `external-session`, `shell-redlog-run`), which need a local
  socket or a real shell and pass outside the sandbox.

## Not changed

The IP alarm's own `matchesCIDR` remains. It serves safe/exposed IP matching,
not scope, and its IPv6 handling is exact-address only where `matchPattern`
does prefix arithmetic — worth unifying, but it is the IP alarm's contract and
belongs in its own change.
