# Research: Loot Rule Switches

- **Why a disabled list, not an enabled map**: rules the operator has never
  seen — a newly installed plugin — should be on without an entry.
- **Why `jwt` and `generic_api_key`**: both are `medium` rules whose shapes are
  common in non-secret text; the other built-ins (hashes, keys, shadow lines,
  AWS keys, DB URLs, Basic auth) are specific. This matches the operator
  feedback that started the loot work.
- **Why masking is independent**: `findMatches` feeds the redaction denylist
  (Spec 031). Filtering there would turn a noise preference into data exposure.
- **Checked**: e2e specs that produce loot use AWS keys, which stay on.
