# Design Principles

Written 2026-08-11. These are the durable laws behind RedLog's design — the
things that should still be true five versions from now, and the yardstick every
"should we build X?" question answers to. They were settled in a decision review
(the grilling of 2026-08-10/11) and are the source of truth that
`PRODUCT-POSITIONING.md`, `ROADMAP.md` and the UX docs elaborate. When a specific
doc disagrees with a principle here, the principle wins and the doc is the bug.

Each principle carries a one-line *why* and, where it matters, the *test* it
gives you for future decisions.

---

## 1. RedLog is an evidence tool; passive capture is the feeder

The irreducible core is the tamper-evident record a third party can verify:
hash chain + OpenTimestamps + operator attribution + signed bundle. Passive
capture is **how the chain gets fed**, not the point. It is necessary — a record
you must remember to make has holes exactly where the interesting things
happened, and a holey record is not defensible — but its necessity is *derived
from* the evidentiary core, not independent of it.

**Test:** a feature earns its place iff it (i) strengthens the chain, (ii) feeds
capture that would otherwise be lost, or (iii) serves the live-OPSEC front door
(§4). Anything else is a frozen secondary identity (§3) or scope creep.

## 2. Capture broad, sanitize/prune later — and invest in detection

For an evidence tool, capturing *more content* is not safer: exhaustive capture
vacuums up client PII, credentials and out-of-scope data, which is evidentiary
*liability*. But capturing *narrowly* loses reconstruction you can't get back,
and you cannot always know at capture time what will matter. RedLog resolves this
the way `redaction-design.md` already prescribes: **capture full, sanitize on
export.** Bytes never enter the chain (only their sha256); bodies live in a
prunable sidecar; sanitization is a downstream, chained, attributable action.

This makes the **detection/sanitize/prune machinery necessary, not optional** —
loot detector, entropy redaction, scope monitor, io sidecar, retention pruning,
export sanitize. Broad capture without strong detection is just an
undifferentiated pile of sensitive data in your evidence store.

**Corollary — default-on vs opt-in by source:** capture the operator's *own
deliberate actions* (commands, agent tool calls, navigation, targets) on by
default; ambient *vacuums* (clipboard, periodic screenshots) opt-in — not because
they shouldn't be captured, but because they must run continuously and carry an
exposure window, so the operator should consciously accept that bet. (RedLog
already does this: clipboard off by default.)

## 3. Two-tier attributes: record facts, never write interpretation as fact

RedLog records **facts** — including the fact "detector D fired at T with
confidence C." It **never** records an *interpretation* as authoritative ground
truth. Authoritative assertions come from exactly two places: the **operator**
(a marker) or **primary capture** (a command was actually run). Everything
interpreted — phase, target when ambiguous, loot type, scope verdict, any MITRE
tag — is a **suggestion**: labelled `inferred`, confidence-scored, attributable
to the detector, and **promotable by the operator** to an authoritative marker.

This is not a new philosophy — loot detection ("looks like an AWS key,
confidence high"), scope violations and redaction spans already work this way. It
is the law that keeps RedLog honest as it adds convenience.

**Test — every "should RedLog auto-detect X?" has one answer:** *yes, as a
labelled suggestion; never as fact.* Inference lives in the derived/review layer
or as a typed detection event; it never mutates the underlying event's data, and
it is always visually distinct from an operator's assertion (e.g. a dashed
segment vs. a solid one), with one-click promotion.

## 4. Two front doors, one reason to exist

RedLog has two entry points:

- **Evidence recorder** (primary) — the reason RedLog exists. Remove it and
  you have an OPSEC widget, not RedLog.
- **Live-OPSEC HUD** (co-headline) — a genuinely standalone-usable second front
  door. Some operators use *only* the HUD (external-IP/EXPOSED alarm, pivot
  chain, capture-health) and never record an engagement.

The HUD is a *main* feature — polished, marketed, usable on its own — but its
OPSEC scope is **frozen** (§3-of-the-freeze-list): it does not grow new OPSEC
features. "Main" means important and standalone-capable, not ever-expanding.

**Consequences:** the IP/OPSEC/pivot monitors are *doubly* necessary (they feed
the chain *and* the HUD); there must be a **first-class HUD-only runtime mode**
(main window closed, monitors + overlay + tray keep running); and first-run
leads with the zero-setup HUD value while **stating plainly that evidence
recording is the core**, with the Capture Readiness checklist as the invited next
step. Value-first, commitment-later — but never misrepresenting which is the
point.

