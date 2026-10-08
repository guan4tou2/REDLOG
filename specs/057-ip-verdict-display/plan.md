# Implementation Plan: IP Verdict Display That Keeps the Policy's Distinctions

**Branch**: `spec/057-ip-verdict-display` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/057-ip-verdict-display/spec.md`

## Summary

Today the main process folds the policy's five verdicts into three before any
surface sees them. This plan replaces that fold with one display decision, made
in core. Every consumer reads it: the HUD, the dashboard card, the status bar,
the main-side HUD override and `/api/status`. The changes:

- **States.** `ipSafety` takes seven values:
  - `exposed`, `off_profile`, `safe`, `presumed_safe` (the policy's names);
  - `unconfigured`;
  - `no_reading`;
  - `checking`.

  Research R2.
- **Alarm.** One flag, `alarm`, decides the HUD overrides and the agents' stop
  rule. It is true for `exposed` and `off_profile`, and for a failed read after
  either of them (R6).
- **Last reading.** The runtime records the state of the last successful read,
  so that a failed read keeps saying what it was (R4).
- **Freshness.** It comes from the producer, not from the badge. The policy's
  dedup leaves the badge's modifiers behind (R3).
- **Presentation.** One renderer table gives each state its tone, mark, label
  and hint:
  - off-profile gets a new orange;
  - presumed safe gets a hollow mark;
  - each hint names the fix that applies (R7, R8).

The policy, its verdicts and the chain's `ip_verdict` events do not change
(FR-015).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Electron 44

**Primary Dependencies**: electron-vite 5, Tailwind 4 (a CSS `@theme` in
`src/renderer/src/styles/index.css`)

**Storage**: none. The IP state lives in memory in main. The chain's
`ip_verdict` rows are unchanged.

**Testing**:

- vitest 5. Core and main-side units run under Node. The renderer runs in jsdom
  with @testing-library/react 16, under the stub bridge used by
  `test/renderer-smoke.test.tsx`.
- Playwright 1.63 e2e against the built app. A local HTTP provider feeds the
  IP producer.

**Target Platform**: desktop, on macOS and Windows. The Windows e2e needs the
Electron ABI build of better-sqlite3 (`pree2e`).

**Project Type**: desktop app (Electron main, preload, React renderer, core
library), plus the local HTTP API and `cli/redlog-cli.js`

**Performance Goals**: none new. `ipDisplay()` is a constant-time mapping, run
once per producer tick (60 s by default).

**Constraints**:

- The IP policy and the chain events are unchanged (FR-015).
- The exposed presentation keeps every behaviour of FR-002.
- `ipSafety` has no compatibility alias (FR-018).
- No new settings.
- zh-TW copy uses the fixed glossary.
- Contrast holds 4.5:1 for text and 3:1 for marks.

**Scale/Scope**: about 19 source files (the two i18n files and the CLI
included), 7 docs, and 4 new test files. The largest file changed is
`OverlayApp.tsx`.

## Constitution Check

*Pre-design and post-design: PASS. No violations to justify.*

| Principle | How this plan meets it |
|-----------|------------------------|
| I Evidence Integrity | Nothing recorded changes. The chain's `ip_verdict` rows keep their fields. The dedup that decides which verdicts reach the chain is untouched (R3). |
| II Surface Truthfulness | This is the feature. An inference is qualified. The off-profile hint is true. A failed read is not "unconfigured". The last known address carries its age. A new address being confirmed is shown. |
| III Canonical Domain Semantics | One decision, `ipDisplay()` in core, feeds the IPC push and pull, the API and the HUD override. One `IPStatus` type replaces four copies. One renderer table replaces three private maps. |
| IV Query Completeness | Not applicable: no bounded query. |
| V Preview/Execute Consistency | Not applicable: no export. |
| VI Explicit Failure | `no_reading`, `unconfigured` and `checking` are distinct at every layer. Each reason is kept: `air_gap`, or `lookup_failed` with the provider's text. A failure never displays as a verdict. |
| VII Evidence Provenance | The last reading keeps its own time (`lastReading.at`), apart from `lastCheck`. |
| VIII Risk-Based Test-First | The runtime test and the e2e fail today for the reasons this feature fixes (R10). The surface tests, typecheck, build, the new e2e, and the `hud-overlay` and `cli-smoke` journeys all pass before Verified. |
| IX Architectural Restraint | No new framework or state library. The core module solves a present variation: five consumers of one decision, as ALERT-ROLES A.3 already asks. The renderer table removes a present duplication. |

## Canonical interfaces and domain invariants

- **`ipDisplay(input)`** (`src/core/alert/ip-display.ts`) is the only place
  where a verdict and a reading state become a display state.
  - It takes:
    - `verdict`: the badge's value, or `null`;
    - `external`, `stale`, `settling` and `failure`: from the producer;
    - `lastFresh`: the runtime's last reading.
  - It returns `ipSafety`, `alarm`, `lastReading`, `reason` and `settling`.
  - The derivation table is in [data-model.md](data-model.md#display-state).
- **`IPStatus`** (same module) is the one wire shape for `ip:getStatus`,
  `ip:status` and `GET /api/status` → `ip`. See
  [contracts/ip-status.md](contracts/ip-status.md).
- **`AlertRuntime.ipStatus()`** composes `IPStatus`. It records the last reading
  on each successful producer tick.
- **`handleIpAlarmChange(alarm)`** (`src/main/ipc/overlay.ts`), renamed from
  `handleIpExposedChange`, is the only main-side reader of `alarm`.
- **`ipPresentation(state, reason)`**
  (`src/renderer/src/lib/ip-presentation.ts`) gives each state its tone, mark,
  pulse, label, status line and hint. See
  [contracts/surfaces.md](contracts/surfaces.md).

**Invariants affected**: no contract in `docs/domain/` covers the IP verdict.

- **Design references.** docs/ALERT-ROLES.md (Part A, the tier axis) and the
  state table in docs/UIUX-STANDARD.md §1 are the references for this area.
  Both are updated as explicit tasks.
- **Invariants enforced on screen.** The feature puts these rules on screen
  for the first time:
  - an inference never renders as a fact;
  - `unknown` never collapses into `safe`;
  - red and the flash belong to `exposed`.
- **An amendment to ALERT-ROLES A.3 rule 1.** A stale exposure still decays,
  with no red and no flash. It now also keeps its record and the HUD hold until
  a read succeeds (R4).

## Project Structure

### Documentation (this feature)

```text
specs/057-ip-verdict-display/
├── spec.md
├── plan.md               # this file
├── research.md           # R1–R11
├── data-model.md         # entities, the derivation table, invariants, transitions
├── quickstart.md         # validation guide
├── contracts/
│   ├── ip-status.md      # the IPC and API wire shape
│   └── surfaces.md       # each state on each surface
├── checklists/
│   └── requirements.md
├── tasks.md              # /speckit-tasks
└── verification.md       # during implementation, from the override template
```

### Source code (repository root)

```text
src/core/alert/
├── ip-display.ts                # NEW: ipDisplay(), IPDisplayState, IPStatus
└── index.ts                     # re-exports them
src/core/api-server.ts           # AlertRuntimeSlice.ipStatus(): IPStatus (route unchanged)
src/main/
├── index.ts                     # broadcastIPStatus → handleIpAlarmChange(status.alarm)
├── ipc/overlay.ts               # handleIpExposedChange → handleIpAlarmChange
└── services/
    ├── alert-runtime.ts         # ipStatus() via ipDisplay(); last reading; verdictToSafety removed
    └── producers/ip-signal-producer.ts   # state gains `failure`
