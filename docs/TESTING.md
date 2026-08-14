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
egress IP ──► classifyIP ──► settling ──► IPStatus ──► HUD frame + dashboard card
command  ──► classifyTarget ──► warnOnViolation ──► violation event ──► ScopeStatus
```

## 1.1 IP verdict matrix — which list wins

Two lists, each independently set or unset, and an address that may hit either.
Nine reachable cells.

| # | whitelist | blacklist | address hits | Verdict | Why |
|---|---|---|---|---|---|
| A-1 | — | — | — | `unknown` | nothing declared, nothing to judge against |
| A-2 | — | set | blacklist | `exposed` | your own IP is showing |
| A-3 | — | set | neither | `safe` | blacklist-only mode infers "behind the tunnel" |
| A-4 | set | — | whitelist | `safe` | on a declared exit |
| A-5 | set | — | neither | `unknown` | declaring a whitelist declares an expectation |
| A-6 | set | set | both | `exposed` | config conflict resolves to the alarming side |
| A-7 | set | set | blacklist | `exposed` | identity leak is never masked |
| A-8 | set | set | whitelist | `safe` | |
| A-9 | set | set | neither | `unknown` | **the VPN-dropped-onto-café-NAT case** |

Proof: `ip-monitor` (table-driven, one `it` per row).

A-9 is the regression that G-A1 fixed — it used to answer `safe` because the
blacklist-only shortcut ran even after a configured whitelist had already
missed. `ip-monitor` keeps both the truth-table row and the scenario-shaped
assertion so a future refactor cannot silently re-introduce it.

## 1.2 Range matching — `network.whitelist` / `network.blacklist`

| Value | Behaviour | Proof |
|---|---|---|
| `10.8.0.0/24` | matches `10.8.0.0` through `10.8.0.255`, including network + broadcast | `ip-monitor-options` |
| `10.8.0.0/24` vs `10.8.1.0` / `10.7.255.255` | one address either side is outside | `ip-monitor-options` |
| `172.16.0.0/12` | matches up to `172.31.255.255`, not `172.32.0.1` | `ip-monitor-options` |
| `203.0.113.42/32` | single host | `ip-monitor-options` |
| `0.0.0.0/0` | matches everything | `ip-monitor-options` |
| `203.0.113.42` (no mask) | exact equality, never a prefix — `203.0.113.4` does not match | `ip-monitor-options` |
| `2001:db8::1/64` | IPv6 compares the literal prefix address only; `::2` does not match | `ip-monitor-options` |
| IPv4 CIDR vs IPv6 address | family mismatch never matches | `ip-monitor-options` |
| multiple entries | a hit on any one entry is a hit | `ip-monitor-options` |
| `[]` (default) | list is not configured → see A-1/A-3/A-5 | `ip-monitor`, `config-options` |

The blacklist is evaluated first and wins outright; a whitelist that is set but
missed downgrades to `unknown`, never to `safe`.

## 1.3 `network.confirmations` — flap protection

A new address is held until it has been read this many times in a row. The
displayed address, and therefore the verdict, does not change during the hold.

| Value | Behaviour | Proof |
|---|---|---|
| `1` | promote on sight, no flap protection | `ip-monitor-options` |
| `3` (default) | two reads hold the old address, the third promotes | `ip-monitor`, `ip-monitor-options` |
| `5` | four reads hold, the fifth promotes | `ip-monitor-options` |
| `0`, negative | rejected — falls back to 3, **not** to "promote instantly" | `ip-monitor-options` |
| first ever reading | taken as-is; there is nothing to flap against | `ip-monitor` |
| candidate changes each poll (CGNAT) | nothing is ever promoted; `settling` stays true | `ip-monitor` |
| old address returns mid-hold | the half-confirmed candidate is dropped | `ip-monitor` |

`settling: true` is the "displayed value is the last stable read" flag. It is set
for the whole hold and cleared on promotion (`ip-monitor-options`).

## 1.4 `network.ipMode` and `network.providers`

| Option | Value | Behaviour | Proof |
|---|---|---|---|
| `ipMode` | `auto` (default) | DNS first, HTTP only if DNS fails/blocked | `ip-monitor-dns` |
| `ipMode` | `dns` | direct query to OpenDNS/Google resolvers, no HTTP at all | `ip-monitor-dns` |
| `ipMode` | `http` | HTTP echo only, DNS never queried | `ip-monitor-options` |
| `providers` | `[]` (default) | the three built-in echo services are used | `ip-monitor-options` |
| `providers` | custom list | tried in order; first success wins | `ip-monitor`, `ip-monitor-options` |
| `providers` | first entry throws | falls through to the next | `ip-monitor-options` |
| `providers` | first entry answers non-200 | treated as a failure, moves on | `ip-monitor-options` |
| `providers` | response `{ip}` or `{origin}` | both shapes are accepted | `ip-monitor-options` |
| `providers` | every entry fails | `error: 'All IP providers failed'`, **last known address is kept** | `ip-monitor`, `ip-monitor-options` |
| `providers` | a later poll succeeds | error clears | `ip-monitor-options` |

## 1.5 `network.checkInterval`

| Value | Behaviour | Proof |
|---|---|---|
| unset (monitor default) | polls every 10 s | `ip-monitor-options` |
| `60` (config default) | polls every 60 s | `ip-monitor-options`, `config-options` |
| `0` | ignored — a zero-second poll would be a busy loop | `ip-monitor-options` |
| `stop()` | clears the timer, idempotent | `ip-monitor-options` |
| slow poll still in flight | the next tick is skipped, not queued | `ip-monitor-options` |

## 1.6 Scope distance ladder — `classifyDistance`

How far a target sits from declared intent (`ALERT-ROLES.md` Part B). The tier
decides whether an alert fires at all, so every rung needs its own row.

| Tier | Distance | Meaning | Alerts? |
|---|---|---|---|
| D0 | `in_scope` | hits a scope entry | no |
| D1 | `excluded` | hits an exclude entry — a **fact** | **always**, even with warnings off |
| D2 | `adjacent_subnet` | same container as a *single-IP* scope entry — **inferred** | only when `warnOnViolation` |
| D2 | `adjacent_domain` | same registrable domain as a scope entry — **inferred** | only when `warnOnViolation` |
| D3 | `unrelated` | no relationship to anything declared | never; **counted** via `getUnrelatedCount()` |

D1 outranks D0: an explicit exclusion inside a broad CIDR still fires.

| Case | Scope | Target | Distance | Proof |
|---|---|---|---|---|
| no scope set | `[]` | anything | `in_scope` | `scope-monitor-behaviour` |
| single-IP entry expands into its container | `192.168.1.10` | `192.168.1.55` | `adjacent_subnet` | `scope-monitor-behaviour` |
| a written CIDR is **not** widened | `10.0.0.0/24` | `192.168.50.1` | `unrelated` | `scope-monitor-behaviour` |
| wildcard expands to the registrable domain | `*.staging.example.com` | `prod.example.com` | `adjacent_domain` | `scope-monitor-behaviour` |
| unrelated domain | `*.staging.example.com` | `google.com` | `unrelated` | `scope-monitor-behaviour` |
| `proximityBits: 16` | `192.168.1.10` | `192.168.2.55` | `adjacent_subnet` | `scope-monitor-behaviour` |
| `proximityBits: 24` (default) | `192.168.1.10` | `192.168.2.55` | `unrelated` | `scope-monitor-behaviour` |
| nonsensical `proximityBits` | any | any | falls back to 24 rather than opening up | `scope-monitor-behaviour` |

The IP/domain asymmetry is deliberate: a bare IP carries no boundary, so
deriving one fills a gap; a CIDR *states* a boundary, and widening it would
invent authorisation the operator never gave. A domain always expands to its
registrable domain because that is the ownership boundary the authorisation is
about — hitting `prod` while scoped to `staging` is exactly what D2 exists for.

## 1.6.1 Scope verdicts — `classifyTarget`

The coarser four-value verdict shared by sanitize and retention (D2 and D3 both
collapse to `out_of_scope` here).

| Target | Scope | Verdict | Proof |
|---|---|---|---|
| `null` / `''` / `undefined` | any | `unknown` (caller picks the safe default) | `scope-monitor-behaviour` |
| anything | `targets: []` | `in_scope` — no scope set means everything is in scope | `scope-monitor-behaviour` |
| `10.0.0.9` | `10.0.0.0/24` | `in_scope` | `scope-monitor-behaviour` |
| `10.0.1.9` | `10.0.0.0/24` | `out_of_scope` | `scope-monitor-behaviour` |
| `api.app.example.com` | `*.app.example.com` | `in_scope` | `scope-monitor-behaviour` |
| `app.example.com` | `*.app.example.com` | `in_scope` — the wildcard covers its anchor host | `scope-monitor`, `scope-monitor-behaviour` |
| `vpn.example.com` | `*.app.example.com` | `out_of_scope` (same root, outside the wildcard) | `scope-monitor-behaviour` |
| `google.com` | `*.app.example.com` | `out_of_scope` | `scope-monitor-behaviour` |
| `10.0.0.1` | in `targets`, also in `excludeTargets` | `excluded` — exclusion beats the enclosing CIDR | `scope-monitor-behaviour` |
| `dc01.app.example.com` | in the wildcard, also excluded | `excluded` | `scope-monitor-behaviour` |

CIDR and wildcard mechanics themselves (`/8` `/16` `/24` `/32`, `*.` prefix, root
extraction) are table-tested in `scope-monitor`.

## 1.7 `scope.warnOnViolation` — whether the operator is told

The switch silences the **inferred** tier only. D1 is a fact and fires
regardless; D3 is never alerted either way (a scan of `google.com` during an
`*.example.com` engagement is noise, and noise is a safety defect — a muted
channel is a removed defence).

| Distance | `true` (default) | `false` | Proof |
|---|---|---|---|
| D0 in scope | no violation | no violation | `scope-monitor-behaviour` |
| D1 excluded | **violation** | **violation** — "keep off X" is not a preference call | `scope-monitor-behaviour` |
| D2 adjacent subnet | **violation** + event + badge | silent, `inScope: false` | `scope-monitor-behaviour` |
| D2 adjacent domain | **violation** + event + badge | silent, `inScope: false` | `scope-monitor-behaviour` |
| D3 unrelated | no violation, counted | no violation, counted | `scope-monitor-behaviour` |

Bookkeeping: violations accumulate rather than dedupe, each carries
target/command/timestamp, `getViolations()` returns a copy, and the full command
is kept in memory while the chained event slices it to 200 chars
(`scope-monitor-behaviour`). D3 hits increment `getUnrelatedCount()` — silent is
not the same as not looking, and the count is what proves it. A violation event
is `system` / `subtype: scope_violation` and carries `reason`
(`excluded_target` \| `adjacent_subnet` \| `adjacent_domain`) plus `authority`
(`fact` \| `inferred`), so downstream can tell an observation from an inference;
`scope_violation` is also the default deconfliction subtype (`deconfliction`).

Whatever the tier, the command itself still lands in the timeline — only the
*alert* is suppressed, never the record.

`configure()` semantics: omitting `warnOnViolation` on a later call keeps the
current value; replacing `targets` re-derives the containers used for D2; a
re-configured `proximityBits` takes effect on the next check
(`scope-monitor-behaviour`).

## 1.8 Alert display — the verdict has to be seen

HUD overlay (`OverlayApp`) and dashboard card (`IPStatusCard`), proof
`alert-display` throughout.

The same verdict has to be legible on three surfaces. Proof: `alert-display`
(HUD + dashboard) and `alert-surfaces` (status bar).

| Verdict | HUD frame | HUD label | Dashboard card | Status bar |
|---|---|---|---|---|
| `safe` | cyan `#3fc7d6` | `SAFE` | green dot, `Safe IP` | green dot, `SAFE` + address |
| `exposed` | red `#d75f63` + flash | `EXPOSED` | red pulsing dot, `Exposed IP` + "check your VPN" hint | red dot, `EXPOSED` |
| `unknown` | cyan | `IP?` | yellow dot, `Unknown IP` + "configure the lists" hint | amber dot, `IP?` |

