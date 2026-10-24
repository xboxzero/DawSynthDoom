// Master EQ editor: drag a numbered point to move a band (left/right = freq,
// up/down = gain). Wheel or the Q knob sets width. Double-tap a point to flatten it.

import { EQ_BANDS } from './engine.js';

const F_MIN = 20, F_MAX = 20000, G_RANGE = 18;
const BAND_COLORS = ['#ff7a2f', '#ffd23f', '#1fd18b', '#2fb4ff', '#9a6bff'];
export { BAND_COLORS };

export class EqEditor {
  constructor(canvas, reg, onSelect) {
    this.canvas = canvas;
    this.reg = reg;
    this.g = canvas.getContext('2d');
    this.sel = 0;
    this.onSelect = onSelect;
    // Biquads in an offline context are only used to compute the response curve,
    // so the editor works before audio starts.
    this.off = new OfflineAudioContext(1, 128, 48000);
    this.filters = EQ_BANDS.map((b) => { const f = this.off.createBiquadFilter(); f.type = b.type; return f; });
    const pts = 400;
    this.freqs = new Float32Array(pts);
    for (let i = 0; i < pts; i++) this.freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (pts - 1));
    this.mag = new Float32Array(pts);
    this.phase = new Float32Array(pts);
    this.sum = new Float32Array(pts);
    this.spec = null;
    this.bind();
  }

  xOf(f, w) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w; }
  fOf(x, w) { return F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / w))); }
  yOf(db, h) { return h / 2 - (db / G_RANGE) * (h / 2 - 14); }
  gOf(y, h) { return ((h / 2 - y) / (h / 2 - 14)) * G_RANGE; }

  band(i) {
    return {
      f: this.reg.get(`eq.${i}.f`),
      g: this.reg.get(`eq.${i}.g`),
      q: this.reg.get(`eq.${i}.q`),
    };
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    let lastTap = { i: -1, t: 0 };
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top, r.width, r.height];
    };
    const hit = (x, y, w, h) => {
      let best = -1, bd = 34;
      for (let i = 0; i < EQ_BANDS.length; i++) {
        const b = this.band(i);
        const d = Math.hypot(this.xOf(b.f, w) - x, this.yOf(b.g, h) - y);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y, w, h] = local(e);
      let i = hit(x, y, w, h);
      if (i < 0) {
        // nearest band by frequency, so a tap anywhere grabs something useful
        let bd = Infinity;
        for (let k = 0; k < EQ_BANDS.length; k++) {
          const d = Math.abs(this.xOf(this.band(k).f, w) - x);
          if (d < bd) { bd = d; i = k; }
        }
      }
      const now = performance.now();
      if (lastTap.i === i && now - lastTap.t < 320) {
        this.reg.set(`eq.${i}.g`, 0, 'ui');
        lastTap = { i: -1, t: 0 };
        return;
      }
      lastTap = { i, t: now };
      this.select(i);
      c.setPointerCapture(e.pointerId);
      drag = { i };
      this.reg.touch(`eq.${i}.f`, true);
      this.reg.touch(`eq.${i}.g`, true);
      this.reg.set(`eq.${i}.f`, this.fOf(x, w), 'ui');
      this.reg.set(`eq.${i}.g`, this.gOf(y, h), 'ui');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y, w, h] = local(e);
      this.reg.set(`eq.${drag.i}.f`, this.fOf(x, w), 'ui');
      this.reg.set(`eq.${drag.i}.g`, this.gOf(y, h), 'ui');
    });
    const end = () => {
      if (!drag) return;
      this.reg.touch(`eq.${drag.i}.f`, false);
      this.reg.touch(`eq.${drag.i}.g`, false);
      drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const id = `eq.${this.sel}.q`;
      const p = this.reg.param(id);
      this.reg.set(id, p.fromNorm(p.toNorm() + (e.deltaY < 0 ? 0.04 : -0.04)), 'ui');
    }, { passive: false });
  }

  select(i) {
    this.sel = i;
    this.onSelect?.(i);
  }

  draw(analyser) {
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0a0d14';
    g.fillRect(0, 0, w, h);

    // grid
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(this.xOf(f, w)) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, h);
    }
    for (const db of [-12, -6, 6, 12]) {
      const y = Math.round(this.yOf(db, h)) + 0.5;
      g.moveTo(0, y); g.lineTo(w, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.beginPath(); g.moveTo(0, Math.round(h / 2) + 0.5); g.lineTo(w, Math.round(h / 2) + 0.5); g.stroke();
    g.fillStyle = 'rgba(232,236,244,0.35)';
    g.font = '500 10px ui-monospace, monospace';
    for (const f of [100, 1000, 10000]) g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), this.xOf(f, w) + 3, h - 6);
    for (const db of [-12, 12]) g.fillText((db > 0 ? '+' : '') + db, 4, this.yOf(db, h) - 3);

    // live spectrum behind the curve
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
        const v = Math.min(1, Math.max(0, (this.spec[bin] + 100) / 90));
        g.lineTo(this.xOf(f, w), h - v * h);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = 'rgba(47,180,255,0.13)';
      g.fill();
    }

    // response curve
    const on = this.reg.get('eq.on') >= 0.5;
    this.sum.fill(0);
    for (let i = 0; i < EQ_BANDS.length; i++) {
      const b = this.band(i);
      const f = this.filters[i];
      f.frequency.value = b.f; f.gain.value = b.g; f.Q.value = b.q;
      f.getFrequencyResponse(this.freqs, this.mag, this.phase);
      for (let k = 0; k < this.freqs.length; k++) this.sum[k] += 20 * Math.log10(this.mag[k]);
    }
    g.beginPath();
    for (let k = 0; k < this.freqs.length; k++) {
      const x = this.xOf(this.freqs[k], w);
      const y = this.yOf(Math.max(-G_RANGE - 2, Math.min(G_RANGE + 2, this.sum[k])), h);
      k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = on ? '#e8ecf4' : 'rgba(232,236,244,0.3)';
    g.lineWidth = 2;
    g.stroke();
    g.lineTo(w, h / 2); g.lineTo(0, h / 2); g.closePath();
    g.fillStyle = on ? 'rgba(255,122,47,0.12)' : 'rgba(255,255,255,0.03)';
    g.fill();

    // handles
    for (let i = 0; i < EQ_BANDS.length; i++) {
      const b = this.band(i);
      const x = this.xOf(b.f, w), y = this.yOf(b.g, h);
      g.beginPath();
      g.arc(x, y, i === this.sel ? 13 : 10, 0, Math.PI * 2);
      g.fillStyle = on ? BAND_COLORS[i] : '#3a4152';
      g.globalAlpha = i === this.sel ? 1 : 0.8;
      g.fill();
      g.globalAlpha = 1;
      if (i === this.sel) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = '#0a0d14';
      g.font = '700 11px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y + 0.5);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    }
  }
}
