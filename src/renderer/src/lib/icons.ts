// Single source of truth for the app's semantic / entity glyphs.
//
// RedLog's icons are Unicode glyphs. They used to be hardcoded as string
// literals scattered across components — and the SAME entity drifted between
// files (loot `◆` appeared in Sidebar, StatusBar AND LootPanel's empty state;
// the transcript entity was `☰` in the sidebar but `▤` in its empty state; the
// marks entity was `⚑` in the sidebar but `◈` in its empty state). Centralising
// them here (DESIGN-SYSTEM.md §4.2 route B) makes the sidebar the canonical
// definition and stops the drift: one entity, one glyph, one place to change.
//
// Route B keeps the current visuals. The later route A — a real stroke icon set
// — swaps these values in ONE place without touching any call site.
//
// Convention: an icon is decorative. Render it with `aria-hidden` and ALWAYS
// keep a text label or `aria-label` beside it (the sidebar buttons already do).
// Size and colour come from the type scale + colour tokens (DESIGN-SYSTEM §2/§1),
// never from this map — it carries the glyph only.

export const ICON = {
  // ── Nav entities (the sidebar is the reference definition) ──
  dashboard: '◉',
  terminal: '▸',
  timeline: '═',
  transcript: '☰',
  screenshots: '◻',
  targets: '⊕',
  scope: '⊘',
  loot: '◆',
  marks: '⚑',
  settings: '⚙',

  // ── Cross-cutting affordances / semantic glyphs ──
  search: '⌕',
  dragHandle: '⠿',
  anchor: '⚓',
  laneAxis: '⊞',
  phaseRibbon: '▤',
  openInTimeline: '↗'
} as const

export type IconName = keyof typeof ICON
