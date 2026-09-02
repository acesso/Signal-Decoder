# FT8/FT4 TX: Fake Split + window-parity toggle — design (implemented)

Two independent TX-panel features, bundled here because both are toggle
chips on `FTTransmitPanel` persisted the same way as `autoCQ`/`autoPTT`/
`allowConsecutiveTx`. Either can ship without the other.

Implemented in `useFTTransmit.ts` (`fakeSplit`/`fakeSplitSweetSpotHz`/
`fakeSplitStaleRestoreHz`/`txWindowParity` state, `isWrongWindowParity()`,
the Fake Split retune/restore in `runLoop()`, the crash-recovery marker —
see its own section below), `useRadioCAT.ts` (`getTransportKind()`), and
`FTTransmitPanel.tsx` (the Fake Split and Even/Odd chips, plus the
stale-restore warning line). `FAKE_SPLIT_SETTLE_MS` (currently 75ms) is a
placeholder default — see "Remaining open questions" below, still open.

**Post-implementation correction (2026-09-02):** the first cut of this
feature had a real bug, caught before it shipped further: it used the
operator's own Audio Hz as the "sweet spot" (see the old "How this differs
from WSJT-X" section this replaced), which made the VFO delta silently
collapse to zero for ALL ordinary traffic — a plain CQ or reply with no
per-entry pinned tone always has `entry.audioHz ?? getBaseFrequency() ===
getBaseFrequency()`, so "sweet spot" and "desired tone" were always the
same value and nothing ever got shifted. Fixed by introducing a genuinely
separate `fakeSplitSweetSpotHz` setting (default 1750 Hz — center of
WSJT-X's own 1500–2000 Hz range), independent of Audio Hz, matching WSJT-X's
actual architecture (see below) rather than the collapsed one-concept
version. A parallel copy of the same bug existed in the auto-CQ path
(`rebuildAutoCQCache`, a separate encode cache from the queue/`startEncode`)
and needed the identical fix.

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

### How this differs from WSJT-X (one deliberate difference, otherwise the same mechanism)

WSJT-X's sweet spot is an **internal fixed constant** (1500–2000 Hz) that
the operator never sets directly — "what tone do I want to send" (Audio Hz
/ a per-message pinned tone) and "where does Fake It park the audio" (the
sweet spot) are two separate concepts in WSJT-X's model, and this app's
implementation now matches that exactly: `fakeSplitSweetSpotHz` is a
genuinely independent value from `getBaseFrequency()`/`entry.audioHz`.

The one deliberate difference: this app exposes the sweet spot as a
**configurable setting** (`fakeSplitSweetSpotHz`, default 1750 Hz — center
of WSJT-X's range) rather than a truly hardcoded, non-configurable
constant, since a given radio's actual filter response can differ enough
to want tuning. There is currently no panel UI control for changing it
(only `setFakeSplitSweetSpotHz()` on the API) — see "Remaining open
question" below.

### Requires CAT

Yes — gated the same way `autoPTT` already is: chip shows `opacity-40` and
disables itself when `props.onSetPTT` is falsy (no live CAT connection).
Unlike auto-PTT this feature is useless without a *readable* VFO frequency
too (`getVfoFrequency()`/`cat.state().frequency`), so the gate should be
"CAT connected AND frequency known", not just "PTT settable".

### Mechanism (corrected — see "Post-implementation correction" above)

**Sweet-spot tone is a genuinely independent setting** (`fakeSplitSweetSpotHz`,
default `DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ = 1750`), NOT the panel's Audio Hz
— conflating the two was the original bug: for ordinary traffic (no pinned
per-entry tone), `entry.audioHz ?? getBaseFrequency()` always equals
`getBaseFrequency()`, so if the sweet spot is *also* `getBaseFrequency()`
the delta is always zero and the VFO never moves. The sweet spot must be a
fixed reference point the operator's target frequency is measured *against*,
not the target itself.

**Every fake-split transmission encodes at `fakeSplitSweetSpotHz`**, full
stop — including a plain CQ with no pinned tone, and including when a
per-entry `entry.audioHz` would normally override the panel's Audio Hz
(e.g. `qsyAudioOffsetHz()` replies to a station's numeric-tag CQ request,
`parser.ts:655-665`). The operator's actual intended tone is preserved
entirely as a VFO delta instead of partly-audio/partly-VFO:

```
desiredHz    = entry.audioHz ?? getBaseFrequency()   // operator's actual intended TX tone
sweetSpotHz  = fakeSplitSweetSpotHz                  // fixed, independent of desiredHz
delta        = desiredHz - sweetSpotHz               // nonzero for ANY desiredHz != sweetSpotHz —
                                                      // including the common plain-CQ case now
txVfoHz      = originalVfoHz + delta
```

Encoding: whenever fake-split is on, force `encodeHz = fakeSplitSweetSpotHz`
in both `startEncode()` (queued entries) and `rebuildAutoCQCache()` (the
auto-CQ cache — a SEPARATE encode path from the queue, needing the
identical fix independently; see the correction note above). The value
actually encoded at is captured onto the entry as `fakeSplitEncodedHz` (or
`autoCQFakeSplitEncodedHz` for the auto-CQ cache) at encode time, and
`runLoop()`'s delta computation reads THAT captured value rather than a
fresh `fakeSplitSweetSpotHz` read — if the operator changes the sweet spot
(or toggles Fake Split) between an entry's enqueue and its actual TX
window, comparing against the live setting instead of what was actually
baked into `entry.samples` would compute a delta against the wrong
baseline. `syncParams()` treats a Fake Split on/off flip or sweet-spot
change as invalidating every queued entry (not just ones with no pinned
tone, unlike a plain Audio-Hz change) precisely because it changes
`encodeHz` regardless of any per-entry pin.

If `fakeSplitEncodedHz` is missing on an entry (not yet re-encoded under
the current Fake Split state — a real race, since `syncParams()`'s
re-encode is debounced/async, not synchronous with the toggle),
`runLoop()` skips the VFO shift for that transmission entirely rather than
compute a delta against a guessed/wrong baseline — see its own comment.

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

### Crash/reload recovery — the pending-restore marker

`fakeSplitOriginalVfoHz` in `runLoop()` is a plain local `let`, scoped to a
single loop iteration — a page reload or crash between the pre-TX retune
and the post-TX restore loses it completely, leaving the radio parked on
the shifted frequency with **zero durable trace** of what it should be
restored to (flagged by the user directly: "assume an accidental page
reload during a fake split tx... on page reload the web app can notice
that the current VFO is possibly wrong").

Fixed with a localStorage marker (`loadPendingFakeSplitRestoreHz()` /
`savePendingFakeSplitRestoreHz()` / `clearPendingFakeSplitRestoreHz()`),
written **before** the retune command is even sent (not after it resolves
— a crash during the CAT round-trip itself must still leave a record) and
cleared only once the restore is **confirmed** successful. On a failed
restore attempt, the marker is deliberately left in place rather than
cleared: a timeout/rejection means the confirm cycle didn't succeed, not
that the radio definitely never applied the command (especially over the
websocket/bridge transport, where the SET can land while only the
verification read fails) — leaving a false-positive warning up is a much
smaller cost than silently abandoning a radio that's actually shifted.

On `createFTTransmit()` construction (i.e. every fresh page load), a
leftover marker is read straight into `FTTransmitState.fakeSplitStaleRestoreHz`
and the panel shows a compact one-line amber warning (not a full-width
block banner — kept small deliberately per explicit direction) with the
stale frequency, a **Revert now** button (`revertStaleFakeSplitVfo()` —
only shown when a CAT frequency setter is currently available) that
retunes the VFO back and clears the marker on success, and a dismiss `✕`
(`dismissStaleFakeSplitVfo()`) for "I already fixed it manually" or a
false alarm. Neither action is automatic — the app never retunes the radio
on the operator's behalf without an explicit click, for the same reason
Fake Split itself only ever shifts around an operator-visible TX cycle.

The same underlying gap existed for a **deliberate** Stop mid-TX, not just
a crash: `stop()` unkeys PTT but, before this fix, never touched the VFO at
all, since `fakeSplitOriginalVfoHz` lived inside `runLoop()`'s loop body
and was unreachable from `stop()`. Now `stop()` reads the same persisted
marker and attempts an immediate best-effort restore, falling back to the
same stale-restore warning if that also fails.

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
- **Every transmission now retunes, not just QSY replies.** With the
  corrected mechanism (sweet spot independent of Audio Hz), the delta is
  nonzero for essentially ALL traffic whenever the operator's Audio Hz
  differs from the sweet spot — which is the common case, not a rare
  exception. This makes the "auto-CQ / unattended operation" gotcha above
  apply to ordinary CQ beacon operation too, not just QSY-reply edge cases:
  an unattended auto-CQ station with Fake Split on and Auto-PTT off will
  have its VFO jump on every single beacon transmission. This is the
  correct/intended behavior (it's exactly what WSJT-X's Fake It does too),
  but it raises the practical stakes of the Auto-PTT warning above — worth
  re-confirming operators actually see and understand that warning, since
  it now governs much more frequent VFO movement than the original
  (buggy, QSY-only) implementation ever produced.

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

## Remaining open questions

1. `FAKE_SPLIT_SETTLE_MS` (the guard delay after a confirmed VFO retune,
   before audio/PTT proceeds) — no source gives a universal number (see
   Sequencing above). Needs an initial conservative default plus
   real-hardware measurement across at least the TS-480-direct-serial and
   ESP32-bridge paths before trusting a single global constant.

`fakeSplitSweetSpotHz` now has a panel UI control (a "Sweet Spot" NumberField
next to Pre-key/Post-key/Auto-CQ-interval in `FTTransmitPanel.tsx`, gated
the same way — greyed out unless Fake Split is on, 300–2800 Hz bounds
matching `setFakeSplitSweetSpotHz()`'s own clamp) — no longer API-only.
