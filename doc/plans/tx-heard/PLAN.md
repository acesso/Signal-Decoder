# Plan: "was my TX heard?" on the Sent Log (PSK Reporter)

Status: implemented in 0.30.0 (2026-11-03); the follow-up section below covers what was added after the review.

## Goal

Each row of the FT8/FT4 Sent Log shows whether PSK Reporter has reports of
that transmission, even when nobody answered:

- 📡 heard: at least one station reported it.
- 🎯 heard by the station I called: the callee of that message is among the receivers
  (my call reached them; they just didn't answer, or I missed it).

No counters on the row. Hovering shows who heard it: the farthest few, their SNR,
country and distance. A row stays free of marks until there is something to show.

## Where the data comes from

`https://retrieve.pskreporter.info/query?senderCallsign=<my call>&rronly=1&flowStartSeconds=-N`
returns up to 100 reception records (XML): receiverCallsign, receiverLocator,
frequency, flowStartSeconds, mode, sNR, receiverDXCC.

Checked on 2026-10-30:
- the response has no `Access-Control-Allow-Origin`, so a browser page cannot fetch it;
- it sets `cache-control: public,max-age=90`.

PSK Reporter's rules (pskreporter.info/pskdev.html):
- "retrieve reception data no more often than once every five minutes";
- query five minutes after a transmission, so the receivers have reported;
- heavy users may be blocked.

### Transport: a GET on our existing Cloudflare Worker (recommended)

`proxy/pskreporter-worker` already relays our spot uploads, with an origin allow-list.
Add `GET /heard?call=<call>`:

- **Validates the input:** `call` must look like a callsign; only our origins are allowed.
- **Fetches upstream** with `rronly=1`, `flowStartSeconds=-3600`, gzip, and a fixed
  User-Agent naming the app.
- **Answers small JSON:** `[{rx, grid, hz, t, snr, dxcc, mode}]`.
- **Edge cache, 5 minutes per callsign:**
  - every tab, browser and user asking about the same call within 5 minutes shares one
    upstream query;
  - PSK Reporter sees at most one query per callsign per 5 minutes from us, whatever
    the app does.
- **Back-off:** on an upstream 429 or 503, the Worker holds back for 15 minutes and
  serves the stale copy.

Rejected alternatives:
- JSONP (`callback=`): it runs PSK Reporter's script inside our page.
- A generic CORS proxy: an open door.

This needs a Worker deploy, which is yours to do (wrangler). In dev, a Vite proxy
route serves the same `/heard` for local testing.

## When the app asks (client side)

The point is not to load the API and not to block the panel.

- **Only when useful:**
  - a callsign is set;
  - the FT transmit panel is mounted;
  - the tab is visible;
  - at least one Sent Log row is "open": transmitted 2 to 30 minutes ago and not an error row.

  With nothing open, no requests at all.
- **At most one request every 5 minutes**, shared by all tabs. The time of the last
  request sits in localStorage, and a BroadcastChannel passes results to the other tabs.
- **Waits about 2 minutes** after the oldest open TX before the first request. Its
  windows are then still covered by later requests until they are 30 minutes old, after
  which the row is settled and never asked about again.
- **Back-off on errors:** 5 → 10 → 20 → 60 minutes; reset after a success.
  Timeout 10 s (AbortController).
- **Never on the main path of anything:**
  - a plain async fetch;
  - the JSON is small (at most 100 records);
  - matching is at most 50 rows × 100 records, microseconds;
  - results go into a signal, so a slow or failed request changes nothing else on screen.

## Matching reports to rows

A report has no message text, only time, frequency and mode. A report belongs to a row when:
- `mode` matches the row's mode (FT8 or FT4);
- `t` falls inside one of the row's TX windows `[start − 3 s, start + slot + 3 s]`. Receivers do not agree on what they report: for one TX seen live, one gave the window start, one its decode time (+12 s), one the next boundary (+15 s);
- `hz` is within ±150 Hz of the row's `vfoHz + audioHz`. Receivers disagree by tens of Hz;
  in the sample, two receivers differed by 67 Hz on the same TX.

One change to the Sent Log is needed. A repeated identical message (an auto-CQ) refreshes
its row in place and keeps only the latest `windowStart`, so earlier windows of that row
are lost. `SentEntry` gets `windows: number[]`, the start times of every TX the row stands
for, capped at 20 and trimmed to 30 minutes. That is what makes "no counters for repeated
events" work: one 📡 for the row, whichever of its repeats was heard.

## UI

- 📡 / 🎯 right after the message text: one mark, 🎯 when it applies, else 📡.
- Tooltip: "Heard by 7 stations · farthest: K3FHP EL97 (United States) 7 870 km, −16 dB",
  then up to 5 lines, farthest first.
- A small line under the Sent Log header while checks are paused or failing:
  "PSK Reporter: next check 12:40" or "PSK Reporter unreachable, retry 12:55". Dim, no alerts.
- A toggle in the existing PSK Reporter panel: "Check whether my transmissions were heard".
  Default on? (to decide). It sends only my callsign, which the app already reports.

## Code layout

- `src/lib/ft/pskreporter/heard.ts`: matching (pure; tests).
- `src/lib/ft/pskreporter/heardSchedule.ts`: when to ask, back-off and shared timestamp
  (pure; fake-timer tests).
- `src/lib/ft/pskreporter/useHeard.ts`: wiring (fetch, BroadcastChannel, signal).
- `useFTTransmit.ts`: `windows` on SentEntry.
- `FTTransmitPanel.tsx`: the mark and its tooltip.
- `proxy/pskreporter-worker/src`: `GET /heard`, XML to JSON, edge cache, back-off; worker tests.

## Decisions (review of 2026-10-30)

1. **Transport:** the Worker route, `GET /heard`.
2. **Toggle:** default on. It lives in the PSK Reporter panel's settings, next to "Report my decodes".
3. **`appcontact`:** a project contact address, set as the Worker variable `APP_CONTACT` at deploy.
   It is not hard-coded and never the operator's address. Left empty, it is not sent.
4. **Marks and counters:** 📡 / 🎯, with counters (this replaces "no counters" above). The chip shows:
   - the total: distinct stations that heard the row, over all its repeats;
   - the top countries as flags, each with its count, e.g. `📡 7 🇺🇸3 🇺🇾2 🇧🇷2 +1`.

   Hovering expands it into the full country list with counts, and under each country its
   stations with SNR and distance. The counts are distinct receiving stations, not reports:
   one station that heard five repeats of a CQ counts once.

## Earlier open questions


1. Is the Worker route OK, given that it needs a deploy, or should it be browser-only? There is
   no browser-only way without JSONP.
2. Should the toggle default to on or off?
3. The app's contact for `appcontact=`, which PSK Reporter asks frequent users to send:
   a project address of yours, or leave it out? (Not your personal email unless you say so.)
4. Marks: 📡 and 🎯 good, or other emoji?
5. Should the bridge LCD session view show a 📡-style count of "heard" TX? (Later, not now.)

## Follow-up (2026-10-30): what PSK Reporter reports, and answers I missed

Seen live: only CQ rows got a chip. That is how reporting works, not a matching bug.
- Receivers (WSJT-X and others) report standard messages carrying the sender's call and grid:
  my CQ and my `CALL PU7FTW HI22` replies. Reports and RR73 carry no grid, so they are never reported.
- PSK Reporter drops a repeat of the same sender from the same receiver on a band for about
  20 minutes, and its query returns the latest report per receiver. A receiver reports my first
  TX it decodes, usually the CQ, and my next TX to it are dropped.

Added on top:
1. **"📡 recently":** a dimmed chip on a row nobody reported, counting the stations that reported
   me in the 20 minutes before it (`recentSummary`). Labelled as an inference.
2. **🎯 on the contact card:** that station's own receiver reported hearing me, even if I never
   decoded its answer (`heardYouBy`). It uses the data already fetched.
3. **📻? on the contact card:** others heard that station in my reply slot, the window right after
   I called it, while my decoder heard nothing from it (`replySlotEvidence`). This needs one lookup
   of that station as the sender, so it is kept cheap:
   - only stations I addressed in 2+ TX within 10 minutes without decoding them since;
   - at most 3 per check;
   - only right after a successful check of my own call (so at most every 5 minutes);
   - skipped when that station was looked up less than 5 minutes ago;
   - the Worker's per-callsign cache shares each lookup with everyone.

   A report has no text, so this says "probably an answer", never more.
