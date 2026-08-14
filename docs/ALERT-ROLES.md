# Alert Roles — how RedLog warns without lying

Written 2026-08-14. Applies `DECOMPOSITION-METHOD.md` to the **alerting** subsystem
(`ip-monitor.ts`, `scope-monitor.ts`, and the badge/flash/event/webhook surfaces they
feed). It is the 10th subsystem in the map and the first one whose members are
*verdicts*, not components. Its job: **every warning RedLog raises is one of two
roles, carries an explicit authority (fact / inferred / unknown), and sits at a named
distance from the operator's declared intent — so "add an alert" is filling a
template, and no verdict can present an inference as a fact.**

RedLog never blocks. An alert is therefore the *entire* intervention — if it is
wrong-coloured, there is no second line of defence.

## Principle

> **A green light must be a fact. Everything else is a shade of "I don't know yet."**

The failure mode this subsystem exists to prevent is not a missed alert — it is a
**confident green**. An operator glancing at the status bar and seeing SAFE while
their VPN has silently dropped is worse than no indicator at all, because it
converts uncertainty into false assurance.

## The two roles (mechanism axis: signal shape)

```
"Where am I?"      — periodic poll of my own egress position  → SELF ALARM   (state machine)
"What did I hit?"  — per-action evaluation of a target        → TARGET ALARM (event stream)
```

The shapes are genuinely different and that difference explains every asymmetry in
today's code:

| | **Self alarm** | **Target alarm** |
|---|---|---|
| Trigger | timer (`checkInterval`, default 10s) | each `command_start` with an extracted target |
| Output | a *level* that persists until changed | a *record* that happened once |
| Needs hysteresis? | **yes** — flapping egress must not flap the badge (`confirmations`, `settling`) | **no** — every occurrence is its own fact |
| Needs distance? | **no** — you are either at an expected address or not | **yes** — a target can be near-miss or unrelated |
| Failure to read | must degrade the level (stale) | no reading = no event |
| Instance | `IPMonitor` | `ScopeMonitor` |

**Do not port hysteresis to Target alarms** (each command is discrete) and **do not
port the distance ladder to Self alarms** (there is no "nearly my VPN").

## The tier axis (authority → the rules, not the shape)

Inherited from §3 / K1 (`DECOMPOSITION-BACKLOG.md`): every verdict declares whether
it is observed or inferred.

| Tier | Meaning | Rules it carries |
|---|---|---|
| **fact** | a configured rule matched literally | cannot be silenced by a preference toggle; renders solid; always forwards to deconfliction |
| **inferred** | derived by proximity or by absence-of-match | must render dashed/qualified; silenceable per engagement; must name the inference in the event |
| **unknown** | insufficient data (no lists, no reading, no extractable target) | is its **own colour** — never collapses into safe |

The single largest defect in the subsystem today is a tier violation: an **inferred**
verdict ("your IP isn't on the blacklist") is rendered with the **fact** presentation
(solid green SAFE). See A-3 and A-9 below.

---

# Part A — Self alarm: the IP verdict combination matrix

## A.1 The base combination (what is configured × what matched)

Four independent bits produce the whole space: `W` = whitelist configured, `B` =
blacklist configured, `w` = IP ∈ whitelist, `b` = IP ∈ blacklist. Nine reachable
combinations (`w`/`b` are undefined when the corresponding list is empty):

| # | W | B | b | w | Should be | Tier | `classify()` today | Verdict |
|---|:-:|:-:|:-:|:-:|---|---|---|---|
| A-1 | ✗ | ✗ | – | – | `unknown` | unknown | `unknown` | ✅ |
| A-2 | ✗ | ✓ | ✓ | – | `exposed` | fact | `exposed` | ✅ |
| A-3 | ✗ | ✓ | ✗ | – | `presumed_safe` | **inferred** | `safe` | ⚠️ inference shown as fact |
| A-4 | ✓ | ✗ | – | ✓ | `safe` | fact | `safe` | ✅ |
| A-5 | ✓ | ✗ | – | ✗ | `off_profile` | fact | `unknown` | ⚠️ under-warned |
| A-6 | ✓ | ✓ | ✓ | ✓ | `exposed` + `config_conflict` | fact | `exposed` | ⚠️ conflict never surfaced |
| A-7 | ✓ | ✓ | ✓ | ✗ | `exposed` | fact | `exposed` | ✅ |
| A-8 | ✓ | ✓ | ✗ | ✓ | `safe` | fact | `safe` | ✅ |
| A-9 | ✓ | ✓ | ✗ | ✗ | `off_profile` | fact | `unknown` | 🟡 false green **fixed** (G-A1); still under-stated pending G-A2 |

