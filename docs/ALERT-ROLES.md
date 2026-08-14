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
| A-9 | ✓ | ✓ | ✗ | ✗ | `off_profile` | fact | **`safe`** | ❌ **false green** |

**A-9 is the dangerous cell.** `ip-monitor.ts` `classify()` falls through to
`if (this.blacklist.length > 0) return 'safe'` *after* the whitelist test has already
failed. Concretely: whitelist `10.8.0.0/24` (my VPN), blacklist `1.2.3.4` (my home
IP), actual egress `5.6.7.8` (VPN dropped, now on café NAT) → **SAFE, solid green**.
The blacklist-mode shortcut was written for the blacklist-only case (A-3) and was
never re-scoped when a whitelist is also present.

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

| Modifier | Source | Today | Should be |
|---|---|---|---|
| `settling` | new address seen < `confirmations` times | already tracked; **not rendered** | badge shows last stable verdict, visibly de-emphasised |
| `stale` | `check()` threw — all providers/resolvers failed | `error` set, **verdict retained unchanged** | verdict decays to `unknown` after N failed polls |
| `family` | reading is IPv6 | silently mis-classified (below) | verdict per family, or explicit "v6 unchecked" |

**`stale` is a live hazard.** A VPN kill-switch dropping the network is exactly when
external-IP lookup fails — and today the badge keeps showing the last verdict (often
green) indefinitely, with only `lastCheck` moving.

**IPv6 is structurally broken, verified:** `ipInCIDR()` compares an IPv6 address to a
CIDR by string-equality against the network part, so `2001:db8::1` ∈ `2001:db8::/32`
returns **false**. Any v6 whitelist never matches (→ A-5/A-9), and a v6 egress against
a v4-only blacklist takes the A-3 fall-through → `safe`. The DNS path filters to v4
(`IPV4_RE`) so this only bites in `http` / fallback mode — but that is the mode a
restrictive network forces you into.

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
| `192.168.1.10` | single IP | `192.168.1.0/24` | operator enumerated hosts → the segment is the near-miss zone |
| `10.0.0.0/8` | CIDR | *(none)* | operator already drew the boundary; outside it is D3 |
| `10.0.5.0/24` | CIDR | *(none)* | same |
| `www.example.com` | single host | `*.example.com` (registrable domain) | operator enumerated hosts → sibling subdomains are the near-miss zone |
| `*.example.com` | wildcard | *(none)* | operator already drew the boundary |

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

| Case | Today | Ladder | Delta |
|---|---|---|---|
| in `targets` | no violation | D0 | ✅ |
| in `excludeTargets` | violation, ignores `warnOnViolation` | D1 | ✅ |
| domain, shares root domain | violation | D2 | ✅ in spirit — root-domain approximation is wrong (B.4) |
| domain, different root | silent | D3 | ✅ |
| **IP, out of scope** | **violation, always** | conflates D2+D3 | ❌ scanning `8.8.8.8` alerts identically to hitting the wrong host on the target segment |
| single-IP scope entries | no container derived | D2 unreachable | ❌ **the exact case requested is not implemented** |

The `if (!isIP)` guard in `checkTarget()` means the proximity filter applies to domains
only; IPs skip it and every out-of-scope IP raises. The result is the classic alerting
death spiral — the noisy channel gets muted, and the D2 signal dies with it.

## B.4 The registrable-domain defect (verified)

`getRootDomain()` takes the last two labels. So `shop.example.co.uk` →
`co.uk`, and `anything.bbc.co.uk` → `co.uk` as well. With scope `*.example.co.uk`,
**every `.co.uk` host in the world becomes D2-adjacent.** Multi-label public suffixes
(`.co.uk`, `.com.tw`, `.com.au`, `.co.jp`) are exactly the ones common in engagements
where this matters. Needs a public-suffix table — gap G-B2.

## B.5 What D2 must say when it fires

A D2 alert is **inferred**, so per the tier axis it must name its inference. Today
`recordViolation()` writes `reason: 'out_of_scope'` for both the domain-adjacent case
and (via the IP path) the unrelated case. The reason vocabulary should close to:

`excluded_target` (D1, fact) · `adjacent_subnet` (D2, inferred) ·
`adjacent_domain` (D2, inferred) · `unrelated` (D3 — counted, not emitted)

That vocabulary is also what lets the deconfliction feed forward D1 while holding D2
back, instead of the current all-or-nothing `subtypes: ['scope_violation']`.

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
| **G-A1** | `classify()` returns `safe` when both lists are configured and neither matches (A-9) | code | The false green. Highest severity in the subsystem. |
| **G-A2** | No `off_profile` / `presumed_safe` verdicts — 3 states cannot encode 9 cells | code + UI | Blocks A-3/A-5 being expressible at all. |
| **G-A3** | `settling` and `error` never reach the badge; verdict never decays on repeated failure | code + UI | VPN-kill-switch hazard. |
| **G-A4** | `internalIP` collected but never classified; no lan-profile | code | Also the input Part B's subnet proximity would like. |
| **G-A5** | IPv6 CIDR matching is string-equality — v6 whitelists never match | code | Verified. Affects `http`/fallback mode. |
| **G-B1** | No container derivation for single-IP scope entries → 同網段 alert unreachable | code | The requested feature. Needs `scope.proximityBits`. |
| **G-B2** | `getRootDomain()` = last two labels → `.co.uk`/`.com.tw` over-match | code | Needs a public-suffix table. |
| **G-B3** | IP out-of-scope bypasses the proximity filter → D3 alerts as loudly as D2 | code | The noise source that gets the channel muted. |
| **G-B4** | `reason` vocabulary is not closed; D2 and D3 are indistinguishable downstream | code | Blocks tier-aware deconfliction forwarding. |
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
registrable domain, fixed by the public suffix list (G-B2) — there is no coherent
"expand N labels" knob, and offering one would invite `*.co.uk`-shaped scopes. The
asymmetry is intentional; record it so nobody adds `proximityLabels` for symmetry's
sake.

