// Drum groove: synthesised kick / snare / hats on a 16-step grid, plus a
// sidechain "pump" that ducks the bass on every kick. The grid starts at
// AudioContext time 0 — the same grid the bass arpeggiator uses inside the
// C++ voice — so drums and bass patterns lock together.

export const GROOVES = ['OFF', 'FOUR FLOOR', 'ROCK', 'HALF-TIME', 'BREAKBEAT', 'DUB', 'TRAP'] as const;

// k = kick, s = snare, h = closed hat, o = open hat, . = rest (one char per 16th)
const PATTERNS: Record<string, { k: string; s: string; h: string }> = {
  'FOUR FLOOR': { k: 'x...x...x...x...', s: '....x.......x...', h: '..o...o...o...o.' },
  ROCK: { k: 'x.....x.x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  'HALF-TIME': { k: 'x.........x.....', s: '........x.......', h: 'x.x.x.x.x.x.x.x.' },
  BREAKBEAT: { k: 'x.........x.x...', s: '....x..x.x..x..x', h: 'x.x.x.x.x.x.x.o.' },
  DUB: { k: 'x.......x.......', s: '........x.......', h: '..x...x...x...x.' },
  TRAP: { k: 'x......x..x.....', s: '........x.......', h: 'xxx.xxx.xxxxx.xx' },
};

export class Groove {
  readonly out: GainNode;
  private pattern = 'OFF';
  private bpm = 120;
  private swing = 0;
  private next = 0;
  private timer = 0;
  private noise: AudioBuffer;
  private pumpDepth = 0;

  constructor(private readonly ctx: AudioContext, private readonly pump: GainNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.7;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  set(pattern: string, bpm: number, swing: number, level: number, pump: number): void {
    this.bpm = bpm;
    this.swing = swing;
    this.pumpDepth = pump;
    this.out.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
    if (pattern === this.pattern) return;
    this.pattern = pattern;
    if (pattern === 'OFF') { clearInterval(this.timer); this.timer = 0; return; }
    if (!this.timer) {
      this.next = this.stepTime(Math.ceil(this.ctx.currentTime / this.stepLen()) + 1);
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
  }

  private stepLen(): number { return 15 / this.bpm; }

  /** absolute time of a 16th on the shared grid (swing delays the off-16ths) */
  private stepTime(step: number): number {
    const L = this.stepLen();
    return Math.floor(step / 2) * 2 * L + (step % 2 ? L * (1 + this.swing) : 0);
  }

  private schedule(): void {
    const p = PATTERNS[this.pattern];
    if (!p) return;
    const L = this.stepLen();
    // find the step index for `next`, then schedule ahead
    let step = Math.round(this.next / L);
    while (this.stepTime(step) < this.ctx.currentTime) step++;
    for (;;) {
      const t = this.stepTime(step);
      if (t > this.ctx.currentTime + 0.12) break;
      if (t >= this.next - 1e-4) {
        const i = ((step % 16) + 16) % 16;
        if (p.k[i] === 'x') this.kick(t);
        if (p.s[i] === 'x') this.snare(t);
        if (p.h[i] === 'x') this.hat(t, false);
        if (p.h[i] === 'o') this.hat(t, true);
        this.next = t + 1e-3;
      }
      step++;
    }
  }

  private kick(t: number): void {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(this.out);
    o.start(t); o.stop(t + 0.4);
    // sidechain pump: duck the bass and let it swell back
    if (this.pumpDepth > 0) {
      const pg = this.pump.gain;
      pg.cancelScheduledValues(t);
      pg.setValueAtTime(1 - this.pumpDepth * 0.85, t);
      pg.setTargetAtTime(1, t + 0.02, 0.09);
    }
  }

  private snare(t: number): void {
    const c = this.ctx, n = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    n.buffer = this.noise;
    f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(f); f.connect(g); g.connect(this.out);
    const o = c.createOscillator(), og = c.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(0.4, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og); og.connect(this.out);
    n.start(t, Math.random() * 0.5); n.stop(t + 0.2);
    o.start(t); o.stop(t + 0.12);
  }

  private hat(t: number, open: boolean): void {
    const c = this.ctx, n = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    n.buffer = this.noise;
    f.type = 'highpass'; f.frequency.value = 7500;
    const len = open ? 0.22 : 0.045;
    g.gain.setValueAtTime(open ? 0.22 : 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(f); f.connect(g); g.connect(this.out);
    n.start(t, Math.random() * 0.5); n.stop(t + len + 0.02);
  }
}
