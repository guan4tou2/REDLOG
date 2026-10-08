# Research: IP Verdict Display That Keeps the Policy's Distinctions

Every decision below was checked against main `3525711`. The plan's Technical
Context has no open NEEDS CLARIFICATION items.

## R1. One display decision, in core

- **Decision**: add a pure module, `src/core/alert/ip-display.ts`, which exports:
  - `ipDisplay()`: verdict + reading state → display state;
  - `IPDisplayState`;
  - `IPStatus`, the wire shape.

  `AlertRuntime.ipStatus()` builds its result with `ipDisplay()`. Every consumer
  reads that result: the IPC push and pull, `GET /api/status`, and main's HUD
  override. The renderer only chooses how each state looks.
- **Rationale**:
  - Constitution III: one canonical rule, consumed by every layer.
  - ALERT-ROLES A.3 rule 3 already asks for "one decision, three surfaces", and
    cites a `lib/ip-badge.ts` that main never had.
  - The API and the HUD override run in main, so a renderer-only module could
    not serve them.
- **Alternatives considered**:
  - *Widen `verdictToSafety()` in `alert-runtime.ts`.* Rejected: the rule could
    only be tested through the producer, and the three surfaces would still
    derive their own hints.
  - *A renderer `lib/ip-badge.ts`.* Rejected: main (the override) and the API
    would each recreate the rule.

## R2. Seven display states

- **Decision**: `ipSafety` takes one of these values:

  | Value | Meaning |
  |---|---|
  | `exposed`, `off_profile`, `safe`, `presumed_safe` | the policy's own verdicts, for a current reading |
  | `unconfigured` | a current reading, but no list is set (A-1) |
  | `no_reading` | the last read failed, or air-gap mode is on |
  | `checking` | no lookup has completed yet |

- **Rationale**:
  - These are exactly the states FR-001 lists.
  - Reusing the policy's names gives the chain's `ip_verdict_kind`, the API and
    the UI one vocabulary.
  - The policy's `unknown` covers three situations, and each needs a different
    hint (FR-009, FR-012).
- **Alternatives considered**:
  - *Keep `unknown` and add a reason field.* Rejected: FR-018 changes the
    values, and an agent testing `=== 'unknown'` could not tell a failed read
    from an unset list.
  - *Name the failed-read value `stale`.* Rejected: it suggests the old verdict
    still applies, which is what FR-016 avoids.

## R3. Freshness comes from the producer, the verdict from the badge

- **Decision**:
  - `ipDisplay()` takes `stale`, `settling` and the failure reason from
    `IPSignalProducer.getState()`.
  - It takes only the verdict's `value` from `BadgeSurface`.
- **Rationale**: IPPolicy's dedup (`src/core/alert/policies.ts:92`) never emits a
  change that affects only a modifier, so the badge's modifiers go stale:
  - After a candidate address goes away and the old one returns, the badge
    keeps `settling: true`.
  - After a failed read recovers to the same `unknown` value, it keeps
    `stale: true`.

  The producer sets its flags on every read. Today `ipStatus()` already takes
  `settling` from the producer.
- **Alternatives considered**: *add the modifiers to the dedup key.* Rejected: it
  changes which `ip_verdict` rows reach the chain (FR-015, Constitution I).

## R4. The last reading

- **Decision**:
  - `AlertRuntime` records `{ state, at }` on every successful read, from the
    producer's tick. The bus has already updated the badge by then.
  - The record changes only when a read succeeds. A failed read, air-gap mode, a
    settings change and a project switch all leave it as it is.
  - `ipDisplay()` attaches the record to `no_reading`, and sets `alarm` when the
    recorded state is `exposed` or `off_profile`.
- **Rationale**:
  - FR-016 says "until a read succeeds".
  - The clarification says an exposure never ends because the next lookup
    failed.
  - A settings change or a project switch is not a reading. The record is
    history: the state decided at the time, not recomputed against the lists
    now in force.
