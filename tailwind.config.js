/** @type {import('tailwindcss').Config} */
// "Freight Modern" design tokens (2026-06-11 retheme, diverges from the §7
// brief at the user's request). Token NAMES are kept from the original system
// so every screen inherits the new look without edits:
//   navy  → graphite-black chrome + primary buttons (500 = ultramarine accent)
//   gold  → hi-vis amber signal (eyebrows, rollover, queued, underline)
//   paper → cool steel surface tint (sheets, table headers, inset zones)
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#0e1218', 600: '#1a2029', 500: '#2d5bff' },
        gold: { DEFAULT: '#f5a30b', soft: '#ffce6b' },
        paper: '#eff2f6',
        ink: '#101620',
        muted: '#5b6573',
        ok: '#0fa065',
        fail: '#e5484d',
        // Hairline borders throughout
        line: 'rgba(13,19,32,.11)',
      },
      fontFamily: {
        // Display face — DIN/road-signage DNA. Kept under the `serif` key so
        // every existing font-serif usage (titles, refs, buttons) inherits it.
        serif: ["'Barlow Condensed'", "'Arial Narrow'", 'sans-serif'],
        sans: ['Barlow', '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", 'sans-serif'],
        mono: ["'IBM Plex Mono'", 'ui-monospace', "'Courier New'", 'monospace'],
      },
      boxShadow: {
        // Layered ring shadow that reads as a device bezel (pod-demo)
        phone: '0 30px 60px -20px rgba(0,0,0,.6), 0 0 0 9px #05070b, 0 0 0 11px #2a3442',
        // Crisp card lift used across the new theme
        card: '0 1px 2px rgba(13,19,32,.05), 0 8px 24px -12px rgba(13,19,32,.18)',
      },
      borderRadius: {
        phone: '30px',
      },
    },
  },
  plugins: [],
}
