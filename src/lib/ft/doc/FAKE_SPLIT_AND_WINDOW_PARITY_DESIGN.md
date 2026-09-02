# FT8/FT4 TX: Fake Split + window-parity toggle — design (implemented)

Two independent TX-panel features, bundled here because both are toggle
chips on `FTTransmitPanel` persisted the same way as `autoCQ`/`autoPTT`/
`allowConsecutiveTx`. Either can ship without the other.

Implemented in `useFTTransmit.ts` (`fakeSplit`/`txWindowParity` state,
`isWrongWindowParity()`, the Fake Split retune/restore in `runLoop()`),
`useRadioCAT.ts` (`getTransportKind()`), and `FTTransmitPanel.tsx` (the Fake
Split and Even/Odd chips). `FAKE_SPLIT_SETTLE_MS` (currently 75ms) is a
placeholder default — see "Remaining open question" below, still open.

## Feature 1 — Fake Split

### What it actually is (confirmed against WSJT-X)

This is **not** "pick an arbitrary TX frequency, then retune the VFO to hit
it while transmitting a fixed tone" — that was the initial framing and it's
backwards. WSJT-X's real "Fake It" split mode (User Guide, "Split
Operation") works the other way:

- RX stays exactly where the operator has the dial set. The audio tone the
  operator/software picks for a given transmission can be anywhere in the
  usual FT8 passband (~200–3000 Hz here — see `baseFreq`/`audioHz` in
  `useFTTransmit.ts`).
- **On TX only**, the VFO is nudged via CAT so that a *fixed, always-the-same*
  "sweet spot" audio tone (WSJT-X uses 1500–2000 Hz) is what actually goes
  out, and the VFO shift exactly cancels the difference — the emitted RF
  frequency is identical to what a normal (non-split) TX at the chosen tone
  would have produced.
- On TX end, the VFO reverts to the original RX dial frequency.

Net effect on the actual RF frequency: **none**. The point isn't to reach a
frequency you otherwise couldn't — audio-tone-only TX already reaches any
frequency in the passband. The point is *which audio tone gets used to get
there*: low tones (esp. low few-hundred Hz) can alias/produce harmonics that
sneak back inside the transmit filter passband on some rigs, or land in a
region with worse SSB-filter rolloff/ALC behavior. Keeping actual TX audio
pinned to a known-clean tone sidesteps that, at the cost of a VFO retune per
TX. WSJT-X explicitly recommends this ("Fake It") over true rig split
("Rig") for radios like the Kenwood TS-480 — relevant since that's a radio
this app already targets.

