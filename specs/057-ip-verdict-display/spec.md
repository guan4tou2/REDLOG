# Feature Specification: IP Verdict Display That Keeps the Policy's Distinctions

**Feature Branch**: `spec/057-ip-verdict-display`
**Created**: 2026-09-29
**Status**: Draft
**Renumbered**: twice, both times by parallel work reaching main first.
Written as 040; main merged 040-046 and PR #261 took 047, so it moved to
048 — which main then took for `048-pane-target-derivation` while this
branch sat unpushed. Now 057. `verify:specs` compares only against
origin/main, so neither collision was visible from this branch until the
other side had already landed.
**Input**: The IP policy decides five verdicts for the operator's egress address, plus a stale modifier when the last read failed, but every surface is shown only three states. An inferred "safe" looks like a verified safe exit, an off-profile address carries a hint that is false for it, and a failed read carries a hint about lists that may already be set (docs/TESTING.md Part 6, G-UI2).

## Problems (verified on main `3525711`)

1. **An inference looks like a fact.** With only an Exposed IP list set, an address that misses it is `presumed_safe`: "not obviously you". The HUD, the dashboard IP card and the status bar show it exactly like a verified Safe IP, with the same label and the same solid green. docs/ALERT-ROLES.md A.2 says an inference must never render as a solid green fill.
2. **Off-profile is shown as an exposure, with a false hint.** With a Safe IP list set, an address outside it is `off_profile`. Every surface shows it as EXPOSED, and the dashboard card says the address is on the operator's Exposed IP list. It is not: it is simply not one of the declared exits. ALERT-ROLES A.2 gives it its own tone (orange) and no flash.
3. **A failed read looks like an unconfigured one.** When the last lookup failed (a dropped VPN, a dead provider, air-gap mode), the policy withholds the verdict (`unknown`, stale). Every surface then shows the same `IP?` it shows when nothing is configured, with the hint to set the Safe and Exposed IP lists, even when both are set. The address still displayed is the last good one, with nothing saying it is not current.
4. **A new address being confirmed shows nothing.** While a new address is held for confirmation (`network.confirmations`, default 3 reads), every surface keeps showing the previous address and its verdict, with no sign that a different address has been seen.
5. **The distinctions are lost before any surface sees them.** The main process maps the five verdicts onto three states and does not pass on the stale modifier. It does pass on the settling flag and the provider's error text, but no surface reads the settling flag, and only the dashboard card shows the error text, under the same `IP?`.

## Clarifications

### Session 2026-09-29

- Q: Should off-profile keep the exposed alarm's overrides of the operator's HUD preferences (the HUD forced open and held, pass-through switched off, fully opaque)? → A: Yes. It keeps the overrides, in the orange warning tone and without the flash. It is a fact-tier warning that no preference may silence, and pass-through would otherwise hide the A-9 case.
- Q: When the last good reading was exposed and the next read fails, what do the surfaces show? → A: No current reading, together with the fact that the last reading was exposed and when, until a read succeeds. The HUD keeps the exposure's overrides meanwhile.
- Q: Is showing a new address that is being confirmed in scope? → A: Yes, as US5 (P3).
- Q: When the last good reading was off-profile and the next read fails, what do the surfaces show? → A: The same as after an exposure: no current reading, together with the fact that the last reading was off-profile and when. The HUD overrides stay until a read succeeds.
- Q: While a new address is being confirmed, how much do the surfaces show? → A: Only that a new address is being confirmed. They show neither the candidate address nor how it compares with the lists.
- Q: Should the local status API that agents and the CLI read report the same distinctions? → A: Yes, by changing the values of its existing IP safety field to the new states. No compatibility alias is kept, as with the pre-release contract reset (Spec 006).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An exposure stays unmistakable (Priority: P1)

When the egress address is on the operator's Exposed IP list, every surface raises the alarm it raises today. The exposed label is shown in red, and the HUD frame turns red and flashes unless the operator turned flashing off. The HUD also opens and is held open, pass-through is switched off, and the HUD becomes fully opaque. Nothing in this feature weakens that presentation. Two other states share its HUD overrides, as this spec says: off-profile, and a failed read right after an exposure or an off-profile reading. Neither borrows its label, its red or its flash.

