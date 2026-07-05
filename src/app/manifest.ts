import type { MetadataRoute } from 'next';

// GitHub Pages serves this app from a repo subpath (e.g. /Signal-Decoder/),
// not domain root. A static public/manifest.json can't read env vars, so its
// root-relative icon/start_url paths would 404 there — this dynamic route
// (pre-rendered to a static manifest.webmanifest at build time, same as
// public/manifest.json would be) bakes in the same BASE_PATH next.config.js
// uses for basePath/assetPrefix.
const BASE_PATH = process.env.BASE_PATH || '';

// Required for a dynamic metadata route under output: 'export' — otherwise
// `next build` refuses to pre-render it to a static file.
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SSTV Decoder - Real-time Slow Scan Television Decoder',
    short_name: 'SSTV Decoder',
    description: 'Decode amateur radio SSTV signals in real-time from your microphone. Supports Robot36 mode with professional DSP processing.',
    start_url: `${BASE_PATH}/`,
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#238636',
    orientation: 'any',
    icons: [
      {
        src: `${BASE_PATH}/icon-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${BASE_PATH}/icon-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
    categories: ['utilities', 'education', 'radio'],
    screenshots: [
      {
        src: `${BASE_PATH}/og-image.png`,
        sizes: '1200x630',
        type: 'image/png',
        label: 'SSTV Decoder Interface',
      },
    ],
  };
}
