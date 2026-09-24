# SPEC: Scope Evaluation Semantics

## Context

RedLog engagement config defines a **scope**: an allow-list of targets
(`scope.targets`) and an exclude-list (`scope.excludeTargets`). Every surface
that classifies a host/IP as in-scope or out-of-scope must agree on the verdict.

## Current state (bug)

Four independent implementations exist, with two different semantics:

1. **`matchTarget`** (core/db/event-aggregates.ts) — lowercase substring match.
   `example.com` matches `notexample.com`. CIDR handling is broken (startsWith
   on network prefix string). Used by `queryScopeFilteredEvents` and
   `hostCausalChain` (removed in #143).
2. **`matchesScope`** (renderer/lib/scope.ts) — case-sensitive exact + CIDR.
   Used by HTTP History, TargetView.
3. **`matchesScopePattern`** (renderer/lib/timelineScopeMatch.ts) — identical
   copy of #2. Used by Timeline scope highlighting.
4. **`matchesDomain` + `matchesCIDR`** (core/alert/policies.ts) — case-sensitive
   exact + IPv4/IPv6 CIDR. Used by scope-distance classification only.

## Canonical semantics

### Pattern types

A scope pattern is one of:

| Pattern | Matches | Does NOT match |
|---------|---------|----------------|
| `example.com` | `example.com` | `notexample.com`, `sub.example.com` |
| `*.example.com` | `sub.example.com`, `a.b.example.com`, `example.com` | `notexample.com` |
| `10.0.0.0/24` | `10.0.0.0` – `10.0.0.255` | `10.0.1.0` |
| `192.168.1.5` | `192.168.1.5` | `192.168.1.50` |
| `::1` | `::1` (exact, normalized) | |

### Rules

1. **Case-insensitive**: `EXAMPLE.COM` == `example.com` (hostnames are
   case-insensitive per RFC 4343).
2. **No substring matching**: a bare hostname pattern matches only that exact
   hostname. `example.com` does NOT match `notexample.com`.
3. **Wildcard `*.`**: matches any subdomain of the bare domain, AND the bare
   domain itself. `*.example.com` matches `example.com`, `sub.example.com`,
   `a.b.example.com`.
4. **IPv4 CIDR**: proper 32-bit mask arithmetic. `/0` matches all IPv4.
5. **IPv6 CIDR**: full 128-bit prefix arithmetic. `fe80::2` matches
   `fe80::1/64`. (An earlier revision of this contract described exact-address
   matching; the implementation has done prefix arithmetic since, and
   `scope-evaluator.test.ts` pins it.)
6. **IPv4-mapped IPv6**: `::ffff:10.0.0.1` is treated as `10.0.0.1` for
   matching purposes.
7. **Trailing dot FQDN**: stripped before matching. `example.com.` ==
   `example.com`.
8. **host:port**: port is stripped before matching. `example.com:8080` matches
   pattern `example.com`.
9. **URL input**: if subject looks like a URL (`://`), extract the hostname.
10. **Malformed pattern**: never matches anything, never throws.
11. **Malformed subject**: never matches anything, never throws.

### Classification — one procedure, two views (Spec 023)

Scope has exactly one decision procedure, `classifyScope` in
`src/core/scope-evaluator.ts`. Every surface takes one of its two views; none
computes scope separately.

```typescript
type ScopeDistance = 'in_scope' | 'excluded' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'

function classifyScope(
  subject: string,
  policy: { targets: string[]; excludeTargets: string[] },
  indexes?: ScopeIndexes
): { status: ScopeDecision['status']; distance: ScopeDistance; matchedBy?: string }
```

- **status** — the filter view (`evaluateScope`). Used by the investigation
  filter.
- **distance** — the classification view. Used by export masking, scope
  recompute and the scope alarm.

Rungs, in order, all over the **normalised** subject (rules 1, 7, 8, 9 apply
to every rung, including adjacency):

1. No allowlist and no exclusions → `no-scope` / `in_scope`.
2. Matches an exclusion → `excluded` / `excluded`.
3. No allowlist (exclusions only) → `no-scope` / `in_scope`. Nothing is out of
   scope except what is explicitly excluded.
4. Matches an allowlist entry → `in-scope` / `in_scope`.
5. IPv4 in the same /24 as an allowlisted address → `out-of-scope` /
   `adjacent_subnet`.
6. Same registrable domain as an allowlisted host → `out-of-scope` /
   `adjacent_domain`.
7. Otherwise → `out-of-scope` / `unrelated`.

**Authority and severity are not part of the domain.** How much a distance
matters — a rule is a fact, an adjacency is an inference, adjacency warns and
`unrelated` only notices — is an alert policy decision, mapped from the
distance in `src/core/alert/policies.ts`. The alert subsystem does not decide
distance, and nothing outside it imports scope from it.

Before Spec 023 the distance view lived inside the alert module and read the
raw subject on the adjacency rungs, so `Dev.Target.com`,
`dev.target.com:8443` and `https://dev.target.com/x` were `unrelated` beside an
in-scope `target.com` while `dev.target.com` was `adjacent_domain`.

### Evaluation function

```typescript
type ScopeDecision =
  | { status: 'in-scope';    matchedBy: string }
  | { status: 'out-of-scope' }
  | { status: 'excluded';    matchedBy: string }
  | { status: 'no-scope' }

function evaluateScope(
  subject: string,
  policy: { targets: string[]; excludeTargets: string[] }
): ScopeDecision
```

**Precedence:**
1. No scope configured (both lists empty) → `{ status: 'no-scope' }`
2. Exclude list match → `{ status: 'excluded', matchedBy }` (excludes win)
3. Allow list match → `{ status: 'in-scope', matchedBy }`
4. No match → `{ status: 'out-of-scope' }`

`matchedBy` is the pattern string from the policy that produced the verdict.

### Properties (for property-based testing)

- `normalize(host)` must not change the scope decision.
- Hostname case must not change the decision.
- Any malformed input must not throw.
- `∀ address ∈ CIDR block → evaluateScope(address, { targets: [cidr] }).status === 'in-scope'`
- `evaluateScope(subject, { targets: [], excludeTargets: [] }).status === 'no-scope'`

## Acceptance scenarios

### S1: Exact hostname
Given scope targets `["example.com"]`
When evaluating `example.com` → in-scope
When evaluating `EXAMPLE.COM` → in-scope (case-insensitive)
When evaluating `notexample.com` → out-of-scope (no substring)
When evaluating `sub.example.com` → out-of-scope (no wildcard implied)

### S2: Wildcard hostname
Given scope targets `["*.example.com"]`
When evaluating `sub.example.com` → in-scope
When evaluating `a.b.example.com` → in-scope
When evaluating `example.com` → in-scope (bare domain included)
When evaluating `notexample.com` → out-of-scope

### S3: IPv4 CIDR
Given scope targets `["10.0.0.0/24"]`
When evaluating `10.0.0.1` → in-scope
When evaluating `10.0.0.255` → in-scope
When evaluating `10.0.1.0` → out-of-scope

### S4: Exclude wins
Given targets `["*.example.com"]`, excludeTargets `["dev.example.com"]`
When evaluating `dev.example.com` → excluded
When evaluating `prod.example.com` → in-scope

### S5: Input normalization
When evaluating `example.com:8080` against `["example.com"]` → in-scope
When evaluating `example.com.` against `["example.com"]` → in-scope
When evaluating `http://example.com/path` against `["example.com"]` → in-scope
When evaluating `::ffff:10.0.0.1` against `["10.0.0.0/24"]` → in-scope

### S6: Malformed inputs
When evaluating `""` against any scope → out-of-scope, no throw
When evaluating any subject against pattern `""` → no match, no throw
When evaluating `10.0.0.1` against `"10.0.0.0/33"` → no match, no throw
