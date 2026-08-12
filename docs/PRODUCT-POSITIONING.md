# Product Positioning

Written 2026-08-10 against v0.11.5. This is the single source of truth for
**who RedLog is for, what job it does, and where its edges are**. The one-line
positioning has lived in `ROADMAP.md` and `docs/README.md`; this page keeps
those in sync and adds the layer they never had — users, jobs, and the
competitive frame. When positioning and roadmap disagree, this page wins and
the roadmap is the bug.

## One sentence

**RedLog is the local, tamper-evident audit-log layer of a red-team
engagement:** it passively records every operator and agent action into a
per-project SHA-256 hash chain, anchored to OpenTimestamps and exportable as a
signed evidence bundle a third party can verify.

If it happened, RedLog captured it. If the timeline shows a 20-minute gap, the
timeline is *right* — the operator was idle, or a `recording_paused` row
explains it.

## The job to be done

> When I run an engagement, I need a complete, defensible record of what I did
> and when — so I can prove I stayed in scope, reconstruct the attack timeline,
> and hand a client or my own legal team something they can trust — **without
> spending the engagement taking notes.**

One core, one feeder — not two co-equal halves (see `DESIGN-PRINCIPLES.md` §1):

1. **The core is evidentiary.** The reason RedLog exists is the tamper-evident
   record a third party can verify: the hash chain, the OpenTimestamps anchor,
   the operator attribution, the signed bundle. This is what separates RedLog
   from a scratchpad, and it is what every feature ultimately answers to.
2. **Passive capture is the feeder, not the point.** Capture must be passive
   because a record you must remember to make has holes exactly where the
   interesting things happened, and a holey record is not defensible. So passive
   capture is *necessary* — but its necessity is derived from the evidentiary
   core, not independent of it. This is why hooks are the backbone and MCP is
   only the control plane (see `agent-integration.md`).

**Necessity test** (the yardstick for every feature): it earns its place iff it
strengthens the chain, feeds capture that would otherwise be lost, or serves the
live-OPSEC front door (below). Anything else is a *frozen secondary identity* or
scope creep. The full tiering and the design laws behind it live in
`DESIGN-PRINCIPLES.md`.

## Two front doors, one reason to exist

RedLog has two entry points, and conflating them mis-sizes half the roadmap:

- **Evidence recorder** *(primary)* — the reason RedLog exists. Remove it and
  what's left is an OPSEC widget, not RedLog.
- **Live-OPSEC HUD** *(co-headline)* — a genuinely standalone-usable second
  front door. Some operators use *only* the HUD (external-IP / EXPOSED alarm,
  live pivot chain, capture-health) and never record an engagement. It is a main,
  marketed, on-its-own-usable feature — but its OPSEC scope is **frozen**: it
  does not grow new OPSEC features. There is a first-class HUD-only runtime mode
  (main window closed; monitors + overlay + tray keep running), and first-run
  leads with the zero-setup HUD value while stating plainly that evidence
  recording is the core. See `DESIGN-PRINCIPLES.md` §4.

## Who it's for

### P1 — The solo pentester / independent consultant *(primary)*

Runs engagements alone or nearly alone. Bills by the engagement, not the tool.
Already keeps notes in Obsidian/OneNote/CherryTree and knows those don't prove
anything. Cares about: **zero setup tax, local-only data (client NDAs forbid
cloud sync), and a deliverable that makes the report defensible.** Does not have
a C2 server, a SIEM, or a report-generation pipeline they want to replace.

> RedLog's design centre. When a decision trades P1's simplicity for a
> team/enterprise capability, the default answer is no.

### P2 — The small red-team operator (2–6 people)

Shares an engagement with teammates and needs **deconfliction** (the blue team
must be able to tell "was that us?") and **per-operator attribution**. Uses the
deconfliction webhook and secondary operator tokens. Still local-first — each
operator runs their own RedLog; there is no central server by design.

### P3 — The AI-agent-driven operator

