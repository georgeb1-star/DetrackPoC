/** @type {import('tailwindcss').Config} */
// Design tokens from §7 of the brief — matches design-reference.html exactly.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#0e1c38', 600: '#16294d', 500: '#1f3a66' },
        gold: { DEFAULT: '#c9a227', soft: '#e3c766' },
        paper: '#f6f4ee',
        ink: '#10192e',
        muted: '#6b7589',
        ok: '#2f8f5b',
        fail: '#c0492f',
        // Hairline borders throughout the reference design
        line: 'rgba(14,28,56,.12)',
      },
      fontFamily: {
        serif: ['Georgia', "'Times New Roman'", 'serif'],
        mono: ["'SF Mono'", 'ui-monospace', "'Courier New'", 'monospace'],
      },
      boxShadow: {
        // Layered ring shadow that reads as a device bezel (§7)
        phone: '0 30px 60px -20px rgba(0,0,0,.6), 0 0 0 9px #060b18, 0 0 0 11px #223256',
      },
      borderRadius: {
        phone: '30px',
      },
    },
  },
  plugins: [],
}
