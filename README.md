# DawSynthDoom

Plug an analog synth into your audio interface and get a **well-tempered bass synthesizer** out. It's a low-latency rig that runs in the browser, with a 3D effect pad, NAM bass amps, wet / dry / wet effects, and a 3D spectrum display that colours the sound by the kind of noise it hears.

**Live site:** https://xboxzero.github.io/DawSynthDoom/

## Signal chain

```
ANY INPUT ─ BASS VOICE (C++ → WebAssembly) ─ PRE-AMP EQ ─ NAM AMP + CAB ─┬─ DRY (mono, centre) ─┐   DRUM GROOVE
            track/any → temper → PATTERN → osc/fifth/sub → mod → ladder  └─ DELAY/REVERB/MOD/   ├─ PUMP ─┴─ RACK ─ IR SIM ─ GUARD ─ EQ ─ GLUE
                                                                            DOUBLER (wet) ──────┘        ─ MASTER ─ FINAL BOOST ─ LIMITER ─ CEILING ─ LOOP BREAKER ─ OUT
```

- **Loud enough everywhere:**
  - **AUTO LEVEL** gives the same full bass level from any input level (tested from -10 to -45 dBFS).
  - **FINAL BOOST**, after the master fader, has LOW BOOST, PUNCH, PRESENCE, bass **HARMONICS** (so small speakers and guitar amps can hear the bass), LOUDNESS into the limiter, a speaker-protection cut, and a soft-clip ceiling.
  - **OUTPUT TO** profiles: HEADPHONES, PA / BASS AMP, **GUITAR AMP** and PHONE / LAPTOP. The guitar-amp and phone profiles lift the bass into the speaker's range (lowest note E2), add harmonics and cut the sub-lows the speaker can't play.
- **Any signal becomes bass:** with **ANY SIGNAL** on, unpitched sounds (drums, noise, voice, scratches) also play bass notes in your key and temperament. Each hit picks a note from how bright it is. Steady hiss never triggers notes.
- **Music:**
  - **Bass patterns**, locked to the BPM and built on the note you play, always in key and temperament: root 8ths, octaves, root-5th, walking, disco, acid, dub, gallop and random. They have note length, swing, and LATCH (keeps playing after you stop).
  - **FIFTH** adds a power-fifth layer tuned to the temperament's own fifth.
  - **Drums** (four-on-the-floor, rock, half-time, breakbeat, dub, trap) share the same grid. PUMP ducks the bass on each kick (sidechain).
  - **TAP** tempo.