**A-9 was the dangerous cell — fixed (G-A1).** `classify()` used to fall through to
`if (this.blacklist.length > 0) return 'safe'` *after* the whitelist test had already
failed. Concretely: whitelist `10.8.0.0/24` (my VPN), blacklist `1.2.3.4` (my home
IP), actual egress `5.6.7.8` (VPN dropped, now on café NAT) → **SAFE, solid green**.
The blacklist-mode shortcut was written for the blacklist-only case (A-3) and was
never re-scoped when a whitelist is also present.

The rule now reads: **declaring a whitelist declares an expectation; being outside it
is never `safe`** — which closes A-9 and leaves A-5's existing `unknown` consistent
with it. Both are honestly *under*-stated until `off_profile` exists (G-A2): amber
says "I don't know," where the truth is the stronger "you are not where you said you
would be." Amber is not a false green, so the hazard is closed; the precision is not
yet there.

**A-5 is the mirror mistake.** Declaring a whitelist *is* declaring an expectation;
being outside it is an observed deviation (fact), not a lack of information
(`unknown`). Today it lands in the same amber bucket as "nothing configured at all."

## A.2 The verdict vocabulary this implies

Three states cannot express nine cells. The closed set is five, plus modifiers:

| Verdict | Tier | Meaning | UI |
|---|---|---|---|
| `exposed` | fact | on the blacklist — real identity is leaking | red, flash |
| `off_profile` | fact | a whitelist exists and this is not in it | red-amber, no flash |
| `safe` | fact | on the whitelist | green |
| `presumed_safe` | inferred | blacklist-only, no match — "not obviously you" | green **outline**, not fill |
| `unknown` | unknown | nothing configured / no reading | amber |

## A.3 The confidence modifiers (orthogonal — they multiply, not add rows)

These do **not** create new cells; they qualify any cell. This is the part that keeps
the matrix from exploding.

| Modifier | Source | Status |
|---|---|---|
| `settling` | new address seen < `confirmations` times | ✅ **shipped** — badge shows the last stable verdict, hollow dot + reason |
| `stale` | `consecutiveFailures` reached `network.staleAfter` | ✅ **shipped** — verdict decays to `unknown`, last address retained |
| `family` | reading is IPv6 | ❌ silently mis-classified (below) — G-A5 |

**`stale` was a live hazard.** A VPN kill-switch dropping the network is exactly when
external-IP lookup fails — and the badge kept showing the last verdict (often green)
indefinitely, with only `lastCheck` moving. Neither modifier was even *declared* on
the renderer's `IPStatus`, so no surface could have shown them.

Three rules the fix pins down:

1. **The decay is uniform.** An `exposed` verdict decays too. Holding a red alarm on
   a reading we can no longer confirm is the same dishonesty as holding a green one —
   `unknown` is what we actually know. The last seen address stays on screen, so the
   decay re-labels rather than erases.
2. **`staleAfter` (default 2) is deliberately tighter than `confirmations`
   (default 3).** The thresholds look alike but point opposite ways: being slow to
   *promote* a new address is safe — you keep showing a verdict you verified. Being
   slow to *expire* an old one is not. One failure can be a provider hiccup; two in a
   row at the shipped 60s poll is two minutes of no contact.
3. **One decision, three surfaces.** `lib/ip-badge.ts` maps (verdict, settling,
   stale) → (tone, qualified, reason). StatusBar, IPStatusCard and the HUD keep their
   own styling but cannot disagree about the verdict. `qualified` renders as a hollow,
   unglowing dot — a filled dot is reserved for "this is what we see right now".

**Two further defects surfaced while fixing this**, both in the same
unchanged-address branch of `check()`, which reset the flags but never re-ran
`classify()`:

- A decayed verdict **never recovered** if the network came back on the *same* exit IP
  — the common case for a VPN blip. The badge stayed amber indefinitely.
- Editing the safe/exposed lists in Settings **did not move the badge** until the
  external address happened to change.

The verdict is a pure function of (address, lists), so it is now derived on every
poll rather than only on address change.

