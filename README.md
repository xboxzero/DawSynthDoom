# DawSynthDoom

A live wet / dry / wet guitar and vocal rig that runs in the browser. It needs no install and no build step, so it runs as a plain static site on GitHub Pages.

**Live site:** https://xboxzero.github.io/DawSynthDoom/

## Signal chain

```
INPUT ─ GATE ─ AUTOTUNE ─ PRE EQ ─ AMP (boost · NAM · tone · IR cab) ─┬─ DRY (centre) ───────────────┐
                                                                      └─ DELAY / REVERB / CHORUS /   ├─ END RACK ─ FEEDBACK GUARD ─ MASTER EQ ─ GLUE ─ MASTER ─ LIMIT
                                                                         DOUBLER (100% wet, sides) ──┘
```

- **Feedback protection:**
  - The output starts muted until you confirm you're on headphones.
  - A noise gate and a 35 Hz rumble filter sit at the input.
  - Delay repeats are capped at 85%.
  - The **feedback guard** finds ringing frequencies, cuts them with narrow notches, and briefly ducks the master if a howl gets loud.
- **Pre-amp:** noise gate, then **well-temperament autotune**, then a 4-band draggable EQ with low cut.
  - The autotune snaps to the nearest note of your key and scale in Equal, Werckmeister III, Kirnberger III, Vallotti or Young II tuning, with A kept at your reference pitch (415–466 Hz).
  - It has strength, retune speed and mix controls, plus a tuner readout.
- **Amp:** a real Neural Amp Modeler engine (TONE3000's MIT-licensed WebAssembly build) that loads A1 and A2 `.nam` files. It also has a boost, a tone stack, IR cab loading, and the TONE3000 picker.
- **Wet · dry · wet:**
  - The dry amp signal sits in the centre.
  - Delay (stereo ping-pong), reverb, chorus and doubler are parallel 100%-wet sends on the sides, each with its own send fader and mute.
  - Separate DRY and WET faders, plus WIDTH and a W/D/W mode, control the stereo picture.
- **End rack:** optional gig modules at the end of the chain: tremolo, auto filter, bitcrush, lo-fi radio, stutter (hold) and a looper (rec / overdub / stop / clear). Add, bypass, reorder or remove them while playing.
- **Qubit chaos:** a simulated two-qubit quantum state drives the parameters you choose: the four wet sends, width, delay time, a wet filter and master swell.
  - Its rotations and entanglement evolve continuously, and random measurements collapse the state, which makes the modulation jump.
- **Master:** 5-band EQ, glue compressor, feedback guard, a big master volume fader, an always-on limiter, and recording to file.
- **SDR display:** the left side shows the overall waveform, a live spectrum with peak hold, and a scrolling waterfall in the style of a software-defined-radio display, with feedback notches marked.

## Controls

Everything works with one mouse or one finger:

- **Knobs:** drag up/down or sideways, use the wheel, or the arrow keys. Double-tap resets a knob.
- **Faders:** tap a fader track to jump there.
- **Monitor:** Space toggles the monitor.

## Publishing on GitHub Pages

Go to **Settings → Pages → Deploy from a branch**, and pick the branch with `/ (root)`. Browsers only allow audio interface access on https or `localhost`. For local development, run `python3 -m http.server`.

## TONE3000 setup (optional)

1. Create a publishable key at tone3000.com → Settings → API Keys.
2. Register `https://xboxzero.github.io/DawSynthDoom/callback.html` as a redirect URI.
3. Paste the `t3k_pub_…` key into the TONE3000 dialog.

## Credits

`vendor/nam/` is the Neural Amp Modeler WebAssembly engine from [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) (MIT, see `vendor/nam/LICENSE`), based on Steven Atkinson's [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore). The fonts are Permanent Marker and Sedgwick Ave Display from Google Fonts.