src/preload/
├── overlay.ts                   # IPStatus from core
└── index.ts                     # IPStatus from core
src/renderer/src/
├── env.d.ts                     # IPStatus via import()
├── lib/ip-presentation.ts       # NEW: the per-state presentation table
├── lib/hud.ts                   # HUD.orange
├── styles/index.css             # --color-redlog-deviation
├── OverlayApp.tsx               # alarm force-open and guard; frame and flash; modifiers
├── components/IPStatusCard.tsx
├── components/StatusBar.tsx
└── i18n/en.json, zh-TW.json     # new labels, status lines and hints
cli/redlog-cli.js                # status prints the state, the alarm and the last reading

test/
├── alert/ip-display.test.ts     # NEW: the derivation table (pure)
├── alert/ip-status.test.ts      # NEW, RED: ipStatus() through the producer with fetch stubbed
├── ip-verdict-surfaces.test.tsx # NEW: HUD, card, status bar per state (jsdom)
├── overlay-pass-through.test.ts # + handleIpAlarmChange
├── design-tokens.test.ts        # + the orange token's contrast
└── renderer-smoke.test.tsx      # fixture gains the new fields
e2e/
└── ip-verdict-display.spec.ts   # NEW, RED: a local provider drives the journey

docs/ALERT-ROLES.md, docs/UIUX-STANDARD.md, docs/TESTING.md,
docs/api-reference.md, docs/agent-integration.md,
docs/skills/redlog-pentest.md, CHANGELOG.md
```

**Structure Decision**: the existing single-repository layout. The decision
goes in core, beside the verdict vocabulary it maps (`src/core/alert/`),
because main and the API consume it. The renderer keeps only presentation. No
new package, and no new layer.

## Design

The order runs from failing behaviour to docs. The tasks break it down.

1. **RED.** Two tests fail today for the reasons this feature fixes:
   - `test/alert/ip-status.test.ts` drives `AlertRuntime` through the A.1 cells
     and the failure sequences, with `fetch` stubbed. A-3 reads `safe`, A-5 and
     A-9 read `exposed`, a failed read reads `unknown`, and `alarm` does not
     exist.
   - `e2e/ip-verdict-display.spec.ts` shows the fault in real windows:
     off-profile flashes and carries the Exposed IP list hint, and a failed read
     after an exposure releases the HUD.
2. **Core.** Add `ip-display.ts`, with its table test.
3. **Producer and runtime.**
   - The producer records `failure`.
   - The runtime records the last reading on each successful tick.
   - `ipStatus()` returns `IPStatus` built by `ipDisplay()`.
   - `verdictToSafety()` and `IPStatusShape` are removed. `src/main/index.ts`
     imports `IPStatus` instead. An alias would be an export that production
     code never reaches, and `verify:architecture` rejects those.
4. **Types.** Preload and `env.d.ts` take `IPStatus` from core. The typecheck
   then lists every consumer the new union breaks.
5. **Main.** Add `handleIpAlarmChange(status.alarm)`, and extend
   `overlay-pass-through.test.ts` for it.
6. **Presentation.**
   - Add the orange token to the theme, the HUD and `design-tokens.test.ts`.
   - Add `ip-presentation.ts` and the i18n keys in both languages.
   - Move the three surfaces onto the table.
   - Add the modifiers: the settling indicator, the held-alarm line and the
     last known address.
   - Add the surface tests.
7. **Agents.**
   - The CLI's `status`.
   - `api-reference.md` defines `IPStatus`.
   - `agent-integration.md` states the stop rule.
   - The pentest skill checks `ip.alarm`.
   - The CHANGELOG gets a breaking-change entry.
8. **Design docs.**
   - ALERT-ROLES: A.2 and A.3 describe what ships. The stale citations of
     `lib/ip-badge.ts` and `lib/alertSeverity.ts` are corrected where they
     describe this. The consumer row at line 400 is updated.
   - UIUX-STANDARD §1 gains the orange row.
   - TESTING.md: §1.8 is rewritten, §5.1 and §5.2 are updated, the §4 rows cite
     the new tests, and G-UI2 moves to the Fixed table.
9. **Verify.**
   - Run the targeted tests, typecheck, the full suite, build, and the e2e
     (`ip-verdict-display`, `hud-overlay`, `cli-smoke`).
   - Run `verify:specs` and `verify:architecture`.
   - Write `verification.md`.

## Workflow gates

This feature touches core, main, preload, the renderer and the API contract,
so the constitution requires Clarify, Checklist and Analyze before
implementation.

- **Clarify**: done on 2026-09-29. Specify asked three questions and Clarify
  three more, all recorded in the spec.
- **Checklist**: to run next (`/speckit-checklist`).
- **Analyze**: to run after `/speckit-tasks` (`/speckit-analyze`).
- **Converge**: after implementation.

`verification.md` records each gate's outcome.

## Complexity Tracking

No Constitution Check violations. Nothing to justify.
