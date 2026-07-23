/// <reference types="vite/client" />

// Defined via vite.config.ts's `define` — the repo-root package.json version.
declare const __APP_VERSION__: string

// WGSL compute shader sources, imported as raw text via Vite's built-in
// `?raw` suffix (src/lib/ft/webgpu/*.wgsl) — not covered by vite/client's
// own module type declarations, which only cover `?raw` for a fixed set of
// asset extensions.
declare module '*.wgsl?raw' {
  const src: string
  export default src
}
