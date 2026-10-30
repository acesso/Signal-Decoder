# LCD client views (views drawn by the web app), plan

**Status:** step 1 (the bridge side) written on branch `feat/lcd-client-views` (2026-10-29): builds for both boards, slot logic and drawing checked in the host harness, and run on the bridge (WebSocket and HTTP clients, show, fallback when the client leaves, expiry). Step 2 (the web app's copy of the drawing, `src/lib/lcd/gfx.ts`) done: its tests check it pixel for pixel against `lcd_gfx.c`. Step 3 (the feed and the box picker) written, unit-tested and run in a browser against the bridge. Step 4 done, reshaped by the user (below): the QSO view is for unattended operation, with a "QSO n!" overlay, plus overlays and events on the bridge (2026-10-29). Step 5 (the map) done and compared on the glass with the map box picked and rasterized: the vector map reads far better (the dark tiles come out as a filled ocean with no detail). Step 6 (the app's stale `/backlight`, `/contrast` calls removed) and step 7 (docs: app README "Bridge status LCD", firmware README, CHANGELOG) done. All steps done. Then (user, 2026-10-29): views made for the LCD are marked on their boxes (`data-lcd-view`) and highlighted in the picker; the QSO view moved to contact cards (one per station), the transmit panel keeps the session totals. Builds on the status LCD (`doc/plans/s3-status-lcd/PLAN.md`, bridge 0.13.0). S3 bridge only.

**Decided (user, 2026-10-29):**
- **The client draws.** A web app (or any other tool) sends the picture; the bridge stores and shows it. The bridge has no knowledge of FT8 or of any other client view.
- **The FT8 view is about QSOs, not the decode list.**
- **A second FT8 view shows the map,** following the web app's map zoom and position.
- **The way a panel becomes an LCD view is generic,** so any box of any web-app panel can be attached to the LCD.
- **The QSO view is for unattended operation** (auto-CQ, auto-reply): this session's completed QSOs and a "QSO n!" overlay when one completes, not the exchange step by step.
- **Overlays like the upload one:** the QSO announcement pops up over any view. Clients get an events API (text drawn by the bridge, icons from a library stored with the control page, or their own small static icon).
- **No LCD tags on panels: the user picks any box,** like a browser's screenshot tool that outlines the element under the mouse (decided after a first version with an "LCD" chip per panel).

**Goal:** the LCD's view list grows with views that clients provide, next to the six built-in ones. The first users are two FT8 views in the web app. Other tools can use the same API.

## Bridge side

### What stays the bridge's job
- The rounded title bar with the view's title, and the page dots (client views count).
- The slide between views, the overlays (PA emergency, Wi-Fi setup, upload, Last TX) and the splash.
- Choosing what is on the glass: the page's view buttons, auto-cycle, and the rules below.

The client draws only the body: **84 × 40 pixels** under the title bar, 420 bytes in the controller's layout (5 banks of 84 columns, bit 0 at the top). That is the same layout as banks 1–5 of `GET /display/frame`.

### API

**`/display-ws` (WebSocket), both directions:**
- **Client → bridge, text:** `{"register":"ft8-qso","title":"FT8 QSO","focus_on_tx":true}`. The bridge answers `{"slot":0}`, or `{"error":"full"}`. One socket may register several views.
- **Client → bridge, binary:** `[slot][420 bytes]`, whenever the picture changes, at most 5 per second (the glass refreshes at 5 Hz).
- **Client → bridge, text:** `{"show":"ft8-qso"}` asks the bridge to show a view now, as the page's buttons do.
- **Bridge → client, binary:** the whole frame on the glass (504 bytes) each time it changes.
- **Bridge → client, text:** `{"showing":"ft8-qso"}` when the view changes.
- The control page's preview moves to this socket instead of polling `GET /display/frame` every 250 ms.

**`POST /display/client?id=…&title=…`** with a 420-byte body: the same thing for a tool without WebSocket. Each POST refreshes the view.