Sources: [WSJT-X User Guide § Split Operation](https://wsjt.sourceforge.io/wsjtx-doc/wsjtx-main-2.6.1.html),
[K0PIR: WSJT-X Split Operation](https://k0pir.us/wsjt-x-split-operation/),
[groups.io: Split Operation: Rig or Fake it?](https://wsjtx.groups.io/g/main/topic/split_operation_rig_or_fake/88996981).

### How this differs from WSJT-X (deliberate deviation, not an oversight)

WSJT-X's sweet spot is an **internal fixed constant** (1500–2000 Hz) that
the operator never sets directly — "what tone do I want to send" and
"where does Fake It park the audio" are two separate concepts in WSJT-X's
model, with the operator's intended TX frequency living in "Tx Freq" and
Fake It's own internal target being independent of it.

This app instead **collapses those into one concept**: the sweet spot *is*
whatever the operator already has in the panel's Audio Hz field. Turning
Fake Split on changes what that field *means* — from "the tone that gets
sent" to "the tone we always send; any per-message deviation (e.g. a QSY
reply) goes out via VFO shift instead" — rather than introducing a second,
separately-configured constant alongside it. One fewer setting for the
operator to reconcile, at the cost of the mapping not matching WSJT-X's
internals 1:1. Worth calling out explicitly here so nobody reads the code
later, notices it doesn't match WSJT-X's source, and "fixes" it back.

### Requires CAT

Yes — gated the same way `autoPTT` already is: chip shows `opacity-40` and
disables itself when `props.onSetPTT` is falsy (no live CAT connection).
Unlike auto-PTT this feature is useless without a *readable* VFO frequency
too (`getVfoFrequency()`/`cat.state().frequency`), so the gate should be
"CAT connected AND frequency known", not just "PTT settable".

### Mechanism

**Sweet-spot tone is not a hardcoded constant — it's the panel's existing
Audio Hz setting** (`baseFreq`/`getBaseFrequency()`). This is a deliberate
choice (confirmed with the operator) rather than copying WSJT-X's fixed
1500–2000 Hz literally: it keeps a single "what tone am I sending" mental
model — the operator already tunes Audio Hz for their rig's cleanest
passband spot (filter shape, ALC behavior, etc. all vary per radio), so
that's exactly the value Fake Split should be defending, not a separate
independently-configured constant that could disagree with it.

Consequence: **every fake-split transmission encodes at `getBaseFrequency()`**,
full stop — including when a per-entry `entry.audioHz` would normally
override it (e.g. `qsyAudioOffsetHz()` replies to a station's numeric QSY
request, `parser.ts:655-665`). The QSY intent is preserved, just moved
entirely into the VFO delta instead of partly-audio/partly-VFO:

```
desiredAudioHz = entry.audioHz ?? getBaseFrequency()   // what a normal TX would've encoded at
sweetSpotHz    = getBaseFrequency()                     // what fake-split always encodes at instead
delta          = desiredAudioHz - sweetSpotHz           // can be + or -, 0 for a plain CQ/non-QSY entry
txVfoHz        = originalVfoHz + delta
```

Encoding: whenever fake-split is on, force `encodeHz = getBaseFrequency()`
at `useFTTransmit.ts:769` (ignoring `entry.audioHz` for the *encode* call
specifically — it still flows into the `delta` computation above). Note this
means `getBaseFrequency()` must be read at *encode* time and again at *TX*
time — if the operator changes Audio Hz between an entry's enqueue and its
actual TX window, re-deriving `delta` from whatever `entry.samples` was
actually encoded at (not a fresh `getBaseFrequency()` read) avoids the two
going out of sync; carry the sweet-spot value the entry was encoded against
alongside `entry.samples` rather than re-reading the live setting at TX time.

### Sequencing — the real risk

This is the "quite delicate" part the user flagged, and it's a genuine
architectural gap today:

`getOnTxWindowStart()?.()` (`useFTTransmit.ts:1002`) is called
**synchronously, fire-and-forget** — `getOnTxWindowStart: () => (() => void) | undefined`
(line 597). PTT keys immediately after (line ~1006), racing a 500ms
timeout. A VFO retune needs to *complete* (ideally CAT-confirmed) **before**
PTT keys, or the first symbol(s) go out at the wrong frequency — silently
producing a bad decode at the other end, not an error this app would ever
see.

This means `onTxWindowStart` must become awaitable:

```ts
getOnTxWindowStart: () => (() => void | Promise<void>) | undefined
...
await getOnTxWindowStart()?.();   // useFTTransmit.ts:1002
```

`handleTxWindowStart` in `App.tsx` (currently only suspends the I/Q bridge,
synchronous) becomes `async`, and — when fake-split is on — does:

```ts
originalVfoHz = cat.state().frequency
await cat.setFrequency(originalVfoHz + delta)   // awaited, ideally confirmed
```

`cat.setFrequency()` is already `Promise<void>` and, over the websocket
(ESP32 bridge) transport, already does confirm-with-retry
(`confirmedSet`, up to `CONFIRM_RETRIES = 3` — see `useRadioCAT.ts:1356-1372`).
Over serial it's fire-and-forget (no confirmation), which is a real
limitation to surface in the UI (see Gotchas) rather than silently trust.

`handleTxWindowEnd` (`App.tsx:918`) restores the VFO the same way, awaited,
**before** the existing I/Q-bridge-reconnect logic — though since
`getOnTxWindowEnd` is already only called after PTT unkeys
(`useFTTransmit.ts:1100`) and nothing downstream depends on it finishing
quickly, it doesn't strictly need to block the TX loop the way window-start
does. Still make it `awaited` for symmetry and so a slow revert can't race
a fast-arriving next-window start.

**Settle delay (`fakeSplitSettleMs`)**: a CAT "confirmed" reply only proves
the radio *acknowledged* the new frequency — it doesn't prove the PLL has
finished physically locking onto it yet. Some radios need a brief extra
moment after confirmation before the synthesizer is actually settled and
safe to key; keying too early risks the first symbol(s) going out chirped,
off-frequency, or at reduced power while the loop is still settling. So the
sequence is: retune → await CAT confirmation → wait `fakeSplitSettleMs` →
key PTT/start audio. No source gives a universal number for this (it's
radio/synthesizer-specific and not something WSJT-X's docs quantify either)
— ship a conservative default (order of 50–100ms) and treat it as a value
to validate against real hardware (TS-480, uSDX, ESP32-bridge round-trip
adds its own latency on top) rather than a constant to trust blindly. This
is separate from `preKeyMs` (the existing PA/relay warm-up hold) — both may
end up applying back-to-back on a fake-split TX.

### Gotchas to design around

- **Serial transport can't confirm.** `setFrequency` over `'serial'` is
  fire-and-forget (`useRadioCAT.ts:1361`) — no way to know the retune
  actually landed before keying. Decision: allow it, but the chip's
  tooltip/title should say so explicitly ("Fake Split: frequency change is
  not confirmed on serial CAT — verify on the radio") rather than silently
  behave as if it were as reliable as the websocket/bridge path.
- **PTT-off is never optimistic and can retry forever** (`useRadioCAT.ts`
  1400–1441) — if fake-split's VFO-restore is chained after PTT-off
  confirmation, a stuck radio could delay restoring RX frequency
  indefinitely. Don't block the restore on PTT-off's own retry loop; fire it
  right after `onSetPTTOff` resolves/rejects (window-end already runs after
  that point regardless of outcome).
- **Auto-CQ / unattended operation**: if fake-split is on and Auto-PTT is
  *not* enabled (CAT connected but the operator keys the radio manually via
  a footswitch or VOX), retuning the VFO right before *audio* starts (not
  PTT) will move the operator's dial out from under them for every
  transmission, RX included, if they haven't keyed by the time it retunes
  back. Decision: don't hard-require Auto-PTT, but warn — chip tooltip
  should say something like "Fake Split without Auto-PTT will retune your
  VFO before you key manually" so the risk is visible rather than a
  surprise the first time the dial jumps.
- **Interaction with `qsyAudioOffsetHz`** (`parser.ts:655-665`): a QSY reply
  that already computes a specific `audioHz` per-entry needs its delta
  computed against *that* per-entry tone, not the panel's global
  `baseFreq` — already true of the `entry.audioHz ?? getBaseFrequency()`
  pattern used elsewhere, just needs to carry through here too.
- **Radio must actually support fast enough CAT retuning** — this is a
  per-radio characteristic with no universal number (see research); the
  TS-480 is specifically the radio WSJT-X's own docs recommend Fake-It
  *for*, which is a good sign for this app's primary target, but the ESP32
  bridge path adds its own WebSocket round-trip on top of the radio's own
  CAT latency and should be measured separately.

## Feature 2 — TX window-parity toggle (0/30 vs 15/45)

Much simpler, no CAT dependency at all — pure scheduling.

### Mechanism

`useFTTransmit.ts:906`: `currentWindowStart = nowMs - (nowMs % windowMs)`
is the epoch-ms boundary of the current window. For FT8 (`windowMs =
15000`), two consecutive windows make one WSJT-X-style 30-second period.
Parity of the *pair*:

```ts
const windowParity = Math.floor(currentWindowStart / windowMs) % 2   // 0 or 1
```

Whether `windowParity === 0` means ":00/:30" or ":15/:45" depends on Unix
epoch alignment (epoch is at :00:00 UTC on a day boundary, and 15s divides
evenly into that), so this should be verified once against a real clock
rather than assumed — worth a unit test asserting
`windowParity(<a known :00:00 UTC ms timestamp>) === 0` and
`windowParity(<the :15 timestamp 15s later>) === 1`, so the "0,30" vs
"15,45" label in the UI is guaranteed correct rather than hand-verified once
and left to bitrot.

### Toggle semantics

Corrected from the first draft: **2 states, not 3** — there's no separate
"off"/"any" state, since `allowConsecutiveTx` already covers "don't
restrict which windows I can use." This toggle always restricts to one
parity or the other:

- **Even** — only transmit when `windowParity === 0` (the pair starting at
  second :00 or :30)
- **Odd** — only transmit when `windowParity === 1` (the pair starting at
  second :15 or :45)

Default: **Even** (arbitrary but needs a default — matches WSJT-X's own
"Tx even/1st" as the more commonly-seen default in the wild).

This is the FT8 half of the operator's own even/odd slot discipline (WSJT-X
"Tx even/1st" vs "Tx odd/2nd" style behavior, made a persistent panel
setting here rather than a one-shot per-QSO decision) — it answers "which
of the two 15s slots in a 30s period is mine," the same concept ham
operators already use manually to avoid doubling with a QSO partner who's
on the other slot.

The actual :00/:30 vs :15/:45 seconds are **not** in the chip's label
(just "Even"/"Odd", to stay compact) — they go in the hover tooltip instead,
e.g. `title="Transmit only in windows starting at :00 and :30"` /
`title="Transmit only in windows starting at :15 and :45"`, following the
existing pattern of the other chips using `title` for the fuller
explanation (see Consecutive TX's tooltip, `FTTransmitPanel.tsx:1132-1134`).

Gate on FT8 specifically (`props.mode === 'FT8'`): FT4's 7.5s windows make
four slots per 30s period, not two, so a binary "0/30 vs 15/45" toggle
doesn't map cleanly — either hide the chip outside FT8 or, if there's
appetite later, generalize it to N-way parity. Out of scope for this pass;
build it FT8-only and note the FT4 gap rather than guessing at FT4 semantics
nobody asked for.

### Integration point

`useFTTransmit.ts:903-909`, alongside the existing `skipForListen`
(consecutive-TX) gate — both are "don't transmit this window" conditions
and should combine with OR:

```ts
const windowParity   = Math.floor(currentWindowStart / windowMs) % 2
const wrongParity     = getMode() === 'FT8' &&
  windowParity !== (txWindowParity === 'even' ? 0 : 1)
const skipForListen   = wrongParity || (!allowConsecutiveTx &&
  (lastTxWindow === prevWindowStart || lastTxWindow === currentWindowStart))
```

(Naming placeholder — `txWindowParity: 'even' | 'odd'` as the persisted
setting, defaulting to `'even'`.)

This composes automatically with `allowConsecutiveTx`: a wrong-parity
window is always skipped regardless of the consecutive-TX setting (you
literally aren't allowed to transmit there), and consecutive-TX's own guard
still applies on top within your allowed parity's windows.

### Persistence

Same pattern as `allowConsecutiveTx` (`useFTTransmit.ts:184-190`,
`LS_CONSECUTIVE_TX`): a new `LS_TX_WINDOW_PARITY` localStorage key, `load`/
`save` pair, threaded into `FTTransmitState` since `runLoop()` needs to read
it live (same reason `allowConsecutiveTx` lives in `state`, not a
panel-local `createSignal`).

### UI

A single chip that toggles between its 2 states on click, same interaction
as every other chip in the grid (`onClick` flips the persisted setting) —
no cycling needed since there's no third/off state. Label shows the current
state directly: **"Even"** or **"Odd"**. Seconds are not in the label
(would make it "Even (:00,:30)" — too long for the grid's compact chips);
they go in the `title` tooltip instead:

- Even: `title="Transmit only in windows starting at :00 and :30 — click to switch to Odd"`
- Odd: `title="Transmit only in windows starting at :15 and :45 — click to switch to Even"`

Visually: identical styling to the existing chips (border/background color
when "on" vs a neutral/transparent state) — but since this setting has no
real "off," treat **Odd** as the "active/accent color" state and **Even**
as the chip's neutral/default-looking state (consistent with Even being the
default), the same way e.g. Consecutive-TX's chip looks neutral until
switched on.

## Remaining open question before implementation

`fakeSplitSettleMs` (the guard delay after a confirmed VFO retune, before
audio/PTT proceeds) — no source gives a universal number (see Sequencing
above). Needs an initial conservative default plus real-hardware
measurement across at least the TS-480-direct-serial and ESP32-bridge
paths before trusting a single global constant; flag this explicitly in the
PR rather than treating a guessed value as validated.
