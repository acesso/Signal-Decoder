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
  server: {
    port: 3000,
    strictPort: true,
    // Dev mode should never be cached by the browser — HMR already handles
    // live updates, but a stale disk/memory cache on a hard reload (or a
    // request that HMR didn't catch, e.g. a worker/wasm asset) can still
    // serve old bytes and make it look like an edit didn't take effect.
    headers: {
      'Cache-Control': 'no-store',
    },
  },
  // Force a fresh dependency pre-bundle on every dev server start instead of
  // reusing node_modules/.vite's cache — that cache is normally a nice speed
  // win across restarts, but during active development on this app's own
  // workers/wasm-loading code it has been a source of "I fixed it but it's
  // still broken" confusion. optimizeDeps.force only affects `vite`/`vite dev`;
  // `vite build` is unaffected.
  optimizeDeps: {
    force: true,
  },
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
      // Registered manually via virtual:pwa-register in src/index.tsx instead
      // of the plugin's auto-injected registerSW.js — that script only calls
      // navigator.serviceWorker.register() once on load with no update
      // detection, so an already-open tab could sit on a stale cached bundle
      // indefinitely even after a new version deployed. The manual register
      // call gets an onNeedRefresh callback so the UI can prompt instead.
      injectRegister: false,
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
