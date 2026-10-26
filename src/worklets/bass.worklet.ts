// Bass voice: turns an analog synth (or any monophonic source) into a
// well-tempered bass. Everything runs in one AudioWorklet for low latency.
//
//  in ─ DC block ─┬─ envelope follower ──────────────────────────────┐ (dynamics follow the player)
//                 └─ LP + decimate ─ adaptive YIN ─ well temperament ─ glide ─ OSC + SUB + NOISE
//                                                                     ─ wavefolder ─ ladder LP ─ drive ─ out
//
// The YIN window adapts to ~2.3 periods of the current note and runs every
// ~4 ms, so note changes are picked up within a period or two.

import { nearestTempered } from '../temperament';

const TWO_PI = Math.PI * 2;
const RING = 2048;

function blep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

const P = [
  ['gateThresh', 0.004, 0, 1], ['sens', 4, 0.5, 20],
  ['key', 9, 0, 11], ['scale', 0, 0, 5], ['temper', 1, 0, 4], ['ref', 440, 400, 480],
  ['quant', 1, 0, 1], ['glide', 12, 0, 600], ['octave', -1, -3, 1], ['range', 1, 0, 1],
  ['shape', 0.2, 0, 1], ['sub', 0.5, 0, 1], ['noise', 0, 0, 0.5], ['blend', 0, 0, 1],
  ['cutoff', 400, 30, 12000], ['reso', 0.35, 0, 1], ['envAmt', 0.5, 0, 1], ['drive', 0.25, 0, 1],
  ['fold', 0, 0, 1], ['attack', 3, 0.5, 200], ['release', 120, 5, 2000], ['level', 0.8, 0, 1.5],
] as const;

class BassProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return P.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'k-rate' as const }));
  }

  // input conditioning
  private dcX = 0;
  private dcY = 0;
  private env = 0;
  private open = false;
  private hold = 0;
  private amp = 0;

  // analysis
  private readonly decim = 4;
  private readonly anaRate = sampleRate / 4;
  private readonly ring = new Float32Array(RING);
  private readonly buf = new Float32Array(RING);
  private readonly diff = new Float32Array(512);
  private ringPos = 0;
  private lp = 0;
  private acc = 0;
  private accN = 0;
  private hop = 0;
  private period = 0;          // in decimated samples, 0 = unlocked
  private f0 = 0;
  private voiced = false;
  private lastRaw = 0;          // previous detection, for outlier rejection

  // voice
  private logF = Math.log2(55);
  private logTarget = Math.log2(55);
  private phase = 0;
  private subPhase = 0;
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
  private report = 0;
  private target = { midi: 0, cents: 0, err: 0 };

  private detect(): void {
    const { ring, buf, diff } = this;
    const W = this.period ? Math.max(96, Math.min(480, Math.round(this.period * 2.3))) : 480;
    const tauMax = Math.min(440, this.period ? Math.round(this.period * 2.2) : 440, RING - W - 1);
    const tauMin = Math.max(2, Math.floor(this.anaRate / 1200));
    const n = W + tauMax;
    let p = (this.ringPos - n + RING) % RING;
    for (let i = 0; i < n; i++) { buf[i] = ring[p]; p = (p + 1) % RING; }
    let run = 0;
    diff[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const d = buf[j] - buf[j + tau]; s += d * d; }
      run += s;
      diff[tau] = run > 0 ? (s * tau) / run : 1;
    }
    let found = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (diff[tau] < 0.15) {
        while (tau + 1 < tauMax && diff[tau + 1] < diff[tau]) tau++;
        found = tau;
        break;
      }
    }
    if (found < 1) {
      // lost lock with a short window: widen and retry once next hop
      this.voiced = false;
      this.period = 0;
      return;
    }
    const a = diff[found - 1], b = diff[found], c = diff[found + 1];
    const den = a + c - 2 * b;
    const exact = found + (den !== 0 ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0);
    this.period = exact;
    this.f0 = this.anaRate / exact;
    this.voiced = true;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], prm: Record<string, Float32Array>): boolean {
    const inp = inputs[0]?.[0];
    const out = outputs[0][0];
    const n = out.length;
    const v = (k: string): number => prm[k][0];

    const thr = v('gateThresh'), sens = v('sens');
    const key = Math.round(v('key')), scale = Math.round(v('scale')), temper = Math.round(v('temper'));
    const ref = v('ref'), quant = v('quant'), octave = Math.round(v('octave')), range = v('range') >= 0.5;
    const shape = v('shape'), subAmt = v('sub'), noise = v('noise'), blend = v('blend');
    const cutoff = v('cutoff'), k = v('reso') * 3.9, envAmt = v('envAmt'), drive = v('drive'), fold = v('fold'), level = v('level');
    const glideMs = v('glide');
    const glide = glideMs <= 0 ? 1 : 1 - Math.exp(-1 / (glideMs * 0.001 * sampleRate));
    const atk = 1 - Math.exp(-1 / (v('attack') * 0.001 * sampleRate));
    const rel = 1 - Math.exp(-1 / (v('release') * 0.001 * sampleRate));
    const envAtk = 1 - Math.exp(-1 / (0.0008 * sampleRate));
    const envRel = 1 - Math.exp(-1 / (0.04 * sampleRate));
    const lpCoef = 1 - Math.exp(-TWO_PI * 1500 / sampleRate);
    const dg = 1 + drive * 7;
    const dNorm = 1 / Math.tanh(dg);
    const fg = 1 + fold * 5;

    for (let i = 0; i < n; i++) {
      const raw = inp ? inp[i] : 0;
      // DC blocker
      const x = raw - this.dcX + 0.995 * this.dcY;
      this.dcX = raw;
      this.dcY = x;

      // envelope + gate (hysteresis and a short hold)
      const ax = Math.abs(x);
      this.env += (ax - this.env) * (ax > this.env ? envAtk : envRel);
      if (this.env > thr) { this.open = true; this.hold = sampleRate * 0.03; }
      else if (this.env < thr * 0.5) { if (this.hold > 0) this.hold--; else this.open = false; }

      // analysis path
      this.lp += (x - this.lp) * lpCoef;
      this.acc += this.lp;
      if (++this.accN === this.decim) {
        this.ring[this.ringPos] = this.acc / this.decim;
        this.ringPos = (this.ringPos + 1) % RING;
        this.acc = 0;
        this.accN = 0;
        if (++this.hop >= 48) {
          this.hop = 0;
          if (this.open) {
            this.detect();
            // retune only when two detections in a row agree (rejects octave blips, costs one ~4 ms hop)
            const agree = this.voiced && this.lastRaw > 0 && Math.abs(Math.log2(this.f0 / this.lastRaw)) < 0.04;
            this.lastRaw = this.voiced ? this.f0 : 0;
            if (agree) {
              let m = 69 + 12 * Math.log2(this.f0 / ref) + octave * 12;
              if (range) { while (m >= 52) m -= 12; while (m < 28) m += 12; }   // fold into E1..D#3
              const t = nearestTempered(m, key, scale, temper);
              const tm = t ? m + (t.exact - m) * quant : m;
              if (t) this.target = { midi: t.midi, cents: t.cents, err: (m - t.exact) * 100 };
              this.logTarget = Math.log2(ref) + (tm - 69) / 12;
            }
          } else {
            this.voiced = false;
            this.period = 0;
          }
        }
      }

      // voice
      this.logF += (this.logTarget - this.logF) * glide;
      const f = Math.min(Math.pow(2, this.logF), sampleRate * 0.45);
      const dt = f / sampleRate;
      const t = this.phase;
      const saw = 2 * t - 1 - blep(t, dt);
      let osc: number;
      if (shape < 0.5) {
        const sq = (t < 0.5 ? 1 : -1) + blep(t, dt) - blep((t + 0.5) % 1, dt);
        osc = saw + (sq - saw) * shape * 2;
      } else {
        const pw = 0.5 - (shape - 0.5) * 0.85;
        const t2 = (t + pw) % 1;
        osc = (saw - (2 * t2 - 1 - blep(t2, dt))) * 0.7;
      }
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;
      this.subPhase += dt * 0.5;
      if (this.subPhase >= 1) this.subPhase -= 1;
      const sub = Math.tanh(Math.sin(TWO_PI * this.subPhase) * 2.2) * 0.9;
      let y = osc * (1 - subAmt * 0.45) + sub * subAmt + (Math.random() * 2 - 1) * noise;

      // wavefolder
      if (fold > 0.001) y += (Math.sin(y * fg * 1.2) - y) * Math.min(1, fold * 2.5);

      // amp follows the input envelope
      const want = this.open && (this.voiced || this.amp > 0.002) ? Math.min(1, this.env * sens) : 0;
      this.amp += (want - this.amp) * (want > this.amp ? atk : rel);

      // ladder low-pass with envelope tracking
      const fc = Math.min(cutoff * Math.pow(2, envAmt * 5 * Math.min(1, this.env * sens)), sampleRate * 0.42);
      const g = 1 - Math.exp(-TWO_PI * fc / sampleRate);
      const u = Math.tanh(y - k * this.s4);
      this.s1 += g * (u - this.s1);
      this.s2 += g * (this.s1 - this.s2);
      this.s3 += g * (this.s2 - this.s3);
      this.s4 += g * (this.s3 - this.s4);
      let z = this.s4 * (1 + k * 0.35);

      z = Math.tanh(z * dg) * dNorm * 0.7;
      out[i] = z * this.amp * level + x * blend;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    if (++this.report >= 12) {
      this.report = 0;
      this.port.postMessage({
        f0: this.voiced ? this.f0 : 0,
        out: Math.pow(2, this.logF),
        midi: this.target.midi,
        cents: this.target.cents,
        err: this.target.err,
        amp: this.amp,
        gate: this.open,
      });
    }
    return true;
  }
}

registerProcessor('dsd-bass', BassProcessor);