Also asserted: the expanded pane spells the verdict out in words
(`Exposed IP — Not Protected`) rather than relying on colour alone; an `unknown`
verdict carries the instruction that fixes it; a provider error is shown instead
of pretending the reading is fresh; a missing reading renders `—` rather than a
stale address, and the status bar omits the address entirely.

**Scope alerts** (`alert-surfaces`): the status bar shows `SCOPE OK` or
`SCOPE <n>`; the Scope & Evidence view distinguishes `NOT SET` (with the hint
that fixes it) from `ACTIVE` + "all commands within scope", lists each violation
with its target and command, caps the recent list at 10 rows without losing the
count, and only offers the Export button once there is something to export.

**Recording vs capture health** (`alert-surfaces`): `REC` pulsing red only means
recording *and* a healthy capture. A `partial` verdict turns it amber and still
pulsing; `dark` turns it amber and stops the pulse, because "REC" on its own
would be a lie when nothing is feeding events.

**Live updates** (`alert-surfaces`): the open HUD subscribes to all five overlay
settings (`showMark`, `flashExposed`, `scale`, `emphasizeIp`, `passThrough`), and
each one takes effect without a restart — including the `0`-opacity rejection,
which is enforced on the live message as well as on the config read.

---

# Part 2 — Config option matrix