**IPv6 was structurally broken — fixed (G-A5).** `ipInCIDR()` compared an IPv6
address to a CIDR by string-equality against the network part, so `2001:db8::1` ∈
`2001:db8::/32` returned **false**. Any v6 whitelist never matched (→ A-5/A-9), and a
v6 egress against a v4-only blacklist took the A-3 fall-through → `safe`. The A-9 fix
did not reach v6 at all.

`ip-match.ts` now does real prefix matching for both families, and is the **single**
matcher for the subsystem — `ip-monitor.ts` and `scope-monitor.ts` each carried their
own `ipToLong` + CIDR copy before. It also compares parsed values rather than strings,
so `2001:db8::1` matches the fully expanded `2001:0db8:0000:...:0001`, and reports an
IPv4-mapped address (`::ffff:10.8.0.5`) as IPv4 — providers return that form, and an
operator whose whitelist says `10.8.0.0/24` means it to match. Malformed input is
`false`, never an accidental wildcard.

**The scope side had the same defect in a worse direction (G-B5).** `scope-monitor`'s
`IP_RE` matched only dotted quads, so a v6 target was routed through the *domain*
matcher: a v6 CIDR scope entry never matched, and on the adjacency path a v6 host fell
out as `unrelated` — **silent**. Per Part D that is the one direction this subsystem
must not fail in, so the fix covers both monitors rather than only the one the gap row
named. A single-IP v6 scope entry expands to its **/64** rather than to
`proximityBits`: v6 subnets are /64 near-universally, so there is no operator choice
to expose (Part C.4).

**Remaining v6 limitation (not a defect):** the DNS lookup path filters to v4
(`IPV4_RE`), so a v6 external address is only ever *read* in `http` / fallback mode.

## A.4 The unclassified half

`internalIP` is collected, displayed, and **never classified**. There is no
lan-profile concept ("I expect to be on 10.10.x.x this engagement") even though the
same whitelist machinery would serve it — and the Target alarm's new subnet-proximity
rule (Part B) needs exactly that notion of "my segment." Gap G-A4.

---

# Part B — Target alarm: the distance ladder

## B.1 The four distances

The mechanism is **distance from declared intent**, and it is the same ladder for IPs
and for domains:

| | Distance | Condition | Tier | Alert |
|---|---|---|---|---|
| **D0** | in scope | matches `targets` | — | none |
| **D1** | forbidden | matches `excludeTargets` | fact | **always** — not silenceable |
| **D2** | adjacent | in a scope entry's *container*, not in `targets` | inferred | warn (silenceable via `warnOnViolation`) |
| **D3** | unrelated | outside every container | — | silent (count only) |

D1 outranks D0 by design (an explicit exclusion inside a broad CIDR must still fire) —
that ordering is already correct in `checkTarget()`.

## B.2 The container rule (this is the whole of "same subnet / same domain")

D2 needs a definition of "near." The rule is symmetric across both address families
and closes in one line:

> **A single point expands one level into its container. An entry that already *is* a
> container does not expand.**

| Scope entry | Kind | Container (= the D2 zone) | Rationale |
|---|---|---|---|
| `192.168.1.10` | single IP | `192.168.1.0/24` | a bare IP carries no boundary; deriving one *fills a gap* |
| `10.0.0.0/8` | CIDR | *(none)* | the operator stated a boundary; widening it *invents authorisation* |
| `10.0.5.0/24` | CIDR | *(none)* | same |
| `www.example.com` | single host | `*.example.com` (registrable domain) | sibling subdomains are the near-miss zone |
| `*.staging.example.com` | wildcard | `*.example.com` (registrable domain) | **still expands** — see the asymmetry below |

**Correction (2026-08-14, during implementation).** An earlier revision of this
table said a wildcard entry does *not* expand, by analogy with CIDRs. That was
wrong, and the counterexample is the case D2 most exists for: scope
`*.staging.example.com`, operator hits `prod.example.com`. Under "no expansion"
that is D3 — silent. It must be D2.

The asymmetry is real and deliberate: **the domain container is always the
registrable domain, because that domain is the *ownership* boundary the
authorisation is actually about.** A wildcard is a sub-boundary *within* something
owned, not the ownership boundary itself. A CIDR has no comparable ownership
boundary recoverable from the string — `10.0.0.0/8` tells you nothing about whether
the org also owns `192.168.0.0/16` — which is why it cannot expand. The rule at the
top of this section governs the IP side; the domain side always expands.

So both requested alerts fall out of one rule:

