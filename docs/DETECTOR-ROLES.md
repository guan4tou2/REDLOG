# Detector Roles — the inference layer, decomposed

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to RedLog's detection /
inference layer (the ~10 bespoke `*-detector.ts` / `*-monitor.ts` files). Its job:
**every detector is one of four roles emitting one uniform §3 suggestion — so
"add a detector" is filling a template, and DESIGN-PRINCIPLES §3 is carried by the
role contract instead of each author's memory.**

## The principle everything derives from

By §3, RedLog records **facts** — operator markers and primary capture (a command
*was* run). **Everything a detector produces is interpretation on top of a fact,
so it is an inferred *suggestion*, never authoritative** — labelled, confidence-
scored, attributable to the detector, and operator-promotable. The detector layer
is therefore uniform on the *authority* axis (all inferred); roles are cut on the
**mechanism axis: input → output shape.**

## The four roles (mechanism axis)

```
Pull a structured fact out of ONE event (a command)?        → EXTRACTOR
Attach a LABEL + confidence to one event/output?            → CLASSIFIER
Watch WORLD/SYSTEM state and emit on a transition?          → MONITOR
Relate TWO+ events into a causal/relational edge?           → CORRELATOR
```

## Master table (every detector file maps to one role)

| Role | Input → Output | Built-in files | Emits | Confidence source | Plugin counterpart |
|---|---|---|---|---|---|
| **Extractor** | 1 command → a structured fact | `pivot-detector`, `target-extractor`, `technique-tagger` (`detectCleanup`/`detectFileTransfer`) | `pivot` / target / `cleanup` / `file_transfer` companion events | deterministic rule (implicit-high) | `targetExtractors` (Recognizer) |
| **Classifier** | 1 event/output → label + confidence | `loot-detector`, `scope-monitor`, `command-tagger` | `loot`, `scope_violation`, stamped tags | pattern/entropy → `high\|medium\|low` | `lootPatterns` / `commandTags` (Recognizer) · `detectionPatterns`/`monitors` (Labeller) |
| **Monitor** | world state over time → transition event | `ip-monitor`, opsec-state monitor | `system.ip_transition`, `system.opsec_state_changed` | observed state delta | — (built-in; a plugin path would be a gated Monitor) |
| **Correlator** | N events → causal edge | `causes-resolver` | `_causes` links (start→end via flow_id) | structural match (flow_id/session) | — |

**Completeness:** all ten inference-layer files map to exactly one of four roles.
The axis (input→output shape) is exhaustive because a detector can only consume
one event, one blob, ambient state, or a set of events — there is no fifth input
class.

## The §3 suggestion contract (what EVERY role must emit)

This is the uniform output the role framework enforces — the payoff of the
decomposition:

- **Inferred, never authoritative:** does not mutate the source event's data; lives
  in the derived/review layer or as a typed detection event.
- **Confidence-scored:** an explicit `confidence` (loot already does this,
  `loot-detector` L8/L17). Deterministic Extractors carry an implicit-high but
  should still *state* it, not omit it.
- **Detector-attributed:** names which detector fired (`target-extractor` already
  stamps `extractor_name`; every role should carry the analog).
- **Operator-promotable:** one-click promotion to an authoritative marker; rendered
  visually distinct from operator assertions (dashed vs solid, §3).

## Per-role reference (template)

### 1. Extractor — pull a structured fact from one command

- **Input → output:** a command string → a structured record (tool, subtype, via,
  route, target). Pure function, no side effects (`technique-tagger` L13,
  `pivot-detector` L32 are the model).
- **Emits:** a first-class companion event (`pivot`/`cleanup`/`file_transfer`) or a
  resolved target with provenance.
- **Confidence:** deterministic rule → implicit-high; **state it explicitly** (gap:
  `pivot-detector`/`technique-tagger` currently omit a confidence field though §3
  says the *interpretation* "this ssh -D is a SOCKS pivot" is inferred).
- **Cost:** one regex pass per command. Negligible.
- **Test seam:** `detectX(command) → record | null` over sample-command fixtures —
  already the shape; keep it pure.
- **Instances:** pivot, cleanup, file-transfer, target extraction. Plugin face:
  `targetExtractors`.

