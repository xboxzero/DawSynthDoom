# DawSynthDoom

Plug an analog synth into your audio interface and get a **well-tempered bass synthesizer** out. It's a low-latency rig that runs in the browser, with a 3D effect pad, NAM bass amps, wet / dry / wet effects, and a 3D spectrum display that colours the sound by the kind of noise it hears.

**Live site:** https://xboxzero.github.io/DawSynthDoom/

## Signal chain

```
SYNTH IN ─ BASS VOICE (AudioWorklet) ─ NAM BASS AMP + CAB (optional) ─┬─ DRY (mono, centre) ──────┐
            track → temper → osc/sub/fold → ladder → drive             └─ DELAY / REVERB / CHORUS / ├─ END RACK ─ FEEDBACK GUARD ─ EQ ─ GLUE ─ MASTER ─ LIMITER
                                                                          DOUBLER (high-passed wet) ┘
```

- **Bass voice:** the pitch of your synth is tracked with an adaptive YIN window, about 2 periods long, updated every ~4 ms. A note only changes when two detections in a row agree, which removes octave blips. The voice follows the synth's own envelope, so its dynamics come from your playing.
- **Well temperament:** every note snaps to the nearest note of your key and scale in Werckmeister III, Kirnberger III, Vallotti, Young II or equal temperament, with A at your reference pitch (415–466 Hz). SNAP, GLIDE, OCTAVE and BASS RANGE (which folds notes into E1–D#3) shape how it follows.
- **Sound:** a morphing saw / square / pulse oscillator, sub oscillator, wavefolder, grit, ladder low-pass with envelope, and drive. SYNTH IN blends the original synth back in.
- **3D FX pad:** X, Y and Z each drive any parameter you pick, such as cutoff, fold, space or drive. Drag in the cube for X/Y; set Z with its fader, the wheel or a pinch. ORBIT plays a 3D path; QUBIT lets a simulated two-qubit quantum state steer the point.
- **Wet · dry · wet:** the bass stays dry and mono in the centre. The effects are high-passed sends on the sides, so the low end stays tight.
- **End rack:** phaser, tremolo, auto filter, bitcrush, stutter and a looper.
- **3D monitor:** a perspective spectrogram. Each slice is coloured by what it hears: tonal, mains hum, or white / pink / brown / blue / violet noise, judged from spectral flatness and slope. Drag it to tilt.

## Feedback and phones

- The output starts **muted** until you turn the monitor on.
- **PHONE SAFE** turns on the browser's echo cancellation and caps the output at -9 dB. It's on by default on touch devices; turn it off for a clean interface line input.
- The **feedback guard** notches frequencies that ring steadily for about a second. It ignores harmonics of the note being played, so sustained bass notes aren't touched. It also briefly ducks the master on a loud howl.
- On phones:
  - The 3D monitor sits at the top, with a tab bar (BASS / 3D / FX / MASTER) at the bottom.
  - Knobs turn with a **left/right swipe**, so vertical swipes scroll the page.

## Low latency

There is one AudioWorklet for the whole voice. With LOWEST LATENCY on, the AudioContext asks for the smallest buffer. The interface input is opened raw, with no processing, at 48 kHz. The current latency is shown in the header.

## Development (TypeScript)

The source is strict TypeScript in `src/`, bundled with esbuild into `dist/`. `dist/` is committed so GitHub Pages can serve the site without a build step.

```
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run build       # bundles src/ -> dist/
npm run watch       # rebuild on change
npm run serve       # http://localhost:8000
```

CI (`.github/workflows/check.yml`) type-checks, builds, and fails if `dist/` is out of date.

To publish: **Settings → Pages → Deploy from a branch**, pick the branch, `/ (root)`.

## TONE3000 (optional)

1. Create a publishable key at tone3000.com → Settings → API Keys.
2. Register `https://xboxzero.github.io/DawSynthDoom/callback.html` as a redirect URI.
3. Paste the `t3k_pub_…` key in the BASS AMP panel's TONE3000 dialog.

## Credits

`vendor/nam/` is the Neural Amp Modeler WebAssembly engine from [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) (MIT, see `vendor/nam/LICENSE`), based on Steven Atkinson's [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore). The fonts are Permanent Marker and Sedgwick Ave Display from Google Fonts.
