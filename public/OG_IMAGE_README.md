# OG Image

`/public/og-image.png` (1200x630px) is the Open Graph / Twitter Card image used for
social media link previews (Twitter, Facebook, LinkedIn, Discord, Slack, etc.),
referenced from `index.html`'s `og:image`/`twitter:image` tags.

It's a real screenshot of the app (RTTY mode) with a "Signal Decoder" title card
and mode-pill overlay composited on top — not a generic placeholder.

To regenerate after a UI redesign: take a fresh screenshot of the app (any mode
that looks clean/representative works — RTTY and FT8 are good candidates), then
composite a title/tagline/mode-list overlay at exactly 1200x630px. Keep the
project name and mode list ("RTTY · CW · SSTV · FT8/FT4 · MFSK") accurate to
whatever the app currently supports.
