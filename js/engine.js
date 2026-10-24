// Audio engine: live input -> parallel effect branches -> mix bus -> EQ -> master.
//
//            ┌─ DRY ──────────────────────┐
//            ├─ AMP (NAM -> tone -> IR) ──┤
//  INPUT ────┼─ DRIVE ────────────────────┼──> MIX BUS -> EQ -> GLUE COMP -> MASTER -> LIMITER -> OUT
//            ├─ DELAY / REVERB / MOD ─────┤        (each branch: level, auto-level, mute/solo, pan)
//            └─ SYNTH (pitch tracking) ───┘
//
// Delay, reverb and mod can take their send from the input or from the amp.

import { NamEngine } from '../vendor/nam/nam-engine.js';

const dbToLin = (db) => Math.pow(10, db / 20);
const faderGain = (p) => (p <= 0 ? 0 : p * p * p * 2); // 0.794 ≈ unity, top ≈ +6 dB
export { dbToLin, faderGain };

export const STRIPS = [
  { id: 'dry', name: 'DIRECT', color: '#9aa7bd', send: false },
  { id: 'amp', name: 'AMP · NAM', color: '#ff7a2f', send: false },
  { id: 'drv', name: 'DRIVE', color: '#ff3b5c', send: false },
  { id: 'dly', name: 'DELAY', color: '#2fb4ff', send: true },
  { id: 'rev', name: 'REVERB', color: '#9a6bff', send: true },
  { id: 'mod', name: 'MOD', color: '#1fd18b', send: true },
  { id: 'syn', name: 'SYNTH', color: '#ffd23f', send: false },
];

export const EQ_BANDS = [
  { type: 'lowshelf', f: 90, q: 0.7 },
  { type: 'peaking', f: 280, q: 1.0 },
  { type: 'peaking', f: 1200, q: 1.0 },
  { type: 'peaking', f: 4200, q: 1.0 },
  { type: 'highshelf', f: 10000, q: 0.7 },
];

function smooth(param, value, ctx, t = 0.02) {
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, t);
}

export function makeCurve(type, drive) {
  const n = 2048;
  const c = new Float32Array(n);
  const k = 1 + drive * 50;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y;
    switch (type) {
      case 1: y = Math.max(-1, Math.min(1, x * k)) * 0.8; break;                       // hard clip
      case 2: { const v = x * k + 0.15; y = Math.sign(v) * (1 - Math.exp(-Math.abs(v))) - 0.14; break; } // fuzz
      case 3: y = Math.sin(x * k * 0.6); break;                                          // wavefolder
      default: y = Math.tanh(x * k) / Math.tanh(k);                                      // soft
    }
    c[i] = y;
  }
  return c;
}

export function ampCurve() {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const v = x * 6;
    c[i] = v >= 0 ? Math.tanh(v) : Math.tanh(v * 0.8) * 1.05;
  }
  return c;
}

export function makeReverbIR(ctx, seconds, damp) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const a = 0.25 + 0.7 * t * damp;           // darker as the tail decays
      lp += (Math.random() * 2 - 1 - lp) * (1 - a);
      d[i] = lp * Math.pow(1 - t, 2.2) * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return buf;
}

export async function makeCabIR(rate) {
  // A synthetic 1x12/4x12-ish cabinet response, rendered offline.
  const len = 2048;
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  const imp = off.createBuffer(1, len, rate);
  imp.getChannelData(0)[0] = 1;
  src.buffer = imp;
  const chain = [
    ['highpass', 75, 0.8, 0],
    ['peaking', 110, 1.2, 4],
    ['peaking', 420, 1.0, -3],
    ['peaking', 2400, 1.5, 5],
    ['peaking', 3600, 3, -4],
    ['lowpass', 5200, 0.9, 0],
    ['lowpass', 6500, 0.7, 0],
  ];
  let node = src;
  for (const [type, f, q, g] of chain) {
    const b = off.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    node.connect(b);
    node = b;
  }
  node.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered;
}