- **Alternatives considered**:
  - *Reclassify the last address against the current lists.* Rejected: a list
    edit could then clear an alarm without a reading, and it needs the
    policy's private classifier.
  - *Read the record from the badge.* Rejected: the stale verdict overwrites the
    badge's value, and deduped reads do not re-emit.
- **Consequence**:
  - Turning air-gap on after an exposure keeps the HUD held until air-gap is off
    and a read succeeds.
  - ALERT-ROLES A.3 rule 1 still holds: the state decays, with no red and no
    flash. Only the hold and the record remain.

## R5. Why the read failed

- **Decision**:
  - When a read fails, the producer records
    `failure: 'air_gap' | 'lookup_failed'` in its state. It is `air_gap` when
    `offline` was set for that read.
  - A successful read sets `failure` back to `null`.
  - The provider's error text stays in `error`.
- **Rationale**:
  - FR-010 has to tell air-gap mode apart.
  - Parsing `error` (`offline (air-gap)`) would turn a message into a contract.
  - The text already says whether one provider failed or all of them did
    (`All IP providers failed`, `All DNS resolvers failed`, or the exception
    message). That covers "the reason when it is known" (FR-009).
- **Alternatives considered**: *have the runtime read `network.offline` from the
  config.* Rejected: the config can change between the read and the display,
  and the reason belongs to the read.

## R6. One alarm flag, for the HUD overrides and for agents

- **Decision**:
  - `IPStatus.alarm` is true for `exposed` and `off_profile`, and for a
    `no_reading` whose last reading was one of those two.
  - Main calls `handleIpAlarmChange(status.alarm)`, renamed from
    `handleIpExposedChange`.
  - The HUD forces itself open and skips the auto-collapse while `alarm` is
    true.
  - Agents stop and ask while it is true.
- **Rationale**:
  - FR-006, FR-016 and FR-019 name the same set.
  - Three consumers each testing `ipSafety` values would drift apart (III).
- **Alternatives considered**: *each consumer tests the values.* Rejected (III).

## R7. Tones and marks

- **Decision**:
  - **Tones, per A.2**:
    - red: `exposed`;
    - orange: `off_profile`;
    - green: `safe` and `presumed_safe`;
    - amber: `unconfigured`, `no_reading` and `checking`.
  - **Marks**:
    - A solid, glowing dot means "this is what we see now": `exposed`,
      `off_profile`, `safe` and `unconfigured`.
    - A hollow, unglowing dot marks the rest: `presumed_safe` (an inference),
      `no_reading` and `checking` (nothing is seen now).
  - **Pulse and flash**:
    - The dot pulses, and the HUD frame flashes, for `exposed` only.
    - The flash still depends on `overlay.flashOnExposed`.
  - **HUD frame**:
    - An alarm state gives the frame its own tone: red, orange, or amber for a
      held `no_reading`.
    - Every other state leaves the frame cyan, as today.
  - **Settling**: it adds its own indicator and never changes the mark, so
    `exposed` keeps its solid, pulsing red (FR-002).
  - **Orange**:
    - It is a new token: `--color-redlog-deviation` in `styles/index.css`, and
      `HUD.orange` in `lib/hud.ts` with the same hex.
    - It is desaturated like the rest of the palette.
    - As text it holds at least 4.5:1 on `bg`, `surface`, `elevated` and the HUD
      panel. `test/design-tokens.test.ts` pins this.
    - Tailwind's `orange-*` stays as it is: loot, bookmarks, search and the
      target view use it, and overriding it would recolour them.
  - **UIUX-STANDARD**: its state table (§1) gains the orange row.
- **Alternatives considered**:
  - *Amber for off-profile.* Rejected: A.2 gives it orange, and amber reads as
    "unknown".
  - *Tailwind's stock `orange-400`.* Rejected: it is not desaturated like the
    rest, and `hud.ts` has to match the theme.

## R8. Hints

