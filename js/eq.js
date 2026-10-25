// Draggable EQ editor (used for the pre-amp EQ and the master EQ).
// Drag a numbered point: left/right = frequency, up/down = gain.
// Wheel or the Q knob sets width. Double-tap a point to flatten it.

const F_MIN = 20, F_MAX = 20000, G_RANGE = 18;

export class EqEditor {
  constructor(canvas, reg, { prefix, bands, onId, onSelect }) {
    this.canvas = canvas;
    this.reg = reg;
    this.prefix = prefix;
    this.bands = bands;
    this.onId = onId;
    this.g = canvas.getContext('2d');
    this.sel = 0;
    this.onSelect = onSelect;
    // offline biquads only compute the curve, so the editor works before audio starts
    this.off = new OfflineAudioContext(1, 128, 48000);
    this.filters = bands.map((b) => { const f = this.off.createBiquadFilter(); f.type = b.type; return f; });
    const pts = 360;
    this.freqs = new Float32Array(pts);
    for (let i = 0; i < pts; i++) this.freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (pts - 1));
    this.mag = new Float32Array(pts);
    this.phase = new Float32Array(pts);
    this.sum = new Float32Array(pts);
    this.spec = null;
    this.bind();
  }

  id(i, k) { return `${this.prefix}.${i}.${k}`; }
  xOf(f, w) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w; }
  fOf(x, w) { return F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / w))); }
  yOf(db, h) { return h / 2 - (db / G_RANGE) * (h / 2 - 14); }
  gOf(y, h) { return ((h / 2 - y) / (h / 2 - 14)) * G_RANGE; }
  band(i) { return { f: this.reg.get(this.id(i, 'f')), g: this.reg.get(this.id(i, 'g')), q: this.reg.get(this.id(i, 'q')) }; }

  bind() {
    const c = this.canvas;
    let drag = null, lastTap = { i: -1, t: 0 };
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width, r.height]; };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y, w, h] = local(e);
      let i = -1, bd = 34;
      this.bands.forEach((_, k) => {
        const b = this.band(k);
        const d = Math.hypot(this.xOf(b.f, w) - x, this.yOf(b.g, h) - y);
        if (d < bd) { bd = d; i = k; }
      });
      if (i < 0) {
        let best = Infinity;
        this.bands.forEach((_, k) => { const d = Math.abs(this.xOf(this.band(k).f, w) - x); if (d < best) { best = d; i = k; } });
      }
      const now = performance.now();
      if (lastTap.i === i && now - lastTap.t < 320) { this.reg.set(this.id(i, 'g'), 0, 'ui'); lastTap = { i: -1, t: 0 }; return; }
      lastTap = { i, t: now };
      this.select(i);
      c.setPointerCapture(e.pointerId);
      drag = { i };
      this.reg.set(this.id(i, 'f'), this.fOf(x, w), 'ui');
      this.reg.set(this.id(i, 'g'), this.gOf(y, h), 'ui');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y, w, h] = local(e);
      this.reg.set(this.id(drag.i, 'f'), this.fOf(x, w), 'ui');
      this.reg.set(this.id(drag.i, 'g'), this.gOf(y, h), 'ui');
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.reg.param(this.id(this.sel, 'q'));
      this.reg.set(p.id, p.fromNorm(p.toNorm() + (e.deltaY < 0 ? 0.04 : -0.04)), 'ui');
    }, { passive: false });
  }

  select(i) { this.sel = i; this.onSelect?.(i); }

  draw(analyser) {
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.font = '500 10px ui-monospace, monospace';
    for (const f of [100, 1000, 10000]) g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), this.xOf(f, w) + 3, h - 6);

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

    const on = this.reg.get(this.onId) >= 0.5;
    this.sum.fill(0);
    this.bands.forEach((_, i) => {
      const b = this.band(i), f = this.filters[i];
      f.frequency.value = b.f; f.gain.value = b.g; f.Q.value = b.q;
      f.getFrequencyResponse(this.freqs, this.mag, this.phase);
      for (let k = 0; k < this.freqs.length; k++) this.sum[k] += 20 * Math.log10(this.mag[k]);
    });
    g.beginPath();
    for (let k = 0; k < this.freqs.length; k++) {
      const x = this.xOf(this.freqs[k], w);
      const y = this.yOf(Math.max(-G_RANGE - 2, Math.min(G_RANGE + 2, this.sum[k])), h);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.3)';
    g.lineWidth = 2;
    g.stroke();

    this.bands.forEach((_, i) => {
      const b = this.band(i);
      const x = this.xOf(b.f, w), y = this.yOf(b.g, h), sel = i === this.sel;
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
