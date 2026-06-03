import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ePOD Capture',
        short_name: 'ePOD',
        description: 'Electronic Proof of Delivery — driver evidence capture',
        theme_color: '#0e1c38',
        background_color: '#0e1c38',
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
  server: { host: true },
})