**`GET /display`** lists client views with `"source":"client"` next to the built-in ones. `POST /display {"view":"ft8-qso"}` works for them too.

### Rules
- **Slots:** 4 client views. A fifth registration is refused.
- **Expiry:** a view with no frame for 10 s leaves the list and the cycle. If it is on the glass, the bridge goes back to the built-in view shown before. A closed browser tab never leaves a frozen screen. The socket closing removes its views at once.
- **`focus_on_tx`:** while the radio transmits (PTT seen over CAT), the bridge shows that view, then returns to the previous one at key-up. The "Last TX" overlay still follows.
- **Saved setting:** a client view chosen as the saved view falls back to `radio` at boot, since no client is connected then.

### Cost

| Item | Cost |
|---|---|
| View slots | 4 × 420 bytes, PSRAM |
| Internal RAM | none worth counting |
| HTTP handlers | +2 (`/display-ws`, `/display/client`), 65 of 72 |
| WebSocket clients | 4, through `ws_fanout` (a slow client skips frames); open sockets 24 of lwIP's 32 |
| Traffic | about 2 KB/s per client each way |
| CPU | one copy per frame |

## Web app side

### Drawing: `src/lib/lcd/`
- **`gfx.ts`:** a port of `lcd_gfx.c`, so client views look like the built-in ones: the tiny, small and big fonts, the icons with their frames, `round_rect`, `fill_round`, `dither`. It draws into the same byte layout.
- **Checking the port:** render the same text, icons and boxes with both. The C side uses the host harness from the status-LCD work (C → PNG). The two must match pixel for pixel.

### The generic method: an LCD source
Any panel can offer an LCD view by giving a source:

```ts
interface LcdSource {
  id: string;           // "ft8-qso"
  title: string;        // shown in the bridge's title bar
  fps?: number;         // 1..5, default 2; frames are sent only when the picture changed
  focusOnTx?: boolean;
  render(g: Gfx, tick: number): void;  // draws the 84 x 40 body
}
```

