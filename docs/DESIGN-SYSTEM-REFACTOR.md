# Design System Refactor Plan — 2026-08-20

Written against v0.14.2 by cross-referencing the existing codebase (tailwind.config.js,
index.css, hud.ts, all 19 components) against three external design reference systems:

- **ConardLi/web-design-skill** — oklch color, 8pt grid, anti-cliché blocklist, redesign protocol
- **Dammyjay93/interface-design** — intent-driven design, hierarchy lenses, craft foundations
- **foreverwebs.com blog** — anti-AI-slop patterns, DESIGN.md methodology, polish pipeline

Companion to `UX-AUDIT-2026-08.md` (that one asks "does the persona succeed?",
this one asks "is the visual system consistent and craft-grade?").

---

## TL;DR

RedLog's design foundation is **stronger than most Electron tools** — the `soften`
palette, `redlog` token namespace, border-based depth strategy, and
`prefers-reduced-motion` respect are all correct decisions. The problems are
**consistency, not direction**: three neutral vocabularies compete (`neutral-*`,
`zinc-*`, `redlog-*`), typography hierarchy is weight-flat, and several components
miss interactive states. Fix these in four phases without changing the visual identity.

**Design direction: Precision & Density** — cold like a terminal, dense like a
trading floor, calm unless something is actually wrong.

---

## What's Already Right

| Decision | Why it's correct |
|---|---|
| `soften` palette | Desaturated accents prevent dark-mode vibration — better than the neon-on-dark cliché |
| `redlog` token namespace | Surfaces organised in one place (`bg` → `surface` → `elevated`) |
| `prefers-reduced-motion` | Global blanket rule respects OS-level setting |
| HUD chamfered clip-path | Distinctive signature element — could only be RedLog |
| Border-based depth | Correct for dark mode; shadows don't read on `#0a0a0a` |
| Status encoded in form | Recording pulse, scope badge, loot badge — not color-only |

---

## Phase 1 — Functional & Accessibility Fixes

No visual change for users. Pure correctness.

### 1.1 Settings tab overflow `P-CRITICAL`
**File:** `Settings.tsx`
Tab bar overflows at narrow widths. Add `overflow-x: auto` with hidden scrollbar,
or switch to vertical tabs.

### 1.2 Modal focus trapping `P-CRITICAL`
**Files:** `EventMarker.tsx`, `ConfirmDialog.tsx`, `SearchPanel.tsx`
Tab key escapes modals into the background. Implement focus trap utility.
SearchPanel also needs Escape-to-dismiss.

### 1.3 Sidebar semantic HTML `P-HIGH`
**File:** `Sidebar.tsx`
Nav items are `<div>` with `onPointerDown` — should be `<button>` for keyboard
nav and screen readers. Emoji icons (◉, ▸, ═, etc.) render inconsistently across
platforms — replace with inline SVG.

### 1.4 ErrorBoundary i18n `P-HIGH`
**File:** `ErrorBoundary.tsx`
Error messages hardcoded in English. Either convert to function component with
error boundary hook + `useI18n()`, or read translations from context.

### 1.5 Visible focus states `P-HIGH`
**File:** `index.css`
Define a global `:focus-visible` ring:
```css
:focus-visible {
  outline: 2px solid #3fc7d6;
  outline-offset: 2px;
}
```

### 1.6 Hit area audit `P-MEDIUM`
Sidebar items at `h-8` (32px) are below the 44px WCAG minimum. Extend hit area
with padding or pseudo-element.

---

## Phase 2 — Typography & Hierarchy

Subtle visual improvement. Weight + color drive hierarchy, not size alone.

### 2.1 Type scale `P-HIGH`
Define in tailwind.config.js or index.css. Base 14px, ratio ~1.2:

| Role | Size | Weight | Color tier |
|---|---|---|---|
| caption | 11px | 400 | muted |
| small | 12px | 400 | secondary |
| body | 14px | 400 | primary |
| label | 14px | 500 | primary |
| h4 | 14px | 600 | heading |
| h3 | 16px | 600 | heading |
| h2 | 18px | 700 | heading |
| h1 | 22px | 700 | heading |
| data | mono | — | tabular-nums |

### 2.2 Tabular numerics `P-MEDIUM`
**Files:** `StatusBar.tsx`, `Timeline.tsx`, `IPStatusCard.tsx`, `LootPanel.tsx`
Add `font-variant-numeric: tabular-nums` to counters, IP addresses, timestamps,
and table columns. Currently only the HUD does this.

