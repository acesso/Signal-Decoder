# I/Q receive path — CPU design note

**Status: note only. Not implemented.** Captured 2026-09-24 from an
operator observation while investigating I/Q CPU load. The decimation work
in 0.19.x (see `SSBDemodulator`'s `DEMOD_TARGET_RATE_HZ`) is a partial,
already-shipped step in this direction; the restructure below is not.

## The observation

The two consumers of the I/Q stream have very different bandwidth needs,
and the current pipeline serves both at the widest one:

- **The graphs** (spectrum + waterfall) need the **whole** captured band —
  that is the entire point of the wideband view, and how the operator finds
  a signal to tune to. But they only need magnitudes for display, which is
  cheap: a single FFT per window, measured at ~1% of realtime.

- **The decoder** (and the speaker output, when enabled) only ever needs
  the **passband** — a few kHz. The passband marker is precisely the
  operator saying "this is the part I care about."

So the heavy DSP — the FIR chain in `SSBDemodulator.demodulate` — should
only ever run on a passband-wide signal, never on the full capture.

## The restructure

Cut first, then process:

1. Feed the raw wideband I/Q to the spectrum computer for the graphs
   (unchanged — it is already cheap, and already skipped entirely when
   nothing is displaying it; see `IQSpectrumComputer.setActive`).
2. Extract just the passband from the wideband stream — mix it to baseband
   and decimate hard, using a filter sized for *that* job rather than for
   the final audio quality.
3. Run the existing demodulation chain on the resulting narrow, low-rate
   stream, and hand its output to the decoder and the speaker path.

The shipped decimation already does a weaker version of step 2: it decimates
to 12 kHz, but the anti-alias lowpass still evaluates its full tap count
against every input sample, so its cost still scales with the capture rate.
That is why 96 kHz remains expensive (~67% of a core) while 48 kHz is
comfortable (~17%).

## Why this is the right shape

The remaining cost is dominated by one filter that has to be both *wide
enough to see the whole capture* and *sharp enough for the final audio*.
Splitting that into two stages — a cheap wide decimator, then the sharp
narrow one at a low rate — is the standard answer, and it makes the cost
depend on the passband width rather than the capture rate. That matters
most exactly where it hurts now: moving from 48 kHz to 96 kHz capture
should then cost almost nothing extra, since the second stage never sees
the higher rate.

## Related, still open

Moving the demodulator off the main thread (a worker or AudioWorklet) was
discussed alongside this and is **also not done**. It is a separate axis:
the restructure above reduces the work, the thread move stops what remains
from competing with decode and render. The blocker on the thread move is
that `getPlaybackSource()` hands out a live Web Audio node that decoders
tap directly, so relocating the DSP means rethinking how demodulated audio
reaches both the speakers and the decoder.

Worth re-measuring on the real two-tab setup before doing either: after the
12 kHz decimation the 48 kHz case dropped from ~51% to ~17% of a core, which
may already be enough.

## Validation against the implemented state (2026-09-24)

Checked each claim against the code rather than assumed:

**Graphs get the whole band, cheaply — confirmed.** `feedIQSamples` hands
the full-width buffer to `spectrum.feed`, which does a copy plus one FFT per
4096-sample window, and early-returns entirely when no panel is displaying
the raw tap (`IQSpectrumComputer.setActive`). Measured at ~1% of realtime.

**The heavy DSP still runs at full capture width — confirmed, and this is
the whole remaining cost.** In `demodulate`, the two lowpass `processOne`
calls sit BEFORE the decimation gate, so they run on every input sample at
the capture rate; only the Hilbert and highpass are after it. `processOne`
walks the entire tap array per call, so:

| capture | lowpass (pre-gate) | Hilbert (post-gate) | lowpass share |
|---|---|---|---|
| 48 kHz | 609 taps x2ch x 48000/s = 58M MACs/s | 229 taps x 12000/s = 3M | **96%** |
| 96 kHz | 1217 taps x2ch x 96000/s = 234M MACs/s | 229 taps x 12000/s = 3M | **99%** |

That is exactly the note's point: the only filter that still sees the whole
band accounts for nearly all the cost, and it is the one that would be
replaced by cutting the passband out first. It also explains the measured
17% vs 67% split between 48 and 96 kHz — the post-gate work is constant, so
the difference is entirely that one filter.

**The thread-move blocker is real — confirmed.** `getPlaybackSource()`
returns a live `AnalyserNode` on a main-thread `AudioContext`, and
`acquireBridgeSource()` hands it directly to every decoder.
