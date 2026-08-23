# Roadmap

Written 2026-08-08 against v0.9.3. Sources: `AUDIT-2026-08-08.md`,
`timeline-io-visibility.md`, `WINDOWS_COMPAT_AUDIT.md`, and the open items
CHANGELOG entries deferred.

## Positioning (unchanged)

RedLog is the audit-log layer of a red-team engagement: passive capture into
a tamper-evident, per-project chain, exportable as a signed bundle. Report
writing, ATT&CK opinion and correlation stay downstream.

The agent-transcript work from v0.7.2 onward is **a capture source**, not a
new product direction. The shell hook records what the operator typed; the
tailer records what the agent did. Same chain, same operator attribution,
same pause semantics, same lane treatment. Anything that makes the two
diverge (see P1-2) is a bug, not a feature boundary.

## v0.9.4 — correctness

Everything here is small, verified, and currently losing data or lying.

| Item | Ref | Size |
|---|---|---|
| `os.homedir()` → `homedir()` — tailer exclusions are dead | AUDIT P0-1 | 1 char |
| Lane container `overflow-y-auto` — bottom lanes are clipped | AUDIT P0-2 | 1 line |
| Time domain from `displayTs` min/max — markers can render off-track | AUDIT P0-3 | ~5 lines |
| Minimap bins on `displayTs` to match the track | AUDIT P0-3 | 1 line |
| Static-import `sweepRetention` — retention is dead in every packaged build | AUDIT P0-4 | 2 lines |
| HUD overlay: symmetric x anchoring, measured width, display-scaled ceilings | AUDIT P0-5 | ~25 lines |
| v0.9.3 follow-ups: per-project collapse key, `modKey` in the help modal, missing help rows, `timeline.events` count noun, dead ternaries, hard-coded toasts | AUDIT §3 | ~20 lines |

Ship note: `e2e/timeline-geometry.spec.ts` and `e2e/hud-overlay.spec.ts` cover
all six. None of them were reachable from unit tests — two live in the
main-process startup path, one only reproduces against the bundled build, and
three are renderer geometry. That is why P0-1 in particular survived several
releases: the shell hook reads the same config file, so the feature looked
alive.

## v0.9.5 — decide what "pause" means ✅ shipped

The one item that cannot be deferred, because the README makes a privacy
promise the code does not keep (AUDIT P1-2). Pick A or B, implement it, and
rewrite the README paragraph either way:

- **A — pause stops recording.** Move the gate ahead of `insertEvent`; add
  recording checks to `shell-preexec-hook.sh` and `mitmproxy-addon.py`.
  Costs: a gap in the chain that only `recording_paused` explains — which is
  exactly what that event is for.
- **B — pause stops display.** Rename to "mute" in the UI, drop the privacy
  claim, and keep hook-level `excludedPaths` as the only privacy mechanism.

**Shipped as A**, but enforced server-side rather than in the hook: the gate
lives in `insertEvent()` and `POST /api/events` returns early, so the hook
needs no recording check at all — which also removes the race between the
hook's check and the write, and covers the mitmproxy addon for free.

`redlog_recording` was kept — an operator may legitimately want an agent to
pause capture — but made attributable: pause/resume rows now carry `source`
(`ui` / `api` / `mcp`) next to the token-resolved `operator_id`, so an agent
pausing itself is visible as such.

## v0.9.6 — I/O visibility, phase 1 ✅ shipped

Steps 1–2 of `timeline-io-visibility.md`:

- Stamp `io.stdout = {ref, off, len, sha256}` on built-in-terminal
  `command_end` from the existing `.cast` — output becomes an inline field
  instead of a two-click replay. No new capture or storage.
- Dot encoding for output present / truncated / not captured / non-zero exit,
  sharing the outline-vs-fill language with marker severity (AUDIT V3).
- Explicit "output not captured (external shell)" row, so absence of capture
  is never mistaken for absence of output.
- Document `redlog-run` in the capture-health card, not only in a comment.

## v0.10.0 — I/O visibility, phase 2 ✅ shipped as v0.11.2 (except the sidecar)

Steps 3–6: the `io_ref` sidecar and everything that reads it.

- `<projectDir>/io/` append-only store; `io:read` IPC; bundle export,
  retention pruning (`system.io_pruned`) and `redlog-verify.py` support.
- `ScannerDetail` / `BrowserConsoleDetail`; raise `REDLOG_MAX_BODY` once
  bodies are out of the event row.
- Exchange view pairing `tool_call` ↔ `tool_result` and
  `command_start` ↔ `command_end`.
- Transcript view + Markdown export.

Chain invariant: bytes never enter the chain, only their sha256. The v0.6.47
revert stands.

## v0.11.0 — close the trust-model gaps ✅ shipped

Each of these is either a documented control that does not exist, or a
privileged path that skips the gate:

