// Audio engine — analog synth in, well-tempered bass out.
//
//  INTERFACE IN ─ trim ─ BASS VOICE (worklet: track · temper · osc · fold · ladder · drive)
//     ─ AMP (optional NAM bass amp + IR cab) ─┬─ DRY (mono, centre) ──────────────────┐
//                                             └─ sends (high-passed, lows stay mono)   │
//                                                DELAY · REVERB · CHORUS · DOUBLER ─ WET (stereo, width)
//                                                                                      ▼
//                       MIX ─ END RACK ─ FEEDBACK GUARD ─ MASTER EQ ─ GLUE ─ SAFE ─ MASTER ─ LIMITER ─ OUT

import { NamEngine, type NamModelInfo, type NamNode } from '../vendor/nam/nam-engine.js';
import type { Registry } from './params';
import { Rack } from './rack';
import type { BandDef } from './eq';

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const faderGain = (p: number): number => (p <= 0 ? 0 : p * p * p * 2); // 0.794 ≈ unity

export type WetId = 'dly' | 'rev' | 'cho' | 'dbl';
export const WETS: readonly { id: WetId; name: string; side: 'L' | 'R' }[] = [
  { id: 'dly', name: 'DELAY', side: 'L' },
  { id: 'rev', name: 'REVERB', side: 'L' },
  { id: 'cho', name: 'CHORUS', side: 'R' },
  { id: 'dbl', name: 'DOUBLER', side: 'R' },
];

export const EQ_BANDS: readonly BandDef[] = [
  { type: 'lowshelf', f: 60, q: 0.7 },
  { type: 'peaking', f: 180, q: 1.0 },
  { type: 'peaking', f: 800, q: 1.0 },
  { type: 'peaking', f: 2500, q: 1.0 },
  { type: 'highshelf', f: 8000, q: 0.7 },
];

export interface BassReport { f0: number; out: number; midi: number; cents: number; err: number; amp: number; gate: boolean }

interface Wet {
  send: GainNode; mute: GainNode; ret: GainNode; meter: AnalyserNode; hp: BiquadFilterNode;
  tone?: BiquadFilterNode; l?: DelayNode; r?: DelayNode; fb?: GainNode; pre?: DelayNode; conv?: ConvolverNode;
  lfo?: OscillatorNode; gl?: GainNode; gr?: GainNode;
}

const GUARD_NOTCHES = 8;

function sm(param: AudioParam, value: number, ctx: BaseAudioContext, t = 0.02): void {
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, t);
}

