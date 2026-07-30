/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Defined via vite.config.ts's `define` — the repo-root package.json version.
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  // GA4 Measurement ID (G-XXXXXXXXXX) — set at build time, unset in dev/test
  // so no analytics ever loads locally. See src/lib/analytics.ts.
  readonly VITE_GA_MEASUREMENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
