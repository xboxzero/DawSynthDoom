// The one live display: triggered oscilloscope, scrolling waveform (roll),
// spectrum, or scope + spectrum together. Input is drawn faint behind the
// selected source so you can see how the effects reshape the waveform.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(f) {
  if (!f) return '—';
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

export class Scope {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.mode = 'scope';      // scope | roll | spectrum | both
    this.zoom = 0.5;          // 0..1 -> 4 ms .. 60 ms window
    this.color = '#ff7a2f';
    this.label = 'OUTPUT';
    this.roll = new Float32Array(1200);
    this.rollMin = new Float32Array(1200);
    this.rollIn = new Float32Array(1200);
    this.rollPos = 0;
    this.bufA = null;
    this.bufB = null;
    this.freqA = null;
    this.freqB = null;
    this.info = '';
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }

  draw(src, ref, sampleRate) {
    const [w, h] = this.resize();
    const g = this.g;
    g.fillStyle = 'rgba(8,10,16,0.55)';     // phosphor-style persistence
    g.fillRect(0, 0, w, h);
    this.grid(w, h);
    if (!src) { this.idle(w, h); return; }

    const n = src.fftSize;
    if (!this.bufA || this.bufA.length !== n) { this.bufA = new Float32Array(n); this.bufB = new Float32Array(n); }
    src.getFloatTimeDomainData(this.bufA);
    if (ref) ref.getFloatTimeDomainData(this.bufB);

    if (this.mode === 'scope') this.wave(0, 0, w, h, sampleRate, !!ref);
    else if (this.mode === 'roll') this.rollView(0, 0, w, h, !!ref);
    else if (this.mode === 'spectrum') this.spectrum(src, ref, 0, 0, w, h, sampleRate);
    else {
      const hTop = Math.round(h * 0.58);
      this.wave(0, 0, w, hTop, sampleRate, !!ref);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, hTop, w, 1);
      this.spectrum(src, ref, 0, hTop + 1, w, h - hTop - 1, sampleRate);
    }

    // peak readout
    let pk = 0;
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(this.bufA[i]));
    const db = 20 * Math.log10(pk + 1e-9);
    g.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = this.color;
    g.textBaseline = 'top';
    g.fillText(this.label, 12, 10);
    g.fillStyle = db > -1 ? '#ff3b5c' : 'rgba(232,236,244,0.75)';
    g.textAlign = 'right';
    g.fillText(`${db < -90 ? '-∞' : db.toFixed(1)} dBFS`, w - 12, 10);
    if (this.info) { g.fillStyle = 'rgba(232,236,244,0.75)'; g.fillText(this.info, w - 12, 28); }
    g.textAlign = 'left';
  }

  grid(w, h) {
    const g = this.g;
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round((w * i) / 10) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
    for (let i = 1; i < 6; i++) { const y = Math.round((h * i) / 6) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
  }

  idle(w, h) {
    const g = this.g;
    const t = performance.now() / 1000;
    g.strokeStyle = 'rgba(255,122,47,0.35)';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const y = h / 2 + Math.sin(x / 40 + t * 2) * 6 * Math.sin(t * 0.7);
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = 'rgba(232,236,244,0.6)';
    g.font = '500 14px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('Press  ▶ START AUDIO  to go live', w / 2, h / 2 + 34);
    g.textAlign = 'left';
  }

  trigger(buf, span) {
    // rising zero-crossing with hysteresis, searched in the first half
    const lim = buf.length - span;
    for (let i = 1; i < lim; i++) {
      if (buf[i - 1] < -0.002 && buf[i] >= 0) {
        // walk back to the actual crossing
        return i;
      }
    }
    return 0;
  }

  wave(x0, y0, w, h, rate, hasRef) {
    const g = this.g;
    const winSec = 0.004 * Math.pow(15, this.zoom);
    const span = Math.min(this.bufA.length >> 1, Math.max(32, Math.round(winSec * rate)));
    const start = this.trigger(this.bufA, span);
    const mid = y0 + h / 2;
    const amp = h * 0.46;
    const line = (buf, s, color, width, alpha) => {
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      const step = Math.max(1, span / (w * 1.5));
      for (let i = 0; i < span; i += step) {
        const v = buf[s + Math.floor(i)] || 0;
        const x = x0 + (i / span) * w;
        const y = mid - Math.max(-1.1, Math.min(1.1, v)) * amp;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      g.globalAlpha = 1;
    };
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(x0, Math.round(mid), w, 1);
    if (hasRef) line(this.bufB, this.trigger(this.bufB, span), '#9aa7bd', 1.2, 0.45);
    line(this.bufA, start, this.color, 5, 0.16);
    line(this.bufA, start, this.color, 2, 1);
    this.g.fillStyle = 'rgba(232,236,244,0.45)';
    this.g.font = '500 11px ui-monospace, monospace';
    this.g.fillText(`${(winSec * 1000).toFixed(1)} ms`, x0 + 12, y0 + h - 18);
  }

  rollView(x0, y0, w, h, hasRef) {
    // Each frame contributes the peak of the newest ~frame of audio.
    const take = Math.min(this.bufA.length, 1024);
    let mx = 0, mn = 0, ri = 0;
    for (let i = this.bufA.length - take; i < this.bufA.length; i++) {
      const v = this.bufA[i];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
      if (hasRef) ri = Math.max(ri, Math.abs(this.bufB[i]));
    }
    const N = this.roll.length;
    this.roll[this.rollPos] = mx;
    this.rollMin[this.rollPos] = mn;
    this.rollIn[this.rollPos] = ri;
    this.rollPos = (this.rollPos + 1) % N;
    const g = this.g;
    const cols = Math.min(N, Math.floor(w / 2));
    const mid = y0 + h / 2;
    const amp = h * 0.46;
    for (let c = 0; c < cols; c++) {
      const idx = (this.rollPos - cols + c + N) % N;
      const x = x0 + (c / cols) * w;
      if (hasRef) {
        g.fillStyle = 'rgba(154,167,189,0.25)';
        const r = Math.min(1, this.rollIn[idx]) * amp;
        g.fillRect(x, mid - r, 2, r * 2);
      }
      g.fillStyle = this.color;
      const top = mid - Math.min(1.05, this.roll[idx]) * amp;
      const bot = mid - Math.max(-1.05, this.rollMin[idx]) * amp;
      g.fillRect(x, top, 2, Math.max(1, bot - top));
    }
  }

  spectrum(src, ref, x0, y0, w, h, rate) {
    const g = this.g;
    const bins = src.frequencyBinCount;
    if (!this.freqA || this.freqA.length !== bins) { this.freqA = new Float32Array(bins); this.freqB = new Float32Array(bins); }
    src.getFloatFrequencyData(this.freqA);
    if (ref) ref.getFloatFrequencyData(this.freqB);
    const fMin = 20, fMax = 20000;
    const xOf = (f) => x0 + (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    const yOf = (db) => y0 + h - Math.min(1, Math.max(0, (db + 100) / 100)) * h;
    const path = (arr) => {
      g.beginPath();
      let first = true;
      const pts = Math.min(w, 600);
      for (let i = 0; i <= pts; i++) {
        const f = fMin * Math.pow(fMax / fMin, i / pts);
        const bin = Math.min(bins - 1, Math.round((f / (rate / 2)) * bins));
        const x = xOf(f), y = yOf(arr[bin]);
        if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
      }
    };
    g.fillStyle = 'rgba(232,236,244,0.35)';
    g.font = '500 10px ui-monospace, monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xOf(f) + 3, y0 + h - 12);
    }
    if (ref) {
      path(this.freqB);
      g.strokeStyle = 'rgba(154,167,189,0.5)';
      g.lineWidth = 1;
      g.stroke();
    }
    path(this.freqA);
    g.lineTo(x0 + w, y0 + h);
    g.lineTo(x0, y0 + h);
    g.closePath();
    const grad = g.createLinearGradient(0, y0, 0, y0 + h);
    grad.addColorStop(0, this.color + '88');
    grad.addColorStop(1, this.color + '05');
    g.fillStyle = grad;
    g.fill();
    path(this.freqA);
    g.strokeStyle = this.color;
    g.lineWidth = 1.6;
    g.stroke();
  }
}
