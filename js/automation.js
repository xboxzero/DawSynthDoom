// Automatic mixing helpers: loop automation recorder and A/B scene morphing.

export class Automation {
  constructor(reg) {
    this.reg = reg;
    this.events = [];          // { t, id, v } sorted by t
    this.state = 'idle';       // 'idle' | 'play' | 'rec'
    this.length = 8;           // loop length in seconds
    this.t0 = 0;
    this.lastPos = 0;
    this.lastRec = new Map();  // id -> last recorded t (for overwrite)
    this.onState = () => {};
    reg.onChange((id, v, source) => {
      if (this.state !== 'rec' || source !== 'ui' || id.startsWith('auto.')) return;
      const t = this.pos();
      const prev = this.lastRec.get(id);
      if (prev !== undefined && prev <= t) {
        this.events = this.events.filter((e) => e.id !== id || e.t <= prev || e.t > t);
      }
      this.lastRec.set(id, t);
      this.events.push({ t, id, v });
      this.events.sort((a, b) => a.t - b.t);
    });
  }

  now() { return performance.now() / 1000; }
  pos() { return ((this.now() - this.t0) % this.length + this.length) % this.length; }

  setState(s) {
    if (s !== 'idle' && this.state === 'idle') { this.t0 = this.now(); this.lastPos = 0; }
    this.state = s;
    this.lastRec.clear();
    this.onState(s);
  }

  clear() { this.events = []; this.lastRec.clear(); }

  tick() {
    if (this.state === 'idle') return 0;
    const p = this.pos();
    const fire = (e) => {
      if (this.reg.touched.has(e.id)) return;
      if (this.state === 'rec' && this.lastRec.has(e.id)) return; // being overdubbed
      this.reg.set(e.id, e.v, 'auto');
    };
    if (p >= this.lastPos) {
      for (const e of this.events) if (e.t > this.lastPos && e.t <= p) fire(e);
    } else {
      // wrapped around the loop
      for (const e of this.events) if (e.t > this.lastPos || e.t <= p) fire(e);
      this.lastRec.clear();
    }
    this.lastPos = p;
    return p / this.length;
  }

  toJSON() { return { length: this.length, events: this.events }; }
  fromJSON(o) {
    if (!o) return;
    this.length = o.length ?? 8;
    this.events = Array.isArray(o.events) ? o.events : [];
  }
}

export class Scenes {
  constructor(reg) {
    this.reg = reg;
    this.a = null;
    this.b = null;
  }

  morphable(p) {
    return p.morph && !p.id.startsWith('mix.') && !p.id.startsWith('auto.') && !p.id.startsWith('in.') && p.id !== 'master.vol';
  }

  store(which) {
    const snap = this.reg.snapshot((p) => this.morphable(p));
    if (which === 'a') this.a = snap; else this.b = snap;
  }

  morph(x) {
    if (!this.a || !this.b) return;
    for (const id of Object.keys(this.a)) {
      if (this.reg.touched.has(id) || !(id in this.b)) continue;
      const p = this.reg.param(id);
      // Interpolate in the control's own (log/lin) space so sweeps feel even.
      const n = p.toNorm(this.a[id]) * (1 - x) + p.toNorm(this.b[id]) * x;
      this.reg.set(id, p.fromNorm(n), 'scene');
    }
  }

  toJSON() { return { a: this.a, b: this.b }; }
  fromJSON(o) { this.a = o?.a ?? null; this.b = o?.b ?? null; }
}
