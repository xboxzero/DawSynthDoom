// Draggable master EQ: drag a numbered point (left/right = frequency, up/down = gain).
// Wheel or the Q knob sets width; double-tap a point to flatten it.

import type { Registry } from './params';
import { fitCanvas } from './ui';

const F_MIN = 20, F_MAX = 20000, G_RANGE = 18;

export interface BandDef { type: BiquadFilterType; f: number; q: number }

export class EqEditor {
  sel = 0;
  private readonly filters: BiquadFilterNode[];
  private readonly freqs: Float32Array<ArrayBuffer>;
  private readonly mag: Float32Array<ArrayBuffer>;
  private readonly phase: Float32Array<ArrayBuffer>;
  private readonly sum: Float32Array;
  private spec: Float32Array<ArrayBuffer> | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly reg: Registry, private readonly o: { prefix: string; bands: readonly BandDef[]; onId: string; onSelect?: (i: number) => void }) {
    const off = new OfflineAudioContext(1, 128, 48000);
    this.filters = o.bands.map((b) => { const f = off.createBiquadFilter(); f.type = b.type; return f; });
    const pts = 300;
    this.freqs = new Float32Array(pts);
    for (let i = 0; i < pts; i++) this.freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (pts - 1));
    this.mag = new Float32Array(pts);
    this.phase = new Float32Array(pts);
    this.sum = new Float32Array(pts);
    this.bind();
  }

  private id(i: number, k: 'f' | 'g' | 'q'): string { return `${this.o.prefix}.${i}.${k}`; }
  private xOf(f: number, w: number): number { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w; }
  private fOf(x: number, w: number): number { return F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / w))); }
  private yOf(db: number, h: number): number { return h / 2 - (db / G_RANGE) * (h / 2 - 14); }
  private gOf(y: number, h: number): number { return ((h / 2 - y) / (h / 2 - 14)) * G_RANGE; }
  private band(i: number) { return { f: this.reg.get(this.id(i, 'f')), g: this.reg.get(this.id(i, 'g')), q: this.reg.get(this.id(i, 'q')) }; }

  private bind(): void {
    const c = this.canvas;
    let drag: number | null = null;
    let lastTap = { i: -1, t: 0 };
    const local = (e: PointerEvent): [number, number, number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top, r.width, r.height];
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y, w, h] = local(e);
      let i = -1, bd = 36;
      this.o.bands.forEach((_, k) => {
        const b = this.band(k);
        const d = Math.hypot(this.xOf(b.f, w) - x, this.yOf(b.g, h) - y);
        if (d < bd) { bd = d; i = k; }
      });
      if (i < 0) {
        let best = Infinity;
        this.o.bands.forEach((_, k) => { const d = Math.abs(this.xOf(this.band(k).f, w) - x); if (d < best) { best = d; i = k; } });
      }
      const now = performance.now();
      if (lastTap.i === i && now - lastTap.t < 320) { this.reg.set(this.id(i, 'g'), 0, 'ui'); lastTap = { i: -1, t: 0 }; return; }
      lastTap = { i, t: now };
      this.select(i);
      c.setPointerCapture(e.pointerId);
      drag = i;
      this.reg.set(this.id(i, 'f'), this.fOf(x, w), 'ui');
      this.reg.set(this.id(i, 'g'), this.gOf(y, h), 'ui');
    });
    c.addEventListener('pointermove', (e) => {
      if (drag === null) return;
      const [x, y, w, h] = local(e);
      this.reg.set(this.id(drag, 'f'), this.fOf(x, w), 'ui');
      this.reg.set(this.id(drag, 'g'), this.gOf(y, h), 'ui');
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('pointercancel', () => { drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.reg.param(this.id(this.sel, 'q'));
      this.reg.set(p.id, p.fromNorm(p.toNorm() + (e.deltaY < 0 ? 0.04 : -0.04)), 'ui');
    }, { passive: false });
  }

  select(i: number): void { this.sel = i; this.o.onSelect?.(i); }

  draw(analyser: AnalyserNode | null): void {
    const fc = fitCanvas(this.canvas);
    if (!fc) return;
    const { g, w, h } = fc;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(this.xOf(f, w)) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
    for (const db of [-12, -6, 6, 12]) { const y = Math.round(this.yOf(db, h)) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.beginPath(); g.moveTo(0, Math.round(h / 2) + 0.5); g.lineTo(w, Math.round(h / 2) + 0.5); g.stroke();

    if (analyser) {
      const bins = analyser.frequencyBinCount;
      if (!this.spec || this.spec.length !== bins) this.spec = new Float32Array(bins);
      analyser.getFloatFrequencyData(this.spec);
      const rate = analyser.context.sampleRate;
      g.beginPath();
      g.moveTo(0, h);
      for (let i = 0; i < this.freqs.length; i += 2) {
        const f = this.freqs[i];
        const bin = Math.min(bins - 1, Math.round((f / (rate / 2)) * bins));
        g.lineTo(this.xOf(f, w), h - Math.min(1, Math.max(0, (this.spec[bin] + 100) / 90)) * h);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fill();
    }

    const on = this.reg.on(this.o.onId);
    this.sum.fill(0);
    this.o.bands.forEach((_, i) => {
      const b = this.band(i), f = this.filters[i];
      f.frequency.value = b.f; f.gain.value = b.g; f.Q.value = b.q;
      f.getFrequencyResponse(this.freqs, this.mag, this.phase);
      for (let k = 0; k < this.freqs.length; k++) this.sum[k] += 20 * Math.log10(this.mag[k]);
    });
    g.beginPath();
    for (let k = 0; k < this.freqs.length; k++) {
      const x = this.xOf(this.freqs[k], w), y = this.yOf(Math.max(-20, Math.min(20, this.sum[k])), h);
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.3)';
    g.lineWidth = 2;
    g.stroke();
    this.o.bands.forEach((_, i) => {
      const b = this.band(i), x = this.xOf(b.f, w), y = this.yOf(b.g, h), sel = i === this.sel;
      g.beginPath();
      g.arc(x, y, sel ? 13 : 10, 0, Math.PI * 2);
      g.fillStyle = sel ? '#fff' : '#000';
      g.fill();
      g.strokeStyle = on ? '#fff' : '#555';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = sel ? '#000' : '#fff';
      g.font = '700 11px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y + 0.5);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    });
  }
}