Defaults below are asserted one-per-`it` in `config-options`, so a changed
default fails a named test rather than a distant integration.

## 2.1 `engagement` / `operator`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `engagement.id` | `default` | stamped on every event | `config-options` |
| `engagement.name` | `Default Engagement` | display only | `config-options` |
| `operator.id` | `operator-1` | attribution; no operator = no capture (see 2.5, 2.9) | `config-options` |
| `operator.name` | `Operator` | display only | `config-options` |

## 2.2 `network`

| Option | Default | Values | Behaviour | Proof |
|---|---|---|---|---|
| `whitelist` | `[]` | IPs / CIDRs | §1.1–1.2 | `ip-monitor*` |
| `blacklist` | `[]` | IPs / CIDRs | §1.1–1.2, wins over whitelist | `ip-monitor*` |
| `checkInterval` | `60` | seconds | §1.5; UI coerces junk to 60 | `ip-monitor-options` |
| `providers` | `[]` | URLs | §1.4 | `ip-monitor-options` |
| `confirmations` | `3` | ≥1 | §1.3; UI clamps to ≥1 | `ip-monitor-options` |
| `ipMode` | `auto` | `dns` \| `http` \| `auto` | §1.4 | `ip-monitor-dns` |
| `showWifiName` | `false` | bool | off drops the SSID from the link before it reaches any surface, keeping the link **type** (the UI renders a generic "Wi-Fi"); on shows it. The macOS toggle also asks for Location Services, since the OS redacts the SSID without it. Turning it off applies immediately rather than at the next 20 s poll | `wifi-name-policy` |
| `vpnAdapters` | 12 built-ins, all enabled | `{name, pattern, enabled}` | patterns are user regexes matched case-insensitively against interface names | `vpn-adapters` |