- **同網段但非指定 IP** — scope lists `192.168.1.10`, `192.168.1.20`; operator hits
  `192.168.1.55` → inside the derived `/24` container, not in `targets` → **D2**.
  Almost always "right subnet, wrong box" — the highest-value warning in the ladder.
- **同 domain 但非指定 subdomain** — scope lists `www.example.com`; operator hits
  `admin.example.com` → inside `*.example.com`, not in `targets` → **D2**.

The container prefix length for single IPs must be configurable
(`scope.proximityBits`, default 24): a /24 assumption is right for lab and internal
ranges and wrong for a routed /30 hand-off.

## B.3 Where `ScopeMonitor` sits today

| Case | Ladder | Status |
|---|---|---|
| in `targets` | D0 | ✅ |
| in `excludeTargets` | D1 | ✅ fires regardless of `warnOnViolation` |
| domain, shares registrable domain | D2 `adjacent_domain` | ✅ — but the registrable-domain approximation is still wrong (B.4 / G-B2) |
| domain, different root | D3 | ✅ counted |
| single-IP scope entry, same segment | D2 `adjacent_subnet` | ✅ **shipped (G-B1)** |
| IP outside every container | D3 | ✅ **shipped (G-B3)** — was "violation, always" |

Before G-B1/G-B3 the `if (!isIP)` guard in `checkTarget()` meant the proximity filter
applied to domains only; IPs skipped it and every out-of-scope IP raised. That is the
classic alerting death spiral — the noisy channel gets muted, and the D2 signal dies
with it. Both branches now walk the same ladder via the pure `classifyDistance()`.

**D3 is counted, not dropped** (`getUnrelatedCount()`): "silent" must be
distinguishable from "not looking", and the adherence report (G-D1) needs the
denominator. Note also that a D3 target still lands in the timeline as
`detectedTarget` like any other command — only the *alert* is suppressed, never the
record.

## B.4 The registrable-domain defect — fixed (G-B2)

`getRootDomain()` took the last two labels. So `shop.example.co.uk` → `co.uk`, and
`anything.bbc.co.uk` → `co.uk` as well. With scope `*.example.co.uk`, **every
`.co.uk` host in the world became D2-adjacent.** The platform half bit harder in
practice: a scope of `target.github.io` made every GitHub Pages site a near-miss,
and the same for `*.s3.amazonaws.com`, `*.azurewebsites.net`, `*.herokuapp.com`.

`public-suffix.ts` now derives the true registrable domain (public suffix + one
label, longest suffix wins) from a curated table, with `scope.publicSuffixes` for
per-engagement additions.

**Why a curated table and not the full PSL.** The full list means a runtime
dependency (~3 MB; `tldts` is present only as a `jsdom` dev-transitive, not in the
shipped app). RedLog ships eight runtime dependencies deliberately — for an evidence
tool, supply-chain surface is a cost every user pays. The deciding argument is the
**failure direction**, which is asymmetric:

| Table error | Effect | Verdict |
|---|---|---|
| suffix **missing** | falls back to last-two-labels → over-match → noisier D2 | exactly today's behaviour — degrades to the status quo, never below it |
| suffix **wrongly present** | same-owner hosts get different registrable domains → D3 → **silence** | unacceptable: Part D means there is no second line of defence |

So the table carries only unambiguous suffixes; anything doubtful is left out,
costing noise rather than silence, and operators extend it per engagement. That
property is pinned by a test, not just asserted here.

**Known gap:** regional S3 forms (`s3.us-east-1.amazonaws.com`) are absent and fall
back to `amazonaws.com` — over-match, per the safe direction above.

## B.5 What D2 must say when it fires

A D2 alert is **inferred**, so per the tier axis it must name its inference. The
`reason` vocabulary is now closed (G-B4) — it used to write `out_of_scope` for both
the domain-adjacent case and (via the IP path) the unrelated case, leaving them
indistinguishable downstream:

`excluded_target` (D1, fact) · `adjacent_subnet` (D2, inferred) ·
`adjacent_domain` (D2, inferred) · `unrelated` (D3 — counted, not emitted)

The `scope_violation` event also carries `authority: 'fact' | 'inferred'` — the data
half of the §3 split (K1 owns the `EventTypeDef` half and the dashed rendering). That
pair is what will let the deconfliction feed forward D1 while holding D2 back (G-C2),
instead of the current all-or-nothing `subtypes: ['scope_violation']`.

