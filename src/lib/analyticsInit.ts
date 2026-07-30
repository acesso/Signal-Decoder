// GA4 bootstrap (gtag.js injection) — split out from analytics.ts because
// this file's `import.meta.env` reference makes it uncompilable under this
// project's Jest setup (@swc/jest has no ESM support — see jest.config.cjs;
// SWC's CJS output for `import.meta.env` throws "Cannot use 'import.meta'
// outside a module" at module load, not lazily, so any file merely
// *importing* this one would fail every test, even without calling
// initAnalytics()). qsoLog.ts, App.tsx, etc. import trackEvent from
// analytics.ts instead, which has no such reference. Only index.tsx (never
// imported by a test) imports initAnalytics from here.
import './analytics'

let initialized = false

export function initAnalytics(): void {
  const measurementId: string | undefined = import.meta.env.VITE_GA_MEASUREMENT_ID
  if (initialized || import.meta.env.DEV || !measurementId) return
  initialized = true

  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag(...args) { window.dataLayer!.push(args) }
  window.gtag('js', new Date())
  window.gtag('config', measurementId)

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`
  document.head.appendChild(script)
}
