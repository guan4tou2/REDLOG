# Event-Type Vocabulary — origin, authority, and timeline identity

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to the `agent_type`
vocabulary — the set of event kinds and **how each declares its timeline
presentation and its §3 authority**. This is the seam that ties three frameworks
together: a **capture plugin** (`PLUGIN-ROLES.md`) emits events; each event's
`agent_type` must claim a **timeline identity** (`TIMELINE-ELEMENTS.md` channels);
and that identity must state whether the event is a **fact or a suggestion**
(§3). `event-schema.md` owns the field definitions; this doc is the classification
+ the pairing rule.

## The load-bearing rule (why capture plugins need this)

**A capture plugin that emits a new event kind MUST pair its `capture` with an
`eventTypes` contribution.** Without it, the event's `agent_type` is unknown to the
registry (`event-registry.ts`) and the timeline drops it into the generic "other"
bucket — no lane, no colour, no glyph, no authority. So "capture" and "how it looks
on the timeline" are **one decision**, not two: emitting without declaring is the
most common way a plugin's evidence becomes illegible on the reconstruction
surface.

```
Parser/Tailer/Tee (PLUGIN-ROLES)  →  emits events with agent_type X
                                      │
        MUST pair with ─────────────►  eventTypes: { agentType: X, label, lane, color, icon }
                                      │   (registerEventTypes → event-registry)
                                      ▼
                       timeline channels (TIMELINE-ELEMENTS): lane, colour, glyph
                                      +  §3 authority (fact vs inferred)
```

## Classification — origin axis (mechanism)

Every `agent_type` maps to exactly one **origin** — where the event comes from —
which also fixes its default authority (§3):

| Origin class | agent_types | Authority (§3) | Default timeline identity |
|---|---|---|---|
| **Operator-authored** | `marker` | **authoritative** (operator assertion) | own lane, solid |
| **Primary-capture** | `shell`/`terminal`, `http`, `http_navigation`, `browser`, `scanner`, `dns`, `screenshot`, `clipboard`, `process` | **authoritative** (a thing actually happened) | source lane / target lane, solid |
| **Agent** | `agent` (tool-calls) | authoritative (the agent did call the tool) | agent lane, solid |
| **Detector-derived** | `loot`, `pivot`, `cleanup`, `file_transfer` | **inferred** (interpretation, §3) | own lane, **dashed** ✅ |
| **System / meta** | `system` (`recording_paused`, `config_changed`, `sanitized`, `*_pruned`, `ip_transition`, `opsec_state_changed`) | authoritative (system fact / drift signal) | system lane / ribbon, solid |
| **Split-authority** | `system`/`scope_violation` | **per event** — `fact` for an excluded target, `inferred` for a proximity match | diamond, stroke set by `data.authority` |

**Correction (2026-08-14, found while implementing K1).** An earlier revision of
this table filed `scope_violation` under detector-derived. Two things were wrong:
it is a **`system` subtype**, not an agent_type, and its authority is **not fixed
by type** — hitting an explicitly excluded target is an observed rule match
(`fact`), while hitting a neighbouring host is a proximity judgement
(`inferred`). See `ALERT-ROLES.md` B.5.

That single case is why authority resolution is **per-event first**: no
type-level default can be right for a type that legitimately emits both. The
type-level default (`EventTypeDef.authority`, and the built-in table in
`core/authority.ts`) is the fallback, never the override.
| **Plugin-contributed** | any of the above, via a plugin | inherits the class it emits into | **must be declared** via `eventTypes` |

**Completeness:** an event can only be *authored* by the operator, *captured* from
a medium, produced by the *agent*, *derived* by a detector, emitted by the
*system*, or *contributed* by a plugin — six origins, no seventh. Every existing
`agent_type` lands in exactly one.

## The two axes

- **Origin** (mechanism) → the class above; also sets **default authority**.
- **Authority** (§3) → authoritative vs inferred, which **must** show as solid vs
  dashed on the timeline. This is the same authority axis as `DETECTOR-ROLES.md`
  and `TIMELINE-ELEMENTS.md` — one law, three surfaces.

## Timeline identity contract (per `agent_type`)

Declared by `EventTypeDef { agentType, label, lane?, color?, icon? }`
(`event-registry.ts`), built-in or plugin-contributed. Maps onto the timeline
channels:

- `lane` → the **Lane** channel (should resolve under the target/phase axis, §8 —
  see gap #3).
- `color` → the **Colour** channel (source-type encoding — see gap #4).
- `icon` → the **Glyph** channel.
- ~~**missing** `authority`~~ → ✅ resolved per event, defaulting by type (gap #2)
  (gap #2).

## Gaps this framework surfaces

| # | Gap | Fix |
|---|---|---|
| 1 | `eventTypes` is **optional** — a plugin can emit a new `agent_type` with no identity → "other" lane | make a new-emitting `capture`/`tailer` **require** a paired `eventTypes` (load-time warn/lint); surface undeclared kinds in Settings ▸ Plugins |
| 2 | ~~`EventTypeDef` has no `authority` field~~ | ✅ **done (K1 slice).** `EventTypeDef.authority` + `EventTypeContribution.authority`; resolved by `core/authority.ts`, stamped into the hashed row by `insertEvent`, read by `lib/dotShape.ts` for the solid/dashed split. Promote-to-marker beyond phase is still open. |
| 3 | `lane` is an **open string** — a plugin can invent a lane that doesn't map to the target/phase axis | reconcile the lane vocabulary with the `lanesForAxis` model (§8): a plugin lane is a *source* lane (a filter), never a new organizing axis |
| 4 | `color` is per-`agent_type`, but the timeline binds **Colour ← source-type**; a plugin picking arbitrary colours collides with the palette | derive plugin colours from the source-type palette, or document the collision rule |
| 5 | vocabulary is documented in `event-schema.md` but the **origin/authority classification** isn't formalised there | keep this doc as the classification; `event-schema.md` stays the field reference |

## Cross-references

- The capture roles that emit events: `PLUGIN-ROLES.md` (Parser, Tailer, Tee)
- The channels an identity maps to: `TIMELINE-ELEMENTS.md`
- The inferred-origin detectors: `DETECTOR-ROLES.md`
- Built-in vs plugin capture line: `CAPTURE-SOURCE-TAXONOMY.md`
- Field reference (source of truth): `event-schema.md`
- Fact vs suggestion: `DESIGN-PRINCIPLES.md` §3
