# PSK Reporter relay Worker

Deployed at **https://pskreporter.signal-decoder.workers.dev**, which is the URL
hard-coded in `src/lib/ft/pskreporter/usePskReporter.ts`. The hostname is
`<worker name>.<your workers.dev subdomain>`, so the `name` in `wrangler.toml`
must stay `pskreporter` or the app will post to a URL that no longer exists.

## Why this exists

PSK Reporter ingests reception reports as IPFIX (RFC 7011) messages over **UDP**,
which a browser cannot send. A Cloudflare Worker cannot send UDP either —
`connect()` in `cloudflare:sockets` is TCP-only. What makes this work is that the
collector also accepts the same IPFIX messages over **TCP** on port 4739.

That was verified against the test listener on port 14739, which parsed a packet
from this app's encoder without warnings and echoed every field back at
<https://report.pskreporter.info/cgi-bin/psk-analysis.pl>.

## Deploy

```sh
npm install
npx wrangler login
npm run deploy
```

Then confirm Cloudflare's own network can reach the collector — this is the one
thing that cannot be checked from a workstation, because Cloudflare's egress is
not yours:

```sh
curl https://pskreporter.signal-decoder.workers.dev/health
```

`reachable:` means the relay works end to end. `unreachable:` means Cloudflare
blocks or cannot route the connection, and the Worker has to forward to a
UDP-capable host instead — at which point only `forward()` in `src/index.ts`
changes.

Useful while testing:

```sh
npm run check     # wrangler deploy --dry-run: builds without deploying
npm run tail      # live logs from the deployed Worker
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /report` | Body is the raw IPFIX message as `application/octet-stream`. Requires an allowlisted `Origin`. |
| `POST /report?test=1` | Same, but diverted to the collector's analysis listener so the packet never reaches the live map. Diagnostic; the app never sets it. |
| `GET /health` | TCP reachability probe against the collector. |
| `GET /analysis` | What the collector parsed from packets sent by this Worker. Diagnostic. |

### Testing the full path without inventing spots

The analysis page keys on the requesting IP, and a relayed packet arrives from
Cloudflare's address rather than yours — so opening it in a browser shows your
own packets, never the Worker's. `GET /analysis` fetches it from inside the
Worker, which is the only vantage point that can see them:

```sh
curl -X POST 'https://pskreporter.signal-decoder.workers.dev/report?test=1' \
  -H 'Origin: https://acesso.github.io' \
  -H 'content-type: application/octet-stream' \
  --data-binary @packet.bin
curl -s https://pskreporter.signal-decoder.workers.dev/analysis | sed -e 's/<[^>]*>//g'
```

In practice this comes back empty: the Worker's `fetch` was observed leaving from
an IPv6 address (`2a06:98c0:3600::103`) while the TCP socket leaves from a
different one, so the collector files the packet under an address this page will
never show. Treat an empty result as inconclusive, not as a failure — a `204`
from `/report` already means the socket opened and every byte was written.

There is no way around this from the outside: IPFIX has no acknowledgement, so
the only true confirmation is a real callsign appearing on the live map after a
decoding session.

## Who is allowed to use it

`ALLOWED_ORIGINS` in `src/index.ts` lists the pages that may post — the published
app on `https://acesso.github.io` plus the two localhost dev ports. Edit that list
if the site moves.

Requests are checked two ways, and it is worth being precise about what each one
buys:

- **`Origin`** is the load-bearing check. Browsers set it on every cross-origin
  POST and will not let page scripts override it, so another website cannot point
  its visitors at this relay.
- **`Referer`** is checked as a second gate, but only advisory: a referrer policy
  can strip it entirely, so its absence cannot be treated as failure. A present
  but foreign value is the only thing it can prove.

Neither is authentication — any HTTP client outside a browser sets both freely.
What actually stops this being abused is that it forwards to one hard-coded host
and port, and only if the body parses as a well-formed PSK Reporter message
(IPFIX v10, declared length matching the body, only PSK Reporter's four set ids,
a receiver record present, ≤1400 bytes). Arbitrary bytes cannot be relayed
through it, so it is not usable as a reflector.

A rate-limit binding caps each receiver callsign at 12 requests per 60 seconds.
That is a coarse abuse guard, sized to leave room for per-window uploads (an FT4
decoder sending as each window closes makes 8 requests a minute). The protocol's
real rule — each station reported at most once per five minutes — is enforced in
the browser, in `src/lib/ft/pskreporter/spotQueue.ts`.
