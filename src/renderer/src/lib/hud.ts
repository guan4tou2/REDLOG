// HUD design tokens. The overlay window loads no app stylesheet (no Tailwind,
// no `styles/index.css`), so its colours are strings and they live here, not
// scattered through OverlayApp. Only the HUD imports this file; the state hues
// below are the same values as the app's theme tokens (`styles/index.css`), so
// the two surfaces agree without sharing code.
//
// Look: the simple-1112 HUD (design 10-hud) — a near-black neutral panel, a
// hairline frame, four corner marks in the state colour, vertical ticks for the
// two states. No glow, no scanline, no gradient sheen.

export const HUD = {
  // frame / relay accent (= theme `info`)
  cyan: '#3fc7d6',
  // states — identical hexes to the theme's accent / safe / warn
  red: '#d75f63',      // recording
  green: '#5ecf9c',    // safe
  amber: '#d4ac5a',    // unknown
  danger: '#ff4d4f',   // exposed (= theme `danger`; recording keeps the brand red)
  // Labels. Was #5f7a82 — 4.3:1 on the HUD panel, and HUD labels are the
  // smallest text in the product, so it read as a smudge at arm's length.
  // #8fa8b2 is 7.9:1 and keeps the cyan cast that separates HUD chrome from
  // app chrome (UIUX-STANDARD §1, §8). The design file draws labels at
  // #7d8b92, which is 5.5:1 — under §1's 6:1 grey floor — so this stays.
  muted: '#8fa8b2',
  // panel and frame
  panel: 'rgba(10, 13, 16, 0.92)',
  panelSolid: '#0a0d10',  // the click-through notice, which must not be see-through
  panelExposed: '#120a0b',
  border: '#2c3a40',
  borderExposed: '#5a2224',
  rule: '#3a4a52',      // hairline between the two states, and an idle tick
  // text
  text: '#ececf0',
  ip: '#e6f6fa',        // external IP — the value the HUD exists to show
  internal: '#9fd8e6',  // internal IP
  link: '#7fb8c6',      // Wi-Fi / wired name
  recText: '#e39aa0',   // the word beside the recording tick
  value: '#d6f7fd',     // key/value and relay-node values
  section: '#7fe6f7',   // relay-node heading
  sectionRule: '#24414a',
  pivot: '#bff2ff',     // collapsed relay capsule text
  nodeBg: 'rgba(63, 199, 214, 0.06)',
  action: '#bfe9f2'     // expanded action row
} as const

/** Type stacks. Mono carries IPs and times; the UI face carries sentences. */
export const HUD_FONT = {
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  ui: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif'
} as const

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