An exposure also never ends because the next lookup failed. When the last good reading was exposed and the next read fails, every surface shows that there is no current reading, together with the fact that the last reading was exposed, and when. The HUD keeps the exposure's overrides until a read succeeds. Today the alarm quietly gives way to `IP?`.

**Why this priority**: The alarm is the whole defence; RedLog never blocks. Changing how the other states look must first leave this one intact, and the alarm must not end without a reading that ends it.

**Independent Test**: Give each surface an exposed verdict and compare its presentation with today's. Then follow the exposed reading with a failed one.

**Acceptance Scenarios**:

1. **Given** an address on the Exposed IP list, **When** its verdict arrives, **Then** the HUD, the dashboard card and the status bar show the exposed state in red, the HUD frame flashes (with flashing on), and the HUD opens and stays open.
2. **Given** pass-through is on, **When** the verdict becomes exposed, **Then** pass-through turns off and the HUD becomes fully opaque, as today.
3. **Given** an address on both lists, **When** its verdict arrives, **Then** it is shown as exposed: the Exposed IP list wins, as today.
4. **Given** an exposed reading followed by a failed one, **Then** every surface shows no current reading and that the last reading was exposed, with its age. The HUD stays open and held, with pass-through off, until a read succeeds.

---

### User Story 2 - An inferred "safe" does not look verified (Priority: P1)

With only an Exposed IP list set, an address that is not on it is shown as presumed safe. It keeps the safe tone, but is visibly qualified as an inference: it has its own label and a mark that is neither a solid fill nor a glow, as ALERT-ROLES A.2 describes. Its hint names the fix that would verify it: declare the expected exits in the Safe IP list.

**Why this priority**: ALERT-ROLES calls this the largest defect in the subsystem: an inference rendered with the presentation of a fact, which tells the operator more than RedLog knows.

**Independent Test**: Configure only an Exposed IP list, use an address not on it, and check that every surface can be told apart from a verified safe exit.

**Acceptance Scenarios**:

1. **Given** only an Exposed IP list and an address not on it, **When** its verdict arrives, **Then** every surface shows the presumed-safe state, and each tells it apart at a glance from verified safe: its own label, and not the solid green of a verified exit.
2. **Given** the presumed-safe state, **Then** its hint says the address is not on the Exposed IP list and that listing the expected exits as Safe IPs would verify it. It never says the address is a known safe exit.
3. **Given** a Safe IP list that contains the address, **When** its verdict arrives, **Then** the verified safe state is shown, as today.

---

### User Story 3 - Off-profile is its own warning, with a hint that is true (Priority: P1)

With a Safe IP list set, an address outside it is shown as off-profile, in its own label and the orange warning tone rather than the exposed label and red. Its hint says the address is not one of the declared Safe IPs: check the VPN or tunnel, or add the exit if it is expected. It never says the address is on the Exposed IP list.

Like an exposure, it overrides the operator's HUD preferences: the HUD opens and is held open, pass-through is switched off, and the HUD becomes fully opaque. It is a fact-tier warning that no preference may silence, and pass-through would otherwise hide the VPN-dropped-onto-café-NAT case (A-9). Unlike an exposure, it is orange and does not flash. Like an exposure, it does not end because the next lookup failed. Every surface then shows no current reading, together with the fact that the last reading was off-profile, and when. The HUD keeps the overrides until a read succeeds.

**Why this priority**: Today the operator is sent to look for their own address on a list it is not on, while the real cause (traffic not leaving through a declared exit) goes unnamed.

**Independent Test**: Configure a Safe IP list, use an address outside both lists, and check the state and hint on every surface.

**Acceptance Scenarios**:

1. **Given** a Safe IP list and an address outside it and not on the Exposed IP list, **When** its verdict arrives, **Then** every surface shows off-profile: orange, labelled differently from exposed, with a frame that does not flash.
2. **Given** the off-profile state, **Then** its hint says the address is not one of the declared Safe IPs and names the fix. It never says the address is on the Exposed IP list.
3. **Given** both lists and an address outside both (A-9), **When** its verdict arrives, **Then** it is shown as off-profile, never as safe.
4. **Given** pass-through is on, **When** the verdict becomes off-profile, **Then** pass-through turns off, and the HUD opens, is held open and becomes fully opaque, as for an exposure. Its frame is orange and does not flash.
5. **Given** an off-profile reading followed by a failed one, **Then** every surface shows no current reading and that the last reading was off-profile, with its age. The HUD stays open and held, with pass-through off, until a read succeeds.

