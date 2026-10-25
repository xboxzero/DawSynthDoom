// Pre-amp front end: noise gate -> well-temperament autotune.
//
// The autotune detects pitch (YIN), picks the nearest note of the chosen key/scale
// in the chosen temperament, and shifts toward it with a two-head crossfading
// delay-line pitch shifter. Historical well temperaments are tuned on C and
// normalised so A stays at the reference pitch.

const TEMPERAMENTS = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],                                        // Equal
  [0, -9.78, -7.82, -5.87, -9.78, -1.96, -11.73, -3.91, -7.82, -11.73, -3.91, -7.82], // Werckmeister III
  [0, -9.78, -6.84, -5.87, -13.69, -1.96, -9.78, -3.42, -7.82, -10.26, -3.91, -11.73], // Kirnberger III
  [0, -5.87, -3.91, -1.96, -7.82, 1.96, -7.82, -1.96, -3.91, -5.87, 0, -9.78],       // Vallotti
  [0, -9.8, -3.9, -5.9, -7.8, -2.0, -11.7, -2.0, -7.8, -5.9, -3.9, -9.8],            // Young II
];
const SCALES = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic
  [0, 2, 4, 5, 7, 9, 11],                 // major
  [0, 2, 3, 5, 7, 8, 10],                 // natural minor
  [0, 2, 4, 7, 9],                        // major pentatonic
  [0, 3, 5, 7, 10],                       // minor pentatonic
  [0, 2, 3, 5, 7, 9, 10],                 // dorian
];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

class FrontProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate';
    return [
      { name: 'gateOn', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'gateThresh', defaultValue: 0.005, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'tuneOn', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'amount', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'speed', defaultValue: 40, minValue: 0, maxValue: 500, automationRate: k },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'ref', defaultValue: 440, minValue: 400, maxValue: 480, automationRate: k },
      { name: 'key', defaultValue: 0, minValue: 0, maxValue: 11, automationRate: k },
      { name: 'scale', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: k },
      { name: 'temper', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: k },
    ];
  }

  constructor() {
    super();
    // gate
    this.env = 0;
    this.gateGain = 0;
    this.open = false;
    this.hold = 0;

    // pitch detection at half rate
    this.decim = 2;
    this.anaRate = sampleRate / this.decim;
    this.W = 512;
    this.tauMax = 600;                                     // ~40 Hz
    this.tauMin = Math.floor(this.anaRate / 1500);
    this.ana = new Float32Array(this.W + this.tauMax);
    this.ring = new Float32Array(2048);
    this.ringPos = 0;
    this.acc = 0;
    this.accN = 0;
    this.hop = 0;
    this.diff = new Float32Array(this.tauMax + 1);
    this.f0 = 0;
    this.voiced = false;

    // pitch shifter
    this.buf = new Float32Array(16384);
    this.mask = this.buf.length - 1;
    this.w = 0;
    this.win = Math.round(sampleRate * 0.03);
    this.phase = 0;
    this.ratio = 1;
    this.ratioTarget = 1;
    this.report = 0;
    this.target = { name: '', cents: 0, err: 0 };
  }

  detect() {
    const { ana, ring, W, tauMax, diff } = this;
    const n = ana.length;
    let p = (this.ringPos - n + ring.length) % ring.length;
    for (let i = 0; i < n; i++) { ana[i] = ring[p]; p = (p + 1) % ring.length; }
    let run = 0;
    diff[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const d = ana[j] - ana[j + tau]; s += d * d; }
      run += s;
      diff[tau] = run > 0 ? (s * tau) / run : 1;
    }
    let found = -1;
    for (let tau = this.tauMin; tau < tauMax; tau++) {
      if (diff[tau] < 0.12) {
        while (tau + 1 < tauMax && diff[tau + 1] < diff[tau]) tau++;
        found = tau;
        break;
      }
    }
    if (found < 0) { this.voiced = false; return; }
    const a = diff[found - 1], b = diff[found], c = diff[found + 1];
    const den = a + c - 2 * b;
    const period = found + (den !== 0 ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0);
    this.f0 = this.anaRate / period;
    this.voiced = true;
  }

  // nearest scale note in the chosen temperament -> ratio to apply
  correction(ref, key, scaleIdx, temperIdx) {
    const off = TEMPERAMENTS[temperIdx] ?? TEMPERAMENTS[0];
    const scale = SCALES[scaleIdx] ?? SCALES[0];
    const midi = 69 + 12 * Math.log2(this.f0 / ref);
    const base = Math.floor(midi);
    let best = null, bestDist = Infinity;
    for (let n = base - 2; n <= base + 2; n++) {
      const pc = ((n % 12) + 12) % 12;
      if (!scale.includes((pc - key + 12) % 12)) continue;
      const cents = off[pc] - off[9];                 // keep A at the reference
      const exact = n + cents / 100;
      const dist = Math.abs(midi - exact);
      if (dist < bestDist) { bestDist = dist; best = { n, exact, pc, cents }; }
    }
    if (!best) return 1;
    this.target = { name: NAMES[best.pc] + (Math.floor(best.n / 12) - 1), cents: best.cents, err: (midi - best.exact) * 100 };
    return Math.pow(2, (best.exact - midi) / 12);
  }

  process(inputs, outputs, P) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const n = out.length;
    if (!inp) { out.fill(0); return true; }

    const gateOn = P.gateOn[0] >= 0.5;
    const thr = P.gateThresh[0];
    const tuneOn = P.tuneOn[0] >= 0.5;
    const amount = P.amount[0];
    const speed = P.speed[0];
    const mix = P.mix[0];
    const ref = P.ref[0];
    const key = Math.round(P.key[0]);
    const scale = Math.round(P.scale[0]);
    const temper = Math.round(P.temper[0]);

    const atk = 1 - Math.exp(-1 / (0.001 * sampleRate));
    const rel = 1 - Math.exp(-1 / (0.05 * sampleRate));
    const gOpen = 1 - Math.exp(-1 / (0.002 * sampleRate));
    const gClose = 1 - Math.exp(-1 / (0.08 * sampleRate));
    const glide = speed <= 0 ? 1 : 1 - Math.exp(-1 / (speed * 0.001 * sampleRate));
    const W = this.win;

    for (let i = 0; i < n; i++) {
      let x = inp[i];

      // noise gate with hysteresis + hold
      const ax = Math.abs(x);
      this.env += (ax - this.env) * (ax > this.env ? atk : rel);
      if (gateOn) {
        if (this.env > thr) { this.open = true; this.hold = sampleRate * 0.06; }
        else if (this.env < thr * 0.5) { if (this.hold > 0) this.hold--; else this.open = false; }
        const tg = this.open ? 1 : 0;
        this.gateGain += (tg - this.gateGain) * (tg ? gOpen : gClose);
        x *= this.gateGain;
      }

      if (!tuneOn) { out[i] = x; continue; }

      // feed the detector
      this.acc += x;
      if (++this.accN === this.decim) {
        this.ring[this.ringPos] = this.acc / this.decim;
        this.ringPos = (this.ringPos + 1) % this.ring.length;
        this.acc = 0;
        this.accN = 0;
        if (++this.hop >= 192) {
          this.hop = 0;
          if (this.env > Math.max(thr, 0.002)) this.detect(); else this.voiced = false;
          if (this.voiced) this.ratioTarget = Math.pow(this.correction(ref, key, scale, temper), amount);
          else this.ratioTarget = 1;
        }
      }
      this.ratio += (this.ratioTarget - this.ratio) * glide;

      // two-head pitch shifter
      this.buf[this.w] = x;
      this.phase += (1 - this.ratio) / W;
      this.phase -= Math.floor(this.phase);
      const phB = (this.phase + 0.5) % 1;
      const read = (ph) => {
        const d = 2 + ph * W;
        const pos = this.w - d;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = this.buf[i0 & this.mask], b = this.buf[(i0 + 1) & this.mask];
        return a + (b - a) * frac;
      };
      const s = Math.sin(Math.PI * this.phase);
      const gA = s * s;
      const y = read(this.phase) * gA + read(phB) * (1 - gA);
      this.w = (this.w + 1) & this.mask;
      out[i] = x * (1 - mix) + y * mix;
    }

    if (++this.report >= 16) {
      this.report = 0;
      this.port.postMessage({
        gate: this.gateGain,
        f0: tuneOn && this.voiced ? this.f0 : 0,
        target: this.target.name,
        err: this.target.err,
        tcents: this.target.cents,
        ratio: this.ratio,
      });
    }
    return true;
  }
}

registerProcessor('dsd-front', FrontProcessor);