`vpnAdapters` detail (`vpn-adapters`): a disabled adapter matches nothing; an
empty list means no interface is ever VPN; several adapters can match and the
result is sorted; an interface with no external address is skipped; **a malformed
regex is dropped instead of throwing**, so one bad pattern cannot take the OPSEC
poller down; re-configuring replaces the pattern set. The shipped list is
verified to recognise `wg0`, `tun0`, `tap0`, `tailscale0`, `nordlynx`, `proton0`,
`utun4`, `ipsec0`, `ppp0`, and to leave `en0` / `eth0` / `wlan0` alone.

## 2.3 `scope`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `warnOnViolation` | `true` | §1.7 — silences D2 only | `scope-monitor-behaviour` |
| `targets` | `[]` | §1.6; empty = everything in scope | `scope-monitor-behaviour` |
| `excludeTargets` | `[]` | D1: always warns when hit | `scope-monitor-behaviour` |
| `proximityBits` | `24` | container width derived for a **single-IP** scope entry; entries already written as CIDRs are never widened; values outside 1–32 or non-integers fall back to 24. Settings ▸ Scope renders it under the warn toggle and hides it when warnings are off (nothing to widen); the UI clamps to 1–32 and coerces junk to 24 | `scope-monitor-behaviour`, `config-options`, `settings-interaction` |
| `scopeFile` | `null` | external scope document, loaded on open | `config-options` |

