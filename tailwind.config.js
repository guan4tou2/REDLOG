/** @type {import('tailwindcss').Config} */
const colors = require('tailwindcss/colors')

// App-wide comfort remap: pull the accent shades used across the UI down to the
// desaturated HUD palette so nothing "vibrates" against the dark surface (a
// known dark-mode eye-strain cause). One place, whole app — every text-red-400 /
// text-green-400 / text-amber-400 etc. picks these up, keeping the app unified
// with the HUD (see lib/hud.ts) instead of split between bright and calm reds.
const soften = {
  red: { ...colors.red, 300: '#e4989b', 400: '#d75f63', 500: '#cf5459', 600: '#b84d51' },
  rose: { ...colors.rose, 400: '#d75f63' },
  emerald: { ...colors.emerald, 300: '#8fddb6', 400: '#5ecf9c', 500: '#4bbf8a' },
  green: { ...colors.green, 300: '#8fddb6', 400: '#5ecf9c', 500: '#4bbf8a' },
  amber: { ...colors.amber, 300: '#e2c886', 400: '#d4ac5a', 500: '#c69a45' },
  // off_profile — sits between red (exposed) and amber (unknown), softened to
  // the same degree so it doesn't vibrate next to them.
  orange: { ...colors.orange, 300: '#e3ab84', 400: '#d78550', 500: '#c9773f' },
  yellow: { ...colors.yellow, 300: '#e2c886', 400: '#d4ac5a', 500: '#c69a45' },
  cyan: { ...colors.cyan, 300: '#7fe0ea', 400: '#3fc7d6', 500: '#2ba9b8' }
}

module.exports = {
  content: ['./src/renderer/src/**/*.{tsx,ts,html}'],
  theme: {
    extend: {
      colors: {
        ...soften,
        redlog: {
          bg: '#0a0a0a',
          surface: '#141414',
          elevated: '#1a1a1a',
          border: '#262626',
          'border-subtle': '#1e1e1e',
          accent: '#d75f63',
          'accent-dim': '#b84d51',
          cyan: '#3fc7d6',
          'cyan-dim': '#0e7490',
          muted: '#71717a',
          text: '#e5e5e5',
          'text-dim': '#a1a1aa'
        }
      },
      // Two named micro tiers so the sub-`text-xs` labels stop being hardcoded
      // `text-[10px]`/`text-[9px]`/`text-[8px]` px (which only scaled with
      // --app-zoom, not the 17px base). String form = font-size only, matching
      // the arbitrary-value behaviour these replace. See docs/DESIGN-SYSTEM.md §2.3.
      fontSize: {
        '2xs': '0.625rem', // ~10.6px @17px base — chip counts, freshness, minor meta
        '3xs': '0.5rem'    // ~8.5px  @17px base — the densest badges/labels
      },
      boxShadow: {
        // Softened to match the `soften` accent map (red-400 #d75f63 = rgb(215,95,99),
        // cyan-400 #3fc7d6 = rgb(63,199,214)) so glows no longer render the pre-soften
        // bright #ef4444 / #22d3ee that "vibrates" against the dark surface. See
        // docs/DESIGN-SYSTEM.md §1.5.
        'glow-red': '0 0 12px 0 rgba(215, 95, 99, 0.15)',
        'glow-red-sm': '0 0 6px 0 rgba(215, 95, 99, 0.1)',
        'glow-cyan': '0 0 14px 0 rgba(63, 199, 214, 0.18)',
        'glow-cyan-sm': '0 0 6px 0 rgba(63, 199, 214, 0.25)',
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.4)',
        'card-hover': '0 4px 12px 0 rgba(0, 0, 0, 0.5)'
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'toast-in': 'toastIn 0.25s ease-out',
        'blink-rec': 'blinkRec 1s step-end infinite',
        'spin-slow': 'spin 2s linear infinite'
      },
      keyframes: {
        toastIn: {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        },
        blinkRec: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' }
        }
      }
    }
  },
  plugins: []
}