| Item | Ref |
|---|---|
| `tailers`: isolate like `mcpTools`, or make first-party-only explicit and move it out of `PRIVILEGED_KEYS` | P1-3 |
| Fetch + verify signed revocations, or remove the tab and the doc section | P1-5 |
| `vps-deploy.sh` refuses the primary token; prints the `operators add` command | P1-6 |
| Content hash covers `capture[].hookFile` | P2-1 |
| Worker recomputes sha256 on upload, or the doc stops claiming a server-side sanitize check | P2-3 |

## UX & onboarding track (added 2026-08-10)

Until now this roadmap has had one axis: correctness and trust. The 2026-08-10
review (`UX-AUDIT-2026-08.md`, `UX-TIMELINE-2026-08.md`) added a second — the
primary persona's *success*, not just the log's honesty. The finding is that
RedLog is under-*sequenced*, not over-*featured*: P2/P3/expert surfaces are
presented to the solo operator (P1) at full weight from the first screen, and
the timeline's interactions are invisible, overloaded, and context-dependent.

Full ticket specs (F1–F7, T1–T6) live in `UX-BACKLOG-TICKETS.md`. The tension
to hold: none of this is a new product direction — it is making the passive-
capture promise (`PRODUCT-POSITIONING.md`) true on first run, and making the
existing timeline legible. Report writing, ATT&CK opinion and correlation still
stay downstream.

Shipped in v0.11.6:

- **Capture Readiness onboarding** (F1, partial) — the dark-state Dashboard card
  is now an ordered checklist with one next action, off a pure/tested model.
- **Timeline keyboard resolver** (T5, first seam) — four keydown listeners with
  an overloaded Escape collapsed into one pure, tested precedence.

Next, in impact order (see the tickets doc for acceptance criteria):

| Item | Ticket | Size |
|---|---|---|
| Wire the dead `EmptyState` CTA into the 6 empty views | F4 | S |
| Persistent timeline interaction legend (3 core gestures always visible) | T1 | S |
| Resolve the wheel-mode ambiguity (pan vs. scroll) | T2 | S–M |
| Guided hook install + verify loop | F1-b | M |
| Active-modes row ("why is my timeline empty") | T3 | M |
| Settings filter box | F3 | S–M |
| One shortcut registry, two renderers | F5 | S |
| Discoverable search entry | F6 | S |

Structural, sequenced later: header "View options" menu (T4), the remaining
timeline seam extractions (T5), and lane virtualization (T6) — which is the same
work as **V4** below and, once done, deletes the wheel-mode branch behind T2.

## v0.12.0 — durability and scale

| Item | Ref |
|---|---|
| Full chain verification off the write connection (worker or second read-only handle) | P1-1 |
| Timeline viewport virtualisation | V4 |
| `/` search debounce + prebuilt lowercase index | AUDIT §3 |
| FTS5 for `searchEvents` instead of `data LIKE '%q%'` | ARCH §3 |
| Streaming JSON export (bundle already streams; the JSON path does not) | ARCH |
| Bottom event list follows the viewport | V5 |
| Cross-midnight axis labels; idle-gap compression toggle; `BASE_TRACK_W` tracks container width | V6–V8 |

## v1.0 gate

> **Needs review after the 2026-08-21 core revision.** The gate below is
> written entirely around a third party verifying a bundle, which was the old
> design centre. Under the revised core (`DESIGN-core-and-capture.md`) the
> everyday job is the operator finding out what happened, so the gate is
> arguably missing its own criteria — capture coverage and findability. The
> five items below are still correct and still blockers; the question is
> whether they are *sufficient*. Not rewritten unilaterally.

1.0 means an operator can hand a bundle to a third party and every claim in
the docs is one they can check. Concretely:

- No documented security control is unimplemented (v0.11.0 complete).
- Windows CI runs the test suite — `WINDOWS_COMPAT_AUDIT.md` P0-1 is the
  standing blocker; the fixes themselves are under 100 lines, the missing
  piece is the signal.
- Every capture source's I/O is either visible or explicitly marked
  uncaptured (v0.10.0 complete).
- README, `docs/README.md` and `RELEASE_CHECKLIST.md` carry the current
  version, lane count, tool count and architecture (see AUDIT §5).
- `plugins/host.ts` + `plugin-runner.js` have integration tests; the
  consent → tool-appears → revoke → tool-disappears flow is covered E2E.
- ~~The `chain_sample_broken` root cause from v0.7.5~~ — ✅ closed in v0.11.3. It was field ORDER in the reconstructed hash shapes, not a corrupt row.

## Deliberately not planned

- Report generation, STIX/VECTR export, opinionated ATT&CK tagging — these
  stay downstream by design (`docs/README.md`).
- At-rest DB encryption (P2-2) — worth doing, but it is a 1.x feature, not a
  1.0 blocker; the threat model discloses the exposure honestly today.
- `exporters` / `monitors` plugin contributions — reserved, no demand yet.
- Light theme.
