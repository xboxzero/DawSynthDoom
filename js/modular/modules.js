// Audio, control and data modules for the patch editor.
//
// Port kinds:  audio (sound)   cv (modulation signal)   gate (note on/off events)
//              data (per-frame numbers, like TouchDesigner CHOPs)   tex (images, like TOPs)
//
// make(ctx, h) returns an instance:
//   inputs/outputs  { portId: AudioNode | AudioParam }  for audio + cv ports
//   apply(name, v)  param changed            onGate(port, on, time)  gate event in
//   data            { portId: number }       data outputs, refreshed in frame()
//   schedule(t)     audio-clock scheduler (runs every 25 ms)
//   frame()         per animation frame      build(body)  custom UI
//   save()/load(o)  extra state               destroy()

import { NamEngine } from '../../vendor/nam/nam-engine.js';
import { makeCurve, ampCurve, makeReverbIR, makeCabIR } from '../engine.js';

const STARTER = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/refs/heads/main/ui/public/';
const sm = (p, v, ctx, t = 0.015) => { p.cancelScheduledValues(ctx.currentTime); p.setTargetAtTime(v, ctx.currentTime, t); };
const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];

function fileButton(body, label, accept, onFile) {
  const row = el('div', 'n-row', body);
  const input = el('input', '', row);
  input.type = 'file'; input.accept = accept; input.hidden = true;
  const b = el('button', 'btn small', row);
  b.type = 'button'; b.textContent = label;
  b.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  return row;
}