## 5. Accept but freeze

A secondary identity can be *legitimate yet capped*. This is the principled line
that lets RedLog say no to the next almost-free add-on without pretending the
existing one shouldn't exist. Currently frozen (kept, not grown):

- **Live-OPSEC** — HUD at current scope (§4).
- **Team affordances** — multi-operator tokens, deconfliction webhook, config
  profile sync. **No central server, no shared DB, no team dashboard.**
- **Local code plugins** — drop-in + trust gate; **no** exporters/monitors
  contributions until there is demand.
- **Cloud share** — opt-in BYO-bucket worker; not invested in, not core surface.

**Shelved** (a different verdict — zero demand × high ongoing cost × dangerous if
half-maintained): the **plugin marketplace** (signed registry, publisher trust,
revocation). RedLog is a **product, not a platform**. Revisit only when a real
"someone published a plugin, someone wants to install another's plugin" signal
appears.

**Kept as necessary extensibility:** *declarative* plugins (loot/redaction/target
patterns, event types) — they extend the detection layer §2 deems necessary.

## 6. Agents are a capture source, not a product direction

Agent transcripts are *a capture source*, same chain, same attribution, same
pause semantics as the shell hook — not a new product line. The "AI-agent-native"
angle is real and worth marketing (natively recording agent actions into a
tamper-evident log is a genuine 2026 wedge), but it is a pillar of the **capture
layer**, not of the **control layer**. It never justifies growing an
agent-operations platform.

## 7. Control plane: one implementation, many thin faces

Different consumers legitimately need different transports — agents want MCP,
scripts want REST, humans want shell functions. The rule is **one canonical
implementation** (the localhost REST handlers) with every other surface a
**thin, ideally generated, adapter** that cannot drift: MCP is the blessed
agent-native face; shell functions and the Codex JSON schema are thin wrappers.
The control-op set stays minimal and **evidence-relevant only** — write evidence
(mark, quickmark), operate the chain (anchor, recording pause/resume), read for
agent decisions (scope, status, search, whoami). It never duplicates capture
(hooks own that) and never grows evidence-irrelevant operations.

## 8. The timeline is a reconstruction surface, not a live monitor

Live awareness belongs to the HUD (§4). The timeline's job is **post-hoc
reconstruction and review** — "reconstruct what happened, to whom, in what order;
prove scope-compliance; hand it to a third party." This lets it shed live-ops
weight (follow-mode urgency, live-tail primacy) and its two consequences follow:

- **Organizing axis = target / phase, not source-type.** Source-type (the 18
  lanes) is a live-firehose axis answering "which streams are active" — the HUD's
  job now. Review asks "what happened to *this target*" and "reconstruct *this
  phase*." Source-type demotes to a filter; TargetView folds in as the target
  grouping; the 18-colour problem dissolves because far fewer groups are active
  at once. (Phase per §3: operator-marker segments, with inferred dashed
  suggestions.)
- **Timeline = event map; transcript/exchange = I/O reader.** The timeline shows
  *what happened & to whom* and surfaces I/O only as a presence glyph; the
  actual input/output content is read in the paired transcript/exchange view via
  drill-down. Neither tries to be the other. This also rationalises the
  Timeline/TargetView/Transcript/Search sprawl into three views with distinct
  jobs.

## 9. Sequence, don't just add — surface weight mirrors necessity

RedLog's complexity problem is that P2/P3/expert surfaces are presented to the
solo operator (P1) at equal weight from the first screen — under-sequenced, not
over-featured (with the marketplace the one genuine over-build, §5). The fix is
**progressive disclosure**: essentials prominent, frozen secondary identities
behind "advanced," shelved features removed. Settings, onboarding and the
timeline all follow this — importance decides visual weight, and "find it"
(search) is a complement to sequencing, never a substitute for it.

---

## Using these

For any proposed change, walk the tests: Does it serve §1's core (or §4's second
front door)? If it's capture, does §2's default-on/opt-in line apply? If it
interprets anything, is it a §3 suggestion, not a fact? If it's a secondary
identity, is it §5-frozen or genuinely core? Does it keep the timeline a §8
reconstruction surface and the control plane a §7 single implementation? And does
it earn its §9 surface weight? A change that can't answer these is either scope
creep or an unstated change to the principles — make the latter explicit and
deliberate, never a side effect.
