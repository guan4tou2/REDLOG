# RedLog Test Matrix

Every configurable option, every value that behaves differently, and where each
one is proven. If you change a default, add a field, or touch the alert path,
this is the file that says what the change is allowed to break.

```
npm test                       # the whole vitest suite (unit + renderer)
npx vitest run test/<file>     # one file
npx vitest                     # watch mode
npm run e2e                    # Playwright, needs a built app
npm run typecheck              # renderer types
```

**After an e2e run, `npm test` will fail to start.** `pree2e` points
`node_modules/.bin/node-gyp` at `@electron/node-gyp`, so `pretest`'s
`npm rebuild better-sqlite3` then builds the native module against Electron
headers and vitest cannot load it (`Could not locate the bindings file`, even
though the file is right there — it is the ABI that is wrong). Recover with:

```
rm -rf node_modules/better-sqlite3/build
(cd node_modules/better-sqlite3 && ../../node_modules/node-gyp/bin/node-gyp.js rebuild --release)
```

## How to read a row

| Column | Meaning |
|---|---|
| **Value** | the literal a config file can hold, including the junk values |
| **Behaviour** | what RedLog does with it — stated as an observable outcome |
| **Proof** | vitest file that asserts it, `e2e` for Playwright, `manual` for §5, `—` for an open gap |

Proof names drop the `test/` prefix and the `.test.ts(x)` suffix.

---

# Part 1 — The alert path

The one sequence that has to be right: an address or a target is observed, a
verdict is computed, and the verdict reaches the operator's eye. RedLog never
blocks (`ALERT-ROLES.md` Part D), so a verdict that is wrong or invisible is the
whole defence failing — there is nothing downstream to catch it.

```
egress IP ──► IPSignalProducer ──► IPPolicy ──► verdictToSafety ──► HUD + card + status bar
command   ──► ingest ──► classifyScope ──► alert floor ──► scope_violation row ──► status bar + ScopeStatus
```

## 1.1 IP verdict matrix — which list wins

Two lists, each independently set or unset, and an address that may hit either.
Nine reachable cells.

Five verdicts, because the two lists answer different kinds of question. Three
are **observations** and one is an **inference**, and §3 says an inference may
never wear a fact's colour:

| Verdict | Authority | Means |
|---|---|---|
| `safe` | fact | on an address you declared safe |
| `exposed` | fact | on an address you declared to be *you* |
| `off_profile` | fact | you declared an expectation and this is **outside** it |
| `presumed_safe` | **inference** | "not obviously you" — a blacklist is set and this missed it |
| `unknown` | — | nothing declared; there is no question to answer |

| # | whitelist | blacklist | address hits | Verdict | Why |
|---|---|---|---|---|---|
| A-1 | — | — | — | `unknown` | nothing declared, nothing to judge against |
| A-2 | — | set | blacklist | `exposed` | your own IP is showing |
| A-3 | — | set | neither | `presumed_safe` | an inference, and rendered as one |
| A-4 | set | — | whitelist | `safe` | on a declared exit |
| A-5 | set | — | neither | `off_profile` | an observed deviation from a declared expectation |
| A-6 | set | set | both | `exposed` | config conflict resolves to the alarming side |
| A-7 | set | set | blacklist | `exposed` | identity leak is never masked |
| A-8 | set | set | whitelist | `safe` | |
| A-9 | set | set | neither | `off_profile` | **the VPN-dropped-onto-café-NAT case** |

Proof: `alert/ip-policy`, one `it` per verdict rather than per row. A-1, A-3,
A-4, A-5 and A-6 each have a case; A-7 and A-8 are asserted in passing by its
dedup case. A-2 (blacklist only, hit) and A-9 (both set, neither hit) are
asserted by no test (`—`).

Two fixes, and what still pins them:

- **G-A1** — A-9 answered `safe`, because the blacklist-only shortcut ran even
  after a configured whitelist had already missed. The policy checks the
  whitelist miss first (`IPPolicy` in `src/core/alert/policies.ts`), but no
  test pins it any more: `ip-monitor.test.ts` did, and was deleted with the
  old `IPMonitor` in v0.12.0 (`b69502b`) (`—`).
