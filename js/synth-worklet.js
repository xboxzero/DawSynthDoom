// Pitch-tracking guitar/voice synth.
// Follows the pitch (YIN) and loudness of the live input and plays an
// oscillator through an envelope-controlled resonant low-pass filter.

const TWO_PI = Math.PI * 2;

function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

class SynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate';
    return [
      { name: 'wave', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: k },
      { name: 'octave', defaultValue: 0, minValue: -2, maxValue: 2, automationRate: k },
      { name: 'glide', defaultValue: 30, minValue: 0, maxValue: 500, automationRate: k },
      { name: 'cutoff', defaultValue: 1200, minValue: 40, maxValue: 12000, automationRate: k },
      { name: 'reso', defaultValue: 0.4, minValue: 0, maxValue: 0.97, automationRate: k },
      { name: 'envAmt', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'sub', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'gate', defaultValue: 0.01, minValue: 0, maxValue: 0.5, automationRate: k },
    ];
  }

  constructor() {
    super();
    // Analysis runs at sampleRate / 2 to keep YIN cheap.
    this.decim = 2;
    this.anaRate = sampleRate / this.decim;
    this.W = 512;                         // integration window
    this.tauMax = 512;                    // ~47 Hz lowest pitch at 24 kHz
    this.tauMin = Math.floor(this.anaRate / 1400);
    this.buf = new Float32Array(this.W + this.tauMax);
    this.ring = new Float32Array(2048);
    this.ringPos = 0;
    this.decimAcc = 0;
    this.decimCount = 0;
    this.hopCount = 0;
    this.hop = 256;                       // analysis every 256 decimated samples
    this.diff = new Float32Array(this.tauMax + 1);

    this.freq = 110;
    this.targetFreq = 110;
    this.voiced = false;
    this.phase = 0;
    this.subPhase = 0;
    this.env = 0;
    this.amp = 0;
    this.ic1 = 0;
    this.ic2 = 0;
    this.reportCount = 0;
    this.confidence = 0;
  }

  detect() {
    const { buf, ring, W, tauMax, diff } = this;
    const n = buf.length;
    let p = (this.ringPos - n + ring.length) % ring.length;
    for (let i = 0; i < n; i++) { buf[i] = ring[p]; p = (p + 1) % ring.length; }

    diff[0] = 1;
    let running = 0;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const d = buf[j] - buf[j + tau]; s += d * d; }
      running += s;
      diff[tau] = running > 0 ? (s * tau) / running : 1;
    }
    for (let tau = this.tauMin; tau < tauMax; tau++) {
      if (diff[tau] < 0.15) {
        while (tau + 1 < tauMax && diff[tau + 1] < diff[tau]) tau++;
        found = tau;
        break;
      }
    }
    if (found < 0) { this.voiced = false; this.confidence = 0; return; }
    const a = diff[found - 1], b = diff[found], c = diff[found + 1];
    const den = a + c - 2 * b;
    const shift = den !== 0 ? (a - c) / (2 * den) : 0;
    const period = found + Math.max(-1, Math.min(1, shift));
    this.confidence = 1 - b;
    this.voiced = true;
    this.targetFreq = this.anaRate / period;
  }

  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const n = out[0].length;

    const wave = Math.round(params.wave[0]);
    const octMul = Math.pow(2, Math.round(params.octave[0]));
    const glideMs = params.glide[0];
    const glideCoef = glideMs <= 0 ? 1 : 1 - Math.exp(-1 / (glideMs * 0.001 * sampleRate));
    const baseCut = params.cutoff[0];
    const reso = params.reso[0];
    const envAmt = params.envAmt[0];
    const subMix = params.sub[0];
    const gate = params.gate[0];

    const atk = 1 - Math.exp(-1 / (0.002 * sampleRate));
    const rel = 1 - Math.exp(-1 / (0.12 * sampleRate));
    const ampSmooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
    const k = 2 - 2 * reso;

    const ch0 = out[0];
    for (let i = 0; i < n; i++) {
      const x = input ? input[i] : 0;

      // envelope follower
      const ax = Math.abs(x);
      this.env += (ax - this.env) * (ax > this.env ? atk : rel);

      // decimate into the analysis ring
      this.decimAcc += x;
      if (++this.decimCount === this.decim) {
        this.ring[this.ringPos] = this.decimAcc / this.decim;
        this.ringPos = (this.ringPos + 1) % this.ring.length;
        this.decimAcc = 0;
        this.decimCount = 0;
        if (++this.hopCount >= this.hop) {
          this.hopCount = 0;
          if (this.env > gate * 0.5) this.detect();
          else this.voiced = false;
        }
      }

      // glide toward the detected pitch
      this.freq += (this.targetFreq - this.freq) * glideCoef;
      const f = Math.min(this.freq * octMul, sampleRate * 0.45);
      const dt = f / sampleRate;

      let osc;
      const t = this.phase;
      if (wave === 0) {
        osc = 2 * t - 1 - polyBlep(t, dt);
      } else if (wave === 1) {
        osc = (t < 0.5 ? 1 : -1) + polyBlep(t, dt) - polyBlep((t + 0.5) % 1, dt);
      } else if (wave === 2) {
        osc = 1 - 4 * Math.abs(t - 0.5);
      } else {
        osc = Math.sin(TWO_PI * t);
      }
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;

      this.subPhase += dt * 0.5;
      if (this.subPhase >= 1) this.subPhase -= 1;
      const sub = Math.sin(TWO_PI * this.subPhase);
      osc = osc * (1 - subMix * 0.5) + sub * subMix;

      // gate + dynamics follow the player
      const open = this.env > gate && (this.voiced || this.amp > 0.001);
      const targetAmp = open ? Math.min(1, this.env * 6) : 0;
      this.amp += (targetAmp - this.amp) * ampSmooth;

      // envelope filter (TPT state-variable low-pass)
      const cut = Math.min(baseCut * (1 + envAmt * 12 * Math.min(1, this.env * 4)), sampleRate * 0.45);
      const g = Math.tan(Math.PI * cut / sampleRate);
      const a1 = 1 / (1 + g * (g + k));
      const v3 = osc - this.ic2;
      const v1 = a1 * this.ic1 + g * a1 * v3;
      const v2 = this.ic2 + g * v1;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;

      ch0[i] = v2 * this.amp * 0.6;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

    if (++this.reportCount >= 24) {
      this.reportCount = 0;
      this.port.postMessage({ freq: this.voiced ? this.targetFreq : 0, env: this.env, conf: this.confidence });
    }
    return true;
  }
}

registerProcessor('dsd-synth', SynthProcessor);
