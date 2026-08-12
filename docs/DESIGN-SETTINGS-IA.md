# Design Proposal — Settings Information Architecture (F3 structural)

Written 2026-08-12. For ratification before implementation. This is the
*structural* half of F3 (`UX-BACKLOG-TICKETS.md`): reorganise Settings so its
**weight mirrors necessity** (`DESIGN-PRINCIPLES.md` §9), not so its 34 groups
sit flat across 8 equal tabs. The filter box (F3 search) and the marketplace
shelving already shipped; this is the layout.

The complaint (`UX-AUDIT-2026-08.md` F3): 8 tabs / 34 `FieldGroup`s / 234 i18n
keys, all equal weight — a P1's daily essentials (capture sources, scope) compete
for attention with expert-only surfaces (MCP, deconfliction, plugins) they touch
once. Under-sequenced, not over-featured.

## Current structure (mapped to necessity tiers)

Eight tabs today (`Settings.tsx` L182–190), 34 groups. Tier per
`DESIGN-PRINCIPLES` (Core = essential to record + evidence; OPSEC = second front
door; Advanced = frozen/secondary identities):

| Current tab | Groups | Necessity tier |
|---|---|---|
| **General** | engagement, operator, language, uiScale | mixed — engagement/operator are **core**; language/uiScale are **app-chrome (advanced)** |
| **Capture** | hooks, agent-tailer, clipboard, screenshot(×2), file-watcher, process-monitor, excluded-paths | **Core (essential)** — the #1 thing a P1 sets up |
| **Scope** | enforcement, in-scope, excluded, scope-file | **Core (essential)** |
| **Network / IP** | ip-safety, polling, vpn-adapters | **OPSEC front door** |
| **HUD** | overlay group (all HUD/overlay knobs) | **OPSEC front door** |
| **Integrations** | cdp/proxied-browser, mcp, agents | **Advanced** (agent control plane, §6/§7) |
| **Data** | export-all, scope-export, profile-sync, export-bundle, **integrity**, update, cloud-share | mixed — **integrity + bundle export are core evidence**; profile-sync/cloud-share/update are **advanced** |
| **Plugins** | local/declarative plugins, (marketplace — shelved) | **Advanced (frozen)** |
| *(within tabs)* | operators, deconfliction | operators = **core (attribution)**; deconfliction = **advanced (team, frozen)** |

The mismatch is visible: **evidence integrity** (core) is buried in the Data
tab next to update-check and cloud-share (advanced); **operator identity** (core
attribution) is split between General and a sub-panel; **language/UI-scale**
(pure chrome) sit in the first tab a newcomer sees.

## Two proposals

### Option A — Reorder + regroup the existing tabs *(lighter, lower risk)*

Keep tab-based navigation; fix the ordering and the mis-filed groups so weight
follows necessity. No tab merging.

1. **Tab order becomes tier order** (left→right = most→least essential):
   `Capture · Scope · Evidence · OPSEC · Advanced` — plus the F3 filter spanning
   all.
2. **Re-file the mis-placed groups:**
   - New **Evidence** tab (was scattered): engagement, operators, integrity/chain
     verify, bundle export, redaction (when it lands), profile-sync.
   - **OPSEC** tab = today's HUD + Network/IP merged (one front door, §4).
   - **Advanced** tab = Integrations (mcp/agents/browser) + deconfliction +
     plugins + cloud-share + app-chrome (language, uiScale, update-check).
3. `General` dissolves — engagement/operator → Evidence; language/uiScale/update
   → Advanced.

Net: **5 tabs** (Capture, Scope, Evidence, OPSEC, Advanced) instead of 8, but the
*mechanism* (tabs) is unchanged — this is moving `FieldGroup`s between tab
conditionals, not rewriting them.

### Option B — Two-level: essentials up front, everything else behind "Advanced"

A stronger progressive-disclosure cut. Primary surface shows only what a P1
needs; a single **Advanced** disclosure holds every frozen/secondary surface.

