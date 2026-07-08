import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Same GitHub Pages subpath pattern as the Next.js app (next.config.js) and
// the earlier SvelteKit prototype: CI sets BASE_PATH from
// actions/configure-pages@v5's base_path output.
const BASE_PATH = process.env.BASE_PATH || ''

// App version shown in the footer — sourced from the repo-root package.json
// (the canonical version, same one CI releases from).
const APP_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')).version

export default defineConfig({
  base: BASE_PATH ? `${BASE_PATH}/` : '/',
  plugins: [
    solid(),
    tailwindcss(),
    // Same offline-first PWA behavior as the Next.js app's next-pwa config:
    // cache-first for the app shell/static assets/images, with a 30-day
    // expiry. Workbox generates and registers sw.js at build time; disabled
    // entirely in dev (devOptions.enabled: false) so HMR isn't shadowed by a
    // stale cached response — the exact bug class next-pwa's own
    // `disable: NODE_ENV === 'development'` avoids.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'og-image.png'],
      manifest: {
        name: 'Signal Decoder',
        short_name: 'Signal Decoder',
        description: 'Free web-based signal decoder for amateur radio. Decode RTTY, CW, SSTV, MFSK, and FT8/FT4 signals in real-time from your microphone.',
        start_url: BASE_PATH ? `${BASE_PATH}/` : '/',
        scope: BASE_PATH ? `${BASE_PATH}/` : '/',
        display: 'standalone',
        background_color: '#0d1117',
        theme_color: '#238636',
        orientation: 'any',
        categories: ['utilities', 'education', 'radio'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // Precache the app shell + WASM decoder assets (~850 KB total —
        // small enough to bundle in, unlike e.g. a media library).
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      // The DSP/decoder core (RTTY/CW/SSTV/FT/MFSK, audio, storage, CAT
      // protocol) has zero framework dependencies — lives at src/lib/,
      // a sibling of this app's own src/ tree, same approach as the
      // SvelteKit prototype's $decoder-lib alias.
      '$decoder-lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
})