- **Bass voice:** the pitch of your synth is tracked with an adaptive YIN window, about 2 periods long, updated every ~4 ms. A note only changes when two detections in a row agree, which removes octave blips. The voice follows the synth's own envelope, so its dynamics come from your playing.
- **Well temperament:** every note snaps to the nearest note of your key and scale in Werckmeister III, Kirnberger III, Vallotti, Young II or equal temperament, with A at your reference pitch (415–466 Hz). SNAP, GLIDE, OCTAVE and BASS RANGE (which folds notes into E1–D#3) shape how it follows.
- **Sound:** a morphing saw / square / pulse oscillator, sub oscillator, wavefolder, grit, ladder low-pass with envelope, and drive. SYNTH IN blends the original synth back in.
- **Pre-amp EQ:** a draggable 4-band EQ with low cut between the bass voice and the amp.
- **Modulation:**
  - Two LFOs run inside the C++ DSP, with 9 shapes: sine, triangle, saw up, saw down, square, sample & hold, smooth random, pluck and stairs.
  - Each can target cutoff, pitch, amp, fold, shape, drive, resonance, sub, noise, octave jump, direct input or the fifth layer.
  - **ENVELOPE** modulation: your playing dynamics drive any of the same targets, positive or negative.
  - Each has a free rate, or can sync to the BPM (1/1 to 1/16, dotted, triplets), with optional retrigger on every new note.
  - The **MOD** wet effect switches between chorus, flanger, vibrato, phaser, rotary, ring mod and autopan, with rate, depth, feedback, LFO shape, stereo spread, ring frequency and tone.
- **IR sim:** the last effect before the master. Choose a built-in room, plate, hall, spring, bass cab, radio, phone or **sand dune** soundscape, or load any `.wav` IR or a TONE3000 IR.
  - The sand dune IR is open desert: almost no early reflections, a few distant soft slaps off dune faces, and a long airy tail that loses its highs quickly. It also has a faint "singing sand" drone near 95 Hz and a slow wind swirl. It has mix, low cut, high cut and level.
- **3D FX pad:** X, Y and Z each drive any parameter you pick, such as cutoff, fold, space or drive. Drag in the cube for X/Y; set Z with its fader, the wheel or a pinch. ORBIT plays a 3D path; QUBIT lets a simulated two-qubit quantum state steer the point.
- **Wet · dry · wet:** the bass stays dry and mono in the centre. The effects are high-passed sends on the sides, so the low end stays tight.
- **End rack:** phaser, tremolo, auto filter, bitcrush, stutter and a looper.
- **Input:**
  - **DIRECT** (35% by default) keeps your own input audible even when the bass voice can't find a pitch, for example with chords, voices or noise.
  - **Channel meters** show a live level for each interface input. **AUTO CHANNEL** switches to the input that actually has signal, because many interfaces put the instrument on IN 2.
  - **Status:** the INPUT panel shows the device, or a plain explanation (blocked, busy, not found, no signal, needs https), with **RETRY INPUT**.
  - **Muted output:** a header button says when the output is muted and turns sound on with one tap.
- **3D monitor:** a perspective spectrogram. Each slice is coloured by what it hears: tonal, mains hum, or white / pink / brown / blue / violet noise, judged from spectral flatness and slope. Drag it to tilt.

## Feedback and phones

- The output starts **muted** until you turn the monitor on.
- **PHONE SAFE** turns on the browser's echo cancellation and caps the output at -9 dB. It's on by default on touch devices; turn it off for a clean interface line input.
- **No noise when you're not playing:**
  - The DIRECT input is gated as well as the bass voice, so interface hiss and hum never reach the amp, compressor or reverb.
  - **AUTO GATE** learns your noise floor and keeps the gate about 10 dB above it.
  - The bass voice only plays while it has a locked pitch, so noise can't trigger random notes.
  - The INPUT panel shows the noise floor and the gate level.
- **Loop breaker:** the bass voice re-synthesises whatever it hears, so speaker → mic feedback can turn into a self-sustaining note.
  - When the input is suspiciously steady, the engine dips the output 6 dB for 120 ms. The dip happens after the limiter, so it's real at the speaker.
  - The input is then checked on the audio clock. If it followed the dip, it's our own sound coming back, and the output drops 24 dB for 1.5 s, which starves the loop.
  - If the loop keeps coming back, the output stays 12 dB lower (6 dB more each further time) and PHONE SAFE turns on. RESET GUARD releases it.
  - A real synth never follows our output, so held notes are left alone, and probes on a held note back off from every 2 s to every 16 s.
- **Feedback guard:** cuts narrow notches only above 150 Hz, and only on peaks that keep ringing while the notes change, or while nothing is played. Bass notes and their harmonics are never notched. It also briefly ducks the master on a loud howl.
- **Microphone inputs** (laptop, phone, webcam, headset) automatically switch on PHONE SAFE (echo cancellation). Audio interfaces stay raw.
- On phones:
  - The 3D monitor sits at the top, with a tab bar (BASS / 3D / FX / MASTER) at the bottom.
  - Knobs turn with a **left/right swipe**, so vertical swipes scroll the page.

## Low latency

There is one AudioWorklet for the whole voice. With LOWEST LATENCY on, the AudioContext asks for the smallest buffer. The interface input is opened raw, with no processing, at 48 kHz. The current latency is shown in the header.

## Development (C++ DSP + TypeScript UI)

- **DSP:** the audio core is `dsp/bass.cpp`, freestanding C++ (no libc) compiled with clang to `dist/bass.wasm`. It's about 10 KB with no imports, and runs ~29× faster than realtime on one core.
- **UI:** the interface is strict TypeScript in `src/`, bundled with esbuild.
- **Hosting:** `dist/` is committed, so GitHub Pages serves the site with no build step.
- **Toolchain:** building the DSP needs `clang` and `lld`. On Ubuntu, install them with `apt install clang lld`.

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
2. Register `https://xboxzero.github.io/DawSynthDoom/callback.html` as a redirect URI, with exactly these capital letters. The site always sends this URL, even when opened as `/dawsynthdoom/`.
3. Paste the `t3k_pub_…` key in the TONE3000 dialog. It opens from the BASS AMP or IR SIM panel.

How the sign-in works:

- **Popup:** the picker opens inside your click, so Safari doesn't block it.
- **Popups blocked:** the page goes to TONE3000 itself and finishes the sign-in when it comes back.
- **Errors:** any error, such as a wrong key or an unregistered redirect, is shown inside the dialog.

No key? Browse tone3000.com, download a `.nam` or `.wav`, and drop it on the page.

## Credits

`vendor/nam/` is the Neural Amp Modeler WebAssembly engine from [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) (MIT, see `vendor/nam/LICENSE`), based on Steven Atkinson's [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore). The fonts are Permanent Marker and Sedgwick Ave Display from Google Fonts.
