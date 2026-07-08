/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{tsx,ts,html}'],
  theme: {
    extend: {
      colors: {
        redlog: {
          bg: '#0a0a0a',
          surface: '#171717',
          border: '#262626',
          accent: '#ef4444'
        }
      }
    }
  },
  plugins: []
}