- **Decision**: each state's hint points at the fix that applies to it.

  | State | Hint |
  |---|---|
  | `exposed` | `ip.exposedHint`, unchanged |
  | `off_profile` | new: the address is not one of your Safe IPs. Check the VPN or tunnel, or add the exit if you expect it |
  | `presumed_safe` | new: the address is not on your Exposed IP list. List your expected exits as Safe IPs to verify it |
  | `safe`, `checking` | none |
  | `unconfigured` | the existing set-the-lists hint. It is the only state that shows it (FR-012) |
  | `no_reading`, `lookup_failed` | new: check the network, the VPN or the providers. The provider's error text sits beside it, dim rather than red (FR-003) |
  | `no_reading`, `air_gap` | new: lookups are off by your choice. Turn them back on in Settings ▸ Network |

  A `no_reading` held by an alarm adds the line "Last reading: EXPOSED" (or
  OFF-PROFILE) with its age.

  Labels and copy are proposed in [contracts/surfaces.md](contracts/surfaces.md).
  The tasks settle the final wording under `test/i18n-terminology.test.ts`.

## R9. The contract change and its consumers

- **Decision**:
  - **Fields**: `ipSafety` takes the seven values, and three fields are new:
    `alarm`, `lastReading` and `reason`. `settling`, `lastCheck`, `error` and
    the addresses keep their meaning. No alias is kept.
  - **One type**: `IPStatus` is defined once, in core. It replaces four copies:
    - `IPStatusShape` in `alert-runtime.ts`;
    - `src/preload/overlay.ts`;
    - `src/preload/index.ts`;
    - `src/renderer/src/env.d.ts`, which imports it with `import()` like its
      `core/db/events` types.
  - **Consumers updated**:
    - the HUD, the card and the status bar;
    - main's override;
    - `cli/redlog-cli.js status`;
    - `docs/api-reference.md`, which gets an `IPStatus` definition for the
      first time;
    - `docs/agent-integration.md`;
    - `docs/skills/redlog-pentest.md`, which checks `ip.alarm`;
    - the CHANGELOG (Unreleased, a breaking change).
- **Rationale**: FR-018 and FR-019, following the pre-1.0 precedent of Spec 006.
- **Alternatives considered**: *keep the old three values beside the new
  field.* Rejected by the clarification (Session 2026-09-29).

## R10. How it is verified

- **Decision**:
  - **RED tests.** The first tests fail at the two boundaries that exist today:
    - `AlertRuntime.ipStatus()`, with `fetch` stubbed as in
      `test/ip-signal-producer.test.ts`;
    - the desktop journey: an e2e with a local HTTP provider, `ipMode: 'http'`,
      `confirmations: 1` and `checkInterval: 1`.

    Both fail today for the reasons this feature fixes:
    - A-3 reads `safe`;
    - A-5 and A-9 read `exposed` and flash;
    - a failed read reads `unknown`, and the HUD is released.
  - **The tests that follow**:
    - the table test for `ipDisplay()`;
    - jsdom tests of the three surfaces, under a stub bridge as in
      `renderer-smoke`;
    - the pass-through test for `handleIpAlarmChange`;
    - the i18n tests and the design-token tests.
  - **Existing e2e journeys.** `hud-overlay.spec.ts` runs because the HUD width
    follows the label. `cli-smoke.spec.ts` runs because `status` prints the IP
    state.
- **Rationale**: Constitution VIII. According to TESTING.md, no e2e yet drives
  the IP alert path through real windows.

## R11. Unchanged, and out of scope

- **The policy**: IPPolicy's verdicts and its dedup, and the chain's
  `ip_verdict` events (FR-015).
- **Features left out**: the list-conflict display (A-6), and `lanSafety`.
- **Timing and overrides kept as today**:
  - A settings save restarts the producer, which reads at once, and the
    surfaces move with that read, as today. This covers the edge case "from
    the next status it receives".
  - Pass-through stays off after an alarm clears.
