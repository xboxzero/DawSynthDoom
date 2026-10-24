# DawSynthDoom

A live DAW effect mixer, synthesizer and modular patcher that runs in the browser. It needs no install and no build step, so it runs as a plain static site on GitHub Pages.

**Live site:** https://xboxzero.github.io/DawSynthDoom/

## Mixer (`index.html`)

- **Live input:** captures your audio interface raw, with echo cancellation, noise suppression and auto-gain turned off. Pick IN 1, IN 2 or 1+2. Output device selection works where the browser supports it.
- **Parallel effects:** the input feeds seven branches at the same time: Direct, Amp (NAM + IR cab), Drive, Delay, Reverb, Mod and a pitch-tracking Synth. Each branch has its own fader, pan, mute/solo and meter, and all of them sum into the mix bus.
- **NAM + IR:** real Neural Amp Modeler inference through TONE3000's MIT-licensed WebAssembly engine. Loads A1 and A2 `.nam` models. IR cabinet and reverb impulse responses load as `.wav` files.
- **TONE3000:** sign in and pick tones straight from tone3000.com, or drop downloaded files onto the page.
- **Master:** 5-band draggable EQ over a live spectrum, a glue compressor, a limiter and recording to file.
- **Auto mix:** auto level evens out branch loudness, A/B scenes morph by hand or automatically, and loop automation records your knob and fader moves.
- **One live display:** triggered oscilloscope (input vs output), scrolling waveform, spectrum, or any single branch.

## Patch (`modular.html`)

A modular synth with TouchDesigner-style visuals on one node canvas.

- **Audio and control modules:** audio in, oscillator, noise, keys (touch, computer keyboard and Web MIDI), step sequencer, envelope, LFO, envelope follower, filter, VCA, drive, delay, reverb, NAM amp, cab IR, mixer, pan, scope and output.
- **Data (CHOP-like):** ANALYZE turns audio into level, low, mid and high values.
- **Visual (TOP-like) WebGL2 shader nodes:** noise, shape, waveform, spectrum, feedback, color, blend, kaleidoscope and warp, ending in a viewer that can go fullscreen.
- **Cables are typed:** audio, cv, gate, data and texture. Patches save automatically and can be exported or imported as JSON.

## Controls

Everything works with one mouse or one finger:

- **Knobs:** drag up/down or sideways, use the wheel, or the arrow keys. Double-click or double-tap resets a knob.
- **Faders:** drag the thumb, or tap the track to jump there.
- **Patching:** drag from an output dot to an input dot. Grab a connected input dot to move its cable. Tap a cable twice to delete it.

## Publishing on GitHub Pages

Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, and pick the branch and `/ (root)`. The site is plain static files (`.nojekyll` is included).

Browsers only allow microphone and audio interface access on https or `localhost`. For local development, run `python3 -m http.server` and open `http://localhost:8000`.

## TONE3000 setup (optional)

1. Create a publishable key at tone3000.com → Settings → API Keys.
2. Register `https://xboxzero.github.io/DawSynthDoom/callback.html` as a redirect URI.
3. Paste the `t3k_pub_…` key into the TONE3000 dialog.

## Credits

`vendor/nam/` is the Neural Amp Modeler WebAssembly engine from [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) (MIT, see `vendor/nam/LICENSE`), based on Steven Atkinson's [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore). The starter models and IRs are loaded from that repository.