`scopeFile` parsing (`config-options`): plain text is one target per line with
`#` comments and blank lines dropped; a file with no extension is read as text;
a JSON array keeps only its string entries; malformed JSON, an unrecognised JSON
shape, and a missing file all yield `[]` rather than throwing — an unreadable
scope must never take the project open down with it.

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
| `quality` | `85` | 1–100 | passed to the JPEG encoder verbatim; `0` is ignored and 85 is used | `screenshot-options` |
| `intervalSec` | `0` | seconds, `0` = off | `0` and negatives schedule nothing; `30` schedules a 30 s loop; `12.9` floors to 12 s; setting it back to `0` cancels the running loop; re-configuring replaces the timer instead of stacking one | `screenshot-options` |

Capture gating (`screenshot-options`): a periodic capture of an unchanged screen
is skipped (exact-bytes then perceptual dHash), a changed screen is captured
again, and a **manual** capture always lands — including while recording is
paused, where periodic capture is suppressed. No operator id means nothing is
scheduled and nothing is captured. Files land in `<project>/screenshots/` and the
event records trigger, size, dimensions and sha256.

## 2.5 `overlay` — HUD appearance

| Option | Default | Values | Behaviour | Proof |
|---|---|---|---|---|
| `showMarkButton` | `true` | bool | `false` hides both mark buttons in the expanded pane, keeping the keep-open toggle | `alert-display` |
| `showInDock` | `true` | bool | macOS only: keeps a Dock icon once the HUD is shown | manual §5.4 |
| `flashOnExposed` | `true` | bool | `false` keeps the red frame but stops the flashing; never flashes while `safe` | `alert-display` |
| `scale` | `1.0` | 0.85 / 1.0 / 1.25 / 1.5 in the UI | scales type and padding; **clamped to 0.75–2.0**; `0` and negatives are ignored (treated as unset) | `alert-display` |
| `emphasizeExternalIp` | `false` | bool | multiplies **only** the external IP by a further 1.4×, compounding with `scale` | `alert-display` |
| `passThrough` | `false` | bool | dims HUD chrome and lets mouse events through | `alert-display` |
| `passThroughOpacity` | `0.4` | 0.1–0.9 in the UI | applied to chrome while `passThrough` is on; `0` is ignored (an invisible HUD is worse than none); **the external IP is never dimmed** | `alert-display` |

Measured values for `scale` (external IP font size, base 12 px):
`0.85 → 10.2`, `1.0 → 12`, `1.25 → 15`, `1.5 → 18`, `99 → 24` (clamped),
`0.01 → 9` (clamped); with `emphasizeExternalIp`: `1.0 → 16.8`, `1.5 → 25.2`.

## 2.6 `terminal` / `screenshots` / `io` — retention

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `terminal.maxCastBytes` | `52428800` (50 MB) | a session's `.cast` is truncated at the cap with an inline marker; values ≤ 0 are ignored | `cast-slice` (slicing), manual §5.5 (truncation) |
| `terminal.castKeepDays` | `0` | `0` = keep forever; `N` deletes `.cast` files older than N days on project open, one `system.cast_pruned` audit event per deletion | `retention` |
| `screenshots.keepDays` | `0` | same shape, `system.screenshot_pruned` | `retention` |
| `io.keepDays` | `0` | prunes `io/<sha>.bin` sidecars, `system.io_pruned`; a body still referenced by a fresh event is kept (refcount-gated) | `retention`, `artifact-gc` |
| `io.warmDays` | `0` | `0` = never compress; `N` gzips bodies older than N days in place, keeping the ORIGINAL sha256 so verification still passes | `artifact-gc`, `io-store` |
| `io.maxBytes` | `0` | `0` = no cap; over the cap, unpinned bodies are evicted first (out_of_scope before unknown), and a pinned body is never evicted even if that leaves the store over cap | `artifact-gc`, `retention` |

