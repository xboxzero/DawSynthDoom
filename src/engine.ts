// Audio engine — analog synth in, well-tempered bass out.
//
//  INTERFACE IN ─ trim ─ BASS VOICE (C++/WASM: track · temper · osc · LFO matrix · fold · ladder · drive)
//     ─ PRE-AMP EQ ─ AMP (optional NAM bass amp + IR cab) ─┬─ DRY (mono, centre) ─────────────────┐
//                                                          └─ sends (high-passed, lows stay mono) │
//                                                             DELAY · REVERB · MOD · DOUBLER ─ WET (stereo, width)
//                                                                                                 ▼
//          MIX ─ END RACK ─ IR SIM ─ FEEDBACK GUARD ─ MASTER EQ ─ GLUE ─ SAFE ─ MASTER ─ LIMITER ─ OUT

import { NamEngine, type NamModelInfo, type NamNode } from '../vendor/nam/nam-engine.js';
import type { Registry } from './params';
import { Rack } from './rack';
import { Groove } from './groove';
import type { BandDef } from './eq';
import type { BassReport } from './dsp-params';
export type { BassReport } from './dsp-params';

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const faderGain = (p: number): number => (p <= 0 ? 0 : p * p * p * 2); // 0.794 ≈ unity

export type WetId = 'dly' | 'rev' | 'mod' | 'dbl';
export const WETS: readonly { id: WetId; name: string; side: 'L' | 'R' }[] = [
  { id: 'dly', name: 'DELAY', side: 'L' },
  { id: 'rev', name: 'REVERB', side: 'L' },
  { id: 'mod', name: 'MOD', side: 'R' },
  { id: 'dbl', name: 'DOUBLER', side: 'R' },
];

export const EQ_BANDS: readonly BandDef[] = [
  { type: 'lowshelf', f: 60, q: 0.7 },
  { type: 'peaking', f: 180, q: 1.0 },
  { type: 'peaking', f: 800, q: 1.0 },
  { type: 'peaking', f: 2500, q: 1.0 },
  { type: 'highshelf', f: 8000, q: 0.7 },
];

export const PRE_BANDS: readonly BandDef[] = [
  { type: 'lowshelf', f: 80, q: 0.7 },
  { type: 'peaking', f: 250, q: 1.0 },
  { type: 'peaking', f: 900, q: 1.0 },
  { type: 'highshelf', f: 3500, q: 0.7 },
];

export const MOD_TYPES = ['CHORUS', 'FLANGER', 'VIBRATO', 'PHASER', 'ROTARY', 'RING', 'AUTOPAN'] as const;
export const IR_TYPES = ['ROOM', 'PLATE', 'HALL', 'SPRING', 'BASS CAB', 'RADIO', 'PHONE', 'SAND DUNE'] as const;
export const INPUT_CHANNELS = ['IN 1', 'IN 2', 'IN 3', 'IN 4', '1+2'] as const;

/** Explain a getUserMedia failure in plain words. */
export function describeInputError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NotAllowedError': return 'Audio input blocked. Allow the microphone / audio input for this site in the browser settings (padlock icon), then press RETRY.';
    case 'NotFoundError': return 'No audio input found. Connect your audio interface, then press RETRY.';
    case 'NotReadableError': return 'The input is busy. Close other apps using the interface (DAW, Zoom…), then press RETRY.';
    case 'OverconstrainedError': return 'That device is not available any more. Pick another input.';
    case 'SecurityError': return 'Audio input needs a secure page (https).';
    default: return `Input error: ${e?.message ?? String(err)}`;
  }
}

interface Wet {
  send: GainNode; mute: GainNode; ret: GainNode; meter: AnalyserNode; hp: BiquadFilterNode;
  tone?: BiquadFilterNode; l?: DelayNode; r?: DelayNode; fb?: GainNode; pre?: DelayNode; conv?: ConvolverNode;
  lfo?: OscillatorNode; gl?: GainNode; gr?: GainNode;
}

