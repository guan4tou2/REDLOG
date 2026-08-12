# The Decomposition Method — how RedLog closes open subsystems

Written 2026-08-13. RedLog has several subsystems that grow over time (plugins,
capture sources, detectors, integration surfaces). Left ad-hoc, each addition is a
bespoke design decision and the subsystem drifts. This doc names the **repeatable
method** already used for plugins (`PLUGIN-ROLES.md`) and capture
(`CAPTURE-SOURCE-TAXONOMY.md`) so any future subsystem — plugin or not — can be
decomposed the same way, and lists which RedLog subsystems are next.

## The method (six steps)

1. **Name the open-ended subsystem.** The tell: things get *added* to it over time
   (new plugin, new detector, new integration), and today each addition is a
   one-off. If it's a fixed list that never grows, it doesn't need this.
2. **Find the mechanism axis** — *what shape of work is this?* Usually
   "what layer does it act on" or "what is its input → output shape." This axis
   produces the **roles**.
3. **Find the tier / authority axis** — the orthogonal concern that changes the
   *rules* not the *shape*: trust (runs code inside RedLog?), authority (§3:
   authoritative fact vs inferred suggestion?), or origin (built-in vs plugin).
4. **Enumerate the closed role set** at the axes' intersection, then **prove it's
   exhaustive** over the actual API/surface — a table mapping every existing slot
   (every `PluginContributes` field, every `*-detector.ts`) to exactly one role.
   The proof is what turns "a taxonomy" into "the taxonomy."

   **Variant — one role + a canonical catalog.** Sometimes every member does the
   *same* shape of work (e.g. control-plane faces are all thin adapters). Then the
   mechanism axis yields a *single* role, and the closed set that matters is a
   **canonical catalog** the role adapts (the op set). You still prove
   exhaustiveness — every face exposes only catalog ops; anything outside is drift.
   See `CONTROL-PLANE-FACES.md`.
5. **Give each role a template** — the same headings for every role so building a
   new one is filling a known shape: contract (what it emits), tier & why, local
   cost, install/wiring, test seam, and a real instance.
6. **List the API gaps the framework surfaces** — needs that fit no role are not
   "unclassifiable," they are places the *surface* must grow. Naming them turns
   unknowns into a backlog.

## What makes a decomposition *good* (the invariants)

- **Closed:** a small, named set — not "here are some examples."
- **Exhaustive with proof:** a mapping table showing nothing falls outside. If you
  can't build the table, the axes are wrong — pick different ones.
- **One axis per concern:** mechanism decides the role; tier decides the rules.
  Mixing them (a role that's half-shape, half-trust) is the usual failure.
- **Template per role:** identical headings, so the docs are diff-able and a new
  contributor fills a form, not a blank page.
- **Gaps named, not hidden:** every "doesn't fit yet" is an explicit API-gap row.

## Why it pays

- **Design:** "should we build X?" becomes "which role is X?" — and if none, "which
  gap does X open?" Both have answers; the ambiguous middle disappears.
- **Build:** each role has a test seam and a contract, so implementation is
  mechanical and reviewable against a template.
- **AI-navigability:** a coding agent (or a new dev) routes a task to a role in one
  lookup instead of reading the whole subsystem.
- **Laws enforced structurally:** when every detector role must emit a §3
  suggestion, honesty stops depending on each author remembering §3 — the role
  contract carries it.

## RedLog decomposition map

| Subsystem | Status | Mechanism axis (→ roles) | Tier / authority axis | Doc |
|---|---|---|---|---|
| **Plugins** | ✅ done | what layer × what shape → 7 roles | runs code inside RedLog (🟢/🔴) | `PLUGIN-ROLES.md` |
| **Capture sources** | ✅ done | which medium → 15 substrate items | operator-deliberate vs ambient (§2); built-in vs plugin | `CAPTURE-SOURCE-TAXONOMY.md` |
| **Sanitize/retention/rotation** | ✅ specced | which lifecycle stage → hot/warm/cold | pinned vs unpinned (scope/marker); chain vs artifact | `SPEC-SCOPE-AWARE-LIFECYCLE.md` |
| **Detectors / inference** | 🟡 next (this batch) | input→output shape → Extractor/Classifier/Monitor/Correlator | all §3-inferred; built-in vs plugin | `DETECTOR-ROLES.md` |
| **Control-plane faces (§7)** | ✅ done | *one role* (Adapter) + canonical op catalog; classified by transport × audience × generation | which core ops exposed; auth level | `CONTROL-PLANE-FACES.md` |
| **Delivery / export targets** | ✅ done | timing/cardinality → Snapshot vs Stream | sanitize profile by audience (full / scope-sanitized / filtered) | `DELIVERY-TARGETS.md` |
| **Off-chain content stores** | ✅ done | content shape → Blob (io_ref, screenshot) vs Stream (`.cast`) | on-chain digest vs off-chain bytes; content- vs path-addressed | `OFF-CHAIN-CONTENT-STORES.md` |
| **Timeline surface** | ✅ done (structural lens) | 6 encoding channels × 4 interaction modes | fact vs inferred suggestion (§3, solid/dashed) | `TIMELINE-ELEMENTS.md` (defers to `SPEC-TIMELINE-AXIS.md` for design) |
| **Event-type vocabulary** | ✅ done | origin → authored/captured/agent/derived/system/plugin | authoritative vs inferred (§3); declares timeline identity | `EVENT-TYPE-VOCABULARY.md` (field ref: `event-schema.md`) |

**Already closed elsewhere (cross-link, don't redo):** trust tiers 🟢/🔴;
capabilities (least-authority set, `types.ts` L119); four-layer redaction
(`redaction-design.md`); timeline surfaces §8 (map / I/O reader / HUD / search);
Settings by necessity tier × front door (F3 ticket, §9).

## Cross-references

- Worked instances: `PLUGIN-ROLES.md`, `CAPTURE-SOURCE-TAXONOMY.md`,
  `DETECTOR-ROLES.md`, `SPEC-SCOPE-AWARE-LIFECYCLE.md`
- The laws a decomposition must carry: `DESIGN-PRINCIPLES.md` (§2 capture, §3
  facts-vs-suggestions, §7 one-implementation faces, §8 timeline surfaces)
- Deep-module vocabulary (seams, interfaces): the `codebase-design` skill