**Wire-format note:** consumers parsing exported violations will see
`adjacent_domain` where they previously saw `out_of_scope`.

---

## Completeness

Every warning-producing site in the codebase maps to exactly one role:

| Site | Role | Tier | Surface |
|---|---|---|---|
| `ip-monitor.ts` `classify()` | Self | fact / inferred (A-3) | `IPStatus.ipSafety` |
| `ip-monitor.ts` `settling` | Self (modifier) | inferred | (unrendered) |
| `ip-monitor.ts` `error` | Self (modifier) | unknown | `IPStatus.error` |
| `main/index.ts` safety-change event | Self → record | fact | `system` event → deconfliction |
| `scope-monitor.ts` excluded branch | Target | fact | `scope_violation` |
| `scope-monitor.ts` root-domain branch | Target | inferred | `scope_violation` |
| `scope-monitor.ts` IP out-of-scope branch | Target | **mis-tiered** (fact presentation, D3 content) | `scope_violation` |
| `StatusBar` / `IPStatusCard` / overlay `flashOnExposed` | Self, render | — | badge/flash |
| `ScopeStatus` badge, `Timeline` diamond | Target, render | — | badge/glyph |

**Honest boundary:** complete over the *current* surface. Two things the operator may
reasonably call "an alert" are deliberately out of this decomposition because they are
other subsystems' members: loot/credential detections (`DETECTOR-ROLES.md`) and
capture-health "dark/partial" (a health verdict, not a warning).

## Per-role template

Both roles fill the same headings:

1. **Contract** — the closed verdict vocabulary it may emit.
2. **Tier per verdict** — fact / inferred / unknown, declared, not implied.
3. **Degradation** — what the verdict becomes when the input is missing. (Self:
   decays to `unknown`. Target: emits nothing.)
4. **Silenceability** — fact verdicts are never silenceable; inferred ones name the
   config flag that mutes them.
5. **Surface binding** — which badge/glyph/event/webhook renders it, and how the tier
   changes the rendering (solid vs dashed/outline).
6. **Test seam** — Self: a table-driven test over the combination matrix. Target: a
   table-driven test over the distance ladder.

## Gaps (backlog)

| # | Gap | Kind | Notes |
|---|---|---|---|
| **G-A1** | ~~`classify()` returns `safe` when both lists are configured and neither matches (A-9)~~ | ✅ **fixed** | A whitelist miss is never `safe`. Verdict is `unknown` pending the `off_profile` state (G-A2). Test seam: exported pure `classifyIP()`, table-driven over A-1..A-9 in `test/ip-monitor.test.ts`. |
| **G-A2** | No `off_profile` / `presumed_safe` verdicts — 3 states cannot encode 9 cells | code + UI | Blocks A-3/A-5 being expressible at all. |
| **G-A3** | ~~`settling` and `error` never reach the badge; verdict never decays~~ | ✅ **fixed** | Decay to `unknown` after `network.staleAfter` (default 2); shared `lib/ip-badge.ts` renders both modifiers on all three surfaces. Also fixed: verdict never re-derived on an unchanged address. |
| **G-A4** | `internalIP` collected but never classified; no lan-profile | code | Also the input Part B's subnet proximity would like. |
| **G-A5** | ~~IPv6 CIDR matching is string-equality — v6 whitelists never match~~ | ✅ **fixed** | Shared `ip-match.ts` (both families, parsed-value comparison, v4-mapped handling). Replaced two duplicate matchers. |
| **G-B1** | ~~No container derivation for single-IP scope entries~~ | ✅ **fixed** | Single-IP entries expand to `scope.proximityBits` (default 24). CIDR entries never widen. |
| **G-B2** | ~~`getRootDomain()` = last two labels → `.co.uk`/`.com.tw` over-match~~ | ✅ **fixed** | Curated table in `public-suffix.ts` + `scope.publicSuffixes`. No new runtime dependency; incomplete → noise, never silence. |
| **G-B3** | ~~IP out-of-scope bypasses the proximity filter~~ | ✅ **fixed** | Both branches walk one ladder via pure `classifyDistance()`. D3 counted via `getUnrelatedCount()`. |
| **G-B4** | ~~`reason` vocabulary is not closed~~ | ✅ **fixed** | Closed to 3 values + `authority` on the event. G-C2 (tier-aware forwarding) is now unblocked. |
| **G-B5** | ~~`IP_RE` is dotted-quad only, so a v6 target is routed to the domain matcher and falls out as `unrelated` — silent~~ | ✅ **fixed** | The scope-side twin of G-A5, found while fixing it. Same shared matcher; v6 single-IP entries expand to /64. |
| **G-C1** | No shared severity vocabulary between Self and Target alarms | doc + code | Each grew its own colours; a §3-honest UI needs one scale. |
| **G-C2** | Deconfliction forwards `scope_violation` wholesale — inferred D2 goes to the blue team as though it were a fact | code | Depends on G-B4. |

