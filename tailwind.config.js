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
          accent: '#ef4444',
          'accent-dim': '#dc2626',
          muted: '#71717a',
          text: '#e5e5e5',
          'text-dim': '#a1a1aa'
        }
      },
      boxShadow: {
        'glow-red': '0 0 12px 0 rgba(239, 68, 68, 0.15)',
        'glow-red-sm': '0 0 6px 0 rgba(239, 68, 68, 0.1)',
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.4)',
        'card-hover': '0 4px 12px 0 rgba(0, 0, 0, 0.5)'
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
