import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

// Same GitHub Pages subpath pattern as the Next.js app (next.config.js) and
// the earlier SvelteKit prototype: CI sets BASE_PATH from
// actions/configure-pages@v5's base_path output.
const BASE_PATH = process.env.BASE_PATH || ''

export default defineConfig({
  base: BASE_PATH ? `${BASE_PATH}/` : '/',
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      // The DSP/decoder core (RTTY/CW/SSTV/FT/MFSK, audio, storage, CAT
      // protocol) has zero React/Next dependencies — shared verbatim from
      // the (soon to be replaced) Next.js app's src/lib/ rather than
      // duplicated here, same approach as the SvelteKit prototype's
      // $decoder-lib alias.
      '$decoder-lib': fileURLToPath(new URL('../src/lib', import.meta.url)),
    },
  },
})
