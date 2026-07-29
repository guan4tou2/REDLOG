// Shared HUD design tokens — the single source of truth for the cyberpunk look
// across the overlay and the app's status surfaces.
//
// Tuned for dark UI comfort: accents are DESATURATED ~20-30% from full neon so
// they don't "vibrate" against the dark surface (a known dark-mode eye-strain
// cause), and glows are kept low-alpha. Red in particular is pulled back from
// searing #ff3b5c to a calmer rose so long sessions don't fatigue the eye.

export const HUD = {
  // frame / system / live / pivot — MUST match tailwind's soften map (config)
  // so the overlay and the app render the exact same accents.
  cyan: '#3fc7d6',
  sky: '#57b8d6',
  // states — identical hexes to tailwind red-400/green-400/amber-400
  red: '#d75f63',      // danger / exposed / recording
  green: '#5ecf9c',    // safe
  amber: '#d4ac5a',    // unknown / idle / partial
  // neutrals
  muted: '#5f7a82',    // labels
  value: '#cfe8ee',    // primary values (cyan-tinted, not pure white)
  valueDim: '#9fc4ce'
} as const

// Low-alpha glow helpers — keep these subtle. `soft` for text-shadow, `ring`
// for box-shadow. Passed a hex, returns an rgba-ish shadow string.
export function glow(hex: string, alpha = 0.4, blur = 8): string {
  return `0 0 ${blur}px ${hexA(hex, alpha)}`
}

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Chamfered-panel clip-path (cuts top-left + bottom-right corners).
export const CHAMFER = 'polygon(11px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 11px)'
export const CHAMFER_SM = 'polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px)'