Drives the engagement through Claude Code / Codex / OpenCode. Their risk is a
**silent gap**: the agent did something and forgot to log it. RedLog's answer is
the transcript tailer + shell hooks (passive, can't be forgotten) with MCP as an
explicit control plane. This persona is why "hooks log, MCP operates" is a hard
rule, not a preference.

### P4 — The HUD-only operator

Uses RedLog purely as a live-OPSEC display — external-IP / EXPOSED alarm, live
pivot chain, capture-health at a glance — and may never record an engagement.
Enters through the second front door (above). Cares about: **zero setup, always
on top, out of the way.** This persona is why the HUD must run with the main
window closed and why first-run must give OPSEC value before asking for any
capture wiring. They are a first-class user, not an edge case — but the tray and
overlay always keep the evidence core one click away, because that is what RedLog
is *for*.

### S1 — The evidence consumer *(stakeholder, not a user)*

The client, the client's counsel, or the operator's own QA. Never opens the app.
Receives the signed bundle and runs `ots verify` / `redlog-verify.py`. Every
positioning claim ultimately answers to this person: **can they check it
themselves?** That is the v1.0 gate.

## What RedLog is NOT

These are deliberate non-goals. Doing them well is someone else's job, and
RedLog integrates with that job rather than competing for it.

| Not RedLog's job | Where it belongs | Why the line is here |
|---|---|---|
| Report writing (Ghostwriter / HackTheBox / Bugcrowd formats) | Downstream report generators | RedLog produces the *record*; the report is an opinionated narrative built from it. Coupling them would make the record answer to the narrative's schema. |
| STIX 2.1 / VECTR / adversary-emulation-plan export | Downstream correlation tools | Same reason — these are interpretations of the log, not the log. |
| Opinionated MITRE ATT&CK tagging | `commandTags` plugins / your SIEM | Tagging is per-shop opinion. RedLog ships none installed on purpose (`plugin-development.md`). |
| A central team server / shared DB | Each operator runs their own | Local-first is a positioning pillar, not a missing feature. A server is a different product with a different threat model. |
| At-rest DB encryption | 1.x, not 1.0 | Worth doing; the threat model discloses the exposure honestly today (`ROADMAP.md`). |
| Live C2 log parsing (Cobalt Strike beacon logs) | RedEye | RedLog captures at the operator's shell/agent, not by post-hoc parsing a C2's logs. Different capture model. |

## Where it sits in the landscape

RedLog occupies a corner none of the established tools do: **local-first +
passive capture + tamper-evidence + AI-agent-native**. The comparison isn't
"which is better" — most of these are complementary and sit downstream of
RedLog.

| Tool | Capture model | Hosting | Primary output | Overlap with RedLog |
|---|---|---|---|---|
| **RedLog** | Passive (hooks/tailer) + auto-detectors | Local, per-project | Tamper-evident timeline + signed bundle | — |
| **Ghostwriter** (SpecterOps) | Manual oplog + C2 integration | Server (Django), team | Oplog **and report** | Oplog overlaps; RedLog is local + passive + downstream of its report gen |
| **RedEye** (CISA/PNNL) | Post-hoc C2 log parsing | Local analyst tool | Visualization + tagging of C2 activity | Both visualize activity; RedEye ingests C2 logs, RedLog captures at the shell |
| **PwnDoc / SysReptor / Dradis** | Manual findings entry | Server / desktop | Pentest **report** | None — pure downstream; RedLog feeds them |
| **Manual oplog** (redteam.guide template, spreadsheets) | Manual, per-action | A file | A log the operator maintains by hand | RedLog automates exactly this, and makes it tamper-evident |
| **Obsidian / OneNote / CherryTree** | Manual notes | Local or cloud-sync | Freeform notes | RedLog is the *evidence*; these stay the *narrative* scratchpad |

### The wedge, stated plainly

Every competitor forces at least one of these compromises that RedLog refuses:

- **Manual capture** (Ghostwriter oplog, spreadsheets, note apps) → holes where
  it matters. RedLog: passive.
- **A server** (Ghostwriter, PwnDoc, SysReptor) → data leaves the operator's
  box; a new thing to stand up and secure. RedLog: local, no server.
- **No tamper-evidence** (note apps, most oplogs) → the record proves nothing
  under challenge. RedLog: hash chain + OpenTimestamps + signed bundle.
- **No first-class AI-agent capture** (everything predating the current agent
  wave) → agent actions go unlogged. RedLog: transcript tailer + hooks.

RedLog wins when a P1/P2/P3 operator needs a **defensible record they can prove
to S1, produced without a server and without note-taking discipline.** It loses
(correctly) when the buyer actually wants a report generator, a team platform,
or C2 log analysis — and it hands off cleanly to those.

## Positioning risks (tracked against the UX audit)

The positioning is strong; the risk is that the *experience* undercuts it.

1. **"Zero-friction capture" vs. a high-friction first run.** The core promise
   is passive capture, but RedLog records nothing until a source is wired up —
   the README says so in bold. A first-run operator who sees an empty timeline
   and no clear next step experiences the *opposite* of the promise. Tracked and
   partly addressed by the Capture Readiness onboarding work
   (`DEV-REQUIREMENTS-capture-onboarding.md`); the standing gap is in
   `UX-AUDIT-2026-08.md`.
2. **Surface area vs. the solo persona.** 18 timeline lanes, an 8-tab / 34-group
   Settings page, 4 integration layers, a plugin trust model. Each is defensible
   in isolation; together they read as an enterprise tool to a P1 who wanted a
   recorder. The audit's job is to find where breadth has outrun the primary
   persona.

## Sources

- [Updates to Ghostwriter: UI and Operation Logs — SpecterOps](https://specterops.io/blog/2020/09/30/updates-to-ghostwriter-ui-and-operation-logs/)
- [RedEye — CISA/PNNL (via AlternativeTo)](https://alternativeto.net/software/redeye/about)
- [Ghostwriter vs SysReptor — Logos Red](https://logos-red.com/blog/ghostwriter-vs-sysreptor/)
- [Best Pentest Report Generators 2026 — Dradis](https://dradis.com/compare/pentest-report-generator-roundup.html)
- [Operator Log — Red Team Guide](https://redteam.guide/docs/Templates/oplog/)
- [How I document web penetration testing engagements — Medium](https://medium.com/@rastislongesec/how-i-document-web-penetration-testing-engagements-62914d797228)
- [Cybersecurity (Anti)Patterns: Frictionware — Spaceraccoon](https://spaceraccoon.dev/cybersecurity-antipatterns-frictionware/)