### 2. Classifier — label an event/output with confidence

- **Input → output:** an event or output blob → a label + `confidence`.
- **Emits:** `loot` (type + confidence), `scope_violation` (verdict), stamped tags.
- **Confidence:** pattern/entropy/heuristic → `high|medium|low` (`loot-detector`
  L8). The **scope verdict is a Classifier output** — inferred, so it must be
  promotable, not silently authoritative.
- **Cost:** regex/entropy per event; a model-backed classifier (injection) belongs
  in a 🔴 plugin Monitor, not the built-in hot path.
- **Test seam:** `classify(input) → {label, confidence} | null` over labelled
  fixtures (real / not).
- **Instances:** loot, scope verdict, technique/command tags. Plugin face:
  `lootPatterns`, `commandTags` (deterministic), and the Labeller role
  (`detectionPatterns` 🟢 / `monitors` 🔴) for AI-era injection labels.

### 3. Monitor — watch state, emit on transition

- **Input → output:** ambient world/system state sampled over time → a transition
  event only when it changes.
- **Emits:** `system.ip_transition`, `system.opsec_state_changed` (VPN/DNS/MAC/
  hostname). `IPMonitor extends EventEmitter` (`ip-monitor` L122) is the model.
- **Confidence:** the delta is observed (a fact *that state changed*); the
  *interpretation* (safe vs risky transition) is the inferred part.
- **Cost:** polling (30 s opsec, hysteresis on IP) — standing, so tune intervals;
  matches §2's ambient-is-opt-in stance for anything heavier.
- **Test seam:** `next(prevState, sample) → transition | null` — pure over state
  pairs; the poller is a thin wrapper.
- **Instances:** IP monitor, OPSEC monitor.

### 4. Correlator — relate events into a causal edge

- **Input → output:** two or more events → a causal/relational link between them.
- **Emits:** `_causes` edges (a `command_end` refers to its `command_start`; an
  `http_request_end` to its `http_request_start` via `flow_id` —
  `causes-resolver` L58/L75).
- **Confidence:** usually a **structural** match (flow_id/session/pid), so
  high-certainty; a heuristic correlation (timing-only) would be inferred and must
  say so.
- **Cost:** a small in-memory cache keyed by the linker field; O(1) per event.
- **Test seam:** `resolveIncomingCauses(agentType, data) → sourceIds` over an
  event sequence (`_resetCausesResolver` exists for test isolation, L104).
- **Instances:** start→end causal linking. Candidate future: pivot→command,
  loot→exfil chains.

## The cross-link that matters

**The detector layer and the plugin Recognizer/Labeller roles are one taxonomy
seen from two sides.** Built-in `loot-detector`/`target-extractor` are the core's
Classifier/Extractor; plugin `lootPatterns`/`targetExtractors`/`detectionPatterns`
are the *contributed* Classifier/Extractor. So a new detection need has one
decision — **core or plugin** — and the same role either way. This is why the two
docs share vocabulary.

## Gaps this framework surfaces

| # | Gap | Role | Fix |
|---|---|---|---|
| 1 | Extractors omit an explicit confidence field | Extractor | add `confidence` (implicit-high) so §3's "this is inferred" is visible, not assumed |
| 2 | scope verdict is emitted as a plain violation, not a promotable suggestion | Classifier | render the verdict as a §3 suggestion with one-click operator promotion |
| 3 | no built-in inferred-`detection` event type | Classifier/Labeller | define the shared §3 suggestion shape (confidence, attribution, promote) — same gap as `PLUGIN-ROLES.md` gap #3 |
| 4 | Monitor has no plugin path | Monitor | if third-party state monitors are wanted, a gated plugin Monitor (mirrors 🔴 `monitors`) |
| 5 | Correlator is single-purpose (start→end) | Correlator | generalize to declare linker-field + relation, enabling pivot→command / loot→exfil chains |

## Cross-references

- The method: `DECOMPOSITION-METHOD.md`
- Plugin-side twin roles: `PLUGIN-ROLES.md` (Recognizer, Labeller)
- The law this layer carries: `DESIGN-PRINCIPLES.md` §3
- Event shapes: `event-schema.md`
