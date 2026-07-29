/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{tsx,ts,html}'],
  theme: {
    extend: {
      colors: {
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