- **The feed** (`src/lib/lcd/feed.ts`, no framework): one `/display-ws` socket per bridge, opened only when the bridge reports `display_client_views`. It registers the sources, draws each at its rate, and sends a picture when the bytes changed, and every 4 s anyway (under the bridge's 10 s expiry).
- **Picking a box** (`src/components/lcd/LcdFeed.tsx`): an "LCD" button in the app's header, shown only with such a bridge, lists the views on the LCD (rename, remove, show now) and starts the picker:
  - the box under the mouse is outlined, with its title and size;
  - ↑ widens to the parent box, ↓ narrows back; a click (or Enter) picks, Esc cancels;
  - the pick is saved as a CSS selector (a path from the nearest id) with a title (the box's heading, or one just before it), and comes back after a reload;
  - up to 4 picks, the bridge's client slots.
- **How a picked box is drawn** (`src/lib/lcd/elementSource.ts`), best first:
  1. **a drawing the panel registered** for itself or an ancestor (`registerLcdDrawing(el, draw)`): the FT8 QSO and map views below. Nothing shows on the page; picking anything inside such a panel gets its drawing;
  2. **a canvas filling most of the box** (60 %+): mirrored from the canvas at the view's rate, dithered. Fits the waterfall (`GLSpectrogram` keeps its drawing buffer), the SSTV picture, any 2D canvas. `GLSpectrum` does not keep its buffer, so it reads blank;
  3. **anything else:** rasterized with `html-to-image` (an SVG `foreignObject` redraw) about once a second, in the background, and cut at a threshold (crisper text than a dither). Text shrunk to 84 pixels is barely readable: panels of text are what registered drawings are for.
  
  Pictures keep their shape (scaled to fit, centred). Brightness is a pixel's strongest channel (the waterfall's dark blues carry the signal in blue), stretched from the picture's noise floor to its peaks.

### FT8 QSO view (picked from the FT transmit panel)

Made for leaving the station on auto-CQ and auto-reply (`src/lib/lcd/views/ftQso.ts`):

```
 ↓ CALLING CQ        13S    what the station does now (or "LU1ABC RPT", "LISTENING", "TX OFF"), slot seconds left
 12  QSOS SINCE 1130        this session (since the page opened, UTC): completed QSOs, big
     7 COUNTRIES
 LU1ABC   -14 -08   1158    the last two: call, report sent and received, UTC
 K1XX     -10 -12   1151
```

- **Completed QSO:** reports exchanged both ways (`QSORecord.confirmed` in the QSO log).
- **"QSO n!" overlay:** each new completed QSO (`QsoAnnouncer`) plays for 12 s over whatever the LCD shows (`LcdFeed.overlay()`, the bridge's client overlay), whenever a bridge with an LCD is connected, picked view or not: twinkling stars, the call, grid and country, reports.
- **Who I'm working:** `currentQso()` in `src/lib/ft/conversation.ts`, built on the same helpers as the auto-reply (`messagesToMe`, `latestMessage`, `sentTo`).
- **No focus on TX by default:** with auto-CQ the radio keys every other slot, so the view would flip back and forth. The per-view TX toggle in the LCD menu turns it on.

### Bridge overlays and events

- **Client overlay:** `/display-ws` BINARY `[255][420 bytes]` lays a client's picture over any view inside the bridge's overlay panel, while frames come and 1.5 s after.
- **Events:** `POST /display/event` (or `{"event":…}` on the socket): a title, up to 3 lines, an icon each side, 1–60 s, queued 4 deep, drawn by the bridge. Icons: the 14 built-in ones, the animated library `spiffs_data/lcd_icons.txt` (21 icons, read at boot and after a page upload, `GET /display/icons`), or the client's own static `icon_rows`.

### FT8 map view (`ft8-map`)
- **Follows the app's map:** the Leaflet map's bounds, read on `moveend` / `zoomend` (`FTLeafletMap.tsx`). Panning or zooming in the app moves the LCD map too.
- **Drawn as vectors, not tiles:** map tiles shrunk to 84 × 40 one-bit become noise. Instead:
  - coastlines from a small bundled outline (Natural Earth 110 m, simplified), in the same Web Mercator projection;
  - my station as a cross;
  - heard stations as dots;
  - the QSO partner as a blinking ring, with a line from my station.
- **Generic:** the map panel registers this drawing for its element (`registerLcdDrawing`), so picking the map, or anything in it, gets the vector map.

## Order of work
1. **Bridge:**
   - client slots, `/display-ws` and `POST /display/client`;
   - expiry, `focus_on_tx`, the views in `GET /display`;
   - the page's buttons for client views, and its preview on the socket.
   
   Tested with a small script that pushes a test pattern.
2. **App drawing:** `gfx.ts`, checked pixel for pixel against the C.
3. **App feed:** the feed, the box picker, `elementSource` (canvas mirror, rasterized boxes, registered drawings).
4. **FT8 QSO view:** `currentQso()` with tests, the view, the "QSO n!" overlay; bridge overlays and events. Done.
5. **FT8 map view:** the coastline data, the map drawing, registered on the map panel. Done.
6. **Clean-up:** remove the app's stale `setBridgeBacklight` (`POST /backlight`) and `setBridgeContrast` (`POST /contrast`). Neither endpoint exists in the bridge firmware. Done.
7. **Docs:** the API in the firmware README, for other tools. Done.

## Open points
- **Coastline data size:** Natural Earth 110 m is a few hundred KB as GeoJSON. Simplified and packed for 84 × 40 it should be well under 50 KB. To check.
- **More than one browser:** two app tabs both registering "ft8-qso" each take a slot. Either the bridge replaces a view of the same id, or the app registers only from one tab. Proposed: same id replaces.