function miniButton(parent, label, onClick, cls = '') {
  const b = el('button', `btn small ${cls}`, parent);
  b.type = 'button'; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Shared analyser readout helpers for SCOPE / ANALYZE / visuals.
function bandEnergy(freq, rate, lo, hi) {
  const bins = freq.length;
  const a = Math.max(1, Math.floor((lo / (rate / 2)) * bins));
  const b = Math.min(bins - 1, Math.ceil((hi / (rate / 2)) * bins));
  let s = 0;
  for (let i = a; i <= b; i++) s += freq[i];
  return s / Math.max(1, b - a + 1) / 255;
}

let namEnginePromise = null;
function namEngine(ctx) {
  if (!namEnginePromise) namEnginePromise = NamEngine.attach(ctx, { assetBaseUrl: new URL('../../vendor/nam/', import.meta.url) });
  return namEnginePromise;
}

export const MODULES = {
  // ───────────────────────── sources ─────────────────────────
  input: {
    title: 'AUDIO IN', family: 'source',
    params: { gain: { label: 'GAIN', min: -24, max: 24, def: 0, unit: 'dB' }, ch: { label: 'CH', min: 0, max: 2, def: 0, step: 1, options: ['IN 1', 'IN 2', '1+2'] } },
    inputs: [],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx, h) {
      const split = ctx.createChannelSplitter(2);
      const g0 = ctx.createGain(), g1 = ctx.createGain();
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const out = ctx.createGain();
      split.connect(g0, 0); split.connect(g1, 1); g0.connect(mono); g1.connect(mono); mono.connect(out);
      let stream = null, src = null, channels = 1, select = null;
      const applyCh = () => {
        const ch = h.param('ch'); const st = channels > 1;
        sm(g0.gain, ch === 1 && st ? 0 : ch === 2 && st ? 0.5 : 1, ctx);
        sm(g1.gain, ch === 1 && st ? 1 : ch === 2 && st ? 0.5 : 0, ctx);
      };
      const open = async (deviceId) => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (src) src.disconnect();
        const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: 0 };
        if (deviceId) audio.deviceId = { exact: deviceId };
        stream = await navigator.mediaDevices.getUserMedia({ audio });
        src = ctx.createMediaStreamSource(stream);
        src.connect(split);
        channels = stream.getAudioTracks()[0].getSettings?.().channelCount ?? 1;
        applyCh();
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
        select.innerHTML = '';
        devs.forEach((d, i) => { const o = el('option', '', select); o.value = d.deviceId; o.textContent = d.label || `Input ${i + 1}`; });
        select.value = stream.getAudioTracks()[0].getSettings?.().deviceId ?? '';
      };
      return {
        outputs: { out },
        apply(name, v) { if (name === 'gain') sm(out.gain, 10 ** (v / 20), ctx); else applyCh(); },
        build(body) {
          select = el('select', 'n-select', body);
          select.addEventListener('change', () => open(select.value).catch((e) => h.toast(e.message, 'err')));
          open().catch((e) => h.toast(`Input: ${e.message}`, 'err'));
        },
        destroy() { if (stream) stream.getTracks().forEach((t) => t.stop()); },
      };
    },
  },

  osc: {
    title: 'OSC', family: 'source',
    params: {
      wave: { label: 'WAVE', min: 0, max: 3, def: 2, step: 1, options: ['SINE', 'TRI', 'SAW', 'SQR'] },
      freq: { label: 'FREQ', min: 20, max: 4000, def: 110, scale: 'log', unit: 'Hz' },
      fine: { label: 'FINE', min: -100, max: 100, def: 0, format: (v) => Math.round(v) + 'c' },
      fm: { label: 'FM AMT', min: 0, max: 2000, def: 0, format: (v) => Math.round(v) + 'Hz' },
      level: { label: 'LEVEL', def: 0.5, unit: '%' },
    },
    inputs: [{ id: 'pitch', kind: 'cv', label: 'PITCH' }, { id: 'fm', kind: 'audio', label: 'FM' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const o = ctx.createOscillator();
      const pitch = ctx.createGain();        // cents in
      const fm = ctx.createGain(); fm.gain.value = 0;
      const out = ctx.createGain();
      pitch.connect(o.detune); fm.connect(o.frequency); o.connect(out); o.start();
      return {
        inputs: { pitch, fm }, outputs: { out },
        apply(n, v) {
          if (n === 'wave') o.type = WAVES[v];
          else if (n === 'freq') sm(o.frequency, v, ctx);
          else if (n === 'fine') sm(o.detune, v, ctx);
          else if (n === 'fm') sm(fm.gain, v, ctx);
          else if (n === 'level') sm(out.gain, v, ctx);
        },
        destroy() { o.stop(); },
      };
    },
  },

  noise: {
    title: 'NOISE', family: 'source',
    params: { color: { label: 'COLOR', min: 200, max: 20000, def: 20000, scale: 'log', unit: 'Hz' }, level: { label: 'LEVEL', def: 0.3, unit: '%' } },
    inputs: [],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const out = ctx.createGain();
      s.connect(lp); lp.connect(out); s.start();
      return {
        outputs: { out },
        apply(n, v) { if (n === 'color') sm(lp.frequency, v, ctx); else sm(out.gain, v, ctx); },
        destroy() { s.stop(); },
      };
    },
  },

  // ───────────────────────── control ─────────────────────────
  keys: {
    title: 'KEYS', family: 'control', w: 300,
    params: { oct: { label: 'OCTAVE', min: -2, max: 3, def: 0, step: 1, format: (v) => (v > 0 ? '+' : '') + v }, glide: { label: 'GLIDE', min: 0, max: 0.5, def: 0.01, unit: 's' } },
    inputs: [],
    outputs: [{ id: 'pitch', kind: 'cv', label: 'PITCH' }, { id: 'gate', kind: 'gate', label: 'GATE' }],
    make(ctx, h) {
      const pitch = ctx.createConstantSource(); pitch.offset.value = 0; pitch.start();
      const held = [];
      let midi = null;
      const keyEls = new Map();
      const noteOn = (n) => {
        if (!held.includes(n)) held.push(n);
        const t = ctx.currentTime;
        const cents = (n - 45 + h.param('oct') * 12) * 100;   // relative to A2 (110 Hz)
        pitch.offset.cancelScheduledValues(t);
        pitch.offset.setTargetAtTime(cents, t, Math.max(0.001, h.param('glide') / 3));
        h.gate('gate', true, t);
        keyEls.get(n)?.classList.add('down');
      };
      const noteOff = (n) => {
        const i = held.indexOf(n);
        if (i >= 0) held.splice(i, 1);
        keyEls.get(n)?.classList.remove('down');
        if (held.length) noteOn(held[held.length - 1]);
        else h.gate('gate', false, ctx.currentTime);
      };
      const KB = 'awsedftgyhujkolp;';
      const onKey = (e) => {
        if (e.repeat || e.target.closest?.('input, select, textarea')) return;
        const i = KB.indexOf(e.key.toLowerCase());
        if (i < 0) return;
        const n = 48 + i;
        if (e.type === 'keydown') noteOn(n); else noteOff(n);
      };
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      navigator.requestMIDIAccess?.().then((m) => {
        midi = m;
        const hook = () => m.inputs.forEach((inp) => {
          inp.onmidimessage = (ev) => {
            const [st, n, vel] = ev.data;
            const cmd = st & 0xf0;
            if (cmd === 0x90 && vel > 0) noteOn(n);
            else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) noteOff(n);
          };
        });
        hook();
        m.onstatechange = hook;
      }).catch(() => {});
      return {
        outputs: { pitch },
        build(body) {
          const kb = el('div', 'n-keys', body);
          const black = [1, 3, 6, 8, 10];
          for (let n = 48; n < 72; n++) {
            const k = el('div', black.includes(n % 12) ? 'k black' : 'k white', kb);
            keyEls.set(n, k);
            k.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); k.setPointerCapture(e.pointerId); noteOn(n); });
            const up = () => noteOff(n);
            k.addEventListener('pointerup', up);
            k.addEventListener('pointercancel', up);
          }
          el('div', 'n-hint', body).textContent = 'Touch, computer keys A–; or MIDI';
        },
        destroy() {
          window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey);
          if (midi) midi.inputs.forEach((i) => { i.onmidimessage = null; });
          pitch.stop();
        },
      };
    },
  },

  seq: {
    title: 'SEQUENCER', family: 'control', w: 300,
    params: {
      bpm: { label: 'BPM', min: 40, max: 220, def: 120, step: 1, format: (v) => String(Math.round(v)) },
      len: { label: 'GATE', min: 0.05, max: 1, def: 0.5, unit: '%' },
      steps: { label: 'STEPS', min: 2, max: 16, def: 8, step: 1, format: (v) => String(v) },
      run: { label: 'RUN', def: 1, step: 1, options: ['STOP', 'RUN'] },
    },
    inputs: [],
    outputs: [{ id: 'pitch', kind: 'cv', label: 'PITCH' }, { id: 'gate', kind: 'gate', label: 'GATE' }, { id: 'step', kind: 'data', label: 'STEP' }],
    make(ctx, h) {
      const pitch = ctx.createConstantSource(); pitch.start();
      let steps = [0, 12, 7, 3, 0, 15, 10, 7, 0, 12, 7, 3, 5, 3, 2, 0].map((n, i) => ({ n, on: i % 8 !== 6 }));
      let next = ctx.currentTime + 0.1, idx = 0, canvas = null, playing = -1;
      const queue = [];
      const draw = () => {
        if (!canvas) return;
        const g = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, hh = canvas.clientHeight;
        canvas.width = w * dpr; canvas.height = hh * dpr;
        g.scale(dpr, dpr);
        const N = h.param('steps');
        const cw = w / N;
        for (let i = 0; i < N; i++) {
          const s = steps[i];
          g.fillStyle = i === playing ? '#2a3348' : '#141927';
          g.fillRect(i * cw + 1, 0, cw - 2, hh);
          const y = hh - (s.n / 24) * (hh - 8) - 6;
          g.fillStyle = s.on ? (i === playing ? '#fff' : '#ffd23f') : '#3a4152';
          g.fillRect(i * cw + 3, y, cw - 6, 5);
          if (s.on) { g.globalAlpha = 0.25; g.fillRect(i * cw + 3, y + 5, cw - 6, hh - y - 5); g.globalAlpha = 1; }
        }
      };
      const data = { step: 0 };
      return {
        outputs: { pitch }, data,
        build(body) {
          canvas = el('canvas', 'n-seq', body);
          let drag = null;
          canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            canvas.setPointerCapture(e.pointerId);
            const r = canvas.getBoundingClientRect();
            const i = Math.floor(((e.clientX - r.left) / r.width) * h.param('steps'));
            drag = { i, y: e.clientY, n: steps[i].n, moved: false, h: r.height };
          });
          canvas.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dy = (drag.y - e.clientY) / drag.h;
            if (Math.abs(drag.y - e.clientY) > 4) drag.moved = true;
            if (drag.moved) { steps[drag.i].n = Math.max(0, Math.min(24, Math.round(drag.n + dy * 24))); draw(); }
          });
          canvas.addEventListener('pointerup', () => {
            if (drag && !drag.moved) { steps[drag.i].on = !steps[drag.i].on; draw(); }
            if (drag) h.changed();
            drag = null;
          });
          el('div', 'n-hint', body).textContent = 'Drag a step up/down for pitch, tap to mute it';
          requestAnimationFrame(draw);
        },
        apply(n) { if (n === 'steps') draw(); if (n === 'run') next = ctx.currentTime + 0.05; },
        schedule() {
          if (h.param('run') < 0.5) return;
          const N = h.param('steps');
          const dur = 60 / h.param('bpm') / 2;    // eighth notes
          while (next < ctx.currentTime + 0.12) {
            idx %= N;
            const s = steps[idx];
            queue.push({ t: next, i: idx });
            if (s.on) {
              pitch.offset.setValueAtTime(s.n * 100, next);
              h.gate('gate', true, next);
              h.gate('gate', false, next + dur * h.param('len'));
            }
            idx++;
            next += dur;
          }
        },
        frame() {
          while (queue.length && queue[0].t <= ctx.currentTime) { playing = queue.shift().i; data.step = playing; draw(); }
        },
        save() { return { steps }; },
        load(o) { if (o?.steps) steps = o.steps; draw(); },
        destroy() { pitch.stop(); },
      };
    },
  },

  adsr: {
    title: 'ENVELOPE', family: 'control',
    params: {
      a: { label: 'ATTACK', min: 0.001, max: 2, def: 0.005, scale: 'log', unit: 's' },
      d: { label: 'DECAY', min: 0.01, max: 3, def: 0.25, scale: 'log', unit: 's' },
      s: { label: 'SUSTAIN', def: 0.5, unit: '%' },
      r: { label: 'RELEASE', min: 0.01, max: 5, def: 0.3, scale: 'log', unit: 's' },
    },
    inputs: [{ id: 'gate', kind: 'gate', label: 'GATE' }],
    outputs: [{ id: 'out', kind: 'cv', label: 'ENV' }, { id: 'level', kind: 'data', label: 'LVL' }],
    make(ctx, h) {
      const c = ctx.createConstantSource(); c.offset.value = 0; c.start();
      const p = c.offset;
      const data = { level: 0 };
      let on = false, t0 = 0, tOff = 0, lvlOff = 0;
      return {
        outputs: { out: c }, data,
        onGate(port, gateOn, t) {
          const a = h.param('a'), d = h.param('d'), s = h.param('s'), r = h.param('r');
          if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
          if (gateOn) {
            p.linearRampToValueAtTime(1, t + a);
            p.setTargetAtTime(s, t + a, d / 3);
            on = true; t0 = t;
          } else {
            p.setTargetAtTime(0, t, r / 3);
            on = false; tOff = t; lvlOff = data.level;
          }
        },
        frame() {
          // approximate the envelope level for visuals
          const now = ctx.currentTime;
          const a = h.param('a'), d = h.param('d'), s = h.param('s'), r = h.param('r');
          if (on) data.level = now - t0 < a ? (now - t0) / a : s + (1 - s) * Math.exp(-(now - t0 - a) / (d / 3));
          else data.level = now >= tOff ? lvlOff * Math.exp(-(now - tOff) / (r / 3)) : data.level;
        },
        destroy() { c.stop(); },
      };
    },
  },

  lfo: {
    title: 'LFO', family: 'control',
    params: {
      wave: { label: 'WAVE', min: 0, max: 3, def: 0, step: 1, options: ['SINE', 'TRI', 'SAW', 'SQR'] },
      rate: { label: 'RATE', min: 0.02, max: 30, def: 1, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' },
      depth: { label: 'DEPTH', def: 0.5, unit: '%' },
    },
    inputs: [],
    outputs: [{ id: 'out', kind: 'cv', label: 'CV' }, { id: 'value', kind: 'data', label: 'VAL' }],
    make(ctx, h) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); o.start();
      const data = { value: 0 };
      const t0 = ctx.currentTime;
      return {
        outputs: { out: g }, data,
        apply(n, v) { if (n === 'wave') o.type = WAVES[v]; else if (n === 'rate') sm(o.frequency, v, ctx); else sm(g.gain, v, ctx); },
        frame() {
          const ph = ((ctx.currentTime - t0) * h.param('rate')) % 1;
          const w = h.param('wave');
          const v = w === 0 ? Math.sin(ph * Math.PI * 2) : w === 1 ? 1 - 4 * Math.abs(ph - 0.5) : w === 2 ? 2 * ph - 1 : ph < 0.5 ? 1 : -1;
          data.value = (v * 0.5 + 0.5) * h.param('depth');
        },
        destroy() { o.stop(); },
      };
    },
  },

  follow: {
    title: 'ENV FOLLOW', family: 'control',
    params: { speed: { label: 'SPEED', min: 1, max: 60, def: 12, scale: 'log', format: (v) => v.toFixed(1) + 'Hz' }, amt: { label: 'AMOUNT', min: 0, max: 8, def: 3 } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'out', kind: 'cv', label: 'CV' }],
    make(ctx) {
      const inp = ctx.createGain();
      const rect = ctx.createWaveShaper();
      const curve = new Float32Array(1025);
      for (let i = 0; i < curve.length; i++) curve[i] = Math.abs(i / 512 - 1);
      rect.curve = curve;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const out = ctx.createGain();
      inp.connect(rect); rect.connect(lp); lp.connect(out);
      return {
        inputs: { in: inp }, outputs: { out },
        apply(n, v) { if (n === 'speed') sm(lp.frequency, v, ctx); else sm(out.gain, v, ctx); },
      };
    },
  },

  // ───────────────────────── filters + fx ─────────────────────────
  vcf: {
    title: 'FILTER', family: 'fx',
    params: {
      type: { label: 'TYPE', min: 0, max: 3, def: 0, step: 1, options: ['LOWPASS', 'HIGHPASS', 'BANDPASS', 'NOTCH'] },
      cut: { label: 'CUTOFF', min: 30, max: 16000, def: 1200, scale: 'log', unit: 'Hz' },
      q: { label: 'RESO', min: 0.3, max: 25, def: 4, scale: 'log' },
      amt: { label: 'CV OCT', min: 0, max: 6, def: 3, format: (v) => v.toFixed(1) + 'oct' },
    },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }, { id: 'cut', kind: 'cv', label: 'CUT CV' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const f = ctx.createBiquadFilter();
      const cv = ctx.createGain();
      cv.connect(f.detune);
      return {
        inputs: { in: f, cut: cv }, outputs: { out: f },
        apply(n, v) {
          if (n === 'type') f.type = ['lowpass', 'highpass', 'bandpass', 'notch'][v];
          else if (n === 'cut') sm(f.frequency, v, ctx);
          else if (n === 'q') sm(f.Q, v, ctx);
          else sm(cv.gain, v * 1200, ctx);
        },
      };
    },
  },

  vca: {
    title: 'VCA', family: 'fx',
    params: { level: { label: 'LEVEL', def: 0, unit: '%' }, cv: { label: 'CV AMT', def: 1, unit: '%' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }, { id: 'cv', kind: 'cv', label: 'CV' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const g = ctx.createGain(); g.gain.value = 0;
      const cv = ctx.createGain();
      cv.connect(g.gain);
      return {
        inputs: { in: g, cv }, outputs: { out: g },
        apply(n, v) { if (n === 'level') sm(g.gain, v, ctx); else sm(cv.gain, v, ctx); },
      };
    },
  },

  drive: {
    title: 'DRIVE', family: 'fx',
    params: {
      type: { label: 'TYPE', min: 0, max: 3, def: 0, step: 1, options: ['SOFT', 'HARD', 'FUZZ', 'FOLD'] },
      drive: { label: 'DRIVE', def: 0.4, unit: '%' },
      tone: { label: 'TONE', min: 400, max: 14000, def: 5000, scale: 'log', unit: 'Hz' },
      level: { label: 'LEVEL', def: 0.5, unit: '%' },
    },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx, h) {
      const sh = ctx.createWaveShaper(); sh.oversample = '4x';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const out = ctx.createGain();
      sh.connect(lp); lp.connect(out);
      return {
        inputs: { in: sh }, outputs: { out },
        apply(n, v) {
          if (n === 'type' || n === 'drive') sh.curve = makeCurve(h.param('type'), h.param('drive'));
          else if (n === 'tone') sm(lp.frequency, v, ctx);
          else sm(out.gain, v, ctx);
        },
      };
    },
  },

  delay: {
    title: 'DELAY', family: 'fx',
    params: {
      time: { label: 'TIME', min: 0.01, max: 2, def: 0.33, scale: 'log', unit: 's' },
      fb: { label: 'FEEDBACK', max: 0.95, def: 0.4, unit: '%' },
      tone: { label: 'TONE', min: 500, max: 14000, def: 5000, scale: 'log', unit: 'Hz' },
      mix: { label: 'MIX', def: 0.4, unit: '%' },
    },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }, { id: 'time', kind: 'cv', label: 'TIME CV' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const d = ctx.createDelay(2.5), fb = ctx.createGain(), lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const cv = ctx.createGain(); cv.gain.value = 0.01;
      inp.connect(dry); dry.connect(out);
      inp.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(out);
      cv.connect(d.delayTime);
      return {
        inputs: { in: inp, time: cv }, outputs: { out },
        apply(n, v) {
          if (n === 'time') sm(d.delayTime, v, ctx, 0.05);
          else if (n === 'fb') sm(fb.gain, v, ctx);
          else if (n === 'tone') sm(lp.frequency, v, ctx);
          else { sm(wet.gain, v, ctx); sm(dry.gain, 1 - v, ctx); }
        },
      };
    },
  },

  reverb: {
    title: 'REVERB', family: 'fx',
    params: { size: { label: 'SIZE', min: 0.3, max: 10, def: 2.5, scale: 'log', unit: 's' }, mix: { label: 'MIX', def: 0.35, unit: '%' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx, h) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const conv = ctx.createConvolver();
      inp.connect(dry); dry.connect(out); inp.connect(conv); conv.connect(wet); wet.connect(out);
      let timer = null;
      return {
        inputs: { in: inp }, outputs: { out },
        apply(n, v) {
          if (n === 'size') { clearTimeout(timer); timer = setTimeout(() => { conv.buffer = makeReverbIR(ctx, h.param('size'), 0.6); }, 120); }
          else { sm(wet.gain, v, ctx); sm(dry.gain, 1 - v * 0.6, ctx); }
        },
      };
    },
  },

  // ───────────────────────── amp ─────────────────────────
  nam: {
    title: 'NAM AMP', family: 'amp',
    params: { gain: { label: 'GAIN', min: -24, max: 24, def: 0, unit: 'dB' }, out: { label: 'OUTPUT', min: -30, max: 12, def: 0, unit: 'dB' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx, h) {
      const pre = ctx.createGain(), out = ctx.createGain();
      const fb = ctx.createWaveShaper(); fb.curve = ampCurve(); fb.oversample = '4x';
      const fbOut = ctx.createGain(); fbOut.gain.value = 0.3;
      pre.connect(fb); fb.connect(fbOut); fbOut.connect(out);
      const namGain = ctx.createGain(); namGain.gain.value = 0; namGain.connect(out);
      let node = null, name = 'built-in amp', label = null;
      const show = () => { if (label) label.textContent = name; };
      const load = async (text, n) => {
        if (!node) {
          node = await (await namEngine(ctx)).createNode();
          pre.connect(node);
          node.connect(namGain);
        }
        const info = await node.loadModel(text);
        // NAM models report their loudness; normalise them to -18 dB like the plugin does
        sm(namGain.gain, info?.hasLoudness ? 10 ** ((-18 - info.loudness) / 20) : 1, ctx, 0.05);
        sm(fbOut.gain, 0, ctx, 0.05);
        name = n; show(); h.changed();
      };
      const fetchLoad = async (url, n) => {
        try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); await load(await r.text(), n); h.toast(`NAM: ${n}`); }
        catch (e) { h.toast(`NAM load failed: ${e.message}`, 'err'); }
      };
      return {
        inputs: { in: pre }, outputs: { out },
        apply(n, v) { sm((n === 'gain' ? pre : out).gain, 10 ** (v / 20), ctx); },
        build(body) {
          label = el('div', 'n-file', body); show();
          const row = fileButton(body, 'Load .nam', '.nam', async (f) => {
            try { await load(await f.text(), f.name.replace(/\.nam$/i, '')); } catch (e) { h.toast(`NAM: ${e.message}`, 'err'); }
          });
          miniButton(row, 'AC10', () => fetchLoad(STARTER + 'models/ac10.nam', 'Vox AC10'), 'ghost');
          miniButton(row, 'Deluxe', () => fetchLoad(STARTER + 'models/deluxe.nam', 'Fender Deluxe'), 'ghost');
        },
        save() { return { name, url: name === 'Vox AC10' ? STARTER + 'models/ac10.nam' : name === 'Fender Deluxe' ? STARTER + 'models/deluxe.nam' : null }; },
        load(o) { if (o?.url) fetchLoad(o.url, o.name); },
        destroy() { node?.dispose(); },
      };
    },
  },

  cab: {
    title: 'CAB IR', family: 'amp',
    params: { mix: { label: 'MIX', def: 1, unit: '%' }, level: { label: 'LEVEL', min: -24, max: 12, def: 0, unit: 'dB' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx, h) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const conv = ctx.createConvolver();
      inp.connect(dry); dry.connect(out); inp.connect(conv); conv.connect(wet); wet.connect(out);
      let name = 'built-in cab', label = null;
      makeCabIR(ctx.sampleRate).then((b) => { if (!conv.buffer) conv.buffer = b; });
      const load = async (bytes, n) => { conv.buffer = await ctx.decodeAudioData(bytes); name = n; if (label) label.textContent = n; h.changed(); };
      return {
        inputs: { in: inp }, outputs: { out },
        apply(n, v) {
          if (n === 'mix') { sm(wet.gain, v, ctx); sm(dry.gain, 1 - v, ctx); }
          else sm(out.gain, 10 ** (v / 20), ctx);
        },
        build(body) {
          label = el('div', 'n-file', body); label.textContent = name;
          const row = fileButton(body, 'Load IR', 'audio/*,.wav', async (f) => {
            try { await load(await f.arrayBuffer(), f.name); } catch (e) { h.toast(`IR: ${e.message}`, 'err'); }
          });
          miniButton(row, 'Celestion', async () => {
            try { const r = await fetch(STARTER + 'irs/celestion.wav'); await load(await r.arrayBuffer(), 'Celestion'); } catch (e) { h.toast(`IR: ${e.message}`, 'err'); }
          }, 'ghost');
        },
      };
    },
  },

  // ───────────────────────── mix / out ─────────────────────────
  mixer: {
    title: 'MIXER', family: 'mix',
    params: { a: { label: 'IN A', def: 0.8, unit: '%' }, b: { label: 'IN B', def: 0.8, unit: '%' }, c: { label: 'IN C', def: 0.8, unit: '%' }, d: { label: 'IN D', def: 0.8, unit: '%' } },
    inputs: [{ id: 'a', kind: 'audio', label: 'A' }, { id: 'b', kind: 'audio', label: 'B' }, { id: 'c', kind: 'audio', label: 'C' }, { id: 'd', kind: 'audio', label: 'D' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const out = ctx.createGain();
      const ins = {};
      for (const k of 'abcd') { ins[k] = ctx.createGain(); ins[k].connect(out); }
      return { inputs: ins, outputs: { out }, apply(n, v) { sm(ins[n].gain, v, ctx); } };
    },
  },

  pan: {
    title: 'PAN', family: 'mix',
    params: { pan: { label: 'PAN', min: -1, max: 1, def: 0 }, cv: { label: 'CV AMT', def: 1, unit: '%' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }, { id: 'cv', kind: 'cv', label: 'CV' }],
    outputs: [{ id: 'out', kind: 'audio', label: 'OUT' }],
    make(ctx) {
      const p = ctx.createStereoPanner(); const cv = ctx.createGain(); cv.connect(p.pan);
      return { inputs: { in: p, cv }, outputs: { out: p }, apply(n, v) { sm(n === 'pan' ? p.pan : cv.gain, v, ctx); } };
    },
  },

  output: {
    title: 'OUTPUT', family: 'mix',
    params: { vol: { label: 'VOLUME', def: 0.7, unit: '%' }, limit: { label: 'LIMIT', min: 0, max: 1, def: 1, step: 1, options: ['OFF', 'ON'] } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [],
    make(ctx, h) {
      const inp = ctx.createGain();
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
      const lOn = ctx.createGain(), lOff = ctx.createGain(), out = ctx.createGain();
      inp.connect(lim); lim.connect(lOn); inp.connect(lOff); lOn.connect(out); lOff.connect(out);
      out.connect(h.master);
      const an = ctx.createAnalyser(); an.fftSize = 1024; out.connect(an);
      const buf = new Float32Array(1024);
      let bar = null;
      return {
        inputs: { in: inp },
        apply(n, v) {
          if (n === 'vol') sm(out.gain, v * v * 1.6, ctx);
          else { sm(lOn.gain, v, ctx); sm(lOff.gain, 1 - v, ctx); }
        },
        build(body) { const m = el('div', 'n-meter', body); bar = el('i', '', m); },
        frame() {
          an.getFloatTimeDomainData(buf);
          let pk = 0;
          for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
          const db = 20 * Math.log10(pk + 1e-6);
          if (bar) { bar.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%'; bar.classList.toggle('clip', db > -0.5); }
        },
        destroy() { out.disconnect(); },
      };
    },
  },

  scope: {
    title: 'SCOPE', family: 'mix', w: 240,
    params: {},
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [],
    make(ctx) {
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      const buf = new Float32Array(2048);
      let canvas = null;
      return {
        inputs: { in: an },
        build(body) { canvas = el('canvas', 'n-scope', body); },
        frame() {
          if (!canvas) return;
          const dpr = window.devicePixelRatio || 1;
          const w = canvas.clientWidth, hh = canvas.clientHeight;
          if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hh * dpr; }
          const g = canvas.getContext('2d');
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.fillStyle = '#080a10'; g.fillRect(0, 0, w, hh);
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 1; i < 1024; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { s = i; break; }
          g.strokeStyle = '#ff7a2f'; g.lineWidth = 1.6; g.beginPath();
          for (let i = 0; i < 1024; i++) {
            const x = (i / 1024) * w, y = hh / 2 - buf[s + i] * hh * 0.45;
            i ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.stroke();
        },
      };
    },
  },

  // ───────────────────────── data (CHOP-like) ─────────────────────────
  analyze: {
    title: 'ANALYZE', family: 'data',
    params: { gain: { label: 'GAIN', min: 0.25, max: 8, def: 1.5, scale: 'log' }, smooth: { label: 'SMOOTH', min: 0, max: 0.95, def: 0.7, unit: '%' } },
    inputs: [{ id: 'in', kind: 'audio', label: 'IN' }],
    outputs: [{ id: 'level', kind: 'data', label: 'LEVEL' }, { id: 'low', kind: 'data', label: 'LOW' }, { id: 'mid', kind: 'data', label: 'MID' }, { id: 'high', kind: 'data', label: 'HIGH' }],
    make(ctx, h) {
      const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.5;
      const freq = new Uint8Array(an.frequencyBinCount);
      const time = new Float32Array(2048);
      const data = { level: 0, low: 0, mid: 0, high: 0 };
      let bars = null;
      return {
        inputs: { in: an }, data,
        build(body) {
          bars = el('div', 'n-bars', body);
          for (const k of ['level', 'low', 'mid', 'high']) { const b = el('div', 'bar', bars); el('i', '', b); b.dataset.k = k; }
        },
        frame() {
          an.getByteFrequencyData(freq);
          an.getFloatTimeDomainData(time);
          let s = 0;
          for (let i = 0; i < time.length; i++) s += time[i] * time[i];
          const g = h.param('gain'), k = h.param('smooth');
          const raw = {
            level: Math.min(1, Math.sqrt(s / time.length) * 4 * g),
            low: Math.min(1, bandEnergy(freq, ctx.sampleRate, 30, 200) * g),
            mid: Math.min(1, bandEnergy(freq, ctx.sampleRate, 200, 2500) * g),
            high: Math.min(1, bandEnergy(freq, ctx.sampleRate, 2500, 12000) * g * 1.5),
          };
          for (const key of Object.keys(raw)) data[key] = data[key] * k + raw[key] * (1 - k);
          if (bars) for (const b of bars.children) b.firstChild.style.height = (data[b.dataset.k] * 100) + '%';
        },
      };
    },
  },
};

export const FAMILIES = {
  source: { label: 'SOURCES', color: '#ff7a2f' },
  control: { label: 'CONTROL', color: '#ffd23f' },
  fx: { label: 'FILTER + FX', color: '#2fb4ff' },
  amp: { label: 'AMP', color: '#ff3b5c' },
  mix: { label: 'MIX + OUT', color: '#9aa7bd' },
  data: { label: 'DATA (CHOP)', color: '#1fd18b' },
  visual: { label: 'VISUAL (TOP)', color: '#c86bff' },
};

export const KIND_COLORS = { audio: '#ff7a2f', cv: '#ffd23f', gate: '#ff3b5c', data: '#1fd18b', tex: '#39d5ff' };

export function compatible(from, to) {
  if (from === to) return true;
  if ((from === 'audio' || from === 'cv') && (to === 'audio' || to === 'cv')) return true;
  return false;
}
