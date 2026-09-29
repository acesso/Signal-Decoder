# Staged bridge-slot TX for RTTY (and later SSTV)

**Status: implemented** (RTTY). Written and built 2026-09-26.

SSTV still uses the speaker sink only — the staging model is mode-agnostic
and waits on an `encode` callback supplying its image encoder.

What shipped beyond this design:

- `POST /tx-stop` is now called from the browser. The firmware plays from
  its own PSRAM, so a browser-side stop was previously only half a stop:
  PTT dropped while the device kept transmitting to the end of the buffer.
- Staging is not blocked during a transmission. Queueing the next message
  while the current one plays is much of why a slot pool exists, so
  per-slot progress drives the UI rather than the shared TX phase.
- The FT panel's Requeue is disabled for another mode's slot (it re-encodes
  the stored text as an FT message). Clearing stays allowed from either
  panel, since the pool is shared.

## The problem

RTTY cannot transmit through the ESP32 bridge at all today. Only FT8/FT4
has bridge support; RTTY and SSTV connect straight to
`audioCtx.destination`, so in I/Q mode they play out of the computer's
speakers rather than reaching the radio.

## What exists to build on

FT8's bridge path already does the whole job — encode, upload to one of the
firmware's four TX slots, trigger playback, poll until done:

| helper | where it lives now |
|---|---|
| `bridgeHttpUrl` | private in `useFTTransmit.ts` |
| `toBridgeWireFormat` | private in `useFTTransmit.ts` |
| `uploadToBridgeSlot` | private in `useFTTransmit.ts` |
| `playBridgeSlotAndWait` | exported from `useFTTransmit.ts` |

Only the last is exported, so the first step is extraction rather than new
logic. That is also what makes this reusable for SSTV later: the helpers
have nothing FT-specific in them beyond where they sit.

## The constraint that shapes the design

RTTY has two transmit modes and they are **not** equally portable:

- **`encodeAndTransmit(text)`** — encodes the whole message, then plays it.
  Maps onto slots almost exactly as FT8 does.
- **`startLive()` / `sendLiveChar()`** — real-time keying, one character
  encoded and played as it is typed, PTT held across the over.

Live keying **cannot** work through slots. A slot is a complete buffer
uploaded before playback begins; live typing has no complete buffer. Each
character would need its own upload + `/tx-play` round-trip over WiFi —
hundreds of milliseconds against a 165ms character period at 45.45 baud.

So bridge mode loses live keying. That is a real capability reduction, and
the UI must say so rather than silently disabling the control. Live keying
stays available on the speaker sink.

## Sizing

At 45.45 baud (6.06 chars/sec), uploaded at the slot wire rate (Int16 mono
@ 16kHz, 32 kB/s):

| message | duration | slot bytes |
|---|---|---|
| 20 chars (CQ) | 3s | 0.10 MB |
| 80 chars (exchange) | 13s | 0.40 MB |
| 300 chars (ragchew over) | 50s | 1.5 MB |
| 1000 chars | 165s | 5.0 MB |

The firmware caps a slot at 5 minutes (9.2 MB), but the real limit is
**PSRAM: 8MB across all four slots**. Anything over ~2MB per slot stops
several messages being staged at once. A length cap or a warning at compose
time is needed; silently failing an upload at send time is not acceptable
for something the operator staged deliberately.

## Design

### 1. Extract the slot helpers

New `src/lib/audio/bridgeSlots.ts`, holding the four helpers above with
their behaviour unchanged. `useFTTransmit.ts` imports them instead of
defining them. No functional change to FT8 — this step should be provable
by the existing FT tests alone.

Shape (mode-agnostic on purpose):

```
uploadToSlot(wsUrl, slot, samples, fromRateHz, gain, meta) -> slot actually used
playSlotAndWait(wsUrl, slot, isRunning) -> ok
clearSlot(wsUrl, slot)
readSlots(wsUrl) -> per-slot {ready, bytes, durationMs, message, label, audioHz}
```

`meta.message`/`meta.label` are already free-text on the wire, so RTTY can
put its own text there with no firmware change.

### 2. A shared staging model

The staging concept — "encode now, hold in a slot, send on my command" —
is what RTTY wants and SSTV will want. It belongs beside the helpers, not
inside either mode:

```
createSlotStaging({ getWsUrl, encode, slotCount })
  stage(id, payload)     encode -> upload -> mark slot ready
  send(slot)             play, wait, report
  clear(slot)
  state()                per-slot: empty | encoding | uploading | ready | playing
```