**Net: one enum replaces one boolean, plus one integer. No new switches.**

---

# Part D — Prevention: RedLog cannot block, and what to do instead

## D.1 Why blocking is off the table (three verifiable reasons, not just the law)

`enforcement: block` was **removed** — `config.ts` migrates only `'warn' | 'log'`,
and the surviving `# warn | block | log` comment in `config.example.yaml` is stale.
The removal was correct, for reasons stronger than §1:

1. **The seam is fire-and-forget by construction.** `shell/redlog-hook.zsh`
   `_redlog_preexec` does fire *before* execution — the seam exists — but it posts
   with `curl -sf ... &!`: backgrounded, response discarded, 1s connect timeout. To
   block, the shell would have to *wait on a localhost round-trip before every
   command*, and a wedged RedLog would wedge the operator's shell mid-engagement.
   An evidence tool that can freeze your terminal will be uninstalled.
2. **Coverage is heuristic, and a 70%-coverage gate is worse than none.**
   `extractTargetWithProvenance()` cannot see targets inside pipelines, loops,
   scripts, or custom tooling. A gate the operator *trusts* but that silently
   passes a third of traffic converts a caught mistake into an uncaught one.
3. **A blocked action leaves the weaker record.** RedLog's deliverable is
   "provably did not exceed scope," not "was unable to exceed scope." The former
   survives a blocked-but-bypassed path; the latter is refuted by one `curl`.

## D.2 The prevention ladder (P0–P3) — mirrors the distance ladder

Prevention is not blocking; it is **moving friction earlier**, to where an alert
cannot help. Earlier is strictly more effective.

| | Stage | Mechanism | Owner | Status |
|---|---|---|---|---|
| **P0** | before the engagement | scope arrives from the authorisation document, not from typing | `scope.scopeFile` | ✅ exists |
| **P1** | before the tool runs | **RedLog exports its scope into the tools' own scope formats** | new (G-D1) | ❌ **the gap** |
| **P2** | at invocation | opt-in wrapper asks for confirmation on D1 | `redlog-run` | ❌ (G-D2) |
| **P3** | after the fact | alert + event + **positive adherence proof** | `scope-monitor` + export | 🟡 partial |

### P1 is the real answer

RedLog already holds an authoritative scope — and uses it **only to judge, after the
fact**. The highest-value prevention work is to emit it in the formats the tools that
actually do the reaching can enforce:

| Target format | From | Enforces |
|---|---|---|
| `nmap --excludefile` | `excludeTargets` (+ D3 complement) | hard skip at scan time |
| Burp Suite target scope JSON | `targets` / `excludeTargets` → include/exclude rules | proxy-level out-of-scope drop |
| ZAP context file | same | same |
| `ffuf` / `httpx` deny list | `excludeTargets` | request-level skip |

This inverts the responsibility correctly: **enforcement belongs to the tool; RedLog's
job is to make sure the tool has the right scope.** It passes the §1 test (serves the
live-OPSEC front door), needs no gatekeeper role, and — unlike a wrapper — survives
the operator running the tool outside RedLog's shell.

### P2 — friction is only legitimate when the operator opted into wearing it

`redlog-run` is a wrapper the operator chooses to invoke. A wrapper *may* pre-flight
`checkTarget()` and require confirmation on **D1 only** (fact tier, explicitly
forbidden target). This is not RedLog blocking; it is a voluntary guard the operator
can drop at any moment, and core capture stays non-blocking. **Never extend it to
D2** — inferred-tier friction on every near-miss trains the operator to reflex-confirm,
destroying D1's meaning.

### P3 — the missing half is the *positive* proof

`data:exportViolations` proves violations happened. Nothing today produces the more
valuable artifact: **every target touched, its distance classification, and the D0
count** — "247 targets, 247 in scope, 0 excluded, 3 adjacent (listed with timestamps
and commands)". For a client deliverable that is worth more than any block would have
been, and it is the evidentiary framing §1 actually asks for.

## D.3 Additional gaps

| # | Gap | Kind | Notes |
|---|---|---|---|
| **G-C3** | `scope.alertFloor` enum replacing `warnOnViolation`, + `proximityBits` | code | Depends on G-B1/G-B4. |
| **G-D1** | Scope export adapters (nmap / Burp / ZAP / deny-list) | code | **Highest-value prevention work.** A Snapshot delivery target — see `DELIVERY-TARGETS.md`. |
| **G-D2** | `redlog-run` D1 pre-flight confirmation (opt-in, D1 only) | code | Must not touch the non-blocking `preexec` path. |
| **G-D3** | Scope-adherence report (positive proof, not just violations) | code | Pairs with the bundle export. |
| **G-D4** | Scope provenance — which file, loaded when, by whom, with what diff | code | `config_changed` records the diff; the *source document* is not attributed. |
