// Central parameter registry. Every control on the page is a Param so that
// widgets, presets, scenes (A/B morph) and automation all speak one language.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Param {
  constructor(id, o) {
    this.id = id;
    this.label = o.label ?? id;
    this.min = o.min ?? 0;
    this.max = o.max ?? 1;
    this.def = o.def ?? this.min;
    this.step = o.step ?? 0;
    this.scale = o.scale ?? 'lin';      // 'lin' | 'log'
    this.unit = o.unit ?? '';
    this.options = o.options ?? null;   // for stepped choices: array of names
    this.morph = o.morph ?? (!this.options && this.step === 0);
    this.persist = o.persist ?? true;
    this.fmt = o.format ?? null;
    this.apply = o.apply ?? null;
    this.value = this.def;
    this.widgets = new Set();
  }

  toNorm(v = this.value) {
    if (this.scale === 'log') return Math.log(v / this.min) / Math.log(this.max / this.min);
    return (v - this.min) / (this.max - this.min);
  }

  fromNorm(n) {
    n = clamp(n, 0, 1);
    if (this.scale === 'log') return this.min * Math.pow(this.max / this.min, n);
    return this.min + n * (this.max - this.min);
  }

  format(v = this.value) {
    if (this.fmt) return this.fmt(v);
    if (this.options) return this.options[Math.round(v - this.min)] ?? String(v);
    const u = this.unit;
    if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + '';
    if (u === 'dB') return (v > 0 ? '+' : '') + v.toFixed(1);
    if (u === 's') return v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
    if (u === '%') return Math.round(v * 100) + '%';
    return Math.abs(v) >= 100 ? Math.round(v) + '' : v.toFixed(2);
  }
}

export class Registry {
  constructor() {
    this.params = new Map();
    this.listeners = new Set();
    this.touched = new Set();
  }

  define(id, o) {
    const p = new Param(id, o);
    this.params.set(id, p);
    return p;
  }

  get(id) { return this.params.get(id)?.value; }
  param(id) { return this.params.get(id); }

  set(id, v, source = 'ui') {
    const p = this.params.get(id);
    if (!p) return;
    v = clamp(Number(v), p.min, p.max);
    if (p.step) v = Math.round((v - p.min) / p.step) * p.step + p.min;
    if (Number.isNaN(v)) return;
    const changed = v !== p.value;
    p.value = v;
    if (p.apply) p.apply(v, source);
    for (const w of p.widgets) w.update(v);
    if (changed) for (const fn of this.listeners) fn(id, v, source);
  }

  touch(id, on) {
    if (on) this.touched.add(id); else this.touched.delete(id);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  applyAll() {
    for (const p of this.params.values()) if (p.apply) p.apply(p.value, 'load');
  }

  snapshot(filter = () => true) {
    const out = {};
    for (const p of this.params.values()) if (filter(p)) out[p.id] = p.value;
    return out;
  }

  restore(obj, source = 'load') {
    if (!obj) return;
    for (const [id, v] of Object.entries(obj)) if (this.params.has(id)) this.set(id, v, source);
  }
}