---

### User Story 4 - A failed read is not "nothing configured" (Priority: P2)

When the last lookup failed, or lookups are off in air-gap mode, every surface shows that there is no current reading. This is distinct from having no lists configured. It gives the reason where known (a provider error, every provider failing, or air-gap mode), and a hint that points at the real fix: check the network, VPN or providers; in air-gap mode, the lookup is off by the operator's own choice. If a previous address is shown, it is marked as the last known one, with when it was last read successfully.

A failed read, or air-gap mode turned on, right after an exposure or an off-profile reading is covered by US1, US3 and FR-016.

**Why this priority**: The two P1 stories fix states that claim too much. Today's `IP?` at least claims nothing, but it points the operator at the wrong fix.

**Independent Test**: With both lists set, make every lookup fail, and check the state, the hint and the address marking on every surface. Then repeat in air-gap mode.

**Acceptance Scenarios**:

1. **Given** both lists set and a failed read, **When** the status arrives, **Then** every surface shows the no-current-reading state, not the unconfigured one, and no hint tells the operator to set the lists.
2. **Given** no lists set and a reading, **When** its verdict arrives, **Then** the unconfigured state and its set-the-lists hint are shown, as today.
3. **Given** a good reading followed by a failed one, **Then** the address is shown only as the last known address, with its age.
4. **Given** air-gap mode, **Then** the state says lookups are off by the operator's choice, and where to turn them back on. It does not say that a lookup failed.
5. **Given** a failed read, **When** a later read succeeds, **Then** the no-current-reading state clears and the new verdict is shown.
6. **Given** the first lookup after launch has not completed, **Then** every surface shows that it is still checking, with no address, no hint and no last reading. **When** that lookup succeeds, its verdict replaces the state. **When** it fails, or air-gap mode is on, the no-current-reading state replaces it, still with no address and no last reading.

---

### User Story 5 - A new address being confirmed is visible (Priority: P3)

While a new address is held for confirmation, the surfaces say that a different address has been seen and is being confirmed. They must not keep presenting the previous address and verdict as if nothing had changed. They show neither the candidate address nor how it compares with the lists: its verdict arrives when it is confirmed. With the defaults, a new address takes up to two poll intervals (two minutes) to be confirmed.

**Why this priority**: The hold exists to stop flapping, and its default length is bounded. The indicator tells the operator that a change is under way; it does not judge the new address early.

**Independent Test**: With the default confirmations, change the egress address and check what every surface shows before the new address is confirmed.

**Acceptance Scenarios**:

1. **Given** a stable address and a different one read once, **When** the status arrives, **Then** every surface says a new address is being confirmed, while the verdict stays that of the stable address. No surface shows the candidate address or how it compares with the lists.
2. **Given** a confirmation in progress, **When** the new address is confirmed, or the old one returns, **Then** the indication clears.

---

### Edge Cases