export class Engine {
  constructor(reg) {
    this.reg = reg;
    this.ctx = null;
    this.strips = {};
    this.started = false;
    this.nam = { engine: null, node: null, loaded: false, name: '', info: null, error: '' };
    this.cab = { name: 'Built-in cab', userBuffer: null };
    this.revIR = { name: 'Built-in hall', user: false };
    this.source = null;
    this.stream = null;
    this.onStatus = () => {};
    this.onPitch = () => {};
    this.soloActive = false;
    this.demoTimer = null;
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }

  async start() {
    if (this.started) return;
    const isFirefox = /firefox/i.test(navigator.userAgent);
    const opts = { latencyHint: 'interactive' };
    if (!isFirefox) opts.sampleRate = 48000;   // NAM models are trained at 48 kHz
    this.ctx = new AudioContext(opts);
    const ctx = this.ctx;
    await ctx.resume();

    this.buildInput();
    this.buildMaster();
    for (const s of STRIPS) this.buildStrip(s);
    this.buildDry();
    this.buildAmp();
    this.buildDrive();
    this.buildDelay();
    this.buildReverb();
    this.buildMod();
    await this.buildSynth();

    this.cabBuffer = await makeCabIR(ctx.sampleRate);
    this.strips.amp.cabConv.buffer = this.cabBuffer;

    this.started = true;
    this.reg.applyAll();
    this.updateSolo();

    // NAM loads in the background; the fallback amp plays until a model arrives.
    this.initNam();
  }