/** Built-in impulse responses for the end-of-chain IR sim, rendered offline. */
async function makeIR(rate: number, type: number): Promise<AudioBuffer> {
  const name = IR_TYPES[type] ?? 'ROOM';
  const secs = { ROOM: 0.5, PLATE: 1.8, HALL: 3.2, SPRING: 1.6, 'BASS CAB': 0.05, RADIO: 0.03, PHONE: 0.03, 'SAND DUNE': 5 }[name];
  const len = Math.max(256, Math.floor(rate * secs));
  const off = new OfflineAudioContext(2, len, rate);
  const src = off.createBufferSource();
  const raw = off.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = raw.getChannelData(ch);
    if (name === 'BASS CAB' || name === 'RADIO' || name === 'PHONE') { d[0] = 1; continue; }
    if (name === 'SAND DUNE') {
      // Open desert: almost no early reflections, a few soft distant slaps off dune
      // faces, a long airy tail that loses its highs quickly (sand absorbs them),
      // a faint "singing sand" drone around 95 Hz and wind-like slow swirl.
      let lp = 0;
      const echoes = ch === 0 ? [0.19, 0.47, 0.83, 1.31] : [0.23, 0.55, 0.97, 1.42];
      for (let i = 0; i < len; i++) {
        const sec = i / rate, t = i / len;
        const swirl = 0.75 + 0.25 * Math.sin(2 * Math.PI * (0.31 + ch * 0.07) * sec);
        lp += ((Math.random() * 2 - 1) - lp) * (0.5 * Math.exp(-sec * 1.4) + 0.02);   // darker over time
        let v = lp * Math.pow(1 - t, 1.3) * swirl * 0.6 * Math.min(1, sec / 0.06);
        v += Math.sin(2 * Math.PI * 95 * sec + ch) * 0.05 * Math.exp(-sec * 0.8) * Math.min(1, sec / 0.3);
        for (const e of echoes) { const di = sec - e; if (di >= 0 && di < 0.04) v += (Math.random() * 2 - 1) * 0.35 * Math.exp(-di * 90) * Math.exp(-e * 1.2); }
        d[i] = v;
      }
      continue;
    }
    for (let i = 0; i < len; i++) {
      const t = i / len;
      let v = (Math.random() * 2 - 1) * Math.pow(1 - t, name === 'PLATE' ? 1.6 : 2.4);
      if (name === 'SPRING') v += Math.sin(2 * Math.PI * (180 + 900 * t) * (i / rate) * (1 + ch * 0.01)) * Math.exp(-t * 5) * 0.6;
      if (name === 'ROOM' && i < rate * 0.04 && i % Math.floor(rate * (0.007 + ch * 0.002)) === 0) v += 0.7;   // early reflections
      d[i] = v;
    }
  }
  src.buffer = raw;
  const filters: [BiquadFilterType, number, number, number][] = {
    ROOM: [['lowpass', 7000, 0.7, 0]], PLATE: [['highpass', 200, 0.7, 0], ['highshelf', 5000, 0.7, 3]],
    HALL: [['lowpass', 5000, 0.7, 0]], SPRING: [['highpass', 250, 0.7, 0], ['peaking', 1800, 2, 6], ['lowpass', 4500, 0.7, 0]],
    'BASS CAB': [['highpass', 38, 0.7, 0], ['peaking', 70, 1, 3], ['peaking', 400, 1.2, -4], ['peaking', 1800, 1.5, 3], ['lowpass', 4200, 0.8, 0], ['lowpass', 5500, 0.7, 0]],
    RADIO: [['highpass', 450, 0.9, 0], ['peaking', 1500, 1.2, 6], ['lowpass', 3200, 1.2, 0]],
    PHONE: [['highpass', 320, 1.4, 0], ['highpass', 320, 1.4, 0], ['lowpass', 3400, 1.4, 0], ['lowpass', 3400, 1.4, 0]],
    'SAND DUNE': [['highpass', 50, 0.7, 0], ['highshelf', 3000, 0.7, -6], ['lowpass', 9000, 0.7, 0]],
  }[name] as [BiquadFilterType, number, number, number][];
  let node: AudioNode = src;
  for (const [t, f, q, g] of filters) {
    const b = off.createBiquadFilter();
    b.type = t; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    node.connect(b);
    node = b;
  }
  node.connect(off.destination);
  src.start();
  return off.startRendering();
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
  guard = { notches: [] as { idx: number; freq: number; gain: number }[], cand: new Map<number, { n: number; bin: number; peak: number; first: number; notes: Set<number>; fund: Set<number> }>(), duck: false };
  inputChannels = 1;
  inputLabel = '';
  irName = 'ROOM';
  preAnalyser!: AnalyserNode;

  private splitter!: ChannelSplitterNode;
  private chGain: GainNode[] = [];
  private readonly chMeters: AnalyserNode[] = [];
  private readonly chBuf = new Float32Array(1024);

  /** peak level in dBFS of each physical input channel (IN 1-4) */
  channelLevels(): number[] {
    return this.chMeters.map((a, i) => {
      if (i >= this.inputChannels) return -120;
      a.getFloatTimeDomainData(this.chBuf);
      let pk = 0;
      for (const v of this.chBuf) { const x = Math.abs(v); if (x > pk) pk = x; }
      return 20 * Math.log10(pk + 1e-9);
    });
  }
  private preHp!: BiquadFilterNode;
  private pre: BiquadFilterNode[] = [];
  private irConv!: ConvolverNode;
  private irDry!: GainNode;
  private irWet!: GainNode;
  private irLo!: BiquadFilterNode;
  private irHi!: BiquadFilterNode;
  private irUser = false;
  private irTimer = 0;
  private mod: { types: GainNode[]; lfo: OscillatorNode; lfoR: GainNode; depth: GainNode[]; fb: GainNode[]; ring: OscillatorNode; ringAmt: GainNode; tone: BiquadFilterNode } | null = null;
  private wasm: ArrayBuffer | null = null;
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
  private loopKill!: GainNode;
  pump!: GainNode;
  groove!: Groove;
  final = {} as { hp: BiquadFilterNode; low: BiquadFilterNode; punch: BiquadFilterNode; presence: BiquadFilterNode; harm: GainNode; loud: GainNode };

  setFinal(o: { hp: number; low: number; punch: number; presence: number; harm: number; loud: number }): void {
    const f = this.final;
    if (!f.hp) return;
    sm(f.hp.frequency, o.hp, this.ctx); sm(f.low.gain, o.low, this.ctx); sm(f.punch.gain, o.punch, this.ctx);
    sm(f.presence.gain, o.presence, this.ctx); sm(f.harm.gain, o.harm * 1.2, this.ctx); sm(f.loud.gain, dbToLin(o.loud), this.ctx);
  }
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
    // NAM captures are trained at 48 kHz, but only Chromium resamples the input
    // reliably; Safari/iOS and Firefox can go silent if the context rate is forced.
    const ua = navigator.userAgent;
    const chromium = /Chrome|Chromium|Edg\//.test(ua) && !/CriOS|FxiOS|iPhone|iPad/.test(ua);
    const opts: AudioContextOptions = { latencyHint: lowest ? 0 : 'interactive' };
    if (chromium) opts.sampleRate = 48000;
    try { this.ctx = new AudioContext(opts); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); }
    await this.ctx.resume();
    const [wasm] = await Promise.all([
      fetch(new URL('./bass.wasm', import.meta.url)).then((r) => { if (!r.ok) throw new Error(`bass.wasm ${r.status}`); return r.arrayBuffer(); }),
      this.ctx.audioWorklet.addModule(new URL('./bass.worklet.js', import.meta.url)),
    ]);
    this.wasm = wasm;
    // iOS / Safari can suspend the context (e.g. while the mic starts); resume on the next touch
    this.ctx.addEventListener('statechange', () => this.onStatus('ctx', this.ctx.state));
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
    this.splitter = ctx.createChannelSplitter(4);
    this.inMono = ctx.createGain();
    this.inMono.channelCount = 1;
    this.inMono.channelCountMode = 'explicit';
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      this.splitter.connect(g, i);
      g.connect(this.inMono);
      this.chGain.push(g);
      // one meter per physical input, so we can see (and follow) where the signal is
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      this.splitter.connect(a, i);
      this.chMeters.push(a);
    }
    this.inTrim = ctx.createGain();
    this.inMono.connect(this.inTrim);
    this.inAnalyser = ctx.createAnalyser();
    this.inAnalyser.fftSize = 8192;
    this.inAnalyser.smoothingTimeConstant = 0.5;
    this.inTrim.connect(this.inAnalyser);
    this.bass = new AudioWorkletNode(ctx, 'dsd-bass', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { wasm: this.wasm } });
    this.bass.port.onmessage = (e: MessageEvent<BassReport | { error: string } | { ready: true }>) => {
      const d = e.data;
      if ('error' in d) this.onStatus('dsp-error', `Bass DSP failed: ${d.error}`);
      else if ('f0' in d) this.onBass(d);
    };
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

  /**
   * Open an audio input. Tries the chosen device, then the default device, then
   * whatever the browser allows, so a stale device id or an unsupported constraint
   * never leaves you with no input. safe = phone-safe mode (echo cancellation).
   */
  async useDevice(deviceId: string | undefined, safe: boolean): Promise<string> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Audio input needs https (or localhost).'), { name: 'SecurityError' });
    }
    this.stopSource();
    const base: MediaTrackConstraints = { echoCancellation: safe, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    const attempts: (MediaTrackConstraints | true)[] = [];
    if (deviceId) attempts.push({ ...base, deviceId: { exact: deviceId } });
    attempts.push(base, true);
    let lastErr: unknown = null;
    for (const audio of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio });
        break;
      } catch (err) {
        lastErr = err;
        const name = (err as { name?: string }).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') break;   // retrying will not help
      }
    }
    if (!this.stream) throw lastErr;
    const src = this.ctx.createMediaStreamSource(this.stream);
    src.connect(this.splitter);
    this.source = src;
    const track = this.stream.getAudioTracks()[0];
    this.inputChannels = track.getSettings().channelCount ?? 1;
    this.inputLabel = track.label;
    track.addEventListener('ended', () => this.onStatus('input-ended', 'The audio input was disconnected.'));
    this.applyChannel(this.reg.get('in.ch'));
    if (this.ctx.state !== 'running') await this.ctx.resume();
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

  /** ch: 0-3 = IN 1-4, 4 = IN 1+2. Missing channels fall back to IN 1. */
  applyChannel(ch: number): void {
    if (!this.chGain.length) return;
    const n = this.inputChannels;
    const gains = [0, 0, 0, 0];
    if (ch === 4) { if (n > 1) { gains[0] = 0.5; gains[1] = 0.5; } else gains[0] = 1; }
    else gains[ch < n ? ch : 0] = 1;
    gains.forEach((g, i) => sm(this.chGain[i].gain, g, this.ctx));
  }

  // ───────────────────────── amp (optional NAM bass amp + cab) ─────────────────────────
  private buildAmp(): void {
    const ctx = this.ctx;
    // pre-amp EQ: low cut + four bands between the bass voice and the amp
    this.preHp = ctx.createBiquadFilter();
    this.preHp.type = 'highpass';
    this.preHp.Q.value = 0.7;
    this.bass.connect(this.preHp);
    let node: AudioNode = this.preHp;
    this.pre = PRE_BANDS.map((b) => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q; node.connect(f); node = f; return f; });
    this.preAnalyser = ctx.createAnalyser();
    this.preAnalyser.fftSize = 4096;
    this.preAnalyser.smoothingTimeConstant = 0.8;
    node.connect(this.preAnalyser);
    this.ampIn = ctx.createGain();
    node.connect(this.ampIn);
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
    // MOD: seven modulation effects share one LFO; the TYPE switch picks which one you hear
    const c = mk(140);
    const lfo = ctx.createOscillator(); lfo.start();
    const lfoR = ctx.createGain();                       // right-channel LFO (polarity set by SPREAD)
    lfo.connect(lfoR);
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
    c.hp.connect(tone);
    const types: GainNode[] = [], depth: GainNode[] = [], fbs: GainNode[] = [];
    const typeOut = (l: AudioNode, r: AudioNode): void => {
      const g = ctx.createGain(); g.gain.value = 0; g.channelCount = 2; g.channelCountMode = 'explicit';
      const m2 = ctx.createChannelMerger(2);
      l.connect(m2, 0, 0); r.connect(m2, 0, 1); m2.connect(g); g.connect(c.ret);
      types.push(g);
    };
    const lfoTo = (param: AudioParam, right: boolean, scale: number): void => {
      const g = ctx.createGain(); g.gain.value = 0; (g as GainNode & { scale?: number }).scale = scale;
      (right ? lfoR : lfo).connect(g); g.connect(param); depth.push(g);
    };
    const modDelay = (baseMs: number, scaleMs: number, feedback: boolean): void => {
      const l = ctx.createDelay(0.1), r = ctx.createDelay(0.1);
      l.delayTime.value = baseMs / 1000; r.delayTime.value = (baseMs * 1.15) / 1000;
      tone.connect(l); tone.connect(r);
      lfoTo(l.delayTime, false, scaleMs / 1000); lfoTo(r.delayTime, true, scaleMs / 1000);
      if (feedback) { for (const d of [l, r]) { const fb = ctx.createGain(); fb.gain.value = 0; d.connect(fb); fb.connect(d); fbs.push(fb); } }
      typeOut(l, r);
    };
    modDelay(12, 5, false);                                  // CHORUS
    modDelay(2, 1.8, true);                                  // FLANGER
    modDelay(6, 3, false);                                   // VIBRATO
    {                                                        // PHASER: four all-pass stages per side
      const chain = (right: boolean): AudioNode => {
        let n: AudioNode = tone;
        for (let i = 0; i < 4; i++) {
          const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = 700; ap.Q.value = 0.7;
          n.connect(ap); n = ap;
          lfoTo(ap.detune, right, 2400);
        }
        const mix = ctx.createGain(); tone.connect(mix); n.connect(mix); mix.gain.value = 0.7;
        return mix;
      };
      typeOut(chain(false), chain(true));
    }
    {                                                        // ROTARY: doppler + opposed amplitude
      const l = ctx.createDelay(0.05), r = ctx.createDelay(0.05);
      l.delayTime.value = 0.004; r.delayTime.value = 0.004;
      tone.connect(l); tone.connect(r);
      lfoTo(l.delayTime, false, 0.0012); lfoTo(r.delayTime, true, -0.0012);
      const al = ctx.createGain(), ar = ctx.createGain(); al.gain.value = 0.6; ar.gain.value = 0.6;
      l.connect(al); r.connect(ar);
      lfoTo(al.gain, false, 0.4); lfoTo(ar.gain, false, -0.4);
      typeOut(al, ar);
    }
    const ring = ctx.createOscillator(); ring.start();
    const ringAmt = ctx.createGain();
    {                                                        // RING: multiply by an audio-rate carrier
      const rm = ctx.createGain(); rm.gain.value = 0;
      ring.connect(ringAmt); ringAmt.connect(rm.gain);
      tone.connect(rm);
      typeOut(rm, rm);
    }
    {                                                        // AUTOPAN
      const gl = ctx.createGain(), gr = ctx.createGain(); gl.gain.value = 0.5; gr.gain.value = 0.5;
      tone.connect(gl); tone.connect(gr);
      lfoTo(gl.gain, false, 0.5); lfoTo(gr.gain, false, -0.5);
      typeOut(gl, gr);
    }
    this.mod = { types, lfo, lfoR, depth, fb: fbs, ring, ringAmt, tone };
    // doubler
    const b = mk(180);
    b.lfo = ctx.createOscillator(); b.lfo.frequency.value = 0.13; b.lfo.start();
    b.l = ctx.createDelay(0.2); b.r = ctx.createDelay(0.2);
    b.gl = ctx.createGain(); b.gr = ctx.createGain(); b.gl.gain.value = 0.0012; b.gr.gain.value = -0.0015;
    b.lfo.connect(b.gl); b.lfo.connect(b.gr); b.gl.connect(b.l.delayTime); b.gr.connect(b.r.delayTime);
    const bm = ctx.createChannelMerger(2);
    b.hp.connect(b.l); b.hp.connect(b.r);
    b.l.connect(bm, 0, 0); b.r.connect(bm, 0, 1); bm.connect(b.ret);
    this.wet = { dly: d, rev: r, mod: c, dbl: b };
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

  setMod(): void {
    const md = this.mod;
    if (!md) return;
    const type = Math.round(this.reg.get('mod.type'));
    const depth = this.reg.get('mod.depth');
    md.types.forEach((g, i) => sm(g.gain, i === type ? 1 : 0, this.ctx, 0.03));
    md.lfo.type = (['sine', 'triangle', 'square', 'sawtooth'] as const)[Math.round(this.reg.get('mod.shape'))] ?? 'sine';
    sm(md.lfo.frequency, this.reg.get('mod.rate'), this.ctx);
    sm(md.lfoR.gain, 1 - 2 * this.reg.get('mod.spread'), this.ctx);      // 0 = in phase, 1 = opposite
    for (const g of md.depth) sm(g.gain, depth * ((g as GainNode & { scale?: number }).scale ?? 0), this.ctx);
    for (const g of md.fb) sm(g.gain, Math.min(0.75, this.reg.get('mod.fb')), this.ctx);   // capped: no runaway flanger
    sm(md.ring.frequency, this.reg.get('mod.ring'), this.ctx);
    sm(md.ringAmt.gain, depth, this.ctx);
    sm(md.tone.frequency, this.reg.get('mod.tone'), this.ctx);
  }

  setPre(i: number, on: boolean, f: number, g: number, q: number): void {
    const b = this.pre[i];
    if (!b) return;
    sm(b.frequency, f, this.ctx); sm(b.gain, on ? g : 0, this.ctx); sm(b.Q, q, this.ctx);
  }

  setPreLowCut(on: boolean, hz: number): void { if (this.preHp) sm(this.preHp.frequency, on ? hz : 10, this.ctx); }

  // ───────────────────────── IR sim (end of chain) ─────────────────────────
  applyIR(): void {
    if (!this.irConv) return;
    const on = this.reg.on('ir.on'), mix = this.reg.get('ir.mix');
    sm(this.irDry.gain, on ? 1 - mix : 1, this.ctx);
    sm(this.irWet.gain, on ? mix * dbToLin(this.reg.get('ir.gain')) : 0, this.ctx);
    sm(this.irLo.frequency, this.reg.get('ir.lo'), this.ctx);
    sm(this.irHi.frequency, this.reg.get('ir.hi'), this.ctx);
  }

  regenIR(): void {
    if (!this.irConv || this.irUser) return;
    clearTimeout(this.irTimer);
    const type = Math.round(this.reg.get('ir.type'));
    this.irTimer = window.setTimeout(() => {
      void makeIR(this.ctx.sampleRate, type).then((b) => { if (!this.irUser) { this.irConv.buffer = b; this.irName = IR_TYPES[type] ?? 'ROOM'; this.onStatus('ir', this.irName); } });
    }, 80);
  }

  async loadIR(bytes: ArrayBuffer, name: string): Promise<void> {
    this.irConv.buffer = await this.ctx.decodeAudioData(bytes);
    this.irUser = true;
    this.irName = name;
  }

  useBuiltInIR(): void { this.irUser = false; this.regenIR(); }

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
    this.pump = ctx.createGain();                 // sidechain pump from the drum groove
    this.dryPan.connect(this.pump);
    this.wetGain.connect(this.pump);
    this.pump.connect(mix);
    this.groove = new Groove(ctx, this.pump);
    this.groove.out.connect(mix);
    this.mixAnalyser = ctx.createAnalyser();
    this.mixAnalyser.fftSize = 4096;
    this.mixAnalyser.smoothingTimeConstant = 0.8;
    mix.connect(this.mixAnalyser);
    const rackIn = ctx.createGain(), rackOut = ctx.createGain();
    mix.connect(rackIn);
    this.rack = new Rack(ctx, rackIn, rackOut, this.reg);
    // IR sim at the end of the chain
    this.irConv = ctx.createConvolver();
    this.irDry = ctx.createGain(); this.irWet = ctx.createGain();
    this.irLo = ctx.createBiquadFilter(); this.irLo.type = 'highpass';
    this.irHi = ctx.createBiquadFilter(); this.irHi.type = 'lowpass';
    const irOut = ctx.createGain();
    rackOut.connect(this.irDry); this.irDry.connect(irOut);
    rackOut.connect(this.irConv); this.irConv.connect(this.irLo); this.irLo.connect(this.irHi); this.irHi.connect(this.irWet); this.irWet.connect(irOut);
    let node: AudioNode = irOut;
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
    this.loopKill = ctx.createGain();
    this.master = ctx.createGain();
    this.duck.connect(this.master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    // FINAL BOOST: speaker-protect high-pass, low / punch / presence EQ, bass
    // harmonics (so small speakers and guitar amps can still hear the bass) and a
    // loudness push into the limiter.
    const fin = this.final;
    fin.hp = ctx.createBiquadFilter(); fin.hp.type = 'highpass'; fin.hp.Q.value = 0.7;
    fin.low = ctx.createBiquadFilter(); fin.low.type = 'lowshelf'; fin.low.frequency.value = 90;
    fin.punch = ctx.createBiquadFilter(); fin.punch.type = 'peaking'; fin.punch.frequency.value = 250; fin.punch.Q.value = 0.9;
    fin.presence = ctx.createBiquadFilter(); fin.presence.type = 'highshelf'; fin.presence.frequency.value = 3500;
    fin.loud = ctx.createGain();
    this.master.connect(fin.low); fin.low.connect(fin.punch); fin.punch.connect(fin.presence); fin.presence.connect(fin.hp); fin.hp.connect(fin.loud);
    const hb = ctx.createBiquadFilter(); hb.type = 'lowpass'; hb.frequency.value = 160;
    const hs = ctx.createWaveShaper();
    const hc = new Float32Array(2048);
    for (let i = 0; i < hc.length; i++) { const x = (i / (hc.length - 1)) * 2 - 1; hc[i] = Math.tanh(3 * Math.abs(x)) * 0.7 + Math.tanh(3 * x) * 0.3; }   // even + odd harmonics
    hs.curve = hc;
    const hh = ctx.createBiquadFilter(); hh.type = 'highpass'; hh.frequency.value = 140;
    const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 900;
    fin.harm = ctx.createGain(); fin.harm.gain.value = 0;
    this.master.connect(hb); hb.connect(hs); hs.connect(hh); hh.connect(hl); hl.connect(fin.harm); fin.harm.connect(fin.loud);
    fin.loud.connect(limiter);
    const out = ctx.createGain();
    // the loop breaker sits last, after the limiter, so its probe dips and cuts are real at the speaker
    // true ceiling: the compressor-limiter can overshoot, so a soft clipper catches the rest (max ≈ -0.5 dBFS)
    const ceiling = ctx.createWaveShaper();
    const cc = new Float32Array(4096);
    for (let i = 0; i < cc.length; i++) { const x = ((i / (cc.length - 1)) * 2 - 1) * 2; cc[i] = 0.944 * Math.tanh(x / 0.944); }
    ceiling.curve = cc;
    ceiling.oversample = '2x';
    // the shaper reads inputs in ±1, so feed it x/2 and let the curve handle the real ±2 range
    const pre = ctx.createGain(); pre.gain.value = 0.5;
    limiter.connect(pre); pre.connect(ceiling);
    ceiling.connect(this.loopKill);
    this.loopKill.connect(out);
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
  /** phone-safe caps the output at -4 dB (feedback itself is handled by the loop breaker) */
  setSafe(on: boolean): void { if (this.safeGain) sm(this.safeGain.gain, on ? dbToLin(-4) : 1, this.ctx, 0.05); }
  async setOutputDevice(id: string): Promise<void> {
    const c = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    await c.setSinkId?.(id);
  }

  // ───────────────────────── feedback guard ─────────────────────────
  // Finds narrow peaks far above their neighbours that hold or grow (feedback),
  // as opposed to notes that decay, and notches them. A loud howl ducks the master.
  /** pitches currently being played (bass out + synth in); the guard only notches peaks that outlast a note change */
  playing: number[] = [];

  /** a low harmonic (k ≤ 12, within 1.5%) of any pitch heard while the peak rang */
  private harmonicOf(freq: number, fund: Set<number>): boolean {
    for (const f of fund) {
      const k = Math.round(freq / f);
      if (k >= 1 && k <= 12 && Math.abs(freq / (k * f) - 1) < 0.015) return true;
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
    // above 150 Hz only: bass fundamentals are never notched (low howls go to the loop breaker)
    const lo = Math.ceil(150 / hz), hi = Math.min(bins - 41, Math.floor(12000 / hz));
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
      const c = g.cand.get(key) ?? { n: 0, bin: i, peak: v, first: v, notes: new Set<number>(), fund: new Set<number>() };
      c.n++; c.bin = i; c.peak = v;
      c.notes.add(this.playing[0] > 0 ? Math.round(12 * Math.log2(this.playing[0] / 440)) : -1);
      for (const f of this.playing) if (f > 0) { c.fund.add(Math.round(f)); c.fund.add(Math.round(f / 2)); }   // note + its sub
      g.cand.set(key, c);
    }
    for (const [key, c] of g.cand) {
      if (!seen.has(key)) { c.n -= 2; if (c.n <= 0) g.cand.delete(key); continue; }
      // ~1 s of steady ringing that is not a harmonic of the note being played
      if (c.n >= 10) {
        // Feedback rings whatever note you play; harmonics and distortion products
        // move with the notes. So only notch a peak that survived a note change, or
        // one that rings while nothing is being played. (A howl on a single held
        // note is caught by the loop breaker's probe instead.)
        const real = [...c.notes].filter((n) => n !== -1);
        const ringsAcrossNotes = real.length >= 2 || real.length === 0;
        // (A peak that stays put while the notes change cannot be their harmonic,
        // so no harmonic exemption here: with dense bass harmonics it would hide real howls.)
        if (c.peak >= c.first - 1.5 && ringsAcrossNotes && !this.harmonicOf(c.bin * hz, c.fund)) this.placeNotch(c.bin * hz);
        g.cand.delete(key);
      }
    }
    const howl = loudest > -4 && [...g.cand.values()].some((c) => c.n >= 4 && [...c.notes].filter((n) => n !== -1).length >= 2);
    if (howl !== g.duck) { g.duck = howl; sm(this.duck.gain, howl ? 0.3 : 1, this.ctx, howl ? 0.01 : 0.8); }
    this.loopBreaker();
  }

  // ───────────────────────── loop breaker ─────────────────────────
  // The bass voice re-synthesises whatever it hears, so speaker → mic feedback
  // becomes a self-sustaining note that narrow notches cannot stop, and it can
  // settle at a steady level that looks just like a held note.
  //
  // So when the input is suspiciously steady, the engine asks the room: it dips
  // the output 6 dB for 80 ms. If the input follows the dip, the input is our own
  // output coming back → feedback → the output drops 24 dB for 1.5 s (which
  // starves the loop), then fades back. A real synth never reacts to our output,
  // so held notes are left alone.
  private readonly tdBuf = new Float32Array(8192);
  private readonly probeBuf = new Float32Array(16384);
  private inProbe!: AnalyserNode;
  private inHist: number[] = [];
  private breakUntil = 0;
  private nextProbe = 0;
  private probing = false;
  private probeGap = 2;   // seconds between probes; doubles while a held note keeps proving clean
  private breaks: number[] = [];
  loopHold = false;   // stays reduced after repeated loops, until the user resets
  private holdDb = -12;

  private level(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): { peak: number; rms: number } {
    an.getFloatTimeDomainData(buf);
    let pk = 0, sum = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > pk) pk = a; sum += v * v; }
    return { peak: 20 * Math.log10(pk + 1e-9), rms: 10 * Math.log10(sum / buf.length + 1e-18) };
  }

  private breakLoop(reason: string): void {
    const now = this.ctx.currentTime;
    this.breakUntil = now + 1.5;
    this.breaks = this.breaks.filter((t) => now - t < 30);
    this.breaks.push(now);
    this.loopKill.gain.cancelScheduledValues(now);
    this.loopKill.gain.setTargetAtTime(dbToLin(-24), now, 0.004);
    if (this.breaks.length >= 2) {
      if (this.loopHold) this.holdDb = Math.max(-36, this.holdDb - 6);   // still looping: push it down further
      this.loopHold = true;
      this.onStatus('howl-repeat', `Feedback keeps coming back: output held ${-this.holdDb} dB lower and PHONE SAFE switched on. Use headphones, turn the speaker away from the mic, or lower MASTER. RESET GUARD when fixed.`);
    } else {
      this.onStatus('howl', `Feedback loop stopped (${reason}).`);
    }
  }

  // The probe is judged on the audio clock, not on JS timers: a 340 ms history of
  // the input is read after the dip, and the level just before the dip is
  // compared with the level inside it. A busy main thread can't make it miss.
  private probe(): void {
    this.probing = true;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.03;
    const g = this.loopKill.gain;
    const cur = g.value;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(cur, t0);
    g.linearRampToValueAtTime(cur * 0.5, t0 + 0.005);      // -6 dB for 120 ms
    g.setValueAtTime(cur * 0.5, t0 + 0.12);
    g.linearRampToValueAtTime(cur, t0 + 0.125);
    window.setTimeout(() => {
      this.probing = false;
      const an = this.inProbe, buf = this.probeBuf;
      an.getFloatTimeDomainData(buf);
      const now = ctx.currentTime, sr = ctx.sampleRate, N = buf.length;
      const at = (t: number): number => N - Math.round((now - t) * sr);
      const rms = (a: number, b: number): number => {
        const i0 = at(a), i1 = at(b);
        if (i0 < 0 || i1 > N || i1 <= i0) return NaN;
        let sum = 0;
        for (let i = i0; i < i1; i++) sum += buf[i] * buf[i];
        return 10 * Math.log10(sum / (i1 - i0) + 1e-18);
      };
      const before = rms(t0 - 0.1, t0), during = rms(t0 + 0.035, t0 + 0.12);   // allow ~30 ms of room delay
      if (Number.isNaN(before) || Number.isNaN(during)) { this.nextProbe = now + 0.5; return; }   // read too late: retry
      if (before - during > 3) { this.probeGap = 2; this.breakLoop('the input followed the output'); }
      else this.probeGap = Math.min(16, this.probeGap * 2);   // clean: probe a held note less and less often
    }, 200);
  }

  private loopBreaker(): void {
    if (!this.inProbe) {
      this.inProbe = this.ctx.createAnalyser();
      this.inProbe.fftSize = 16384;   // ~340 ms of input history for the probe
      this.inTrim.connect(this.inProbe);
    }
    const now = this.ctx.currentTime;
    const out = this.level(this.guardAnalyser, this.tdBuf), inp = this.level(this.inAnalyser, this.tdBuf);
    this.inHist.push(inp.rms);
    if (this.inHist.length > 12) this.inHist.shift();
    const steadyInput = this.inHist.length >= 10 && Math.max(...this.inHist) - Math.min(...this.inHist) < 3 && inp.rms > -45;
    if (!steadyInput) this.probeGap = 2;   // the music moved: back to quick checks
    if (now < this.breakUntil) return;           // cut in progress
    if (this.breakUntil > 0) {                    // cut over: fade back, then probe again soon
      this.breakUntil = 0;
      this.loopKill.gain.cancelScheduledValues(now);
      this.loopKill.gain.setTargetAtTime(this.loopHold ? dbToLin(this.holdDb) : 1, now, 0.4);
      this.nextProbe = now + 1.5;
      this.probeGap = 2;
      return;
    }
    // the probe: is the steady input actually our own output?
    if (!this.probing && steadyInput && out.peak > -35 && now > this.nextProbe && this.monitor.gain.value > 0.5) {
      this.nextProbe = now + this.probeGap;
      this.probe();
    }
  }

  releaseLoopHold(): void {
    this.loopHold = false;
    this.holdDb = -12;
    this.breaks = [];
    if (this.loopKill) sm(this.loopKill.gain, 1, this.ctx, 0.5);
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
    if (this.duck) sm(this.duck.gain, 1, this.ctx, 0.3);    this.releaseLoopHold();
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