Every prune writes an audit event, so a pruned body verifies as *pruned*, not as
tampered (`retention`, `io-store`).

## 2.7 `clipboard`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `enabled` | `false` | off captures nothing at all; flipping it off stops the poll; on start the current clipboard is seeded so pre-session content is never captured | `clipboard-options` |
| `pollMs` | `1500` | honoured as given, **clamped up to 500 ms** | `clipboard-options` |
| `storePreview` | `false` | off stores hash + length + line count and `preview: null`; on stores a preview capped at 120 chars with high-entropy secrets masked to `•` | `clipboard-options` |

Invariants (`clipboard-options`): raw clipboard text never appears in the event
whatever the setting; identical consecutive reads dedupe to one event; an empty
clipboard produces nothing; paused recording suspends capture and resuming
restores it; detected credential *types* are recorded without copying the
credential; a throwing loot detector does not lose the event.

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

## 2.9 `redaction`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `entropyThreshold` | `4.5` | Shannon entropy above which a token is flagged | `redaction` |
| `minLength` | `20` | shorter tokens are never entropy-flagged | `redaction` |
| `denylist` | `[]` | substring match, or `/pattern/` for regex; a malformed regex is ignored | `redaction` |
| `allowlist` | `[]` | suppresses an entropy match | `redaction` |

Plugin-contributed denylist entries merge in and unregister cleanly
(`redaction`); masking preserves span length (`redaction`, `secret-redaction`).

## 2.10 `deconfliction`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `enabled` | `false` | disabled sends nothing | `deconfliction` |
| `url` | `''` | empty sends nothing even when enabled | `deconfliction` |
| `secret` | `''` | HMAC over the exact bytes sent | `deconfliction`, `signing` |
| `events` | `marker, system, credential_use, c2_checkin` | only these agent types are forwarded | `deconfliction` |
| `subtypes` | `scope_violation` | forwarded even when the agent type is not listed | `deconfliction` |
| `includeData` | `false` | **the PII gate** — the event body is omitted unless this is on | `deconfliction` |
| `authorityFloor` | `inferred` | lowest §3 authority tier to forward: `inferred` sends both tiers labelled; `fact` holds D2 proximity inferences back so the blue team only hears about observed rule matches (G-C2) | `deconfliction` |

Events batch into a single POST and buffered events flush on shutdown rather
than being dropped (`deconfliction`).

## 2.11 `cloudShare` / `marketplace`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `cloudShare.endpoint` | `''` | empty falls back to the local `file://` stub uploader | `cloud-share`, `cloud-share-uploader` |
| `cloudShare.authToken` | `''` | sent as the bearer to the Worker | manual §5.6 |
| `cloudShare.maxBundleBytes` | unset → 100 MB | an oversized bundle is rejected and the zip cleaned up | `cloud-share` |
| `marketplace.defaultRegistryUrl` | bundled example registry | the placeholder + one-click fetch target; an empty box in Settings falls back to it | manual §5.7 |

Bundle building is gated on the reviewed-by-operator flag and produces
zip + `manifest.json` (`cloud-share`); registry installs enforce revocation,
signatures, and tarball hash/metadata agreement (`marketplace`, `publisher-trust`).

## 2.12 `fileWatcher` / `processMonitor` / `agentTailer`

| Option | Default | Behaviour | Proof |
|---|---|---|---|
| `fileWatcher.enabled` | `false` | starts only with enabled + non-empty `watchPaths` + an engagement id; flipping off stops the watcher | `file-watcher` |
| `fileWatcher.watchPaths` | `[]` | empty is a no-op even when enabled | `file-watcher` |
| `fileWatcher.ignorePatterns` | `[]` | added on top of the built-in ignores | `file-watcher` |
| `processMonitor.enabled` | `false` | off by default; Windows emits a one-shot advisory | `process-monitor` |
| `processMonitor.pollMs` | `500` | poll cadence (CPU/coverage tradeoff) | manual §5.8 |
| `processMonitor.ignoreCommands` | `[]` | leading-token match, on top of the built-ins | `process-monitor` |
| `agentTailer.enabled` | `true` | on by default; a `.redlog-app-root` marker opts a repo out | `agent-transcript-tailer` |
| `agentTailer.emitThinking` | `false` | thinking blocks are excluded unless turned on | `agent-transcript-tailer` |

