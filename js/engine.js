// Audio engine — wet / dry / wet live rig.
//
//  INPUT ─ HP ─ GATE+AUTOTUNE ─ PRE EQ ─ AMP (drive · NAM · tone · IR cab) ─┬─ DRY (center) ─────────────┐
//                                                                         └─ sends ─ DELAY  ┐            │
//                                                                                   REVERB ├─ WET BUS ──┤
//                                                                                   CHORUS │ (stereo,   │
//                                                                                   DOUBLER┘  width)    │
//                                                                                                        ▼
//                                     MIX ─ END RACK ─ FEEDBACK GUARD ─ MASTER EQ ─ GLUE ─ MASTER VOL ─ LIMIT ─ OUT

import { NamEngine } from '../vendor/nam/nam-engine.js';
import { Rack } from './rack.js';

const dbToLin = (db) => Math.pow(10, db / 20);
const faderGain = (p) => (p <= 0 ? 0 : p * p * p * 2); // 0.794 ≈ unity, top ≈ +6 dB
export { dbToLin, faderGain };

export const WETS = [
  { id: 'dly', name: 'DELAY', side: 'L' },
  { id: 'rev', name: 'REVERB', side: 'L' },
  { id: 'cho', name: 'CHORUS', side: 'R' },
  { id: 'dbl', name: 'DOUBLER', side: 'R' },
];

export const PRE_BANDS = [
  { type: 'lowshelf', f: 120, q: 0.7 },
  { type: 'peaking', f: 450, q: 1.0 },
  { type: 'peaking', f: 1600, q: 1.0 },
  { type: 'highshelf', f: 5000, q: 0.7 },
];
export const EQ_BANDS = [
  { type: 'lowshelf', f: 90, q: 0.7 },
  { type: 'peaking', f: 280, q: 1.0 },
  { type: 'peaking', f: 1200, q: 1.0 },
  { type: 'peaking', f: 4200, q: 1.0 },
  { type: 'highshelf', f: 10000, q: 0.7 },
];
const GUARD_NOTCHES = 8;

function smooth(param, value, ctx, t = 0.02) {
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, t);
}

export function makeCurve(drive) {
  const n = 2048, c = new Float32Array(n), k = 1 + drive * 40;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
}

function ampCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ((i / (n - 1)) * 2 - 1) * 6;
    c[i] = v >= 0 ? Math.tanh(v) : Math.tanh(v * 0.8) * 1.05;
  }
  return c;
}

function makeReverbIR(ctx, seconds) {
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (1 - (0.25 + 0.45 * t));
      d[i] = lp * Math.pow(1 - t, 2.2) * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return buf;
}

async function makeCabIR(rate) {
  const len = 2048;
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  const imp = off.createBuffer(1, len, rate);
  imp.getChannelData(0)[0] = 1;
  src.buffer = imp;
  let node = src;
  for (const [type, f, q, g] of [['highpass', 75, 0.8, 0], ['peaking', 110, 1.2, 4], ['peaking', 420, 1, -3], ['peaking', 2400, 1.5, 5], ['peaking', 3600, 3, -4], ['lowpass', 5200, 0.9, 0], ['lowpass', 6500, 0.7, 0]]) {
    const b = off.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    node.connect(b);
    node = b;
  }
  node.connect(off.destination);
  src.start();
  return off.startRendering();
}

export class Engine {
  constructor(reg) {
    this.reg = reg;
    this.ctx = null;
    this.started = false;
    this.wet = {};
    this.nam = { node: null, loaded: false, name: '', info: null };
    this.cab = { name: 'Built-in cab' };
    this.revIR = { name: 'Built-in hall', user: false };
    this.source = null;
    this.stream = null;
    this.onStatus = () => {};
    this.onFront = () => {};
    this.chaos = null;           // { id: 0..1 } when qubit chaos is running
    this.chaosDepth = 0;
    this.guard = { notches: [], cand: new Map(), duck: 0, spec: null, events: 0 };
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }

  async start() {
    if (this.started) return;
    const isFirefox = /firefox/i.test(navigator.userAgent);
    const opts = { latencyHint: 'interactive' };
    if (!isFirefox) opts.sampleRate = 48000;   // NAM models are trained at 48 kHz
    this.ctx = new AudioContext(opts);
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('./front-worklet.js', import.meta.url));

    this.buildInput();
    this.buildAmp();
    this.buildMix();
    this.buildWets();
    this.buildMaster();
    this.cabBuffer = await makeCabIR(this.ctx.sampleRate);
    this.cabConv.buffer = this.cabBuffer;

    this.started = true;
    this.reg.applyAll();
    this.initNam();
  }

  // ───────────────────────── input + pre-amp ─────────────────────────
  buildInput() {
    const ctx = this.ctx;
    this.splitter = ctx.createChannelSplitter(2);
    this.chGain = [ctx.createGain(), ctx.createGain()];
    this.inMono = ctx.createGain();
    this.inMono.channelCount = 1;
    this.inMono.channelCountMode = 'explicit';
    this.splitter.connect(this.chGain[0], 0);
    this.splitter.connect(this.chGain[1], 1);
    this.chGain[0].connect(this.inMono);
    this.chGain[1].connect(this.inMono);
    this.inTrim = ctx.createGain();
    this.inMono.connect(this.inTrim);
    // rumble filter keeps low-frequency feedback and handling noise out
    this.rumble = ctx.createBiquadFilter();
    this.rumble.type = 'highpass';
    this.rumble.frequency.value = 35;
    this.inTrim.connect(this.rumble);
    this.inAnalyser = ctx.createAnalyser();
    this.inAnalyser.fftSize = 8192;
    this.inAnalyser.smoothingTimeConstant = 0.5;
    this.rumble.connect(this.inAnalyser);

    this.front = new AudioWorkletNode(ctx, 'dsd-front', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.front.port.onmessage = (e) => this.onFront(e.data);
    this.rumble.connect(this.front);

    this.preHp = ctx.createBiquadFilter();
    this.preHp.type = 'highpass';
    this.front.connect(this.preHp);
    this.pre = PRE_BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q;
      return f;
    });
    let node = this.preHp;
    for (const f of this.pre) { node.connect(f); node = f; }
    this.preOut = node;
    this.preAnalyser = ctx.createAnalyser();
    this.preAnalyser.fftSize = 4096;
    this.preAnalyser.smoothingTimeConstant = 0.8;
    this.preOut.connect(this.preAnalyser);
  }

  setFront(name, v) {
    const p = this.front?.parameters.get(name);
    if (p) p.setValueAtTime(v, this.ctx.currentTime);
  }

  setPre(i, on, f, g, q) {
    const b = this.pre?.[i];
    if (!b) return;
    smooth(b.frequency, f, this.ctx); smooth(b.gain, on ? g : 0, this.ctx); smooth(b.Q, q, this.ctx);
  }

  async listDevices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return { inputs: devs.filter((d) => d.kind === 'audioinput'), outputs: devs.filter((d) => d.kind === 'audiooutput') };
  }

  stopSource() {
    if (this.demoTimer) { clearInterval(this.demoTimer); this.demoTimer = null; }
    if (this.source) { try { this.source.disconnect(); } catch { /* not connected */ } }
    if (this.source?.stop) { try { this.source.stop(); } catch { /* not started */ } }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.source = null;
    this.stream = null;
  }

  async useDevice(deviceId) {
    this.stopSource();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: 0 };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.splitter);
    const track = this.stream.getAudioTracks()[0];
    this.inputChannels = track.getSettings?.().channelCount ?? 1;
    this.applyChannel(this.reg.get('in.ch'));
    return track.label;
  }

  async useFile(file) {
    this.stopSource();
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.splitter);
    src.start();
    this.source = src;
    this.inputChannels = buf.numberOfChannels;
    this.applyChannel(this.reg.get('in.ch'));
  }

  useDemo() {
    // built-in guitar-ish riff so the rig can be tried without an interface
    this.stopSource();
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(this.inMono);
    this.source = out;
    this.inputChannels = 1;
    const notes = [40, 43, 45, 47, 50, 47, 45, 43, 40, 52, 50, 47, 45, 47, 43, 45];
    const stepDur = 60 / 112 / 2;
    let step = 0, next = ctx.currentTime + 0.1;
    const pluck = (t, midi, dur) => {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * 1.004;  // slightly sharp so autotune has work to do
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
      lp.frequency.setValueAtTime(f * 12, t);
      lp.frequency.exponentialRampToValueAtTime(f * 2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
      o.connect(lp); lp.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur * 1.7);
    };
    const schedule = () => {
      while (next < ctx.currentTime + 0.2) {
        const accent = step % 8 === 0;
        pluck(next, notes[step % notes.length], stepDur * (accent ? 1.8 : 0.9));
        next += stepDur;
        step++;
      }
    };
    schedule();
    this.demoTimer = setInterval(schedule, 50);
  }

  applyChannel(ch) {
    if (!this.ctx) return;
    const stereo = (this.inputChannels ?? 1) > 1;
    smooth(this.chGain[0].gain, ch === 1 && stereo ? 0 : ch === 2 && stereo ? 0.5 : 1, this.ctx);
    smooth(this.chGain[1].gain, ch === 1 && stereo ? 1 : ch === 2 && stereo ? 0.5 : 0, this.ctx);
  }

  // ───────────────────────── amp ─────────────────────────
  buildAmp() {
    const ctx = this.ctx;
    this.boost = ctx.createWaveShaper(); this.boost.oversample = '4x';
    this.boostIn = ctx.createGain(); this.boostDry = ctx.createGain(); this.boostWet = ctx.createGain();
    this.preOut.connect(this.boostIn);
    this.boostIn.connect(this.boostDry);
    this.boostIn.connect(this.boost); this.boost.connect(this.boostWet);
    this.ampPre = ctx.createGain();
    this.boostDry.connect(this.ampPre); this.boostWet.connect(this.ampPre);

    this.namOut = ctx.createGain(); this.namOut.gain.value = 0;
    this.fbPre = ctx.createBiquadFilter(); this.fbPre.type = 'highpass'; this.fbPre.frequency.value = 90;
    this.fbShaper = ctx.createWaveShaper(); this.fbShaper.curve = ampCurve(); this.fbShaper.oversample = '4x';
    this.fbOut = ctx.createGain(); this.fbOut.gain.value = 0.35;
    this.ampPre.connect(this.fbPre); this.fbPre.connect(this.fbShaper); this.fbShaper.connect(this.fbOut);
    this.ampBypass = ctx.createGain(); this.ampBypass.gain.value = 0;
    this.ampPre.connect(this.ampBypass);

    this.bass = ctx.createBiquadFilter(); this.bass.type = 'lowshelf'; this.bass.frequency.value = 120;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 750; this.mid.Q.value = 0.8;
    this.treb = ctx.createBiquadFilter(); this.treb.type = 'highshelf'; this.treb.frequency.value = 3200;
    this.namOut.connect(this.bass); this.fbOut.connect(this.bass);
    this.bass.connect(this.mid); this.mid.connect(this.treb);
    this.cabConv = ctx.createConvolver();
    this.cabWet = ctx.createGain(); this.cabDry = ctx.createGain();
    this.treb.connect(this.cabConv); this.cabConv.connect(this.cabWet); this.treb.connect(this.cabDry);
    this.ampOut = ctx.createGain();
    this.cabWet.connect(this.ampOut); this.cabDry.connect(this.ampOut);
    this.ampLevel = ctx.createGain();
    this.ampOut.connect(this.ampLevel);
    this.ampBypass.connect(this.ampLevel);
    this.dryAnalyser = ctx.createAnalyser(); this.dryAnalyser.fftSize = 2048;
    this.ampLevel.connect(this.dryAnalyser);
  }

  setBoost(on, drive) {
    if (!this.boost) return;
    this.boost.curve = makeCurve(drive);
    smooth(this.boostWet.gain, on ? 0.6 : 0, this.ctx);
    smooth(this.boostDry.gain, on ? 0 : 1, this.ctx);
  }

  async initNam() {
    try {
      const eng = await NamEngine.attach(this.ctx, { assetBaseUrl: new URL('../vendor/nam/', import.meta.url) });
      this.nam.node = await eng.createNode();
      this.ampPre.connect(this.nam.node);
      this.nam.node.connect(this.namOut);
      this.onStatus('nam', 'NAM engine ready');
      if (this.pendingModel) { const { json, name } = this.pendingModel; this.pendingModel = null; await this.loadNam(json, name); }
    } catch (err) {
      this.onStatus('nam-error', `NAM unavailable: ${err.message}`);
    }
  }

  async loadNam(json, name) {
    if (!this.nam.node) { this.pendingModel = { json, name }; return null; }
    const info = await this.nam.node.loadModel(json);
    Object.assign(this.nam, { loaded: true, name, info });
    this.applyAmpRouting();
    return info;
  }

  async unloadNam() {
    if (this.nam.node) await this.nam.node.unloadModel();
    Object.assign(this.nam, { loaded: false, name: '', info: null });
    this.applyAmpRouting();
  }

  applyAmpRouting() {
    if (!this.started) return;
    const on = this.reg.get('amp.on') >= 0.5;
    const normalize = this.reg.get('amp.norm') >= 0.5;
    let g = 1;
    if (normalize && this.nam.info?.hasLoudness) g = dbToLin(-18 - this.nam.info.loudness);
    smooth(this.namOut.gain, on && this.nam.loaded ? g : 0, this.ctx, 0.05);
    smooth(this.fbOut.gain, on && !this.nam.loaded ? 0.35 : 0, this.ctx, 0.05);
    smooth(this.ampBypass.gain, on ? 0 : 1, this.ctx, 0.05);
    smooth(this.cabWet.gain, on && this.reg.get('amp.cab') >= 0.5 ? 1 : 0, this.ctx);
    smooth(this.cabDry.gain, on && this.reg.get('amp.cab') >= 0.5 ? 0 : 1, this.ctx);
  }

  async loadCabIR(bytes, name) { this.cabConv.buffer = await this.ctx.decodeAudioData(bytes); this.cab.name = name; }
  resetCabIR() { this.cabConv.buffer = this.cabBuffer; this.cab.name = 'Built-in cab'; }

  // ───────────────────────── wet / dry / wet ─────────────────────────
  buildMix() {
    const ctx = this.ctx;
    this.mixBus = ctx.createGain();
    // dry: mono, placed by DRY POS (center by default)
    this.dryGain = ctx.createGain();
    this.dryPan = ctx.createStereoPanner();
    this.ampLevel.connect(this.dryGain);
    this.dryGain.connect(this.dryPan);
    this.dryPan.connect(this.mixBus);
    // wet bus: stereo -> width (M/S) -> chaos filter -> WET level
    this.wetBus = ctx.createGain();
    this.wetBus.channelCount = 2; this.wetBus.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.ms = { ll: ctx.createGain(), lr: ctx.createGain(), rl: ctx.createGain(), rr: ctx.createGain() };
    this.wetBus.connect(split);
    split.connect(this.ms.ll, 0); split.connect(this.ms.lr, 0);
    split.connect(this.ms.rl, 1); split.connect(this.ms.rr, 1);
    this.ms.ll.connect(merge, 0, 0); this.ms.rl.connect(merge, 0, 0);
    this.ms.lr.connect(merge, 0, 1); this.ms.rr.connect(merge, 0, 1);
    this.wetFilter = ctx.createBiquadFilter();
    this.wetFilter.type = 'lowpass'; this.wetFilter.frequency.value = 20000; this.wetFilter.Q.value = 0.9;
    merge.connect(this.wetFilter);
    this.wetGain = ctx.createGain();
    this.wetFilter.connect(this.wetGain);
    this.wetGain.connect(this.mixBus);
    this.wetAnalyser = ctx.createAnalyser(); this.wetAnalyser.fftSize = 2048;
    this.wetGain.connect(this.wetAnalyser);
  }

  // Width via mid/side. In W/D/W mode the wet bus loses most of its centre so
  // the effects live on the sides and the dry amp owns the middle.
  applyWidth() {
    if (!this.ms) return;
    let width = this.reg.get('wdw.width');
    if (this.chaos && this.chaosOn('width')) width = Math.max(0, Math.min(2, width + this.chaosDepth * (this.chaos.width * 2 - 1) * 0.8));
    const gm = this.reg.get('wdw.mode') >= 0.5 ? 0.35 : 1;
    const gs = width;
    smooth(this.ms.ll.gain, 0.5 * (gm + gs), this.ctx, 0.05);
    smooth(this.ms.rr.gain, 0.5 * (gm + gs), this.ctx, 0.05);
    smooth(this.ms.lr.gain, 0.5 * (gm - gs), this.ctx, 0.05);
    smooth(this.ms.rl.gain, 0.5 * (gm - gs), this.ctx, 0.05);
  }

  buildWets() {
    const ctx = this.ctx;
    for (const def of WETS) {
      const w = { def };
      w.send = ctx.createGain();        // SEND fader
      w.chaos = ctx.createGain();       // qubit chaos multiplier
      w.mute = ctx.createGain();
      w.ret = ctx.createGain();         // stereo return
      w.ret.channelCount = 2; w.ret.channelCountMode = 'explicit';
      w.meter = ctx.createAnalyser(); w.meter.fftSize = 1024;
      this.ampLevel.connect(w.send);
      w.send.connect(w.chaos);
      w.chaos.connect(w.mute);
      w.ret.connect(this.wetBus);
      w.ret.connect(w.meter);
      this.wet[def.id] = w;
    }
    // delay: stereo ping-pong, filtered feedback (capped below runaway)
    const d = this.wet.dly;
    d.l = ctx.createDelay(2.5); d.r = ctx.createDelay(2.5);
    d.fbR = ctx.createGain();
    d.tone = ctx.createBiquadFilter(); d.tone.type = 'lowpass';
    d.hp = ctx.createBiquadFilter(); d.hp.type = 'highpass'; d.hp.frequency.value = 150;
    d.merge = ctx.createChannelMerger(2);
    d.mute.connect(d.hp); d.hp.connect(d.tone); d.tone.connect(d.l);
    d.l.connect(d.r);                           // L -> R
    d.r.connect(d.fbR); d.fbR.connect(d.l);     // R -> L (feedback, capped)
    d.l.connect(d.merge, 0, 0); d.r.connect(d.merge, 0, 1);
    d.merge.connect(d.ret);
    // reverb
    const r = this.wet.rev;
    r.hp = ctx.createBiquadFilter(); r.hp.type = 'highpass'; r.hp.frequency.value = 180;
    r.pre = ctx.createDelay(0.5);
    r.conv = ctx.createConvolver();
    r.tone = ctx.createBiquadFilter(); r.tone.type = 'lowpass';
    r.mute.connect(r.hp); r.hp.connect(r.pre); r.pre.connect(r.conv); r.conv.connect(r.tone); r.tone.connect(r.ret);
    // chorus: two modulated delays, LFOs in opposite phase, no feedback
    const c = this.wet.cho;
    c.lfo = ctx.createOscillator(); c.lfo.start();
    c.dl = ctx.createDelay(0.1); c.dr = ctx.createDelay(0.1);
    c.dl.delayTime.value = 0.012; c.dr.delayTime.value = 0.016;
    c.gl = ctx.createGain(); c.gr = ctx.createGain();
    c.lfo.connect(c.gl); c.lfo.connect(c.gr); c.gl.connect(c.dl.delayTime); c.gr.connect(c.dr.delayTime);
    c.tone = ctx.createBiquadFilter(); c.tone.type = 'lowpass';
    c.merge = ctx.createChannelMerger(2);
    c.mute.connect(c.tone); c.tone.connect(c.dl); c.tone.connect(c.dr);
    c.dl.connect(c.merge, 0, 0); c.dr.connect(c.merge, 0, 1);
    c.merge.connect(c.ret);
    // doubler: short asymmetric delays with slow drift for a double-tracked spread
    const b = this.wet.dbl;
    b.lfo = ctx.createOscillator(); b.lfo.frequency.value = 0.13; b.lfo.start();
    b.dl = ctx.createDelay(0.2); b.dr = ctx.createDelay(0.2);
    b.gl = ctx.createGain(); b.gr = ctx.createGain(); b.gl.gain.value = 0.0012; b.gr.gain.value = -0.0015;
    b.lfo.connect(b.gl); b.lfo.connect(b.gr); b.gl.connect(b.dl.delayTime); b.gr.connect(b.dr.delayTime);
    b.hp = ctx.createBiquadFilter(); b.hp.type = 'highpass'; b.hp.frequency.value = 120;
    b.merge = ctx.createChannelMerger(2);
    b.mute.connect(b.hp); b.hp.connect(b.dl); b.hp.connect(b.dr);
    b.dl.connect(b.merge, 0, 0); b.dr.connect(b.merge, 0, 1);
    b.merge.connect(b.ret);
  }

  setWetSend(id, p) { const w = this.wet[id]; if (w) smooth(w.send.gain, faderGain(p), this.ctx, 0.015); }
  setWetMute(id, m) { const w = this.wet[id]; if (w) smooth(w.mute.gain, m ? 0 : 1, this.ctx, 0.01); }

  applyDelayTime() {
    const d = this.wet.dly;
    if (!d?.l) return;
    let t = this.reg.get('dly.time');
    if (this.chaos && this.chaosOn('time')) t *= 1 + this.chaosDepth * 0.5 * (this.chaos.time * 2 - 1);
    const spread = this.reg.get('dly.spread');
    smooth(d.l.delayTime, t, this.ctx, 0.08);
    smooth(d.r.delayTime, t * (1 + spread * 0.5), this.ctx, 0.08);
  }

  setDelayFeedback(v) {
    const d = this.wet.dly;
    if (!d?.fbR) return;
    smooth(d.fbR.gain, Math.min(0.85, v), this.ctx);
  }

  regenReverb() {
    const r = this.wet.rev;
    if (!r?.conv || this.revIR.user) return;
    clearTimeout(this._revTimer);
    this._revTimer = setTimeout(() => { r.conv.buffer = makeReverbIR(this.ctx, this.reg.get('rev.size')); }, 120);
  }

  async loadReverbIR(bytes, name) { this.wet.rev.conv.buffer = await this.ctx.decodeAudioData(bytes); this.revIR = { name, user: true }; }
  resetReverbIR() { this.revIR = { name: 'Built-in hall', user: false }; this.regenReverb(); }

  setChorus() {
    const c = this.wet.cho;
    if (!c?.lfo) return;
    const depth = this.reg.get('cho.depth');
    smooth(c.lfo.frequency, this.reg.get('cho.rate'), this.ctx);
    smooth(c.gl.gain, depth * 0.005, this.ctx);
    smooth(c.gr.gain, -depth * 0.005, this.ctx);
  }

  setDoubler() {
    const b = this.wet.dbl;
    if (!b?.dl) return;
    const t = this.reg.get('dbl.time');
    smooth(b.dl.delayTime, t, this.ctx, 0.05);
    smooth(b.dr.delayTime, t * 1.45, this.ctx, 0.05);
  }

  // ───────────────────────── master ─────────────────────────
  buildMaster() {
    const ctx = this.ctx;
    this.mixAnalyser = ctx.createAnalyser();
    this.mixAnalyser.fftSize = 4096;
    this.mixAnalyser.smoothingTimeConstant = 0.8;
    this.mixBus.connect(this.mixAnalyser);
    this.rackIn = ctx.createGain();
    this.rackOut = ctx.createGain();
    this.mixBus.connect(this.rackIn);
    this.rack = new Rack(ctx, this.rackIn, this.rackOut, this.reg);

    // feedback guard: notch filters placed automatically on ringing frequencies
    this.notches = [];
    let node = this.rackOut;
    for (let i = 0; i < GUARD_NOTCHES; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking'; f.frequency.value = 1000; f.Q.value = 30; f.gain.value = 0;
      node.connect(f);
      node = f;
      this.notches.push(f);
    }
    this.eq = EQ_BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q;
      return f;
    });
    for (const f of this.eq) { node.connect(f); node = f; }
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 12; this.comp.attack.value = 0.01; this.comp.release.value = 0.2;
    node.connect(this.comp);
    this.compMakeup = ctx.createGain();
    this.comp.connect(this.compMakeup);
    this.chaosMaster = ctx.createGain();
    this.compMakeup.connect(this.chaosMaster);
    this.duck = ctx.createGain();           // feedback guard emergency duck
    this.chaosMaster.connect(this.duck);
    this.master = ctx.createGain();
    this.duck.connect(this.master);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    this.master.connect(this.limiter);
    this.out = ctx.createGain();
    this.limiter.connect(this.out);
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 8192;
    this.outAnalyser.smoothingTimeConstant = 0.5;
    this.out.connect(this.outAnalyser);
    this.guardAnalyser = ctx.createAnalyser();
    this.guardAnalyser.fftSize = 8192;
    this.guardAnalyser.smoothingTimeConstant = 0;
    this.out.connect(this.guardAnalyser);
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.out.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);
  }

  setEq(i, on, f, g, q) {
    const b = this.eq?.[i];
    if (!b) return;
    smooth(b.frequency, f, this.ctx); smooth(b.gain, on ? g : 0, this.ctx); smooth(b.Q, q, this.ctx);
  }

  setComp(amount) {
    if (!this.comp) return;
    smooth(this.comp.threshold, -amount * 36, this.ctx);
    smooth(this.comp.ratio, 1 + amount * 7, this.ctx);
    smooth(this.compMakeup.gain, dbToLin(amount * 9), this.ctx);
  }

  async setOutputDevice(id) { if (this.ctx?.setSinkId) await this.ctx.setSinkId(id || ''); }

  // ───────────────────────── feedback guard ─────────────────────────
  // Looks for narrow peaks that stand far above their neighbourhood and keep
  // ringing; each confirmed one gets a deep, narrow notch. A sustained howl
  // near full scale also ducks the master for a moment.
  guardTick(enabled, sensitivity) {
    if (!this.started) return;
    const g = this.guard;
    if (!enabled) {
      for (const n of this.notches) smooth(n.gain, 0, this.ctx, 0.2);
      g.notches = [];
      g.cand.clear();
      smooth(this.duck.gain, 1, this.ctx, 0.2);
      return;
    }
    const an = this.guardAnalyser;
    const bins = an.frequencyBinCount;
    if (!g.spec || g.spec.length !== bins) g.spec = new Float32Array(bins);
    an.getFloatFrequencyData(g.spec);
    const s = g.spec;
    const hz = this.ctx.sampleRate / an.fftSize;
    const lo = Math.ceil(80 / hz), hi = Math.min(bins - 40, Math.floor(12000 / hz));
    const thresholdDb = 30 - sensitivity * 18;        // how far above the neighbours
    const seen = new Set();
    let loudest = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = s[i];
      if (v > loudest) loudest = v;
      if (v < -55) continue;
      if (v < s[i - 1] || v < s[i + 1] || v < s[i - 2] || v < s[i + 2]) continue;
      let sum = 0, cnt = 0;
      for (let k = i - 40; k <= i + 40; k += 2) { if (Math.abs(k - i) > 4) { sum += s[k]; cnt++; } }
      if (v - sum / cnt < thresholdDb) continue;
      const key = Math.round(i / 2);
      seen.add(key);
      const c = g.cand.get(key) ?? { n: 0, bin: i, peak: v, first: v };
      c.n++; c.bin = i; c.peak = v;
      g.cand.set(key, c);
    }
    for (const [key, c] of g.cand) {
      if (!seen.has(key)) { c.n -= 2; if (c.n <= 0) g.cand.delete(key); continue; }
      // feedback holds or grows; a plucked note decays, so only notch non-decaying peaks
      if (c.n >= 5) {
        if (c.peak >= c.first - 1.5) this.placeNotch(c.bin * hz);
        g.cand.delete(key);
      }
    }
    // emergency duck on a near-clipping howl
    if (loudest > -4 && g.cand.size) {
      g.duck = 1;
      smooth(this.duck.gain, 0.3, this.ctx, 0.01);
    } else if (g.duck) {
      g.duck = 0;
      smooth(this.duck.gain, 1, this.ctx, 0.8);
    }
  }

  placeNotch(freq) {
    const g = this.guard;
    const near = g.notches.find((n) => Math.abs(Math.log2(n.freq / freq)) < 1 / 12);
    if (near) {
      near.gain = Math.max(-30, near.gain - 4);
      smooth(this.notches[near.idx].gain, near.gain, this.ctx, 0.05);
      g.events++;
      return;
    }
    let idx = this.notches.findIndex((_, i) => !g.notches.some((n) => n.idx === i));
    if (idx < 0) { const oldest = g.notches.shift(); idx = oldest.idx; }
    const n = { idx, freq, gain: -14, t: performance.now() };
    g.notches.push(n);
    const f = this.notches[idx];
    f.frequency.setValueAtTime(freq, this.ctx.currentTime);
    f.Q.setValueAtTime(30, this.ctx.currentTime);
    smooth(f.gain, n.gain, this.ctx, 0.02);
    g.events++;
    this.onStatus('guard', `Feedback tamed at ${freq < 1000 ? Math.round(freq) + ' Hz' : (freq / 1000).toFixed(2) + ' kHz'}`);
  }

  resetGuard() {
    for (const n of this.notches) smooth(n.gain, 0, this.ctx, 0.1);
    this.guard.notches = [];
    this.guard.cand.clear();
  }

  // ───────────────────────── qubit chaos ─────────────────────────
  chaosOn(target) { return this.reg.get(`chaos.t.${target}`) >= 0.5; }

  applyChaos(values, depth) {
    if (!this.started) return;
    this.chaos = values;
    this.chaosDepth = depth;
    const t = this.ctx.currentTime;
    for (const id of Object.keys(this.wet)) {
      const v = values && this.chaosOn(id) ? Math.max(0, 1 + depth * (values[id] * 2 - 1)) : 1;
      this.wet[id].chaos.gain.setTargetAtTime(v, t, 0.06);
    }
    const f = values && this.chaosOn('filter') ? 20000 * Math.pow(2, -depth * 5.5 * values.filter) : 20000;
    this.wetFilter.frequency.setTargetAtTime(f, t, 0.08);
    const m = values && this.chaosOn('master') ? 1 - depth * 0.55 * values.master : 1;
    this.chaosMaster.gain.setTargetAtTime(m, t, 0.08);
    this.applyWidth();
    this.applyDelayTime();
  }

  // ───────────────────────── recording ─────────────────────────
  startRecording() {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
    this.chunks = [];
    this.recorder = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder) { resolve(null); return; }
      this.recorder.onstop = () => { resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' })); this.recorder = null; };
      this.recorder.stop();
    });
  }

  latencyMs() { return this.ctx ? ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000 : null; }
}