## Cross-references

- **`DECOMPOSITION-METHOD.md`** — the method; add alerting as the 10th row.
- **`DECOMPOSITION-BACKLOG.md` K1** — the `authority: fact | inferred` primitive.
  This subsystem is its second consumer; G-A2/G-B4 should land on top of it, not
  beside it.
- **`SPEC-SCOPE-AWARE-LIFECYCLE.md`** — `classifyTarget()` is the *pure* sibling of
  `checkTarget()`. The distance ladder must be added there too, or sanitize and
  alerting will disagree about what "out of scope" means.
- **`DELIVERY-TARGETS.md`** — the deconfliction Stream is an alert consumer (G-C2).
- **`DETECTOR-ROLES.md`** — loot/credential detections are Detectors, not Alerts.

---

# Part C — Toggles: what may be silenced, and at what granularity

## C.1 The rule (falls out of the tier axis)

> **Verdicts have no switches. Surfaces do.**
> Within surfaces: **fact-tier alerts may be de-emphasised, never removed;
> inferred-tier alerts may be silenced.**

`overlay.flashOnExposed` is the existing correct precedent: it does not make
`exposed` disappear, it only stops the flash. Any new toggle must be checkable
against that shape — if flipping it can make a fact-tier verdict *unobservable*,
it is the wrong toggle.

## C.2 Self alarm: zero new toggles

| Candidate | Verdict |
|---|---|
| "silence `exposed`" | ✗ fact — never |
| "silence `off_profile`" | ✗ fact — never |
| "opt out of `presumed_safe` outlining" | ✗ not a toggle — it is a *presentation of uncertainty*; making it optional re-creates the false green (A-3) |
| "hide `settling` / `stale`" | ✗ these are bug fixes (G-A3), not preferences |
| lan-profile whitelist (G-A4) | ✓ but it is a **config field**, not a toggle — same shape as `ipWhitelist` |

The IP side needs **no new booleans**. Every gap in Part A is a correctness fix or
a new list field.

## C.3 Target alarm: one threshold, replacing the existing boolean

The distance ladder is **ordered** (D1 > D2 > D3). An ordered space needs a floor,
not N independent booleans — N booleans would let an operator construct incoherent
states ("warn on unrelated but not on adjacent") and would violate §9 (surface
weight mirrors necessity).

```
scope.alertFloor: 'excluded_only' | 'adjacent' | 'all'      // default: 'adjacent'
```

| Value | Emits | Use case |
|---|---|---|
| `excluded_only` | D1 | recon-heavy phase; third-party services dominate the target stream |
| `adjacent` **(default)** | D1 + D2 | normal engagement — "right subnet/domain, wrong host" is the signal you want |
| `all` | D1 + D2 + D3 | strict authorisation: *any* target not on the list is on the record |

D1 is absent from every "off" position by construction — that is the fact-tier rule
made structural rather than remembered.

**Migration** (the `enforcement` → `warnOnViolation` migration in `config.ts` is the
precedent to copy): `warnOnViolation: true` → `'adjacent'`; `false` →
`'excluded_only'`. Note `false` does **not** map to a "none" — D1 already fires
regardless of `warnOnViolation` today, so the mapping preserves current behaviour
exactly.

Note that `'all'` is today's *accidental* behaviour on the IP path (G-B3). Making it
a deliberate, named choice instead of an unintended default is the whole point.

## C.4 The one tuning parameter (not a toggle)

```
scope.proximityBits: number    // default 24 — container width for single-IP entries
```

**There is deliberately no domain-side counterpart.** The domain container is the
registrable domain — there is no coherent "expand N labels" knob, and offering one
would invite `*.co.uk`-shaped scopes. The asymmetry is intentional; record it so
nobody adds `proximityLabels` for symmetry's sake.

`scope.publicSuffixes` is **not** that counterpart. It does not tune how far the
container reaches; it corrects *where the boundary is* for a suffix the built-in
table does not know. Width knob vs. correctness input — different kinds.

