import type { Metadata, Viewport } from "next";
import "./globals.css";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";

// GitHub Pages serves this app from a repo subpath (e.g. /Signal-Decoder/),
// not domain root — every root-relative asset URL below must carry this
// prefix or it 404s against the domain root instead. Empty string locally/
// on Vercel, where the app IS served from root. Same env var next.config.js
// uses for basePath/assetPrefix, set by the GitHub Actions workflow.
const BASE_PATH = process.env.BASE_PATH || "";

export const metadata: Metadata = {
  metadataBase: new URL(`https://acesso.github.io${BASE_PATH}/`),
  title: {
    default: "Signal Decoder",
    template: "%s | Signal Decoder",
  },
  description: "Free web-based signal decoder for amateur radio. Decode RTTY (Baudot), CW (Morse code), and SSTV signals in real-time from your microphone. Works offline as a PWA.",
  keywords: [
    "SSTV",
    "Slow Scan Television",
    "Robot36",
    "Amateur Radio",
    "Ham Radio",
    "ISS",
    "ISS SSTV",
    "Signal Decoder",
    "Web Audio",
    "Radio Decoder",
    "FM Demodulation",
    "Digital Signal Processing",
    "DSP",
    "Robot 36",
    "SSTV Software",
    "Online SSTV Decoder",
    "Free SSTV Decoder",
    "Browser SSTV",
    "Web SSTV",
    "SSTV Online",
    "Radio Imaging",
    "Satellite Images",
    "Space Station SSTV"
  ],
  authors: [{ name: "smolgroot", url: "https://github.com/smolgroot" }],
  creator: "smolgroot",
  publisher: "smolgroot",
  category: "Technology",
  classification: "Radio Communications Software",
  openGraph: {
    title: "Signal Decoder",
    description: "Free web-based signal decoder for amateur radio. Decode RTTY, CW, and SSTV signals in real-time from your microphone.",
    url: `https://acesso.github.io${BASE_PATH}/`,
    siteName: "Signal Decoder",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "SSTV Decoder Interface - Real-time Radio Signal Decoding",
      },
    ],
    locale: "en_US",
    type: "website",
    countryName: "United States",
  },
  alternates: {
    canonical: `https://acesso.github.io${BASE_PATH}/`,
  },
  twitter: {
    card: "summary_large_image",
    site: "@smolgroot",
    creator: "@smolgroot",
    title: "Signal Decoder",
    description: "Free web-based signal decoder for amateur radio. Decode RTTY, CW, and SSTV signals in real-time from your microphone.",
    images: {
      url: "/og-image.png",
      alt: "SSTV Decoder Interface",
    },
  },
  verification: {
    google: "google-site-verification-token", // Replace with actual token when you verify
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  // No `icon` key here — src/app/icon.svg already covers it via Next's file
  // convention, which resolves against basePath correctly on its own. An
  // explicit override with a root-relative string here would take precedence
  // over that and 404 under GitHub Pages' subpath (this used to be the bug).
  icons: {
    apple: `${BASE_PATH}/icon.svg`,
  },
  // No `manifest` field here — Next auto-detects src/app/manifest.ts and
  // injects its own <link rel="manifest"> tag from it, and that auto-injected
  // link WINS over this field regardless of what it's set to. Under
  // output:'export' that auto-injected link is also NOT basePath-prefixed (a
  // Next.js static-export limitation), so the correct href is rendered
  // manually via <link> in the JSX below instead.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Signal Decoder",
    startupImage: `${BASE_PATH}/icon-512.png`,
  },
  applicationName: "Signal Decoder",
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  other: {
    "msapplication-TileColor": "#238636",
    "msapplication-config": `${BASE_PATH}/browserconfig.xml`,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#238636",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Next's auto-injected manifest <link> (from src/app/manifest.ts)
            isn't basePath-prefixed under output:'export' — render the
            correct one explicitly; it comes first in the head so it wins
            (browsers use the first valid rel="manifest" link in tree order).
            src/app/icon.svg similarly doesn't get an auto <link rel="icon">
            emitted at all under this build config, so render that one
            manually too — without it browsers fall back to guessing
            /favicon.ico and /icon.svg at the DOMAIN ROOT, which 404s under
            GitHub Pages' subpath (the bug this is fixing). */}
        <link rel="manifest" href={`${BASE_PATH}/manifest.webmanifest`} />
        <link rel="icon" href={`${BASE_PATH}/icon.svg`} type="image/svg+xml" />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        {children}
        <PWAInstallPrompt />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator && process.env.NODE_ENV !== 'development') {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register(BASE_PATH + '/sw.js', { scope: BASE_PATH + '/' }).then(
                    function(registration) {
                      console.log('SW registered:', registration);
                    },
                    function(err) {
                      console.log('SW registration failed:', err);
                    }
                  );
                });
              }
            `
              .replace('process.env.NODE_ENV', JSON.stringify(process.env.NODE_ENV || 'production'))
              .replace(/BASE_PATH/g, JSON.stringify(BASE_PATH))
          }}
        />
      </body>
    </html>
  );
}
