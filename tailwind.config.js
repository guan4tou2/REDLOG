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
  yellow: { ...colors.yellow, 300: '#e2c886', 400: '#d4ac5a', 500: '#c69a45' },
  cyan: { ...colors.cyan, 300: '#7fe0ea', 400: '#3fc7d6', 500: '#2ba9b8' }
}

module.exports = {
  content: ['./src/renderer/src/**/*.{tsx,ts,html}'],
  theme: {
    extend: {
      // Type scale from docs/UIUX-STANDARD.md §2. 13px is a hard floor — the
      // ~180 `text-[10px]` / `text-[11px]` call sites are being removed, and
      // the HUD is the single exception (11px, it has its own scale setting).
      //
      // The sizes used to come from Tailwind's rem defaults times a 17px root
      // font-size. That one knob also inflated every rem-based spacing, radius
      // and sizing utility by ~6%. The scale is stated here instead and the
      // root goes back to 16px (styles/index.css); stacking both would make
      // body text too large on a big display.
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.25rem' }], // 13px
        sm: ['0.9375rem', { lineHeight: '1.6rem' }], // 15px
        base: ['1.0625rem', { lineHeight: '1.7rem' }], // 17px
        lg: ['1.1875rem', { lineHeight: '1.75rem' }], // 19px
        xl: ['1.375rem', { lineHeight: '1.9rem' }], // 22px — the value size
        '2xl': ['1.625rem', { lineHeight: '2.125rem' }],
        '3xl': ['2rem', { lineHeight: '2.375rem' }],
        '4xl': ['2.375rem', { lineHeight: '2.625rem' }]
      },
      // Bundled so all three platforms render the same. Noto Sans TC carries
      // the Traditional Chinese the interface is written in; the previous
      // stack fell through to Microsoft JhengHei on Windows and a different
      // metric on every machine.
      fontFamily: {
        sans: ['"Noto Sans TC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      },
      colors: {
        ...soften,
        // The neutral palette from docs/UIUX-STANDARD.md §1. These are not the
        // greys the UI grew up on: the whole surface stack was lifted and given
        // a slight cool cast (#0a0a0a → #121214, #262626 → #33333a) so that
        // borders read as borders on an OLED-black panel and text tiers have
        // room to separate above the 4.5:1 floor.
        //
        // Red carries two meanings and they are now different colours. `accent`
        // is the brand — navigation selection, section titles, primary buttons —
        // and only ever draws text or a hairline. `danger` only ever fills, with
        // white on top, and the standard allows one of them on screen at a time.
        redlog: {
          // Surfaces, recessed → raised.
          bg: '#121214', // window, sidebar, title bar, status bar
          surface: '#1a1a1d', // cards, panels
          elevated: '#212126', // inputs, chips, hover
          // Not in the standard's table: `elevated` is listed as serving both
          // the rest and hover state of a control, which leaves a chip that is
          // already `elevated` with no perceptible hover. One step up, used
          // only for that.
          'elevated-hover': '#2a2a30',
          // Hairlines.
          'border-subtle': '#26262c', // between rows
          border: '#33333a', // cards, dividers
          // Text, brightest → dimmest. `text-dim` is the floor for anything a
          // person reads (7.1:1 on `bg`); `muted` is placeholder and disabled.
          text: '#ececf0',
          'text-dim': '#9a9aa4',
          'text-faint': '#7a7a84',
          muted: '#6a6a74',
          // Brand red — text and hairlines only.
          accent: '#d75f63',
          'accent-dim': '#b84d51',
          // Danger red — solid fills only, white on top.
          danger: '#ff4d4f',
          'danger-hover': '#ff6a6c',
          cyan: '#3fc7d6',
          'cyan-dim': '#0e7490',
          // Every timeline lane. Hue is reserved for status, so eighteen lanes
          // share one neutral and separate by label and position instead.
          lane: '#6e6e78'
        }
      },
      boxShadow: {
        'glow-red': '0 0 12px 0 rgba(239, 68, 68, 0.15)',
        'glow-red-sm': '0 0 6px 0 rgba(239, 68, 68, 0.1)',
        'glow-cyan': '0 0 14px 0 rgba(34, 211, 238, 0.18)',
        'glow-cyan-sm': '0 0 6px 0 rgba(34, 211, 238, 0.25)',
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