### 2.3 Version string contrast `P-LOW`
**File:** `App.tsx:189`
`text-zinc-800` is ~1.6:1 contrast against `#0a0a0a`. Change to `redlog-muted`
(#71717a) for ~4.5:1.

### 2.4 Heading text-wrap `P-LOW`
Add `text-wrap: balance` to section headings across Settings, Dashboard, and
view titles.

---

## Phase 3 — Token Consolidation

Largest diff but low visual change. One vocabulary instead of three.

### 3.1 Unify neutral tokens `P-HIGH`
Search the codebase for `neutral-*` and `zinc-*` classes. Map to `redlog-*`:

| Current | Replacement |
|---|---|
| `text-neutral-500` | `text-redlog-muted` |
| `text-zinc-800` | `text-redlog-text-dim` (or new darker tier) |
| `text-zinc-600` | `text-redlog-muted` |
| `bg-neutral-800/60` | `bg-redlog-elevated/60` |
| `text-neutral-200` | `text-redlog-text` |
| `border-neutral-600/50` | `border-redlog-border` |

### 3.2 Add missing semantic tokens `P-MEDIUM`
In `tailwind.config.js`, extend the `redlog` namespace:

```js
'text-heading': '#f0f0f2',     // headings — currently hardcoded
'input-bg': '#101012',         // inset inputs, slightly darker than surface
'input-border': '#2a2a2e',     // rest state
'input-border-focus': '#3fc7d6', // focus state
'badge-bg': '#1e1e22',         // badge surfaces
```

### 3.3 Switch borders to rgba `P-MEDIUM`
```js
// Before:
border: '#262626',
'border-subtle': '#1e1e1e',

// After:
border: 'rgba(255,255,255,0.07)',
'border-emphasis': 'rgba(255,255,255,0.12)',
```
rgba borders adapt if the surface color shifts and look softer.

### 3.4 Remove card shadow usage `P-LOW`
`card` and `card-hover` box-shadows are invisible on `#0a0a0a`. Replace with
`hover:border-redlog-border-emphasis`. Keep `glow-red`, `glow-cyan` for HUD only.

---

## Phase 4 — Layout & Polish

Noticeable quality improvement.

### 4.1 Dashboard responsive grid `P-HIGH`
Replace fixed column count with:
```css
grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
```

### 4.2 Screenshots responsive grid `P-MEDIUM`
Same auto-fill pattern as dashboard.

### 4.3 Spacing normalisation `P-MEDIUM`
Snap all spacing to 4px grid. Valid values: 4, 8, 12, 16, 24, 32, 48.
Audit `p-*`, `m-*`, `gap-*`, and hardcoded `style={{...}}` padding/margin.

### 4.4 Toast repositioning `P-MEDIUM`
Toasts render behind StatusBar. Either shift up by StatusBar height or
reposition to top-right.

### 4.5 Button press feedback `P-MEDIUM`
Add `transform: scale(0.97)` on `:active` for buttons. Duration 100-160ms,
ease-out.

### 4.6 Save UX unification `P-MEDIUM`
Pick one model: either everything auto-saves (with subtle "saved" indicator)
or everything requires explicit save. Currently the mix confuses users.

### 4.7 Motion specificity `P-LOW`
Replace `transition-all` with specific property transitions. For modals/drawers,
use `cubic-bezier(0.23, 1, 0.32, 1)`.

---

## Protected Contracts (Do Not Change)

- **Hash chain** — SHA-256 chain and events table schema
- **IPC API** — preload bridge methods, channel names, event shapes
- **Keyboard shortcuts** — ⌘1-9, ⌘/, ⌘K, ⌘., ⌘⇧M
- **HUD persistence** — overlay position/scale settings
- **i18n keys** — rename none; only add new keys
- **Sidebar order** — localStorage key and format
- **Recording indicator** — most prominent StatusBar element
- **CSS zoom** — `--app-zoom` / body height calc mechanism

---

## Sources

| Source | Key takeaways applied |
|---|---|
| interface-design (Dammyjay93) | Intent-driven design, one focal point per view, weight > size for hierarchy, rgba borders, inset inputs, 44px hit areas, press feedback, custom ease-out |
| web-design-skill (ConardLi) | oklch color potential, 8pt grid, anti-cliché blocklist (emoji icons, cardification), redesign protocol (lowest-risk-first order), protected contracts |
| Blog post (foreverwebs) | Anti-AI-slop patterns, DESIGN.md methodology, typography pairing, four-phase polish pipeline |
| Internal UX audit | 15 specific component issues (Settings overflow, focus traps, ErrorBoundary i18n, responsive grids, toast positioning) |
