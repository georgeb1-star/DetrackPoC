import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// `npm run dev:https` (--mode https): self-signed HTTPS so phones on the LAN
// get a secure context — required for real geolocation. Expect a one-time
// certificate warning on the phone; the dev service worker won't register
// over an untrusted cert (offline testing stays on localhost / preview).
export default defineConfig(({ mode }) => ({
  plugins: [
    ...(mode === 'https' ? [basicSsl()] : []),
    react(),
    VitePWA({
      // 'prompt': new builds surface a "tap to refresh" toast instead of the
      // service worker silently serving the old version one more time
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ePOD Capture',
        short_name: 'ePOD',
        description: 'Electronic Proof of Delivery — driver evidence capture',
        theme_color: '#0e1218',
        background_color: '#0e1218',
        display: 'standalone',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: 'index.html',
        // Supabase calls must never be swallowed by the SW cache — the Dexie
        // queue is the offline mechanism, not HTTP caching.
        navigateFallbackDenylist: [/^\/rest/, /^\/storage/],
      },
      // Enables the service worker during `npm run dev` so offline behaviour
      // can be exercised without a production build (best-effort; the
      // bulletproof offline demo is `npm run build && npm run preview`).
      devOptions: { enabled: true },
    }),
  ],
  server: {
    host: true,
    // Same-origin proxy to the local Supabase stack: a phone on the LAN
    // can't reach the laptop's 127.0.0.1 (and an HTTPS page would block the
    // plain-HTTP call as mixed content) — but it *can* call its own origin,
    // which the dev server forwards here on the laptop. Paired with the
    // loopback rewrite in src/lib/supabase.ts.
    proxy: {
      '/rest': 'http://127.0.0.1:54321',
      '/auth': 'http://127.0.0.1:54321',
      '/storage': 'http://127.0.0.1:54321',
      '/realtime': { target: 'ws://127.0.0.1:54321', ws: true },
    },
  },
}))