---

# Part 3 — Config file handling

| Case | Behaviour | Proof |
|---|---|---|
| no `config.yaml` | full defaults | `config`, `config-options` |
| corrupt / empty YAML | falls back to defaults, never throws | `config-options` |
| partial file | merges over defaults; siblings keep their defaults | `config`, `config-options` |
| arrays | **replace**, never concatenate | `config-options` |
| explicit `[]` | wins over a non-empty default | `config-options` |
| explicit `false` / `0` | kept, not treated as "unset" | `config-options` |
| unknown key | carried through, not dropped | `config-options` |
| save → load | round-trips every block | `config`, `config-options` |
| `saveConfig` into a missing directory | creates it | `config-options` |

Legacy migration (`config-options`, `config`):

| Old | New | Note |
|---|---|---|
| `network.vpnIPs` | `network.whitelist` | legacy key is deleted so it cannot re-migrate |
| `network.safeIPs` | `network.whitelist` | beats `vpnIPs` when both are present |
| `network.dailyIPs` | `network.blacklist` | |
| `network.exposedIPs` | `network.blacklist` | |
| `scope.enforcement: warn` | `warnOnViolation: true` | |
| `scope.enforcement: log` | `warnOnViolation: false` | the only value that meant quiet (and it did not even log) |
| `scope.enforcement: block` | `warnOnViolation: true` | `block` was the strictest value the old field offered; answering it with silence would give less protection than was asked for, on a config nobody revisits |
| `scope.enforcement: <anything else>` | `warnOnViolation: true` | unrecognised values fail loud, not quiet |

An explicit `warnOnViolation` is never overwritten by a stale `enforcement` key.

---

# Part 4 — Renderer surfaces

| Surface | Covered | Proof |
|---|---|---|
| every view mounts with one event of each agent type | crash-on-open regressions | `renderer-smoke` |
| HUD verdict colour / label / flash / scale / emphasis / pass-through / mark buttons | §1.8, §2.5 | `alert-display` |
| dashboard IP card: three verdicts, both addresses, hints, provider error | §1.8 | `alert-display` |
| status bar: IP verdict, scope count, recording × capture-health dot, loot | §1.8 | `alert-surfaces` |
| scope violations list, empty/not-set states, 10-row cap, chain length, export button | §1.8 | `alert-surfaces` |
| HUD live-update subscriptions (Settings → open overlay) | §1.8 | `alert-surfaces` |
| Settings controls: each toggle / number field writes the right config key, with its UI-layer coercion | §2.x | `settings-interaction` |
| settings search index covers every group | option discoverability | `settings-search` |
| timeline lanes, axis, clustering, modes, wheel, geometry | timeline behaviour | `timeline-*` |
| capture onboarding + readiness | empty/partial states | `capture-onboarding-render`, `capture-readiness`, `empty-state` |
| keyboard shortcuts, split pane, lane visibility/colours | UI plumbing | `shortcuts`, `split-pane`, `lane-*` |

Playwright (`npm run e2e`) covers the HUD overlay window, recording pause,
project flow, command IO, marketplace flow, cloud-share flow, transcript view
and timeline presentation against a built app.

`ip-alert.spec.ts` is the alert path through real windows: a verdict pushed on
`ip:status` turns the HUD frame red and flashes it, reaches the main window's
status bar at the same time, clears back to cyan on `safe`, stays amber and
distinct on `unknown`, and stops flashing the moment `flashOnExposed` is saved
false — no restart. The verdict is pushed rather than provoked by a real egress
lookup: the classifier has exhaustive unit coverage, and an e2e run must not
depend on the machine's network position.

