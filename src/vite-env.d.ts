/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Defined via vite.config.ts's `define` — the repo-root package.json version.
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  // GA4 Measurement ID (G-XXXXXXXXXX) — set at build time, unset in dev/test
  // so no analytics ever loads locally. See src/lib/analytics.ts.
  readonly VITE_GA_MEASUREMENT_ID?: string
  // CARTO basemap API key — set at build time from the CARTO_API_KEY repo
  // secret (see .github/workflows/deploy.yml). Unset in dev and in forks,
  // where the map falls back to watermarked tiles. See FTLeafletMap.tsx's
  // cartoTileUrl() for why this is NOT a secret once published.
  readonly VITE_CARTO_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