- **Primary (always visible):** Capture, Scope, Evidence, OPSEC — four tabs.
- **Advanced (one collapsed section / tab, closed by default):** Integrations
  (mcp/agents/browser), Team (deconfliction), Plugins, Cloud share, App
  (language/scale/updates).
- The F3 filter still searches across everything (including collapsed Advanced),
  so nothing becomes unfindable — just un-prominent.

Net: the newcomer sees 4 essential tabs; the long tail is one deliberate click
away. Higher impact on the "under-sequenced" complaint, slightly more work (the
Advanced disclosure + making the filter reach into it).

## Recommendation

**Option A**, then adopt B's "Advanced is collapsed by default" idea for the
Advanced tab only. Rationale: A is a faithful, low-risk re-file (weight follows
necessity, `General` chrome stops greeting newcomers) that we can ship and
verify tab-by-tab; collapsing just the Advanced tab's contents by default gets
most of B's progressive-disclosure benefit without a new nav paradigm. Full B can
follow if A proves the tiers are right.

## Migration & muscle memory

- **F3 search already mitigates** the "where did X move?" cost — typing the
  setting name finds it regardless of tab. The marketplace change already reset
  Plugins-tab muscle memory, so this is a good moment to move things.
- **⌘-number / deep-links:** Settings is a single view (⌘9); the tabs aren't
  individually shortcutted, so no shortcut churn.
- **No config/key changes** — this is pure presentation. Every `FieldGroup`
  keeps its config path, state, and i18n key; only its parent tab changes. i18n:
  add the new tab labels (Evidence, OPSEC, Advanced), keep the rest.

## Risk & incremental strategy

Settings.tsx is 2,681 lines; moving groups between tab conditionals is mechanical
but wide. Do it as **one tab at a time, verified in the app** (the loop is set up):

1. Introduce the new tab list + empty new tabs; keep old tabs rendering.
2. Move groups into the new tabs one tier at a time; after each, screenshot that
   tab in the running app + `renderer-smoke` + `npm run typecheck` (gate is
   green — must stay 0).
3. Delete the emptied old tabs last.
4. Collapse the Advanced tab's groups by default.

Each step is revertible; the app never ships a half-moved tab because the old one
stays until its groups are gone.

## Acceptance criteria

- **A1** Tabs read Capture · Scope · Evidence · OPSEC · Advanced, left→right.
- **A2** A newcomer's first tab (Capture) is an essential, not app chrome;
  language/UI-scale/update-check live only under Advanced.
- **A3** Evidence integrity (chain verify) + bundle export sit together under
  Evidence, not scattered in Data.
- **A4** Every setting reachable before the move is still reachable (F3 filter
  finds it; Advanced is collapsed but searchable).
- **A5** No config key or behaviour changes — a saved profile round-trips
  identically. `npm run typecheck` stays 0; `renderer-smoke` green; each tab
  screenshotted in the app.
- **A6** i18n parity for the new tab labels.

## Open questions (for ratification)

- **Q1 — A or B?** Recommend A + collapsed-Advanced. Full two-level (B) is more
  disruptive; worth it?
- **Q2 — "Evidence" vs "Engagement" as the tab name** for engagement/operators/
  integrity/export? "Evidence" states the purpose; "Engagement" is the current
  mental model. Recommend **Evidence**.
- **Q3 — merge HUD + Network into one "OPSEC" tab** (recommended, §4 one front
  door), or keep them separate? Merging is truer to the model but changes two
  familiar tabs into one.
- **Q4 — fold PL1** (the new "plugin lifecycle: Install≠Enable" ticket) into this
  reorg's Advanced/Plugins tab, or keep it a separate follow-up? Recommend
  separate — PL1 is a behaviour change, this is layout only.

Cross-references: `DESIGN-PRINCIPLES.md` §4/§9 · `UX-AUDIT-2026-08.md` F3 ·
`UX-BACKLOG-TICKETS.md` (F3, PL1) · `Settings.tsx` L182–742.