**Not covered end to end:** a scope violation cannot be provoked from the
renderer bridge (no "emit a shell event" IPC), so §1.6–1.7 stop at the unit
level plus the manual walk-through in §5.3.

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
4. Reconnect the VPN → back to `SAFE` (or `unknown` if no whitelist is set).
5. Set `overlay.flashOnExposed: false` and repeat: still red, no flashing.

### 5.2 Trigger the UNKNOWN (dropped-VPN) case

Whitelist your VPN exit CIDR, blacklist your home IP, then connect through a
third network (phone hotspot). The verdict must be `IP?` / amber — **never**
green. This is the A-9 case from §1.1.

### 5.3 Trigger a scope violation

1. Settings ▸ Scope: `targets: *.app.example.com, 192.168.1.10`, warnings on.
2. Run `curl vpn.example.com` in a hooked shell → D2 violation badge, red row in
   Scope & Evidence, `system/scope_violation` event with
   `reason: adjacent_domain`, `authority: inferred`.
3. Run `nmap 192.168.1.55` → D2 again (`reason: adjacent_subnet`), because the
   single-IP entry expands to `/24`.
4. Run `curl google.com` and `nmap 8.8.8.8` → no alert (D3, by design); the
   commands are still in the timeline.
5. Add `dc01.app.example.com` to `excludeTargets`, turn warnings **off**, hit it
   → still alerts (`reason: excluded_target`, `authority: fact`). Hit
   `vpn.example.com` and `192.168.1.55` again → silent.

### 5.4 `overlay.showInDock` (macOS)

Show the HUD with the option on → Dock icon stays. Turn it off → Dock icon
disappears while the HUD keeps working.

### 5.5 `terminal.maxCastBytes`

Set a small cap (e.g. 4096), run `yes | head -100000` in the built-in terminal,
and confirm the `.cast` ends with the `[redlog: cast truncated at N bytes]`
marker and the event records `castTruncated`.

### 5.6 `cloudShare.authToken`

Point `endpoint` at a deployed `redlog-share-worker`, set the token, share a
bundle. Then clear the token → the upload must fail with an auth error rather
than silently falling back to the local stub.

### 5.7 `marketplace.defaultRegistryUrl`

Override it with an internal mirror, open Settings ▸ Plugins, leave the registry
box empty and fetch → the override URL is used.

### 5.8 `processMonitor.pollMs`

Set 100 ms and 5000 ms, spawn a short-lived process, and confirm the shorter
cadence catches it while the longer one may miss it — this is the documented
CPU/coverage tradeoff, not a bug.

### 5.9 Wi-Fi SSID (`network.showWifiName`, macOS)

Toggle it on, accept the Location Services prompt, and confirm the HUD shows the
real SSID instead of a generic `Wi-Fi`. Toggle it back off — the HUD must drop
to `Wi-Fi` straight away, not at the next poll. The SSID names the building you
are sitting in and the HUD is the surface most likely to be in frame on a
screenshot, so "off" has to mean off everywhere, immediately.

---

# Part 6 — Known gaps

| ID | Gap | Impact |
|---|---|---|
| **G-A2** | Blacklist-only mode reports `safe` for an unmatched address — an inference ("not obviously you"), not an observation. | Documented in `ALERT-ROLES.md`; the verdict deserves its own state rather than borrowing `safe`. |
| **G-C3** | `warnOnViolation` is a boolean, so D3 cannot be turned back on. An operator who wants to see *everything* has no setting for it — `ALERT-ROLES.md` Part C.3 replaces it with a three-value `alertFloor`. | D3 is only observable through `getUnrelatedCount()`, which no surface renders yet. |
| **G-UI1** | `overlay.showInDock`, `cloudShare.authToken`, `marketplace.defaultRegistryUrl` and `processMonitor.pollMs` are manual-only. | Main-process/IPC-only paths; the matrix rows above point at §5 instead of a test. |

Adding a config option? Add its default to the table in `config-options`, its
behaviour to the relevant Part 2 section, and — if it changes what the operator
sees — an assertion in `alert-display`.