**Net: one enum replaces one boolean, plus one integer. No new switches.**

---

# Part D — Prevention is a non-goal

## D.1 The boundary

> **RedLog records and warns. It does not prevent, gate, or block.**

This is not a limitation to be worked around later — it is the boundary that
defines the subsystem. Everything in Parts A–C is *the whole intervention*, and
Part D exists to say so explicitly, because "surely it should also stop me" is the
first thing everyone asks.

`enforcement: block` was **removed** — `config.ts` migrates only `'warn' | 'log'`.
Three reasons, stronger than citing the law:

1. **The seam is fire-and-forget by construction.** `shell/redlog-hook.zsh`
   `_redlog_preexec` does fire *before* execution — the seam exists — but it posts
   with `curl -sf ... &!`: backgrounded, response discarded, 1s connect timeout. To
   gate, the shell would have to *wait on a localhost round-trip before every
   command*, and a wedged RedLog would wedge the operator's terminal mid-engagement.
2. **Coverage is heuristic, and a 70%-coverage gate is worse than none.**
   `extractTargetWithProvenance()` cannot see targets inside pipelines, loops,
   scripts, or custom tooling. A gate the operator *trusts* but that silently passes
   a third of traffic converts a caught mistake into an uncaught one.
3. **A blocked action leaves the weaker record.** RedLog's deliverable is "provably
   did not exceed scope," not "was unable to exceed scope." The former survives a
   bypassed path; the latter is refuted by one `curl`.

## D.2 The consequence: the alert-quality bar goes *up*, not down

Declining to block does not lower what the alerting subsystem owes — it raises it.
With no second line of defence:

- **A false green is unrecoverable.** Nothing downstream catches what the badge got
  wrong. This is why G-A1 (the A-9 false green) is the highest-severity item in the
  whole subsystem, not a cosmetic issue.
- **Noise is a safety defect, not an annoyance.** A muted channel is a removed
  defence. G-B3 (D3 alerting as loudly as D2) is therefore a correctness bug.
- **Latency is the only "prevention" available.** A D2 warning raised at
  `command_start` reaches the operator within seconds — the drift-to-discovery
  window *is* the whole mitigation. Shortening it is legitimate work; adding a gate
  is not.

## D.3 What RedLog *does* contribute to staying in scope

Entirely within record-and-warn:

| | Contribution | Mechanism | Status |
|---|---|---|---|
| **before** | the scope is correct and legible, sourced from the authorisation document rather than typed | `scope.scopeFile` | ✅ exists |
| **during** | a fast, correctly-tiered warning the operator can act on (Parts A–C) | `IPMonitor` / `ScopeMonitor` | 🟡 gaps open |
| **after** | **positive adherence proof**, not just a violation list | export | ❌ gap |

The *after* column is the underbuilt one. `data:exportViolations` proves violations
happened; nothing produces the more valuable artifact — **every target touched, its
distance classification, and the D0 count**: "247 targets, 247 in scope, 0 excluded,
3 adjacent (with timestamps and commands)". For a client deliverable that is worth
more than any block would have been, and it is the evidentiary framing §1 asks for.

## D.4 Explicit non-goals (considered, rejected — do not re-propose)

| Non-goal | Why not |
|---|---|
| Blocking / gating command execution | D.1 — all three reasons |
| Confirmation prompts before a D1 target, even in an opt-in wrapper | Friction is prevention wearing a costume; it also trains reflex-confirmation, which degrades D1's meaning |
| Exporting scope into tool-enforceable formats (nmap `--excludefile`, Burp scope, deny-lists) | Legitimate work, but it is *prevention tooling*, not record-and-warn. Out of RedLog's remit. |
| Proxy/DNS-level interception of out-of-scope traffic | Same, plus it makes RedLog a network component with an availability contract it must not have |

## D.5 Additional gaps

| # | Gap | Kind | Notes |
|---|---|---|---|
| **G-C3** | `scope.alertFloor` enum replacing `warnOnViolation`, + `proximityBits` | code | Depends on G-B1/G-B4. |
| **G-D1** | Scope-adherence report (positive proof, not just violations) | code | The one real gap left in Part D. Pairs with the bundle export (`DELIVERY-TARGETS.md`, Snapshot role). |
| **G-D2** | Scope provenance — which file, loaded when, by whom, with what diff | code | `config_changed` records the diff; the *source document* is not attributed. |