- **G-A2** — A-3 answered `safe` (an inference in a fact's solid green) and A-5
  answered `unknown`, which understated an observed deviation into the same
  amber bucket as "nothing is configured at all". Both now have their own
  verdict at the policy (`alert/ip-policy`). The screen still folds them:
  `presumed_safe` renders as `safe` and `off_profile` as `exposed` (§1.8).

## 1.2 Range matching — `network.whitelist` / `network.blacklist`

| Value | Behaviour | Proof |
|---|---|---|
| `10.8.0.0/24` | matches `10.8.0.0` through `10.8.0.255`, including network + broadcast | `—` |
| `10.8.0.0/24` vs `10.8.1.0` / `10.7.255.255` | one address either side is outside | `—` |
| `172.16.0.0/12` | matches up to `172.31.255.255`, not `172.32.0.1` | `—` |
| `203.0.113.42/32` | single host | `—` |
| `0.0.0.0/0` | matches every IPv4 address | `—` |
| `203.0.113.42` (no mask) | exact equality, never a prefix — `203.0.113.4` does not match | `alert/ip-policy` (the exact hit); `—` (the prefix case) |
| `2001:db8::1/64` | **never matches any IPv6 address**, `2001:db8::1` included: `IPV6_RE` rejects the `/`, so the family check fails before the exact-address fallback `matchesCIDR` means to run (G-IP1) | `—` |
| IPv4 CIDR vs IPv6 address | family mismatch never matches. The reverse does not hold: an IPv6 CIDR with a prefix of 32 or less is read as IPv4 arithmetic, so `2001:db8::/1` can match an IPv4 address (G-IP1) | `—` |
| multiple entries | a hit on any one entry is a hit | `—` |
| `[]` (default) | list is not configured → see A-1/A-3/A-5 | `config-options` (the default), `alert/ip-policy` (the unconfigured verdicts) |

The blacklist is evaluated first and wins outright; a whitelist that is set but
missed answers `off_profile` — never `safe`, and never the same `unknown` that
"nothing configured" gets (`alert/ip-policy`). The matcher itself,
`matchesCIDR` in `src/core/alert/policies.ts`, is private and asserted by no
test; `scope-evaluator` tests a different one (`matchPattern`).

## 1.2.0 The internal address is reported, not judged

There is no `network.lanProfile` option and no LAN verdict. The IP producer
reads the internal address on every check, and main's 20 s link poll pushes the
link into it (`link`: the Wi-Fi SSID or wired, via `setLink()` in
`src/main/index.ts`). Both ride on every signal and are displayed, but nothing
classifies them: `IPPolicy` is configured with the whitelist and blacklist only
(`src/main/services/alert-runtime.ts`) and reads neither `internal` nor `link`
(`src/core/alert/policies.ts`). The "`lanProfile` verdict pathway" named in
`src/core/alert/signal.ts` was not built. So a laptop that silently reassociated to a guest SSID reads exactly like
one still on the client VLAN, and the external IP can be perfectly fine while
you are on the wrong network.

A failed external lookup still re-reads the internal address rather than
discarding it with the rejection (`check()` in
`src/main/services/producers/ip-signal-producer.ts`); no test asserts it (`—`).

## 1.2.1 A failed read expires the verdict

There is no `network.staleAfter` option. The first failed read marks the
reading stale (`check()` in `src/main/services/producers/ip-signal-producer.ts`):
the last stable address is kept, and `IPPolicy` answers `unknown` with
`stale: true`, whatever the lists say.

| Case | Behaviour | Proof |
|---|---|---|
| a read fails (a provider error, every provider down, or air-gap `offline`) | `stale: true` at once; the verdict is `unknown`, never the last good answer | `alert/ip-policy` (the verdict); `—` (the producer) |
| a later read succeeds | the verdict is recomputed and `stale` clears | `—` |

A dropped VPN and a dead IP provider look identical from outside the process, so
neither may keep rendering the last good answer at full confidence. The screen
does not show `stale` as its own state: the renderer receives `unknown`, and
reads neither `stale` nor `settling` (§1.8).

## 1.3 `network.confirmations` — flap protection

A new address is held until it has been read this many times in a row. The
displayed address, and therefore the verdict, does not change during the hold.

| Value | Behaviour | Proof |
|---|---|---|
| `1` | promote on sight, no flap protection | `—` |
| `3` (default) | two reads hold the old address, the third promotes | `config-options` (the default); `—` (the hold) |
| `5` | four reads hold, the fifth promotes | `—` |
| `0`, negative | ignored: the previous value is kept (3 on a fresh producer), **not** "promote instantly" (`configure()`) | `—` |
| first ever reading | taken as-is; there is nothing to flap against | `—` |
| candidate changes each poll (CGNAT) | nothing is ever promoted; `settling` stays true | `—` |
| old address returns mid-hold | the half-confirmed candidate is dropped | `—` |

`settling: true` is the "displayed value is the last stable read" flag. It is
set during the hold and cleared on promotion; a failed read in mid-hold also
clears it, although the hold goes on (`ip-signal-producer.ts`). The policy
carries it into the verdict as a modifier without changing the verdict
(`alert/ip-policy`); the producer's side is asserted by no test (`—`).
`IPSignalProducer` has had no tests since v0.12.0, which is why §1.3–§1.5 are
`—` throughout.

## 1.4 `network.ipMode` and `network.providers`

| Option | Value | Behaviour | Proof |
|---|---|---|---|
| `ipMode` | `auto` (default) | DNS first, HTTP only if DNS fails/blocked | `config-options` (the default); `—` (the fallback) |
| `ipMode` | `dns` | direct query to OpenDNS/Google resolvers, no HTTP at all | `—` |
| `ipMode` | `http` | HTTP echo only, DNS never queried | `—` |
| `providers` | `[]` (default) | the three built-in echo services are used | `config-options` (the default); `—` (the services) |
| `providers` | custom list | tried in order; first success wins | `—` |
| `providers` | first entry throws | falls through to the next | `—` |
| `providers` | first entry answers non-2xx | treated as a failure, moves on | `—` |
| `providers` | response `{ip}` or `{origin}` | both shapes are accepted | `—` |
| `providers` | every entry fails | `error: 'All IP providers failed'`, **last known address is kept**, and the reading goes stale (§1.2.1) | `—` |
| `providers` | a later poll succeeds | error clears | `—` |

## 1.5 `network.checkInterval`

| Value | Behaviour | Proof |
|---|---|---|
| unset (monitor default) | polls every 10 s | `—` |
| `60` (config default) | polls every 60 s | `config-options` (the default); `—` (the cadence) |
| `0` | ignored, the previous interval is kept — a zero-second poll would be a busy loop | `—` |
| `stop()` | clears the timer, idempotent | `—` |
| slow poll still in flight | the next tick is skipped, not queued | `—` |

## 1.6 Scope distance ladder — `classifyScope`

How far a target sits from declared intent (`ALERT-ROLES.md` Part B), computed
by `classifyScope()` in `src/core/scope-evaluator.ts`; `classifyScopeTarget()`
in `src/core/alert/policies.ts` adds authority and severity. The tier decides
whether an alert fires at all, so every rung needs its own row. (The titles in
`alert/scope-policy` number the rungs differently: D1 excluded, D2 subnet, D3
domain, D4 in scope.)

| Tier | Distance | Meaning | Alerts? |
|---|---|---|---|
| D0 | `in_scope` | hits a scope entry | no |
| D1 | `excluded` | hits an exclude entry — a **fact** | **always**, even with warnings off |
| D2 | `adjacent_subnet` | same /24 as a single-IP scope entry, or as the base address of a CIDR entry — **inferred** | only when `warnOnViolation` |
| D2 | `adjacent_domain` | same registrable domain as a scope entry — **inferred** | only when `warnOnViolation` |
| D3 | `unrelated` | no relationship to anything declared | never, and not counted: `ScopePolicy.evaluate()` drops the verdict before any surface sees it |

D1 outranks D0: an explicit exclusion inside a broad CIDR still fires
(`scope-evaluator`, `alert/scope-policy`, both with wildcard entries; no test
has a CIDR with an excluded address inside it).

| Case | Scope | Target | Distance | Proof |
|---|---|---|---|---|
| no scope set | `[]` | anything | `in_scope` | `alert/scope-policy`, `scope-evaluator` |
| single-IP entry expands into its /24 | `192.168.1.10` | `192.168.1.55` | `adjacent_subnet` | `alert/scope-policy`, `scope-one-classifier` |
| an address outside a /24 CIDR | `10.0.0.0/24` | `192.168.50.1` | `unrelated` | `—` |
| wildcard expands to the registrable domain | `*.staging.example.com` | `prod.example.com` | `adjacent_domain` | `—` (every adjacency test uses a bare-host entry) |
| unrelated domain | `*.staging.example.com` | `google.com` | `unrelated` | `alert/scope-policy` |
| a different /24 | `192.168.1.10` | `192.168.2.55` | `unrelated` | `—` |

The container is always a /24 (`subnetOf` in `src/core/scope-evaluator.ts`);
there is no option to change it. The design intent was an asymmetry: a bare IP
carries no boundary, so deriving one fills a gap, while a CIDR *states* a
boundary, and widening it would invent authorisation the operator never gave.
The code does not hold to the second half for CIDRs narrower than /24:
`buildScopeIndexes` seeds the /24 of every CIDR entry's base address, so
`10.0.0.0/28` makes `10.0.0.200` `adjacent_subnet` (G-S1). A domain always
expands to its registrable domain because that is the ownership boundary the
authorisation is about — hitting `prod` while scoped to `staging` is exactly
what D2 exists for.

## 1.6.1 Scope verdicts — `evaluateScope`

The coarser four-value status from `evaluateScope()` in
`src/core/scope-evaluator.ts`: `in-scope`, `out-of-scope`, `excluded` or
`no-scope`. It is what the shared filter's in-scope condition uses
(`src/core/db/event-queries.ts`); D2 and D3 both collapse to `out-of-scope`
here.

| Target | Scope | Status | Proof |
|---|---|---|---|
| `null` / `''` / `undefined` | a scope set | `out-of-scope` — there is no `unknown`; callers that must not judge an empty target check for it first | `scope-evaluator` (empty subject); `scope-sanitize`, `scope-classify` (the callers) |
| anything | no targets, no excludes | `no-scope` — no scope set means nothing is out of scope | `scope-evaluator`, `scope-classify` |
| `10.0.0.9` | `10.0.0.0/24` | `in-scope` | `scope-evaluator` |
| `10.0.1.9` | `10.0.0.0/24` | `out-of-scope` | `scope-evaluator` |
| `api.app.example.com` | `*.app.example.com` | `in-scope` | `scope-evaluator` |
| `app.example.com` | `*.app.example.com` | `in-scope` — the wildcard covers its anchor host | `scope-evaluator`, `scope-classify` |
| `vpn.example.com` | `*.app.example.com` | `out-of-scope` (same root, outside the wildcard) | `—` |
| `google.com` | `*.app.example.com` | `out-of-scope` | `scope-evaluator`, `scope-sanitize` |
| `10.0.0.1` | in `targets`, also in `excludeTargets` | `excluded` — exclusion beats the enclosing CIDR | `—` |
| `dc01.app.example.com` | in the wildcard, also excluded | `excluded` | `scope-evaluator`, `alert/scope-policy` |

CIDR and wildcard mechanics themselves are asserted one `it` each rather than
in a table: `/0`, `/24` and `/32` and the `*.` prefix in `scope-evaluator`
(`matchPattern`), `/16` in `scope-classify`, `/8` in `scope-sanitize`, and
registrable-domain extraction in `alert/scope-policy`.

## 1.7 `scope.warnOnViolation` — how much the operator is told

The setting is the `scope.warnOnViolation` boolean (default `true`; the
checkbox in Settings ▸ Scope). There is no `scope.alertFloor` key. The policy
works with an *alert floor*, the list of distances that raise a violation, and
`alertFloorFor()` in `src/core/alert/policies.ts` derives it from the boolean:
`true` gives `excluded`, `adjacent_subnet` and `adjacent_domain`; `false` gives
`excluded` only. The live path (`src/main/services/alert-runtime.ts`) and the
retroactive recompute (`src/main/index.ts`) both take the floor from there.

| Distance | `false` | `true` (default) | Proof |
|---|---|---|---|
| D0 in scope | no violation | no violation | `alert/scope-policy`, `scope-recompute` |
| D1 excluded | **violation** | **violation** | `alert/scope-policy`, `scope-recompute` |
| D2 adjacent subnet | silent | **violation** | `alert/scope-policy` (on); `—` (off) |
| D2 adjacent domain | silent | **violation** | `alert/scope-policy` |
| D3 unrelated | silent | silent | `alert/scope-policy`, `scope-recompute` |

D1 fires either way: "keep off X" is not a preference call. D3 raises a
violation through no setting, and is not counted either: `ScopePolicy.evaluate()`
drops the verdict before any surface sees it.

Bookkeeping: violations accumulate rather than dedupe. The in-memory log
(`ViolationLog` in `src/core/alert/surface.ts`) keeps the newest 500, each with
target, command and timestamp; it cuts the command to 200 characters, as the
chained event does, and `list()` returns a copy. The Scope page reads the chain
instead (`scope:getViolations`). A violation event is `system` /
`subtype: scope_violation` carrying `distance` (`excluded` \| `adjacent_subnet`
\| `adjacent_domain`), with `authority` (`fact` \| `inferred`) and `severity`
alongside, so downstream can tell an observation from an inference. The log and
the live event payload are asserted by no test (`—`); the recompute's rows carry
their distance (`scope-recompute-run`). The chain also gets a row for every
in-scope hit, with `distance: in_scope` but under the same `scope_violation`
subtype (G-S2).

Whatever the tier, the command itself still lands in the timeline — only the
*alert* is suppressed, never the record: `src/core/ingest.ts` inserts the event
before it dispatches to the policies (`—`).

`configure()` semantics: omitting `alertFloor` on a later call keeps the current
floor, and replacing `targets` rebuilds the containers used for D2
(`ScopePolicy.configure()`). Neither is asserted by a test (`—`).

## 1.7.1 One severity scale for both alarms

The self alarm (IP) and the target alarm (scope) share one severity type, four
steps: `clean` < `notice` < `warning` < `critical` (`Severity` in
`src/core/alert/policy.ts`). No code ranks or folds them: the status bar draws
the IP dot and the scope count separately, and the scope side is still an
on/off light, so a D1 hit and a D2 inference look the same there.

| Input | Severity |
|---|---|
| `exposed` / D1 `excluded` | `critical` — the thing you must not do, observed, non-silenceable |
| `off_profile` / D2 adjacent | `warning` |
| D3 `unrelated` | `notice`, though no setting lets it reach a surface (§1.7) |
| `unknown` (including stale) / `presumed_safe` | `notice` |
| `safe` / D0 `in_scope` | `clean` |

Proof: `alert/ip-policy` and `alert/scope-policy` assert the severity of each
verdict except `unknown` and `unrelated`, and `scope-one-classifier` that every
spelling of one target gets the same severity. No surface renders severity.

Authority (`fact` \| `inferred` \| `unknown`) travels alongside severity on each
verdict and on the chained events (`src/core/alert/surface.ts`). No surface
renders it either, and `insertEvent` stamps none of its own. On the Timeline,
`dotShape()` (`src/renderer/src/lib/timelineDomain.ts`) keys on the event type
and a marker's severity, not on authority: every scope violation is a diamond
and a critical marker a hollow ring (`e2e`: `timeline-encoding.spec.ts`).

## 1.8 Alert display — the verdict has to be seen

The same verdict has to be legible on three surfaces. The renderer receives
three states, not five: `verdictToSafety()` in
`src/main/services/alert-runtime.ts` shows `presumed_safe` as `safe` and
`off_profile` as `exposed`, and a stale reading arrives as `unknown`. So on
screen the two qualified verdicts do borrow a plain one's confidence (G-UI2).
No test asserts what any surface renders: the decision is `alert/ip-policy`,
and every display claim in this section is `—` unless it names a test.

| State | Verdicts | HUD label | Dashboard card | Status bar |
|---|---|---|---|---|
| `safe` | `safe`, `presumed_safe` | `SAFE` | green dot, `Safe IP` | green dot, `SAFE` |
| `exposed` | `exposed`, `off_profile` | `EXPOSED` | red pulsing dot, `Exposed IP`, and the hint that the address is on the Exposed IP list — shown for `off_profile` too, where it is not true | red dot, `EXPOSED` |
| `unknown` | `unknown`, any stale reading | `IP?` | yellow dot, `Unknown IP`, and the hint to set the two lists — shown for a failed read too, when both may be set | amber dot, `IP?` |

The HUD frame turns red on the `exposed` state (`#d75f63`) and stays cyan
(`#3fc7d6`) otherwise; `flashOnExposed` controls only the flash, never the
colour. The `exposed` state also opens the HUD and keeps it from collapsing
(`src/renderer/src/OverlayApp.tsx`).

The expanded HUD pane spells the state out in words (`Safe IP — Protected`,
`Exposed IP — Not Protected`, or `Unknown IP` and the same set-the-lists hint).
A provider error is printed in the expanded pane and on the card, and the last
address stays on display: a stale reading keeps it. The status bar prints the
address after the label in every state; before the first successful reading the
HUD and card show `—` and the status bar shows no address.

**Scope alerts:** the status bar shows `SCOPE <n>` with a red dot, `SCOPE OK`,
or `SCOPE —` when no scope is set. `<n>` counts the violations that still stand
across the whole chain (`countActiveScopeViolations()` in
`src/core/scope-recompute-run.ts`). The Scope & Evidence view distinguishes
`NOT SET` (with the hint that fixes it) from `ACTIVE` + "all commands within
scope". It lists the standing violations with target, command and time, 200 at
a time with a shown / total footer. Withdrawn ones sit behind "Show withdrawn",
which appears only while at least one violation still stands. There is no
Export button on it. The list is read from the newest 500
`scope_violation` rows (`queryScopeViolationRows()`, same file), and that
window counts the in-scope rows before dropping them (G-S3). Proof:
`scope-recompute-run` for the read model; `e2e` (`scope-recompute.spec.ts`)
for the recompute banner, the "judged later" tag on rows a recompute flagged,
and withdrawn rows kept rather than deleted. The rest is `—`.

**Recording vs capture health:** the status bar's recording control has a dot
and a label. Paused: a grey dot and `PAUSED`, which turns amber, pulses and
shows the minutes after five minutes. Recording: the label reads
`Waiting for events…` before the first event and whenever capture is `dark`,
and `REC` otherwise. The dot pulses red on a healthy or not-yet-reported
capture, pulses amber on `partial`, and stays amber and still on `dark`. Proof:
`e2e` (`recording-flow.spec.ts`) asserts `PAUSED` and `Waiting for events…`;
the `REC` label and the dot colours are `—`.

**Live updates:** the open HUD subscribes to all five overlay settings
(`showMark`, `flashExposed`, `scale`, `emphasizeIp`, `passThrough`), and each
takes effect without a restart. A pass-through opacity of `0` is ignored on the
live message as well as on the config read; a live `scale` of `0` is clamped to
0.75 rather than ignored. `—`.

---

# Part 2 — Config option matrix

Defaults below are asserted one-per-`it` in `config-options`, so a changed
default fails a named test rather than a distant integration.

## 2.1 `engagement` / `operator`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `engagement.id` | `default` | stamped on every event | `config-options` |
| `engagement.activeTarget` | `null` | the operator's current target: canonical ingest labels shell, marker and screenshot rows that carry no target of their own with it, and never overwrites an observed one (SPEC-target-identity) | `ingest` |
| `operator.id` | `operator-1` | attribution; no operator = no capture (see 2.5, 2.9) | `config-options` |
| `operator.name` | `Operator` | display only | `config-options` |

There is no `engagement.name`: the project's name is the one name, shown by the
title bar and the picker, and Settings ▸ General renames the project.

## 2.2 `network`

| Option | Default | Values | Behaviour | Proof |
|---|---|---|---|---|
| `whitelist` | `[]` | IPs / CIDRs | §1.1–1.2 | `config-options` (the default), `alert/ip-policy` (the verdicts) |
| `blacklist` | `[]` | IPs / CIDRs | §1.1–1.2, wins over whitelist | `config-options` (the default), `alert/ip-policy` (the verdicts) |
| `checkInterval` | `60` | seconds | §1.5; the Settings field turns junk, and `0`, into 60 (`parseInt(v) \|\| 60` in `NetworkPage.tsx`) | `config-options` (the default); `—` (the cadence, the field) |
| `providers` | `[]` | URLs | §1.4 | `config-options` (the default); `—` (§1.4) |
| `confirmations` | `3` | ≥1 | §1.3; the Settings field clamps to ≥1 and turns junk into 3 | `config-options` (the default); `—` (§1.3, the field) |
| `ipMode` | `auto` | `dns` \| `http` \| `auto` | §1.4 | `config-options` (the default); `—` (§1.4) |
| `offline` | `false` | bool | air-gap: RedLog makes no outbound requests of its own — OpenTimestamps anchoring, NTP, the update check and the external-IP lookup. The IP verdict reads `unknown`, with the internal address still shown. Capture and the local API are unaffected | `—` |
| `showWifiName` | `false` | bool | off drops the SSID from the link before it reaches any surface, keeping the link **type** (the UI renders a generic "Wi-Fi"); on shows it. The toggle shows on every platform; on macOS it also asks for Location Services, since the OS redacts the SSID without it. Turning it off applies immediately rather than at the next 20 s poll | `network-link-display` |
| `vpnAdapters` | 12 built-ins, all enabled | `{name, pattern, enabled}` | patterns are user regexes matched case-insensitively against interface names | `config-options` (the default); `—` (the matching) |

`vpnAdapters` detail (`setVpnAdapters()` and `detectVpnInterfaces()` in
`src/main/services/opsec-state.ts`): the result feeds the OPSEC state events of
the 30 s poll there, not the IP verdict. A disabled adapter matches nothing; an
empty list means no interface is ever VPN; several adapters can match and the
interface list is sorted; an interface with no non-internal address is skipped;
**a malformed regex is dropped instead of throwing**, so one bad pattern cannot
take the OPSEC poller down; re-configuring replaces the pattern set. The shipped
patterns (`DEFAULT_VPN_ADAPTERS` in `src/core/config.ts`) match `wg0`, `tun0`,
`tap0`, `tailscale0`, `nordlynx`, `proton0`, `utun4`, `ipsec0` and `ppp0`, and
none of them matches `en0` / `eth0` / `wlan0`. No test runs any of this (`—`).

There is no `staleAfter` option: the first failed read marks the verdict stale,
and it reads `unknown` until a read succeeds (`alert/ip-policy`).

## 2.3 `scope`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `warnOnViolation` | `true` | the alert floor (§1.7): `true` alerts on excluded targets and on the adjacent rungs, the same /24 and the same registrable domain; `false` alerts on excluded targets only. Unrelated traffic never alerts. There is no `alertFloor` key: the floor is derived from this (`alertFloorFor`) | `alert/scope-policy` |
| `targets` | `[]` | §1.6; empty = everything in scope | `config-options` (the default), `alert/scope-policy`, `scope-evaluator` (empty = in scope) |
| `excludeTargets` | `[]` | D1: always warns when hit | `config-options` (the default), `alert/scope-policy` (D1) |
| `personalDomains` | `127.0.0.0/8`, `::1`, `localhost` | hosts that are never part of any engagement, in the `excludeTargets` syntax. The personal-traffic filter hides them (`events`), the create card adds the operator's own IP to the defaults rather than replacing them (`create-config-merge`), and exports drop their rows rather than masking them (`—`) | `events`, `create-config-merge` |
| `scopeFile` | `null` | external scope document, loaded on open | `config-options` |

Adjacency is not configurable: a single-IP scope entry's neighbours are its /24
(`subnetOf` in `scope-evaluator.ts`), and registrable domains come from a
built-in table of two-label suffixes (`co.uk`, `co.jp`, …). There is no
`proximityBits` or `publicSuffixes` option.

`scopeFile` parsing (`loadScopeFile`): plain text is one target per line with
`#` comments and blank lines dropped; a JSON array is read as the target list;
a missing file yields `[]` rather than throwing (`config`). Also what the code
does, but asserted by no test (`—`): a file with no extension, or any extension
but `.json`, is read as text; a JSON array keeps only its string entries;
Burp/ZAP's `target.scope` JSON is decoded; malformed JSON and an unrecognised
JSON shape yield `[]`. An unreadable scope must never take the project open
down with it.

Burp/ZAP hold a scope host as a **regex**, so `burpHostToTarget()` decodes the
shapes those tools write into RedLog target syntax:

| Burp host | Decoded | Meaning |
|---|---|---|
| `^example\.com$` | `example.com` | exact host |
| `\Qexample.com\E` | `example.com` | literal-quoted |
| `.*\.example\.com$` | `*.example.com` | "and subdomains" |
| `.*\Qcorp.example.com\E` | `*.corp.example.com` | same, literal-quoted |

`\Q…\E` runs are expanded wherever they appear and however many times; a
hand-written pattern that is still regex-shaped afterwards (`(dev|prod)\.…`) is
handed back **untouched** rather than dropped or half-converted. It matches
nothing, but it stays visible in the scope list — a scope target that vanishes
is the failure with no symptom, since the operator sees a scope load
successfully and never learns which hosts are missing from it.

## 2.4 `screenshot`

| Option | Default | Values | Behaviour | Proof |
|---|---|---|---|---|
| `quality` | `85` | 1–100 | passed to the JPEG encoder verbatim; `0` is ignored and the previous value is kept, 85 on a fresh agent (`configure()` in `src/main/services/screenshot-agent.ts`) | `config-options` (the default); `—` |
| `intervalSec` | `0` | seconds, `0` = off | `0` and negatives schedule nothing; `30` schedules a 30 s loop; `12.9` floors to 12 s; setting it back to `0` cancels the running loop; re-configuring replaces the timer instead of stacking one | `config-options` (the default); `—` |
| `diffThreshold` | `5` | bits, `0` = off | automatic captures only: a frame whose dHash distance from the last stored frame is below this is skipped as no visible change; `0` stores every non-identical frame; manual captures ignore it | `dhash` (the distance and the threshold); `—` (which captures it gates) |
| `captureOnCommand` | `false` | bool | on captures a screenshot when a shell command finishes, linked to it by `_causes`; the perceptual dedup still applies | `—` |

Capture gating (`captureNow()` in `src/main/services/screenshot-agent.ts`): a
periodic capture of an unchanged screen is skipped (exact-bytes then perceptual
dHash), a changed screen is captured again, and a **manual** capture always
lands — including while recording is paused, where periodic capture is
suppressed. No operator id means nothing is scheduled and nothing is captured.
Files land in `<project>/screenshots/` and the event records trigger, size,
dimensions and sha256. `ScreenshotAgent` has no unit test (`—`); `e2e`
(`screenshot-capture.spec.ts`) asserts only that an empty screen-source list is
reported to capture health rather than dropped.

## 2.5 `overlay` — HUD appearance

| Option | Default | Values | Behaviour | Proof |
|---|---|---|---|---|
| `showMarkButton` | `true` | bool | `false` hides both mark buttons in the expanded pane, keeping the keep-open toggle | `config-options` (the default); `—` |
| `showInDock` | `true` | bool | macOS only: keeps a Dock icon once the HUD is shown. Stays manual — `app.dock.hide()` takes effect asynchronously via the activation policy and its result is **not observable** through `app.dock.isVisible()` in an automated Electron run (polled 5 s, still reports visible), which is also why main re-runs `applyDock()` on a timer and on overlay show | manual §5.4 |
| `flashOnExposed` | `true` | bool | `false` keeps the red frame but stops the flashing; never flashes while `safe` | `config-options` (the default); `—` |
| `scale` | `1.0` | six stops in the UI, 0.75 / 0.85 / 1.0 / 1.25 / 1.5 / 1.75; the slider snaps to them | scales type and padding; **clamped to 0.75–1.75** (`OverlayApp.tsx`). `0` and negatives are ignored when the HUD first reads the config, but a saved `0` reaches the open HUD as a live update and is clamped to 0.75 (§1.8) | `config-options` (the default); `e2e` (`hud-overlay.spec.ts`: no expanded-pane label wraps at 1.0, 1.25 or 1.5); `—` (the clamp) |
| `emphasizeExternalIp` | `false` | bool | multiplies **only** the external IP by a further 1.4×, compounding with `scale` | `config-options` (the default); `—` |
| `passThrough` | `false` | bool | dims HUD chrome and lets mouse events through (`setIgnoreMouseEvents` in `src/main/ipc/overlay.ts`). A toggle from the HUD, ⌘⇧P or the menu bar is saved as the setting. The `exposed` state turns it off for the session and makes the window fully opaque; the stored setting is untouched, so it comes back at the next project open | `config-options` (the default), `overlay-pass-through` (a runtime toggle is saved); `—` (the rest) |
| `passThroughOpacity` | `0.4` | 0.1–0.9 in the UI | applied while `passThrough` is on; `0` is ignored (an invisible HUD is worse than none). In the compact bar it dims everything but the frame and the external IP column (address and pivot), so the verdict label and dot dim with the rest. The expanded pane is dimmed as a whole, its external IP row included | `config-options` (the default); `—` |

The external IP's font size (base 12 px), computed by `fsIp()` in
`OverlayApp.tsx` rather than measured by any test: `0.85 → 10.2`, `1.0 → 12`,
`1.25 → 15`, `1.5 → 18`, `1.75 → 21`; `99 → 21` and `0.01 → 9` (clamped); with
`emphasizeExternalIp`: `1.0 → 16.8`, `1.5 → 25.2`.

## 2.6 `terminal` / `retention`

Every store's retention sits under `retention.<store>` with the same two knobs
(Spec 028): `keepDays` sweeps by age on project open, `maxBytes` evicts under
size pressure. `0` means keep forever / unbounded, and is the default for all
of them (`one-retention-model`).

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `terminal.maxCastBytes` | `52428800` (50 MB) | a session's `.cast` is truncated at the cap with an inline marker; values ≤ 0 are ignored. A capture limit on one recording, not retention | `cast-slice` (slicing), manual §5.5 (truncation) |
| `retention.casts.keepDays` | `0` | `N` deletes `.cast` files older than N days, one `system.cast_pruned` audit event per deletion; the recording leaves the search index too | `retention` |
| `retention.screenshots.keepDays` | `0` | same shape, `system.screenshot_pruned` | `retention` |
| `retention.httpBodies.keepDays` | `0` | same shape for `http-bodies/*.body`, `system.http_body_pruned` | `retention` |
| `retention.agentTranscripts.keepDays` | `0` | same shape for agent transcript sidecars, `system.agent_transcript_pruned` | `retention` |
| `retention.casts.maxBytes` / `retention.screenshots.maxBytes` | `0` | over budget, the coldest files are evicted first; a file of an in-scope target is pinned and never evicted, even if that leaves the store over budget (reported as a shortfall) | `artifact-eviction` |
| `retention.httpBodies.maxBytes` | `0` | same model for the body store | `body-eviction-sweep` |
| `retention.loggedTier.keepDays` / `sweepIntervalHours` | `0` / `24` | row-level sweep of `events_logged`, on project open and every N hours | `retention-logged-tier` |
| `retention.bookmarks.keepDays` | `0` | deletes bookmarks older than N days; one `system.bookmarks_pruned` row with the count only | `retention` |

Eviction and pruning delete the file, never the event: the sha256 attestation
and the chain survive, so a pruned file verifies as *pruned*, not as tampered.

## 2.7 `clipboard`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| *(runs with)* | `packs.hostMonitors` | with the pack off from the start nothing is captured; on start the current clipboard is seeded so pre-session content is never captured. Turning the pack off in Settings does **not** stop the poll (G-CB2) | `capture-packs` (the pack's members); `—` (the monitor) |
| `pollMs` | `1500` | honoured as given, **clamped up to 500 ms** | `config-options` (the default); `—` |
| `storePreview` | `false` | off stores hash + length + line count and `preview: null`; on stores the first 120 characters with the spans redaction flags masked to `•` | `config-options` (the default); `—` |

What the monitor does (`src/main/clipboard-monitor.ts`), none of it asserted by
a test (`—`): with `storePreview` off no clipboard text is stored; with it on,
the preview is the raw text apart from the masked spans, so a secret redaction
does not flag lands in clear. Identical consecutive reads dedupe to one event;
an empty clipboard produces nothing; paused recording suspends capture and
resuming restores it — but what was copied during the pause is still captured
at the first poll after resume if it is still on the clipboard (G-CB1).
Detected credential *types* are recorded without copying the credential; a
throwing loot detector does not lose the event.

## 2.8 `browser`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `binary` | `''` | auto-detect per platform (incl. per-user Windows installs) | `browser-launcher` |
| `proxy` | `http://127.0.0.1:8080` | adds `--proxy-server` **and** `--proxy-bypass-list=<-loopback>`; `''` omits both | `browser-launcher` |
| `cdpPort` | `9222` | `--remote-debugging-port`; `0` omits it | `browser-launcher` |
| `isolateProfile` | `true` | `--user-data-dir` + `--no-first-run`; `false` leaves the daily profile alone | `browser-launcher` |
| `ignoreCertErrors` | `true` | `--ignore-certificate-errors` so the intercepting CA is accepted; `false` restores validation | `browser-launcher` |
| `startUrl` | `''` | appended **last** so it is the target, not a flag value; omitted when empty | `browser-launcher` |
| `extraArgs` | `[]` | appended before the start URL; empty strings dropped | `browser-launcher` |

A fully stripped-down config produces no flags at all (`browser-launcher`).

## 2.8a `httpCapture`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `port` | `8080` | the port RedLog's managed mitmdump listens on | `—` |
| `routeTerminals` | `false` | on, a built-in terminal opened while HTTP capture is running gets `HTTP_PROXY` / `HTTPS_PROXY` pointing at the capture proxy | `first-run-record-terminal` (the setting), `—` (the environment) |

## 2.9 `redaction`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `entropyThreshold` | `4.5` | Shannon entropy above which a token is flagged | `redaction` |
| `minLength` | `20` | shorter tokens are never entropy-flagged | `redaction` |
| `denylist` | `[]` | substring match, or `/pattern/` for regex; a malformed regex is ignored | `redaction` |
| `allowlist` | `[]` | suppresses an entropy match | `redaction` |

Plugin-contributed denylist entries merge in and unregister cleanly
(`redaction`); masking preserves span length (`redaction`, `secret-redaction`).

## 2.10 `deconfliction` — removed

The blue-team webhook was removed (`98a7bba`); no code reads a `deconfliction`
block. A config that still has one carries it through unread (Part 3).

## 2.11 `cloudShare` / `marketplace` — removed

Cloud share (`1a77090`) and the plugin marketplace were removed, and
`settings-ia` asserts both stay gone. No code reads either block; the evidence
bundle itself remains, in the one export control.

## 2.12 `fileWatcher` / `processMonitor` / `agentTailer` (tuning; see `packs`)

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| *(runs with)* | `packs.hostMonitors` | starts only with the pack on + non-empty `watchPaths` + an engagement id; turning the pack off stops the watcher | `file-watcher`, `capture-packs` |
| `fileWatcher.watchPaths` | `[]` | empty is a no-op even with the pack on | `file-watcher` |
| `fileWatcher.ignorePatterns` | `[]` | added on top of the built-in ignores | `file-watcher` |
| *(runs with)* | `packs.hostMonitors` | off by default; polled on macOS, Linux and Windows and nowhere else. If the first process listing fails (BusyBox `ps` in a minimal container), a one-shot `process_monitor_ps_unavailable` event says why (`restart()` in `src/main/services/process-monitor.ts`) | `capture-packs` (the pack's members); `—` (the start, the advisory) |
| `processMonitor.pollMs` | `500` | poll cadence; floored at 200 ms, and at **2000 ms on Windows** where a cold PowerShell spawn is 800–1500 ms and a 500 ms cadence would stack calls | `config-options` (the default); `—` (the floors) |
| `processMonitor.ignoreCommands` | `[]` | leading-token match, on top of the built-ins | `process-monitor` |
| `connectionMonitor.pollMs` | `2000` | socket-table poll cadence of the connection monitor, which runs with `packs.hostMonitors`; floored at 1000 ms | `—` |
| *(runs with)* | `packs.aiAgents` | agent transcripts are sensitive: off until the operator turns the pack on for the project; a `.redlog-app-root` marker still opts a repo out | `capture-packs`, `agent-tailer` |
| `agentTailer.emitThinking` | `false` | thinking blocks are excluded unless turned on | `agent-tailer` |
| *(runs with)* | `packs.windowsOutput` | Windows: follows `~/.redlog/transcripts/*.txt` written by `start-transcript-hook.ps1` and emits each command once | `powershell-transcript`, `capture-packs` |

## 2.12a `packs` — optional capture (Spec 035)

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `packs.hostMonitors` | `false` | runs the process, connection, file and clipboard monitors | `capture-packs` |
| `packs.aiAgents` | `false` | runs the Claude Code / Codex / OpenCode transcript tailers | `capture-packs` |
| `packs.windowsOutput` | `false` | runs the PowerShell Start-Transcript follower | `capture-packs` |

A pack runs only when it is on **and** its bundled plugin (`pack-host-monitors`,
`pack-ai-agents`, `pack-windows-output`) is active; disabling the plugin in
Plugins removes the pack's sources from Settings and capture health. The
sources' own `enabled` keys were removed and are not read (`capture-packs`).

## 2.13 `loot`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `loot.disabledRules` | `['jwt', 'generic_api_key']` | rule ids (built-in `type`, or `pluginId:patternName`) not recorded as loot; a switched-off rule still matches, so its values are still masked in the record and in exports. `[]` records every rule | `loot-rule-switches`, `loot-rules-group` |

What any rule records (Spec 031): every occurrence is masked; one loot row per
secret per target, compared on the full value; a failed write is reported in
Capture Health and retried on the next sighting (`loot-correctness`).

---

# Part 3 — Config file handling

| Case | Behaviour | Proof |
|---|---|---|
| no `config.yaml` | full defaults | `config`, `config-options` |
| corrupt / empty YAML | falls back to defaults, never throws | `—` |
| partial file | merges over defaults; siblings keep their defaults | `config` |
| arrays | **replace**, never concatenate | `—` |
| explicit `[]` | wins over a non-empty default | `—` |
| explicit `false` / `0` | kept, not treated as "unset" | `—` |
| unknown key | carried through, not dropped | `—` |
| save → load | round-trips (asserted for `engagement.id` and `network.whitelist`) | `config` |
| `saveConfig` into a missing directory | creates it | `—` |

Each `—` row is what `loadConfig` / `saveConfig` do today (a `deepMerge` over
the defaults, a catch-all fallback, `mkdirSync({ recursive: true })`), but no
test asserts it.

No legacy key is migrated. Spec 006 (the pre-release contract reset) removed
the migrations: `loadConfig` merges the file over the defaults and nothing
else, so an old key such as `network.vpnIPs` or `scope.enforcement` is carried
through unread.

---

# Part 4 — Renderer surfaces

| Surface | Covered | Proof |
|---|---|---|
| every view mounts with one event of each agent type | crash-on-open regressions | `renderer-smoke` |
| HUD verdict colour / label / flash / scale / emphasis / pass-through / mark buttons | §1.8, §2.5 | `—` (`renderer-smoke` mounts the HUD and drives expand and hide; `e2e` `hud-overlay.spec.ts` covers its geometry) |
| dashboard IP card: three states, both addresses, hints, provider error | §1.8 | `—` (`renderer-smoke` mounts it) |
| status bar: IP state, scope count, recording × capture-health dot, loot | §1.8 | `—` (`renderer-smoke`: the clock's title; `e2e` `recording-flow.spec.ts`: the `PAUSED` and `Waiting for events…` labels; `loot-count`: the number it reads) |
| scope violations list: not-set / all-in-scope states, paging, withdrawn rows, chain length | §1.8 | `scope-recompute-run` (the read model), `e2e` (`scope-recompute.spec.ts`), `list-keyboard` (the list keyboard contract) |
| HUD live-update subscriptions (Settings → open overlay) | §1.8 | `—` |
| Settings controls: each toggle / number field writes the right config key, with its UI-layer coercion | §2.x | `—` (`scope-entry-ui`: the create card's excludes and the project rename; `overlay-pass-through`: the pass-through toggle) |
| process-monitor poll cadence + platform floors | §2.12 | `—` |
| one severity scale across both alarms; nothing ranks or folds them | §1.7.1 | `alert/ip-policy`, `alert/scope-policy` |
| Timeline dot shape by event type and marker severity, not by authority | §1.7.1 | `e2e` (`timeline-encoding.spec.ts`) |
| `authority` on each verdict; `insertEvent` stamps none of its own | §1.7.1 | `alert/ip-policy`, `alert/scope-policy`; `—` (the chained events) |
| `scope_violation` payload: `distance` + `authority` per rung | §1.7 | `—` (the live payload); `scope-recompute-run` (the recompute's rows) |
| registrable-domain table (built-in two-label suffixes; not configurable) | §2.3 | `alert/scope-policy` |
| settings search index covers every group | option discoverability | `settings-search` |
| timeline lanes, axis, clustering, modes, wheel, geometry | timeline behaviour | `timeline-*` |
| capture onboarding + readiness | empty/partial states | `capture-onboarding-render`, `capture-readiness`; `—` (the shared `EmptyState`) |
| keyboard shortcuts, split pane, lane visibility/colours | UI plumbing | `shortcuts`, `lane-*`; `—` (the split pane) |

Playwright (`npm run e2e`) runs against a built app. Among others it covers
the HUD overlay window's geometry, recording pause, project flow, command IO,
scope entry and recompute, transcript view and timeline presentation (the
specs are in `e2e/`). The marketplace and cloud-share flows were removed with
their features (`5603ae9`, `1a77090`).

No e2e spec drives the IP alert path through real windows: nothing pushes a
verdict and checks the HUD frame, the flash or the status bar, so §1.8 stays
`—` for every surface.

**End to end, scope:** `e2e/scope-recompute.spec.ts` seeds commands through
the local API and then changes the scope, so the retroactive half of §1.6–1.7
— rows flagged or withdrawn by a recompute — is covered end to end. A live
violation is not: the shell hook's own endpoint (`/api/events`, which
`recording-pause.spec.ts` posts to) could raise one, but no spec checks one on
screen. That part stays at the unit level plus the manual walk-through in §5.3.

---

# Part 5 — Manual QA

What no unit test can reach. Run before a release, or after touching the alert
path.

### 5.1 Trigger an EXPOSED alert end to end

1. Settings ▸ Network: put your real egress IP (`curl ifconfig.me`) in the
   **blacklist**, leave the whitelist empty. Set `confirmations: 1` to skip the
   hold.
2. Disconnect the VPN.
3. Within `checkInterval` seconds the HUD frame turns red, flashes, and reads
   `EXPOSED`; the dashboard card shows a red pulsing dot and the "check your
   VPN" hint.
4. Reconnect the VPN → back to `SAFE`. With only a blacklist set the verdict is
   `presumed_safe` (A-3), which the surfaces show as `SAFE` (§1.8).
5. Set `overlay.flashOnExposed: false` and repeat: still red, no flashing.

### 5.2 Trigger the off-profile (dropped-VPN) case

Whitelist your VPN exit CIDR, blacklist your home IP, then connect through a
third network (phone hotspot). This is the A-9 case from §1.1: the verdict is
`off_profile`, which the surfaces show as `EXPOSED` / red — **never** green. The
card's hint then says the address is on the Exposed IP list, which it is not
(G-UI2).

### 5.3 Trigger a scope violation

1. Settings ▸ Scope: `targets: *.app.example.com, 192.168.1.10`, warnings on.
2. Run `curl vpn.example.com` in a hooked shell → D2 violation: the status bar
   reads `SCOPE 1`, a red row appears in Scope & Evidence, and the
   `system/scope_violation` event carries `distance: adjacent_domain`,
   `authority: inferred`.
3. Run `nmap 192.168.1.55` → D2 again (`distance: adjacent_subnet`), because the
   single-IP entry expands to `/24`.
4. Run `curl google.com` and `nmap 8.8.8.8` → no alert (D3, by design); the
   commands are still in the timeline. No setting makes D3 alert (§1.7).
5. Add `dc01.app.example.com` to `excludeTargets` and turn warnings off
   (`scope.warnOnViolation: false`). Every save schedules a recompute, and this
   one runs under the new floor: the banner counts the two D2 violations from
   steps 2–3 as withdrawn, and the status bar goes back to `SCOPE OK`. Hit
   `dc01.app.example.com` → still alerts (`distance: excluded`,
   `authority: fact`). Hit `vpn.example.com` and `192.168.1.55` again → silent.

### 5.4 `overlay.showInDock` (macOS)

Show the HUD with the option on → Dock icon stays. Turn it off → Dock icon
disappears while the HUD keeps working. **This step cannot be automated**: the
Dock change goes through the macOS activation policy asynchronously and
`app.dock.isVisible()` keeps reporting the old value in an automated run, so an
e2e assertion here would be a false green rather than coverage.

### 5.5 `terminal.maxCastBytes`

Set a small cap (e.g. 4096), run `yes | head -100000` in the built-in terminal,
and confirm the `.cast` ends with the `[redlog: cast truncated at N bytes]`
marker and the event records `castTruncated`.

### 5.6 Wi-Fi SSID (`network.showWifiName`)

Toggle it on, accept the Location Services prompt, and confirm the HUD shows the
real SSID instead of a generic `Wi-Fi`. Toggle it back off — the HUD must drop
to `Wi-Fi` straight away, not at the next poll. The SSID names the building you
are sitting in and the HUD is the surface most likely to be in frame on a
screenshot, so "off" has to mean off everywhere, immediately.

---

# Part 6 — Known gaps

| ID | Gap | Impact |
|---|---|---|
| **G-UI1** | `overlay.showInDock` is the last manual-only option. `app.dock.hide()` changes the macOS activation policy asynchronously and the result does not surface through `app.dock.isVisible()` in an automated run, so the assertion would be a false green. | One setting, verified by §5.4. Of the other three once filed here, `cloudShare.authToken` and `marketplace.defaultRegistryUrl` went with their features (`1a77090`, `5603ae9`), and `processMonitor.pollMs` is decided synchronously in `restart()`, though no test pins its floors (§2.12). |
| **G-UI2** | The renderer gets three states for five verdicts (`verdictToSafety()` in `src/main/services/alert-runtime.ts`): `presumed_safe` shows as `SAFE`, `off_profile` as `EXPOSED` with a hint that the address is on the Exposed IP list, and a stale reading as `IP?` with a hint to set lists that may already be set (§1.8). | The policy's distinctions (§1.1, §1.2.1) stop at the main process, and two of the hints point at the wrong fix. |
| **G-UI3** | No test asserts what an alert surface renders: HUD label and frame, card, status bar dot and label, live updates (§1.8, Part 4). | A display regression on a correct verdict passes the suite. |
| **G-IP1** | An IPv6 CIDR entry in either list never matches, not even its own address; only a bare IPv6 address matches, and only exactly. An IPv6 CIDR with a prefix of 32 or less is read as IPv4 arithmetic instead, so it can match IPv4 addresses (`matchesCIDR` in `src/core/alert/policies.ts`, §1.2). | An IPv6 exit or home range gives no verdict, and a short IPv6 prefix can put IPv4 addresses on a list. |
| **G-IP2** | `IPSignalProducer` (`src/main/services/producers/ip-signal-producer.ts`) has had no tests since v0.12.0 (§1.2.1–§1.5). Two things in it no test would catch: the HTTP path takes `data.ip ?? data.origin ?? String(data)` without the IPv4 check the DNS path applies, so a provider answering another JSON shape yields an address such as `[object Object]`; and `check()` clears its in-flight flag at the end rather than in a `finally`, so a throw from `getInternalIP()` would stop every later check, stale marking included. | A malformed custom provider misses every list: with only a blacklist set that reads `presumed_safe`, shown as `SAFE`. |
| **G-S1** | A CIDR entry narrower than /24 still seeds the /24 of its base address (`buildScopeIndexes`, §1.6). | `10.0.0.0/28` makes `10.0.0.200` `adjacent_subnet`: an inferred boundary the operator did not state. |
| **G-S2** | Every in-scope hit is chained as a `scope_violation` row with `distance: in_scope` (`ChainEmitter`, §1.7), and the Timeline titles each one as a violation (`eventTitle.ts`). | Adherence records read as violations to anyone looking at the Timeline or the raw chain. |
| **G-S3** | The Scope page reads the newest 500 `scope_violation` rows and only then drops the in-scope ones (`queryScopeViolationRows()` in `src/core/scope-recompute-run.ts`, §1.8). Reproduced with one excluded violation under three newer in-scope rows and a window of 2: `countActiveScopeViolations()` 1, rows 0, `truncated: true`. | After enough in-scope traffic the page lists none of the standing violations, hides the truncation note (it renders only with rows), and says "All commands within scope" while the status bar reads `SCOPE <n>`. |
| **G-CB1** | While recording is paused the clipboard monitor returns before reading, so its last hash is the pre-pause one (`sample()` in `src/main/clipboard-monitor.ts`, §2.7). | Whatever was copied during the pause and is still on the clipboard is captured at the first poll after resume — its hash, length, loot types, and the preview when `storePreview` is on. |
| **G-CB2** | `restart()` in `src/main/clipboard-monitor.ts` checks `enabled` before an `await` and sets the interval after it, without clearing one set in between. config:save calls `configureClipboardMonitor` twice in one tick (the options, then `applyCapturePacks`, in `src/main/index.ts`), so every save with the pack on leaves an extra poller nothing references, and the save that turns the pack off still starts one. Reproduced with fake timers in that call order: a clipboard change made after the pack was turned off was captured; with a single configure call it was not. | Clipboard capture continues after the operator turned host monitors off, and nothing stops a leaked poller short of quitting the app. |

Adding a config option? Add its default to the table in `config-options` and
its behaviour to the relevant Part 2 section. If it changes what the operator
sees, it lands in G-UI3 until a surface test exists.

The first of those is **enforced, not requested**: `config-options` walks the
real default config and fails on any option the table does not name (and on any
table entry whose option has been removed). Its first run, with the table taken
from this document as it stood, found drift both ways: nine options the
defaults held that Part 2 never listed (`engagement.activeTarget`,
`network.offline`, `scope.warnOnViolation`, `scope.personalDomains`,
`screenshot.diffThreshold`, `screenshot.captureOnCommand`, `httpCapture.port`,
`httpCapture.routeTerminals`, `connectionMonitor.pollMs`), and fifteen rows for
options no code reads (`engagement.name`, `network.staleAfter`,
`scope.alertFloor`, `scope.proximityBits`, `scope.publicSuffixes`, and the
`deconfliction`, `cloudShare` and `marketplace` blocks). That is exactly the
drift a sentence in a doc cannot prevent.
