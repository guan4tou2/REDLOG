# Product Positioning

Written 2026-08-10 against v0.11.5. **Revised 2026-08-21** — the core moved
from *defensibility* to *knowability*; see `DESIGN-core-and-capture.md` for the
review that produced the change and what it does to capture coverage.

This is the single source of truth for
**who RedLog is for, what job it does, and where its edges are**. The one-line
positioning has lived in `ROADMAP.md` and `docs/README.md`; this page keeps
those in sync and adds the layer they never had — users, jobs, and the
competitive frame. When positioning and roadmap disagree, this page wins and
the roadmap is the bug.

## One sentence

**RedLog is the local record of what actually happened in a red-team
engagement:** it passively captures every command, connection, file and screen
— whoever or whatever produced it — so that afterwards you can replay the
engagement, hand a purple team something they can judge traffic from, and find
evidence of the things you were not watching when they happened.

If it happened, RedLog captured it. If the record shows a 20-minute gap, the
record is *right* — the operator was idle, or a `recording_paused` row
explains it. (The timeline may *draw* that gap compressed; the record still
contains it. Rendering is a reading convenience, storage is not.)

The hash chain, OpenTimestamps anchoring and the signed bundle still run, and
still let a third party verify the record end to end. They are a **property of
how the record is kept**, not the reason to keep one.

## The job to be done

> When I run an engagement, I need a complete record of what was done and when
> — so I can reconstruct the attack timeline, show a purple team what my
> traffic was, prove I stayed in scope, and **find out what happened during the
> stretches I wasn't watching** — **without spending the engagement taking
> notes.**

Two halves, and both are load-bearing:

1. **Complete** — because you are relying on it to tell you things you do not
   already know. An hour into a scan, three hundred agent turns in, or a
   teammate's session on the shared VPS: the record is the only account of
   what happened, so a hole in it is not an inconvenience, it is the failure.
   Tamper-evidence falls out of how completeness is kept (an append-only hash
   chain), and is worth having, but it is not the job.
2. **Without taking notes** — capture has to be passive. The moment logging
   depends on the operator remembering to log, the record has holes exactly
   where the interesting things happened. This is why hooks are the backbone
   and MCP is only the control plane (see `agent-integration.md`).

An AI agent is the sharpest case of the first half — you delegate, it does
three hundred things, you know none of them — but it is **one producer among
several**, not half the product. The same gap opens with no agent involved.

Everything RedLog does is in service of one of these two. A feature that serves
neither is scope creep.

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

### S1 — The purple team / blue team *(stakeholder, not a user)*

The client's defenders, correlating what they saw against what the red team
actually did. They never open the app; they receive an activity record —
time, source, target, command, HTTP exchange, across every capture source —
and match it against their own telemetry. `deconfliction.md` covers the live
half of this ("was that us?"); the exported record covers the after-action
half.

### S2 — The evidence consumer *(stakeholder, occasional)*

The client's counsel, or the operator's own QA, when a record is challenged.
Receives the signed bundle and runs `ots verify` / `redlog-verify.py`. This
path stays fully supported and is what the hash chain is *for* — but it is the
exception, not the design centre, and it should not shape the everyday UI.

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

RedLog occupies a corner none of the established tools do: **capture at the
point of work, locally, readable afterwards**. Tamper-evidence and
agent-native capture are both real and both differentiating — they are just
properties of that corner rather than the definition of it. The comparison isn't
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