function makeReverbIR(ctx: BaseAudioContext, seconds: number): AudioBuffer {
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

async function makeCabIR(rate: number): Promise<AudioBuffer> {
  const len = 2048, off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource(), imp = off.createBuffer(1, len, rate);
  imp.getChannelData(0)[0] = 1;
  src.buffer = imp;
  let node: AudioNode = src;
  // a generic 8x10 / 4x10 bass cab response
  for (const [type, f, q, g] of [['highpass', 38, 0.7, 0], ['peaking', 70, 1, 3], ['peaking', 400, 1.2, -4], ['peaking', 1800, 1.5, 3], ['lowpass', 4200, 0.8, 0], ['lowpass', 5500, 0.7, 0]] as const) {
    const b = off.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    node.connect(b);
    node = b;
  }
  node.connect(off.destination);
  src.start();
  return off.startRendering();
}

export const isTouchDevice = (): boolean => navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;

export class Engine {
  ctx!: AudioContext;
  started = false;
  onStatus: (kind: string, text: string) => void = () => {};
  onBass: (r: BassReport) => void = () => {};

  // nodes (assigned in start)
  inTrim!: GainNode;
  inAnalyser!: AnalyserNode;
  bass!: AudioWorkletNode;
  voiceAnalyser!: AnalyserNode;
  ampLevel!: GainNode;
  dryGain!: GainNode;
  dryPan!: StereoPannerNode;
  dryAnalyser!: AnalyserNode;
  wetGain!: GainNode;
  wetAnalyser!: AnalyserNode;
  mixAnalyser!: AnalyserNode;
  outAnalyser!: AnalyserNode;
  master!: GainNode;
  monitor!: GainNode;
  rack!: Rack;
  wet = {} as Record<WetId, Wet>;

  nam: { node: NamNode | null; loaded: boolean; name: string; info: NamModelInfo | null } = { node: null, loaded: false, name: '', info: null };
  cab = { name: 'Built-in bass cab' };
  revIR = { name: 'Built-in hall', user: false };
  guard = { notches: [] as { idx: number; freq: number; gain: number }[], cand: new Map<number, { n: number; bin: number; peak: number; first: number }>(), duck: false };
  inputChannels = 1;
  inputLabel = '';

  private splitter!: ChannelSplitterNode;
  private chGain!: [GainNode, GainNode];
  private inMono!: GainNode;
  private ampIn!: GainNode;
  private ampPre!: GainNode;
  private namOut!: GainNode;
  private ampBypass!: GainNode;
  private cabConv!: ConvolverNode;
  private cabWet!: GainNode;
  private cabDry!: GainNode;
  private cabBuffer!: AudioBuffer;
  private wetBus!: GainNode;
  private ms!: Record<'ll' | 'lr' | 'rl' | 'rr', GainNode>;
  private notches: BiquadFilterNode[] = [];
  private eq: BiquadFilterNode[] = [];
  private comp!: DynamicsCompressorNode;
  private compMakeup!: GainNode;
  private safeGain!: GainNode;
  private duck!: GainNode;
  private guardAnalyser!: AnalyserNode;
  private guardSpec: Float32Array<ArrayBuffer> | null = null;
  private recDest!: MediaStreamAudioDestinationNode;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private demoTimer = 0;
  private revTimer = 0;
  private pendingModel: { json: string; name: string } | null = null;

  constructor(private readonly reg: Registry) {}

  get sampleRate(): number { return this.ctx?.sampleRate ?? 48000; }

  async start(lowest: boolean): Promise<void> {
    if (this.started) return;
    const isFirefox = /firefox/i.test(navigator.userAgent);
    const opts: AudioContextOptions = { latencyHint: lowest ? 0 : 'interactive' };
    if (!isFirefox) opts.sampleRate = 48000;   // NAM captures are trained at 48 kHz
    try { this.ctx = new AudioContext(opts); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); }
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('./bass.worklet.js', import.meta.url));
    this.buildInput();
    this.buildAmp();
    this.buildMix();
    this.buildWets();
    this.buildMaster();
    this.cabBuffer = await makeCabIR(this.ctx.sampleRate);
    this.cabConv.buffer = this.cabBuffer;
    this.started = true;
    this.reg.applyAll();
    void this.initNam();
  }

  // ───────────────────────── input + bass voice ─────────────────────────
  private buildInput(): void {
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
    this.inAnalyser.fftSize = 8192;
    this.inAnalyser.smoothingTimeConstant = 0.5;
    this.inTrim.connect(this.inAnalyser);
    this.bass = new AudioWorkletNode(ctx, 'dsd-bass', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.bass.port.onmessage = (e: MessageEvent<BassReport>) => this.onBass(e.data);
    this.inTrim.connect(this.bass);
    this.voiceAnalyser = ctx.createAnalyser();
    this.voiceAnalyser.fftSize = 2048;
    this.bass.connect(this.voiceAnalyser);
  }

  setBass(name: string, v: number): void {
    this.bass?.parameters.get(name)?.setValueAtTime(v, this.ctx.currentTime);
  }

  async listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return { inputs: devs.filter((d) => d.kind === 'audioinput'), outputs: devs.filter((d) => d.kind === 'audiooutput') };
  }

  private stopSource(): void {
    if (this.demoTimer) { clearInterval(this.demoTimer); this.demoTimer = 0; }
    this.source?.disconnect();
    if (this.source instanceof AudioScheduledSourceNode) { try { this.source.stop(); } catch { /* not started */ } }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
  }

  /** safe = phone-safe mode: the browser's echo cancellation removes the speaker from the mic */
  async useDevice(deviceId: string | undefined, safe: boolean): Promise<string> {
    this.stopSource();
    const audio: MediaTrackConstraints & { latency?: number } = {
      echoCancellation: safe, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: 0,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const src = this.ctx.createMediaStreamSource(this.stream);
    src.connect(this.splitter);
    this.source = src;
    const track = this.stream.getAudioTracks()[0];
    this.inputChannels = track.getSettings().channelCount ?? 1;
    this.inputLabel = track.label;
    this.applyChannel(this.reg.get('in.ch'));
    return track.label;
  }

  async useFile(file: File): Promise<void> {
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

  /** a mono analog-synth style line (slightly out of tune) for trying the rig without hardware */
  useDemo(): void {
    this.stopSource();
    const ctx = this.ctx, out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.inMono);
    this.source = out;
    this.inputChannels = 1;
    const notes = [48, 48, 55, 51, 48, 53, 51, 46, 48, 48, 55, 58, 56, 55, 51, 53];
    const stepDur = 60 / 118 / 2;
    let step = 0, next = ctx.currentTime + 0.1;
    const play = (t: number, midi: number, dur: number): void => {
      const f = 440 * Math.pow(2, (midi - 69) / 12) * 1.006;
      const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f;
      lp.type = 'lowpass'; lp.Q.value = 3;
      lp.frequency.setValueAtTime(f * 10, t);
      lp.frequency.exponentialRampToValueAtTime(f * 2.5, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.6, t + 0.005);
      g.gain.setTargetAtTime(0.35, t + 0.02, 0.08);
      g.gain.setTargetAtTime(0.0001, t + dur * 0.9, 0.03);
      o.connect(lp); lp.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.3);
    };
    const schedule = (): void => {
      while (next < ctx.currentTime + 0.2) {
        play(next, notes[step % notes.length], stepDur * (step % 4 === 3 ? 0.5 : 0.95));
        next += stepDur;
        step++;
      }
    };
    schedule();
    this.demoTimer = window.setInterval(schedule, 50);
  }

  applyChannel(ch: number): void {
    if (!this.started && !this.chGain) return;
    const stereo = this.inputChannels > 1;
    sm(this.chGain[0].gain, ch === 1 && stereo ? 0 : ch === 2 && stereo ? 0.5 : 1, this.ctx);
    sm(this.chGain[1].gain, ch === 1 && stereo ? 1 : ch === 2 && stereo ? 0.5 : 0, this.ctx);
  }

  // ───────────────────────── amp (optional NAM bass amp + cab) ─────────────────────────
  private buildAmp(): void {
    const ctx = this.ctx;
    this.ampIn = ctx.createGain();
    this.bass.connect(this.ampIn);
    this.ampPre = ctx.createGain();
    this.ampIn.connect(this.ampPre);
    this.namOut = ctx.createGain();
    this.namOut.gain.value = 0;
    this.ampBypass = ctx.createGain();
    this.ampIn.connect(this.ampBypass);
    this.cabConv = ctx.createConvolver();
    this.cabWet = ctx.createGain();
    this.cabDry = ctx.createGain();
    this.namOut.connect(this.cabConv);
    this.namOut.connect(this.cabDry);
    this.cabConv.connect(this.cabWet);
    this.ampLevel = ctx.createGain();
    this.cabWet.connect(this.ampLevel);
    this.cabDry.connect(this.ampLevel);
    this.ampBypass.connect(this.ampLevel);
  }

  private async initNam(): Promise<void> {
    try {
      const eng = await NamEngine.attach(this.ctx, { assetBaseUrl: new URL('../vendor/nam/', import.meta.url) });
      const node = await eng.createNode();
      this.nam.node = node;
      this.ampPre.connect(node);
      node.connect(this.namOut);
      this.onStatus('nam', 'NAM engine ready');
      if (this.pendingModel) { const { json, name } = this.pendingModel; this.pendingModel = null; await this.loadNam(json, name); }
    } catch (err) {
      this.onStatus('nam-error', `NAM unavailable: ${(err as Error).message}`);
    }
  }

  async loadNam(json: string, name: string): Promise<NamModelInfo | null> {
    if (!this.nam.node) { this.pendingModel = { json, name }; return null; }
    const info = await this.nam.node.loadModel(json);
    this.nam = { ...this.nam, loaded: true, name, info };
    this.applyAmpRouting();
    return info;
  }

  async unloadNam(): Promise<void> {
    await this.nam.node?.unloadModel();
    this.nam = { ...this.nam, loaded: false, name: '', info: null };
    this.applyAmpRouting();
  }

  /** The amp stage is only in the path when switched on AND a NAM model is loaded. */
  applyAmpRouting(): void {
    if (!this.started) return;
    const on = this.reg.on('amp.on') && this.nam.loaded;
    const cab = this.reg.on('amp.cab');
    const norm = this.reg.on('amp.norm') && this.nam.info?.hasLoudness ? dbToLin(-18 - (this.nam.info?.loudness ?? -18)) : 1;
    sm(this.namOut.gain, on ? norm : 0, this.ctx, 0.05);
    sm(this.ampBypass.gain, on ? 0 : 1, this.ctx, 0.05);
    sm(this.cabWet.gain, cab ? 1 : 0, this.ctx);
    sm(this.cabDry.gain, cab ? 0 : 1, this.ctx);
  }

  setAmpGain(db: number): void { if (this.ampPre) sm(this.ampPre.gain, dbToLin(db), this.ctx); }
  async loadCabIR(bytes: ArrayBuffer, name: string): Promise<void> { this.cabConv.buffer = await this.ctx.decodeAudioData(bytes); this.cab.name = name; }

  // ───────────────────────── wet / dry / wet ─────────────────────────
  private buildMix(): void {
    const ctx = this.ctx;
    this.dryGain = ctx.createGain();
    this.dryPan = ctx.createStereoPanner();
    this.ampLevel.connect(this.dryGain);
    this.dryGain.connect(this.dryPan);
    this.dryAnalyser = ctx.createAnalyser();
    this.dryAnalyser.fftSize = 2048;
    this.dryGain.connect(this.dryAnalyser);
    this.wetBus = ctx.createGain();
    this.wetBus.channelCount = 2;
    this.wetBus.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    this.ms = { ll: ctx.createGain(), lr: ctx.createGain(), rl: ctx.createGain(), rr: ctx.createGain() };
    this.wetBus.connect(split);
    split.connect(this.ms.ll, 0); split.connect(this.ms.lr, 0);
    split.connect(this.ms.rl, 1); split.connect(this.ms.rr, 1);
    this.ms.ll.connect(merge, 0, 0); this.ms.rl.connect(merge, 0, 0);
    this.ms.lr.connect(merge, 0, 1); this.ms.rr.connect(merge, 0, 1);
    this.wetGain = ctx.createGain();
    merge.connect(this.wetGain);
    this.wetAnalyser = ctx.createAnalyser();
    this.wetAnalyser.fftSize = 2048;
    this.wetGain.connect(this.wetAnalyser);
  }

  /** mid/side width; W/D/W mode thins the wet centre so the dry bass owns it */
  applyWidth(): void {
    if (!this.ms) return;
    const gm = this.reg.on('wdw.mode') ? 0.35 : 1, gs = this.reg.get('wdw.width');
    sm(this.ms.ll.gain, 0.5 * (gm + gs), this.ctx, 0.05);
    sm(this.ms.rr.gain, 0.5 * (gm + gs), this.ctx, 0.05);
    sm(this.ms.lr.gain, 0.5 * (gm - gs), this.ctx, 0.05);
    sm(this.ms.rl.gain, 0.5 * (gm - gs), this.ctx, 0.05);
  }

  private buildWets(): void {
    const ctx = this.ctx;
    const mk = (hpHz: number): Wet => {
      const w: Wet = { send: ctx.createGain(), mute: ctx.createGain(), ret: ctx.createGain(), meter: ctx.createAnalyser(), hp: ctx.createBiquadFilter() };
      w.ret.channelCount = 2;
      w.ret.channelCountMode = 'explicit';
      w.meter.fftSize = 1024;
      w.hp.type = 'highpass';
      w.hp.frequency.value = hpHz;              // keep the sub frequencies mono and dry
      this.ampLevel.connect(w.send);
      w.send.connect(w.mute);
      w.mute.connect(w.hp);
      w.ret.connect(this.wetBus);
      w.ret.connect(w.meter);
      return w;
    };
    // delay: stereo ping-pong, feedback capped
    const d = mk(160);
    d.tone = ctx.createBiquadFilter(); d.tone.type = 'lowpass';
    d.l = ctx.createDelay(2.5); d.r = ctx.createDelay(2.5); d.fb = ctx.createGain();
    const dm = ctx.createChannelMerger(2);
    d.hp.connect(d.tone); d.tone.connect(d.l);
    d.l.connect(d.r); d.r.connect(d.fb); d.fb.connect(d.l);
    d.l.connect(dm, 0, 0); d.r.connect(dm, 0, 1); dm.connect(d.ret);
    // reverb
    const r = mk(200);
    r.pre = ctx.createDelay(0.5); r.conv = ctx.createConvolver();
    r.tone = ctx.createBiquadFilter(); r.tone.type = 'lowpass';
    r.hp.connect(r.pre); r.pre.connect(r.conv); r.conv.connect(r.tone); r.tone.connect(r.ret);
    // chorus
    const c = mk(220);
    c.lfo = ctx.createOscillator(); c.lfo.start();
    c.l = ctx.createDelay(0.1); c.r = ctx.createDelay(0.1);
    c.l.delayTime.value = 0.012; c.r.delayTime.value = 0.016;
    c.gl = ctx.createGain(); c.gr = ctx.createGain();
    c.lfo.connect(c.gl); c.lfo.connect(c.gr); c.gl.connect(c.l.delayTime); c.gr.connect(c.r.delayTime);
    c.tone = ctx.createBiquadFilter(); c.tone.type = 'lowpass';
    const cm = ctx.createChannelMerger(2);
    c.hp.connect(c.tone); c.tone.connect(c.l); c.tone.connect(c.r);
    c.l.connect(cm, 0, 0); c.r.connect(cm, 0, 1); cm.connect(c.ret);
    // doubler
    const b = mk(180);
    b.lfo = ctx.createOscillator(); b.lfo.frequency.value = 0.13; b.lfo.start();
    b.l = ctx.createDelay(0.2); b.r = ctx.createDelay(0.2);
    b.gl = ctx.createGain(); b.gr = ctx.createGain(); b.gl.gain.value = 0.0012; b.gr.gain.value = -0.0015;
    b.lfo.connect(b.gl); b.lfo.connect(b.gr); b.gl.connect(b.l.delayTime); b.gr.connect(b.r.delayTime);
    const bm = ctx.createChannelMerger(2);
    b.hp.connect(b.l); b.hp.connect(b.r);
    b.l.connect(bm, 0, 0); b.r.connect(bm, 0, 1); bm.connect(b.ret);
    this.wet = { dly: d, rev: r, cho: c, dbl: b };
  }

  setWetSend(id: WetId, p: number): void { const w = this.wet[id]; if (w) sm(w.send.gain, faderGain(p), this.ctx, 0.015); }
  setWetMute(id: WetId, m: boolean): void { const w = this.wet[id]; if (w) sm(w.mute.gain, m ? 0 : 1, this.ctx, 0.01); }

  applyDelayTime(): void {
    const d = this.wet.dly;
    if (!d?.l || !d.r) return;
    const t = this.reg.get('dly.time');
    sm(d.l.delayTime, t, this.ctx, 0.08);
    sm(d.r.delayTime, t * (1 + this.reg.get('dly.spread') * 0.5), this.ctx, 0.08);
  }

  setDelayFeedback(v: number): void { const fb = this.wet.dly?.fb; if (fb) sm(fb.gain, Math.min(0.85, v), this.ctx); }
  setTone(id: WetId, hz: number): void { const t = this.wet[id]?.tone; if (t) sm(t.frequency, hz, this.ctx); }
  setReverbPre(s: number): void { const p = this.wet.rev?.pre; if (p) sm(p.delayTime, s, this.ctx, 0.05); }

  regenReverb(): void {
    const conv = this.wet.rev?.conv;
    if (!conv || this.revIR.user) return;
    clearTimeout(this.revTimer);
    this.revTimer = window.setTimeout(() => { conv.buffer = makeReverbIR(this.ctx, this.reg.get('rev.size')); }, 120);
  }

  async loadReverbIR(bytes: ArrayBuffer, name: string): Promise<void> {
    const conv = this.wet.rev.conv!;
    conv.buffer = await this.ctx.decodeAudioData(bytes);
    this.revIR = { name, user: true };
  }

  setChorus(): void {
    const c = this.wet.cho;
    if (!c?.lfo || !c.gl || !c.gr) return;
    const depth = this.reg.get('cho.depth');
    sm(c.lfo.frequency, this.reg.get('cho.rate'), this.ctx);
    sm(c.gl.gain, depth * 0.005, this.ctx);
    sm(c.gr.gain, -depth * 0.005, this.ctx);
  }

  setDoubler(): void {
    const b = this.wet.dbl;
    if (!b?.l || !b.r) return;
    const t = this.reg.get('dbl.time');
    sm(b.l.delayTime, t, this.ctx, 0.05);
    sm(b.r.delayTime, t * 1.45, this.ctx, 0.05);
  }

  // ───────────────────────── master ─────────────────────────
  private buildMaster(): void {
    const ctx = this.ctx;
    const mix = ctx.createGain();
    this.dryPan.connect(mix);
    this.wetGain.connect(mix);
    this.mixAnalyser = ctx.createAnalyser();
    this.mixAnalyser.fftSize = 4096;
    this.mixAnalyser.smoothingTimeConstant = 0.8;
    mix.connect(this.mixAnalyser);
    const rackIn = ctx.createGain(), rackOut = ctx.createGain();
    mix.connect(rackIn);
    this.rack = new Rack(ctx, rackIn, rackOut, this.reg);
    let node: AudioNode = rackOut;
    for (let i = 0; i < GUARD_NOTCHES; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking'; f.frequency.value = 1000; f.Q.value = 30; f.gain.value = 0;
      node.connect(f);
      node = f;
      this.notches.push(f);
    }
    this.eq = EQ_BANDS.map((b) => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q; return f; });
    for (const f of this.eq) { node.connect(f); node = f; }
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 12; this.comp.attack.value = 0.005; this.comp.release.value = 0.15;
    node.connect(this.comp);
    this.compMakeup = ctx.createGain();
    this.comp.connect(this.compMakeup);
    this.safeGain = ctx.createGain();
    this.compMakeup.connect(this.safeGain);
    this.duck = ctx.createGain();
    this.safeGain.connect(this.duck);
    this.master = ctx.createGain();
    this.duck.connect(this.master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    this.master.connect(limiter);
    const out = ctx.createGain();
    limiter.connect(out);
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 8192;
    this.outAnalyser.smoothingTimeConstant = 0.55;
    out.connect(this.outAnalyser);
    this.guardAnalyser = ctx.createAnalyser();
    this.guardAnalyser.fftSize = 8192;
    this.guardAnalyser.smoothingTimeConstant = 0;
    out.connect(this.guardAnalyser);
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    out.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    out.connect(this.recDest);
  }

  setEq(i: number, on: boolean, f: number, g: number, q: number): void {
    const b = this.eq[i];
    if (!b) return;
    sm(b.frequency, f, this.ctx); sm(b.gain, on ? g : 0, this.ctx); sm(b.Q, q, this.ctx);
  }

  setComp(amount: number): void {
    if (!this.comp) return;
    sm(this.comp.threshold, -amount * 36, this.ctx);
    sm(this.comp.ratio, 1 + amount * 7, this.ctx);
    sm(this.compMakeup.gain, dbToLin(amount * 9), this.ctx);
  }

  /** phone-safe mode caps the output at -9 dB */
  setSafe(on: boolean): void { if (this.safeGain) sm(this.safeGain.gain, on ? dbToLin(-9) : 1, this.ctx, 0.05); }
  async setOutputDevice(id: string): Promise<void> {
    const c = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    await c.setSinkId?.(id);
  }

  // ───────────────────────── feedback guard ─────────────────────────
  // Finds narrow peaks far above their neighbours that hold or grow (feedback),
  // as opposed to notes that decay, and notches them. A loud howl ducks the master.
  /** pitches currently being played (bass out + synth in), so the guard never notches the music */
  playing: number[] = [];

  private isMusic(freq: number): boolean {
    for (const f0 of this.playing) {
      if (f0 <= 0) continue;
      const k = Math.round(freq / f0);
      if (k >= 1 && k <= 24 && Math.abs(freq / (k * f0) - 1) < 0.03) return true;
    }
    return false;
  }

  guardTick(enabled: boolean, sensitivity: number): void {
    if (!this.started) return;
    const g = this.guard;
    if (!enabled) {
      if (g.notches.length || g.duck) this.resetGuard();
      return;
    }
    const an = this.guardAnalyser, bins = an.frequencyBinCount;
    if (!this.guardSpec || this.guardSpec.length !== bins) this.guardSpec = new Float32Array(bins);
    an.getFloatFrequencyData(this.guardSpec);
    const s = this.guardSpec, hz = this.ctx.sampleRate / an.fftSize;
    const lo = Math.ceil(70 / hz), hi = Math.min(bins - 41, Math.floor(12000 / hz));
    const thresholdDb = 30 - sensitivity * 18;
    const seen = new Set<number>();
    let loudest = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = s[i];
      if (v > loudest) loudest = v;
      if (v < -55 || v < s[i - 1] || v < s[i + 1] || v < s[i - 2] || v < s[i + 2]) continue;
      let sum = 0, cnt = 0;
      for (let k = i - 40; k <= i + 40; k += 2) if (Math.abs(k - i) > 4) { sum += s[k]; cnt++; }
      if (v - sum / cnt < thresholdDb) continue;
      const key = Math.round(i / 2);
      seen.add(key);
      const c = g.cand.get(key) ?? { n: 0, bin: i, peak: v, first: v };
      c.n++; c.bin = i; c.peak = v;
      g.cand.set(key, c);
    }
    for (const [key, c] of g.cand) {
      if (!seen.has(key)) { c.n -= 2; if (c.n <= 0) g.cand.delete(key); continue; }
      // ~1 s of steady ringing that is not a harmonic of the note being played
      if (c.n >= 10) {
        if (c.peak >= c.first - 1.5 && !this.isMusic(c.bin * hz)) this.placeNotch(c.bin * hz);
        g.cand.delete(key);
      }
    }
    const howl = loudest > -4 && [...g.cand.values()].some((c) => c.n >= 4 && !this.isMusic(c.bin * hz));
    if (howl !== g.duck) { g.duck = howl; sm(this.duck.gain, howl ? 0.3 : 1, this.ctx, howl ? 0.01 : 0.8); }
  }

  private placeNotch(freq: number): void {
    const g = this.guard;
    const near = g.notches.find((n) => Math.abs(Math.log2(n.freq / freq)) < 1 / 12);
    if (near) { near.gain = Math.max(-30, near.gain - 4); sm(this.notches[near.idx].gain, near.gain, this.ctx, 0.05); return; }
    let idx = this.notches.findIndex((_, i) => !g.notches.some((n) => n.idx === i));
    if (idx < 0) idx = g.notches.shift()!.idx;
    const n = { idx, freq, gain: -14 };
    g.notches.push(n);
    const f = this.notches[idx];
    f.frequency.setValueAtTime(freq, this.ctx.currentTime);
    sm(f.gain, n.gain, this.ctx, 0.02);
    this.onStatus('guard', `Feedback tamed at ${freq < 1000 ? Math.round(freq) + ' Hz' : (freq / 1000).toFixed(2) + ' kHz'}`);
  }

  resetGuard(): void {
    for (const n of this.notches) sm(n.gain, 0, this.ctx, 0.1);
    this.guard.notches = [];
    this.guard.cand.clear();
    this.guard.duck = false;
    if (this.duck) sm(this.duck.gain, 1, this.ctx, 0.3);
  }

  // ───────────────────────── recording + info ─────────────────────────
  startRecording(): void {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.chunks = [];
    this.recorder = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);
  }

  stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) { resolve(null); return; }
      rec.onstop = () => { resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' })); this.recorder = null; };
      rec.stop();
    });
  }

  latencyMs(): number { return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000; }
}