- **No lookup has completed yet** (the first lookup after launch is still running). Surfaces show that they are still checking, and make no claim about the address. Today they show this only until the first status arrives, and then `IP?`.
- **Both lists contain the address** (A-6). The address is shown as exposed. Showing the list conflict alongside it is out of scope.
- **A settings change alters the verdict without a new read.** Every surface shows the new state from the next status it receives.
- **A settings change or a project switch while an alarm is held.** Neither is a reading. The held state and its last reading stay until a read succeeds.
- **A read fails while a new address is being confirmed.** The surfaces show no current reading, without the confirming indicator. The next successful read decides as any read does: until the new address is confirmed, the stable address's verdict is shown with the confirming indicator.
- **An alarm ends.** When a read ends the exposed, off-profile or held state, the HUD returns to its resting opacity. Pass-through stays off until the operator turns it back on, as today.
- **The provider's own error text.** It is still shown where the surfaces show it today, next to the no-current-reading state. It is not red: red belongs to the exposed state (FR-003).
- **The surfaces disagree** because one received a newer status than another. This lasts only until each has received the latest status, and no surface keeps a state the others have left.
- **The status bar is narrow.** Its state labels fit in the width that today's exposed label and an address take, and still tell every state apart without colour. While an alarm is held, the last reading may add to that width.
- **An agent written against the old `ipSafety` values.** After the change, off-profile no longer reads as `exposed`. The updated guidance (FR-019) keeps a guided agent stopping where it stopped before, and the CHANGELOG records the change for everyone else.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each surface that shows the IP verdict (the HUD's compact bar and expanded pane, the dashboard IP card, the status bar) MUST let the operator tell apart the states in scope. These are: exposed, off-profile, verified safe, presumed safe, not configured, no current reading, and still checking (no lookup has completed yet). A surface MUST also show when a new address is being confirmed (FR-017), which accompanies a state rather than replacing it. The status bar and the HUD's compact bar show the state's label, its mark and the confirming indicator; the status bar also shows the last reading while an alarm is held. The HUD's expanded pane and the dashboard card show all of that, plus the hint and the address with its age.
- **FR-002**: The exposed state MUST keep today's presentation. On every surface: its label and the red tone. On the HUD and the dashboard card: the pulsing mark. On the card: the hint that the address is on the Exposed IP list. On the HUD: the frame flashing when flashing is on, the HUD opened and held open, pass-through switched off, and the HUD fully opaque. "Held open" means, as today, that the HUD opens whenever it receives a state that carries these overrides while it was not showing one, and does not collapse on its own while that state lasts. The operator can still collapse it by hand.
- **FR-003**: States other than exposed MUST NOT use the exposed label, the red tone, the pulsing mark or the frame flash.
- **FR-004**: The presumed-safe state MUST have its own label and a qualified mark that is neither a solid fill nor a glow. It MUST NOT use the solid presentation of verified safe (ALERT-ROLES A.2).
- **FR-005**: The presumed-safe hint MUST say the address is not on the Exposed IP list and that declaring the expected exits as Safe IPs would verify it. It MUST NOT claim the address is a known safe exit.
- **FR-006**: The off-profile state MUST have its own label and the orange warning tone, and MUST NOT flash. It MUST keep the exposed state's overrides of the HUD preferences: the HUD opened and held open, pass-through switched off, and the HUD fully opaque.
- **FR-007**: The off-profile hint MUST say the address is not one of the declared Safe IPs, and name the fix (check the VPN or tunnel; add the exit if it is expected). It MUST NOT say the address is on the Exposed IP list.
- **FR-008**: The hint that says the address is on the Exposed IP list MUST be shown for the exposed state only.
- **FR-009**: A failed read MUST be shown as no current reading, distinct from not configured, with the reason when it is known. Its hint MUST NOT tell the operator to set lists that are already set.
- **FR-010**: In air-gap mode, the no-current-reading state MUST say that lookups are off by the operator's choice, and where to turn them back on.
- **FR-011**: While there is no current reading, any address a surface still shows MUST be marked as the last known address, with its age. Every age this spec names counts from the last successful read, not from the last attempt.
- **FR-012**: The set-the-lists hint MUST appear only in the not-configured state, which requires that neither the Safe nor the Exposed IP list is set. A failed read shows the no-current-reading hint, even when no list is set.
- **FR-013**: Every state, the confirming indicator and the last-reading line MUST be identifiable from their text alone, without colour, in both English and Traditional Chinese.
- **FR-014**: The HUD, the dashboard card, the status bar and the local status API MUST show the same state for the same status.
- **FR-015**: The policy's verdicts MUST be unchanged. This feature changes what the surfaces are told and how they show it, not what is decided.
- **FR-016**: When the last good reading was exposed or off-profile and the next read fails, or air-gap mode is turned on, every surface MUST show no current reading together with the last reading's verdict and its age. The HUD MUST keep the overrides (open and held, pass-through off, fully opaque) until a read succeeds. In air-gap mode, that means until lookups are back on and one succeeds.
- **FR-017**: A new address being confirmed MUST be indicated on every surface, without changing the verdict shown. The surfaces and the status API MUST NOT show the candidate address or how it compares with the lists.
- **FR-018**: The local status API that agents and the CLI read (`/api/status`) MUST report the state the surfaces show, in its existing IP safety field (`ipSafety`), whose values change to the states of FR-001. It MUST also carry what the surfaces show for a failed read after an exposed or off-profile reading, and for a new address being confirmed. No compatibility alias is kept. The CLI's status command prints the same state, and says when an alarm is held.
- **FR-019**: Agent-facing guidance that acts on the IP state MUST be updated to the new values: the pentest skill, the agent integration guide and the API reference. An agent following it MUST still stop and ask before network-touching actions in every case where it does today, off-profile included, and also when there is no current reading after an exposed or off-profile reading. In the states that make no claim (still checking, and no current reading without an earlier exposed or off-profile reading), the guidance tells the agent to report the state to the operator. It does not require stopping, as today.

### Key Entities *(include if feature involves data)*

- **IP verdict**: what the policy decided about the egress address. It is one of exposed, off-profile, safe, presumed safe or unknown, and each carries an authority (observed fact, inference, or no claim).
- **Reading freshness**: whether the verdict rests on a current reading. It is current, stale (with the reason: a provider error, every provider failing, or air-gap mode), or not yet read (the first lookup has not completed). A current reading can also be settling: a new address seen and not yet confirmed.
- **Display state**: what a surface shows for a verdict and its freshness: a label, a tone, whether the mark is qualified, a hint, and the address with its age where one is shown.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: ALERT-ROLES A.1 defines nine list-and-address cells. With a current reading, the three surfaces and the status API show exposed for A-2, A-6 and A-7; off-profile for A-5 and A-9; verified safe for A-4 and A-8; presumed safe for A-3; and not configured for A-1. After a failed read, and in air-gap mode, they show no current reading. Before the first lookup completes, they show still checking. No case exists in which one of them shows another state, or in which two of them disagree.
- **SC-002**: In every off-profile case, no surface says the address is on the Exposed IP list. In every failed-read case with a list set, no surface tells the operator to set the lists.
- **SC-003**: Every exposed behaviour that FR-002 lists is present on its surface, unchanged from today.
- **SC-004**: In a walkthrough of every state in scope, on each of the three surfaces and in both languages, a reviewer names the state correctly from that surface alone, on the first try.
- **SC-005**: Each state is identifiable from its label alone, with colour removed, in English and in Traditional Chinese.

## Assumptions

- The IP policy's decisions (ALERT-ROLES A.1) are correct and stay as they are; `test/alert/ip-policy.test.ts` pins them. This feature changes what the surfaces and the status API are told, not what is decided.
- Tones follow ALERT-ROLES A.2: red for exposed, orange for off-profile, green for safe and presumed safe (presumed safe qualified), and amber for unknown. The no-current-reading and still-checking states take the unknown tone. UIUX-STANDARD §1's state table has no orange yet. It gains the off-profile tone, and its amber keeps its meaning. The orange meets the standard's contrast floors on every surface it appears on: 4.5:1 as text and 3:1 as a mark.
- The surfaces in scope are the HUD (compact and expanded), the dashboard IP card and the status bar. The local status API (`/api/status`), which agents and the CLI read, reports the same state (FR-018). These are today's only consumers of the IP state, apart from bookmarks, which record the external address when one is created. What a bookmark records is unchanged, and out of scope.
- ALERT-ROLES A.3 rule 1 still holds: a stale verdict decays, and a held state uses neither red nor the flash. This spec adds that the record of an exposed or off-profile reading, and the HUD overrides, outlast the decay until a read succeeds. ALERT-ROLES is amended to say so.
- RedLog is pre-1.0. The API's `ipSafety` values change without a compatibility alias, as with the pre-release contract reset (Spec 006), and the change is recorded in the CHANGELOG.
- No new settings are added. Flashing on exposure remains the operator's choice (`overlay.flashOnExposed`), as today.
- Showing the list-conflict modifier (A-6) is out of scope.
- These are updated to what ships:
  - ALERT-ROLES.md, A.2 and A.3;
  - the state table in UIUX-STANDARD.md §1;
  - docs/TESTING.md: §1.8, §5.1, §5.2, and G-UI2 in Part 6;
  - the agent-facing documents that FR-019 names;
  - the CHANGELOG.

  ALERT-ROLES still cites modules that no longer exist on main (`lib/ip-badge.ts`, `lib/alertSeverity.ts`).
