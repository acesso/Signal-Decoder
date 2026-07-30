// Google Analytics 4 event tracking (trackEvent) — this file has no
// `import.meta.env` reference so components can safely import it (see
// analyticsInit.ts for why that split exists and matters under Jest).

type GtagArgs = [command: 'js' | 'config' | 'event', ...rest: unknown[]]

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: GtagArgs) => void
  }
}

/** Fires a GA4 custom event. Safe to call unconditionally — no-ops if
 *  analytics was never initialized (dev builds, no measurement ID set). */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  window.gtag?.('event', name, params)
}