  // ───────────────────────── input ─────────────────────────
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
    this.inAnalyser = ctx.createAnalyser();
    this.inAnalyser.fftSize = 4096;
    this.inAnalyser.smoothingTimeConstant = 0.7;
    this.inTrim.connect(this.inAnalyser);
    this.inBus = ctx.createGain();
    this.inTrim.connect(this.inBus);
  }

  async listInputs() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devs.filter((d) => d.kind === 'audioinput'),
      outputs: devs.filter((d) => d.kind === 'audiooutput'),
    };
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
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      latency: 0,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.splitter);
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings?.() ?? {};
    this.inputChannels = settings.channelCount ?? 1;
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
    // A built-in guitar-ish riff so the site can be tried without an interface.
    this.stopSource();
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(this.inMono);
    this.source = out;
    this.inputChannels = 1;
    const notes = [40, 43, 45, 47, 50, 47, 45, 43, 40, 52, 50, 47, 45, 47, 43, 45];
    const bpm = 112;
    const stepDur = 60 / bpm / 2;
    let step = 0;
    let next = ctx.currentTime + 0.1;
    const pluck = (t, midi, dur) => {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = f * 1.002;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(f * 14, t);
      lp.frequency.exponentialRampToValueAtTime(f * 2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
      o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(out);
      o.start(t); o2.start(t);
      o.stop(t + dur * 1.7); o2.stop(t + dur * 1.7);
    };
    const schedule = () => {
      while (next < ctx.currentTime + 0.2) {
        const midi = notes[step % notes.length];
        const accent = step % 8 === 0;
        pluck(next, midi, stepDur * (accent ? 1.8 : 0.9));
        if (accent) pluck(next, midi + 7, stepDur * 1.8);
        next += stepDur;
        step++;
      }
    };
    schedule();
    this.demoTimer = setInterval(schedule, 50);
  }

  applyChannel(ch) {
    if (!this.ctx) return;
    // 0 = input 1, 1 = input 2, 2 = 1+2 summed
    const stereo = (this.inputChannels ?? 1) > 1;
    const g0 = ch === 1 && stereo ? 0 : ch === 2 && stereo ? 0.5 : 1;
    const g1 = ch === 1 && stereo ? 1 : ch === 2 && stereo ? 0.5 : 0;
    smooth(this.chGain[0].gain, g0, this.ctx);
    smooth(this.chGain[1].gain, g1, this.ctx);
  }

  // ───────────────────────── strips ─────────────────────────
  buildStrip(def) {
    const ctx = this.ctx;
    const s = { def };
    s.input = ctx.createGain();
    s.fxOut = ctx.createGain();
    s.preAnalyser = ctx.createAnalyser();
    s.preAnalyser.fftSize = 1024;
    s.auto = ctx.createGain();
    s.fader = ctx.createGain();
    s.mute = ctx.createGain();
    s.pan = ctx.createStereoPanner();
    s.post = ctx.createAnalyser();
    s.post.fftSize = 4096;
    s.post.smoothingTimeConstant = 0.7;
    s.fxOut.connect(s.preAnalyser);
    s.fxOut.connect(s.auto);
    s.auto.connect(s.fader);
    s.fader.connect(s.mute);
    s.mute.connect(s.pan);
    s.mute.connect(s.post);
    s.pan.connect(this.mixBus);
    if (def.send) {
      s.fromIn = ctx.createGain();
      s.fromAmp = ctx.createGain();
      this.inBus.connect(s.fromIn);
      s.fromIn.connect(s.input);
      s.fromAmp.connect(s.input);
    } else {
      this.inBus.connect(s.input);
    }
    s.autoGain = 1;
    this.strips[def.id] = s;
  }

  setSendSource(id, fromAmp) {
    const s = this.strips[id];
    if (!s?.fromIn) return;
    smooth(s.fromIn.gain, fromAmp ? 0 : 1, this.ctx);
    smooth(s.fromAmp.gain, fromAmp ? 1 : 0, this.ctx);
  }

  setLevel(id, p) { const s = this.strips[id]; if (s) smooth(s.fader.gain, faderGain(p), this.ctx, 0.015); }
  setPan(id, v) { const s = this.strips[id]; if (s) smooth(s.pan.pan, v, this.ctx); }

  updateSolo() {
    if (!this.started) return;
    const soloed = STRIPS.filter((d) => this.reg.get(`${d.id}.solo`) >= 0.5).map((d) => d.id);
    this.soloActive = soloed.length > 0;
    for (const d of STRIPS) {
      const muted = this.reg.get(`${d.id}.mute`) >= 0.5;
      const audible = !muted && (!this.soloActive || soloed.includes(d.id));
      smooth(this.strips[d.id].mute.gain, audible ? 1 : 0, this.ctx, 0.01);
    }
  }

  isAudible(id) {
    if (this.reg.get(`${id}.mute`) >= 0.5) return false;
    if (this.soloActive && this.reg.get(`${id}.solo`) < 0.5) return false;
    return this.reg.get(`${id}.lvl`) > 0;
  }

  // Dugan-style auto level: bring each active branch toward a common loudness.
  autoLevelTick(on, targetDb) {
    if (!this.started) return;
    const buf = this._lvlBuf ?? (this._lvlBuf = new Float32Array(1024));
    for (const d of STRIPS) {
      const s = this.strips[d.id];
      let g = 1;
      if (on && this.isAudible(d.id)) {
        s.preAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 1e-3) {
          const want = dbToLin(targetDb) / rms;
          g = Math.min(dbToLin(12), Math.max(dbToLin(-18), want));
        } else {
          g = s.autoGain;   // hold during silence
        }
      }
      s.autoGain = g;
      s.auto.gain.setTargetAtTime(g, this.ctx.currentTime, on ? 0.35 : 0.05);
    }
  }

  // ───────────────────────── master ─────────────────────────
  buildMaster() {
    const ctx = this.ctx;
    this.mixBus = ctx.createGain();
    this.mixAnalyser = ctx.createAnalyser();
    this.mixAnalyser.fftSize = 4096;
    this.mixAnalyser.smoothingTimeConstant = 0.8;
    this.eq = EQ_BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.f;
      f.Q.value = b.q;
      return f;
    });
    let node = this.mixBus;
    for (const f of this.eq) { node.connect(f); node = f; }
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 12;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.2;
    node.connect(this.comp);
    this.compMakeup = ctx.createGain();
    this.comp.connect(this.compMakeup);
    this.master = ctx.createGain();
    this.compMakeup.connect(this.master);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.limBypass = ctx.createGain();
    this.limOn = ctx.createGain();
    this.master.connect(this.limiter);
    this.limiter.connect(this.limOn);
    this.master.connect(this.limBypass);
    this.out = ctx.createGain();
    this.limOn.connect(this.out);
    this.limBypass.connect(this.out);
    this.mixBus.connect(this.mixAnalyser);
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 4096;
    this.outAnalyser.smoothingTimeConstant = 0.75;
    this.out.connect(this.outAnalyser);
    this.monitor = ctx.createGain();
    this.out.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);
  }

  setEq(i, on, f, g, q) {
    const b = this.eq?.[i];
    if (!b) return;
    smooth(b.frequency, f, this.ctx);
    smooth(b.gain, on ? g : 0, this.ctx);
    smooth(b.Q, q, this.ctx);
  }

  setComp(amount) {
    if (!this.comp) return;
    smooth(this.comp.threshold, -amount * 36, this.ctx);
    smooth(this.comp.ratio, 1 + amount * 7, this.ctx);
    smooth(this.compMakeup.gain, dbToLin(amount * 9), this.ctx);
  }

  setLimiter(on) {
    if (!this.limOn) return;
    smooth(this.limOn.gain, on ? 1 : 0, this.ctx);
    smooth(this.limBypass.gain, on ? 0 : 1, this.ctx);
  }

  async setOutputDevice(id) {
    if (this.ctx?.setSinkId) await this.ctx.setSinkId(id || '');
  }

  // ───────────────────────── direct ─────────────────────────
  buildDry() {
    const ctx = this.ctx;
    const s = this.strips.dry;
    s.lo = ctx.createBiquadFilter(); s.lo.type = 'highpass'; s.lo.Q.value = 0.7;
    s.hi = ctx.createBiquadFilter(); s.hi.type = 'lowpass'; s.hi.Q.value = 0.7;
    s.input.connect(s.lo); s.lo.connect(s.hi); s.hi.connect(s.fxOut);
  }

  // ───────────────────────── amp (NAM + IR) ─────────────────────────
  buildAmp() {
    const ctx = this.ctx;
    const s = this.strips.amp;
    s.pre = ctx.createGain();
    s.input.connect(s.pre);
    s.namOut = ctx.createGain();
    s.namOut.gain.value = 0;
    s.fbShaper = ctx.createWaveShaper();
    s.fbShaper.curve = ampCurve();
    s.fbShaper.oversample = '4x';
    s.fbPre = ctx.createBiquadFilter();
    s.fbPre.type = 'highpass';
    s.fbPre.frequency.value = 90;
    s.fbOut = ctx.createGain();
    s.fbOut.gain.value = 0.35;
    s.pre.connect(s.fbPre);
    s.fbPre.connect(s.fbShaper);
    s.fbShaper.connect(s.fbOut);
    s.bass = ctx.createBiquadFilter(); s.bass.type = 'lowshelf'; s.bass.frequency.value = 120;
    s.mid = ctx.createBiquadFilter(); s.mid.type = 'peaking'; s.mid.frequency.value = 750; s.mid.Q.value = 0.8;
    s.treb = ctx.createBiquadFilter(); s.treb.type = 'highshelf'; s.treb.frequency.value = 3200;
    s.namOut.connect(s.bass);
    s.fbOut.connect(s.bass);
    s.bass.connect(s.mid);
    s.mid.connect(s.treb);
    s.cabConv = ctx.createConvolver();
    s.cabWet = ctx.createGain();
    s.cabDry = ctx.createGain();
    s.treb.connect(s.cabConv);
    s.cabConv.connect(s.cabWet);
    s.treb.connect(s.cabDry);
    s.out = ctx.createGain();
    s.cabWet.connect(s.out);
    s.cabDry.connect(s.out);
    s.out.connect(s.fxOut);
    // Delay/reverb/mod may send from here.
    for (const d of STRIPS) if (d.send) s.out.connect(this.strips[d.id].fromAmp);
  }

  async initNam() {
    try {
      this.nam.engine = await NamEngine.attach(this.ctx, { assetBaseUrl: new URL('../vendor/nam/', import.meta.url) });
      this.nam.node = await this.nam.engine.createNode();
      this.strips.amp.pre.connect(this.nam.node);
      this.nam.node.connect(this.strips.amp.namOut);
      this.onStatus('nam', 'NAM engine ready');
      if (this.pendingModel) {
        const { json, name } = this.pendingModel;
        this.pendingModel = null;
        await this.loadNam(json, name);
      }
    } catch (err) {
      this.nam.error = err.message;
      this.onStatus('nam-error', `NAM unavailable: ${err.message}`);
    }
  }

  async loadNam(json, name) {
    if (!this.nam.node) {
      this.pendingModel = { json, name };
      this.nam.name = name + ' (waiting for engine)';
      return null;
    }
    const info = await this.nam.node.loadModel(json);
    this.nam.loaded = true;
    this.nam.name = name;
    this.nam.info = info;
    this.applyAmpRouting();
    return info;
  }

  async unloadNam() {
    if (this.nam.node) await this.nam.node.unloadModel();
    this.nam.loaded = false;
    this.nam.name = '';
    this.nam.info = null;
    this.applyAmpRouting();
  }

  applyAmpRouting() {
    if (!this.started) return;
    const s = this.strips.amp;
    const normalize = this.reg.get('amp.norm') >= 0.5;
    let g = 1;
    if (normalize && this.nam.info?.hasLoudness) g = dbToLin(-18 - this.nam.info.loudness);
    smooth(s.namOut.gain, this.nam.loaded ? g : 0, this.ctx, 0.05);
    smooth(s.fbOut.gain, this.nam.loaded ? 0 : 0.35, this.ctx, 0.05);
  }

  async loadCabIR(arrayBuffer, name) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    this.strips.amp.cabConv.buffer = buf;
    this.cab.name = name;
    return buf;
  }

  resetCabIR() {
    this.strips.amp.cabConv.buffer = this.cabBuffer;
    this.cab.name = 'Built-in cab';
  }

  setCab(on, mix) {
    const s = this.strips.amp;
    if (!s?.cabWet) return;
    smooth(s.cabWet.gain, on ? mix : 0, this.ctx);
    smooth(s.cabDry.gain, on ? 1 - mix : 1, this.ctx);
  }

  // ───────────────────────── drive ─────────────────────────
  buildDrive() {
    const ctx = this.ctx;
    const s = this.strips.drv;
    s.hp = ctx.createBiquadFilter(); s.hp.type = 'highpass'; s.hp.frequency.value = 80;
    s.shaper = ctx.createWaveShaper(); s.shaper.oversample = '4x';
    s.tone = ctx.createBiquadFilter(); s.tone.type = 'lowpass'; s.tone.Q.value = 0.6;
    s.makeup = ctx.createGain(); s.makeup.gain.value = 0.5;
    s.input.connect(s.hp); s.hp.connect(s.shaper); s.shaper.connect(s.tone); s.tone.connect(s.makeup); s.makeup.connect(s.fxOut);
  }

  setDrive() {
    const s = this.strips.drv;
    if (!s?.shaper) return;
    s.shaper.curve = makeCurve(Math.round(this.reg.get('drv.type')), this.reg.get('drv.drive'));
  }

  // ───────────────────────── delay ─────────────────────────
  buildDelay() {
    const ctx = this.ctx;
    const s = this.strips.dly;
    s.delay = ctx.createDelay(2.5);
    s.fb = ctx.createGain();
    s.tone = ctx.createBiquadFilter(); s.tone.type = 'lowpass';
    s.hp = ctx.createBiquadFilter(); s.hp.type = 'highpass'; s.hp.frequency.value = 120;
    s.input.connect(s.delay);
    s.delay.connect(s.tone);
    s.tone.connect(s.hp);
    s.hp.connect(s.fb);
    s.fb.connect(s.delay);
    s.hp.connect(s.fxOut);
  }

  // ───────────────────────── reverb ─────────────────────────
  buildReverb() {
    const ctx = this.ctx;
    const s = this.strips.rev;
    s.pre = ctx.createDelay(0.5);
    s.conv = ctx.createConvolver();
    s.tone = ctx.createBiquadFilter(); s.tone.type = 'lowpass';
    s.hp = ctx.createBiquadFilter(); s.hp.type = 'highpass'; s.hp.frequency.value = 150;
    s.input.connect(s.hp); s.hp.connect(s.pre); s.pre.connect(s.conv); s.conv.connect(s.tone); s.tone.connect(s.fxOut);
  }

  regenReverb() {
    const s = this.strips.rev;
    if (!s?.conv || this.revIR.user) return;
    clearTimeout(this._revTimer);
    this._revTimer = setTimeout(() => {
      s.conv.buffer = makeReverbIR(this.ctx, this.reg.get('rev.size'), 0.6);
    }, 120);
  }

  async loadReverbIR(arrayBuffer, name) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    this.strips.rev.conv.buffer = buf;
    this.revIR = { name, user: true };
  }

  resetReverbIR() {
    this.revIR = { name: 'Built-in hall', user: false };
    this.regenReverb();
  }

  // ───────────────────────── mod (stereo chorus / flanger) ─────────────────────────
  buildMod() {
    const ctx = this.ctx;
    const s = this.strips.mod;
    s.lfo = ctx.createOscillator();
    s.lfo.type = 'sine';
    s.dL = ctx.createDelay(0.1); s.dR = ctx.createDelay(0.1);
    s.dL.delayTime.value = 0.012; s.dR.delayTime.value = 0.014;
    s.depL = ctx.createGain(); s.depR = ctx.createGain();
    s.lfo.connect(s.depL); s.lfo.connect(s.depR);
    s.depL.connect(s.dL.delayTime); s.depR.connect(s.dR.delayTime);
    s.fbL = ctx.createGain(); s.fbR = ctx.createGain();
    s.input.connect(s.dL); s.input.connect(s.dR);
    s.dL.connect(s.fbL); s.fbL.connect(s.dL);
    s.dR.connect(s.fbR); s.fbR.connect(s.dR);
    s.merge = ctx.createChannelMerger(2);
    s.dL.connect(s.merge, 0, 0);
    s.dR.connect(s.merge, 0, 1);
    s.merge.connect(s.fxOut);
    s.lfo.start();
  }

  setMod() {
    const s = this.strips.mod;
    if (!s?.lfo) return;
    const depth = this.reg.get('mod.depth');
    const fb = this.reg.get('mod.fb');
    smooth(s.lfo.frequency, this.reg.get('mod.rate'), this.ctx);
    smooth(s.depL.gain, depth * 0.006, this.ctx);
    smooth(s.depR.gain, -depth * 0.006, this.ctx);
    smooth(s.fbL.gain, fb, this.ctx);
    smooth(s.fbR.gain, fb, this.ctx);
  }

  // ───────────────────────── synth ─────────────────────────
  async buildSynth() {
    const ctx = this.ctx;
    const s = this.strips.syn;
    try {
      await ctx.audioWorklet.addModule(new URL('./synth-worklet.js', import.meta.url));
      s.node = new AudioWorkletNode(ctx, 'dsd-synth', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      s.node.port.onmessage = (e) => this.onPitch(e.data);
      s.input.connect(s.node);
      s.node.connect(s.fxOut);
    } catch (err) {
      this.onStatus('synth-error', `Synth unavailable: ${err.message}`);
    }
  }

  setSynth(name, v) {
    const p = this.strips.syn?.node?.parameters.get(name);
    if (p) p.setTargetAtTime(v, this.ctx.currentTime, 0.01);
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
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'audio/webm';
        resolve(new Blob(this.chunks, { type }));
        this.recorder = null;
      };
      this.recorder.stop();
    });
  }

  latencyMs() {
    if (!this.ctx) return null;
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }
}