`encode` is the only mode-specific part: RTTY supplies its Baudot/ASCII
encoder, SSTV would supply its image encoder. Everything else is shared.

### 3. Slot allocation

FT8 reserves slot 0 for auto-CQ and uses 1-2 for the queue lookahead
(`TX_SLOT_AUTOCQ`, `TX_SLOT_QUEUE_LOOKAHEAD`). Those reservations are FT's
own policy, not the firmware's — and under cross-mode sharing they stop
being safe assumptions.

Allocation becomes **first-free, with the owner recorded in the slot's own
label** (see Decisions below). FT claims a slot rather than assuming one,
and no mode overwrites a slot another mode staged. A full pool is a normal
state the UI must show, not an error: four slots against FT wanting up to
three plus a contest operator staging RTTY messages will run out.

### 4. RTTY panel changes

- An **Output** selector mirroring FT's (Local speaker / ESP32 Bridge).
- A **slot pool view** — four rows, each showing its staged text, duration
  and a Send / Clear action. FT's existing `BRIDGE TX SLOTS` panel is the
  obvious model, and its layout can be lifted.
- **Live keying disabled on the bridge sink**, with the reason shown, not
  just greyed out.
- A length warning as composed text approaches the practical slot size.

## Decisions

These were open when this was first written; all three are now settled.

### 1. Slots are shared across modes, and the device says who owns what

Any mode can stage into any free slot, and the operator can switch modes
and still send what they staged earlier. That is the point: stage a contest
exchange in RTTY, switch to FT8, come back and it is still there.

The mechanism already exists. Every slot carries a 32-byte free-text
`label` **stored on the device**, which is what lets a freshly loaded page
describe slots it never staged itself (see `refreshSlotHashCache`'s
comment: the device is the only thing that survives a reload, a different
browser or a cleared cache). Prefixing that label with the owning mode
makes the pool self-describing with **no firmware change**:

```
"FT8 · CQ (auto)"          15 bytes
"RTTY · CQ contest"        17 bytes
"SSTV · PD120 test card"   22 bytes
```

Consequences to handle:

- **FT8's slot reservations become policy, not fact.** `TX_SLOT_AUTOCQ = 0`
  and `TX_SLOT_QUEUE_LOOKAHEAD = [1, 2]` are FT's own constants. Under
  sharing, FT must claim a free slot rather than assume one, and must not
  overwrite a slot another mode staged.
- **Allocation is first-free, not fixed.** With four slots and FT wanting
  up to three, a contest operator staging several RTTY messages will run
  out. The UI has to show that plainly — a full pool is a normal state, not
  an error.
- **`message` is 48 bytes and `label` 32.** RTTY overs routinely exceed 48
  characters ("UR 599 599 QTH BRAZIL BRAZIL BTU W1ABC DE PU7FTW K" is 50),
  so the display text is deliberately truncated. The audio is the payload;
  the metadata is only ever a label.

### 2. Staging is the point, not an optimisation

Confirmed as the intended workflow for contest and remote operation:

1. Operator types the message.
2. Clicks to send it to the bridge — encode, upload, slot goes `ready`.
3. Clicks an uploaded message to transmit it.

So the upload is a deliberate, visible step rather than something hidden
inside Send, and the actual transmission is a separate act on a staged
slot. This is why staging earns its keep here despite RTTY having no window
deadline: the operator wants messages *waiting*, and wants transmitting to
be one click on a known-good buffer.

### 3. PTT is driven exactly as FT8 drives it

A staged send keys PTT, waits the pre-key hold, plays the slot, waits the
post-key hold, unkeys — the same sequence `useFTTransmit`'s TX loop already
performs. Pre-key/post-key values are shared rather than duplicated per
mode, so an external PA's timing is configured once.

### Carrier shift list

One list, shared by the TX panel and the decoder panel, replacing the two
that exist now (`[170, 200, 425, 450, 850]` in `RTTYTransmitPanel.tsx` and
`[170, 200, 450]` in `RTTYDecoder.tsx`). 150Hz is added to it:

```
150, 170, 200, 425, 450, 850
```

Checked against the decoder's own filter sizing
(`max(baud*0.6, min(shift/3, baud*4))`): 150Hz gives a 50.0Hz cutoff at
45.45 baud, the same regime as 170Hz's 56.7Hz. No decoder change needed.
