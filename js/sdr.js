// Software-defined-radio style analysis display: overall waveform strip,
// live spectrum with peak hold, and a scrolling waterfall underneath.
// Feedback-guard notches are marked on the frequency axis.

const F_MIN = 30, F_MAX = 20000;

export class SdrDisplay {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.wf = document.createElement('canvas');
    this.wg = this.wf.getContext('2d');
    this.spec = null;
    this.hold = null;
    this.time = null;
    this.row = null;
    this.label = 'OUTPUT';
    this.notches = [];
    this.info = '';
    this.env = new Float32Array(400);
    this.envPos = 0;
  }

  xOf(f, w) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w; }

  draw(an) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    const waveH = 74, specH = Math.round(H * 0.24), axisH = 16;
    const wfY = waveH + specH + axisH, wfH = H - wfY;

    if (!an) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.font = '13px "Permanent Marker", system-ui';
      g.textAlign = 'center';
      g.fillText('PRESS START', W / 2, H / 2);
      g.textAlign = 'left';
      return;
    }
    const bins = an.frequencyBinCount;
    if (!this.spec || this.spec.length !== bins) {
      this.spec = new Float32Array(bins);
      this.hold = new Float32Array(bins).fill(-140);
      this.time = new Float32Array(an.fftSize);
    }
    an.getFloatFrequencyData(this.spec);
    an.getFloatTimeDomainData(this.time);
    const rate = an.context.sampleRate;

    // ── waveform strip: live trace + scrolling envelope history
    let pk = 0;
    for (let i = this.time.length - 1024; i < this.time.length; i++) pk = Math.max(pk, Math.abs(this.time[i]));
    this.env[this.envPos] = pk;
    this.envPos = (this.envPos + 1) % this.env.length;
    const mid = waveH / 2;
    g.fillStyle = 'rgba(255,255,255,0.14)';
    const cols = Math.min(this.env.length, Math.floor(W / 1.5));
    for (let i = 0; i < cols; i++) {
      const v = this.env[(this.envPos - cols + i + this.env.length) % this.env.length];
      const hh = Math.min(1, v) * (waveH / 2 - 4);
      g.fillRect((i / cols) * W, mid - hh, 1.5, hh * 2);
    }
    let start = 0;
    for (let i = 1; i < 2048; i++) if (this.time[i - 1] < 0 && this.time[i] >= 0) { start = i; break; }
    g.strokeStyle = '#fff';
    g.lineWidth = 1.4;
    g.beginPath();
    const span = 1200;
    for (let i = 0; i < span; i += 2) {
      const x = (i / span) * W, y = mid - (this.time[start + i] || 0) * (waveH / 2 - 4);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const db = 20 * Math.log10(pk + 1e-9);
    g.font = '600 10px ui-monospace, monospace';
    g.fillStyle = db > -1 ? '#000' : 'rgba(255,255,255,0.7)';
    if (db > -1) { g.fillStyle = '#fff'; g.fillRect(W - 82, 4, 78, 15); g.fillStyle = '#000'; }
    g.fillText(`${db < -90 ? '-∞' : db.toFixed(1)} dBFS`, W - 78, 15);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(this.label, 6, 15);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(0, waveH - 1, W, 1);

    // ── spectrum
    const sy = waveH, yOf = (v) => sy + specH - Math.min(1, Math.max(0, (v + 110) / 100)) * specH;
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.beginPath();
    for (const d of [-90, -70, -50, -30, -10]) { const y = Math.round(yOf(d)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    const pts = Math.min(Math.round(W), 500);
    const binOf = (f) => Math.min(bins - 1, Math.max(1, Math.round((f / (rate / 2)) * bins)));
    const val = (arr, f0, f1) => {
      const a = binOf(f0), b = Math.max(a, binOf(f1));
      let m = -200;
      for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
      return m;
    };
    for (let i = 0; i < bins; i++) this.hold[i] = Math.max(this.spec[i], this.hold[i] - 0.4);
    g.beginPath();
    g.moveTo(0, sy + specH);
    for (let i = 0; i <= pts; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / pts), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / pts);
      g.lineTo((i / pts) * W, yOf(val(this.spec, f0, f1)));
    }
    g.lineTo(W, sy + specH);
    g.closePath();
    const grad = g.createLinearGradient(0, sy, 0, sy + specH);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0.03)');
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.2;
    g.stroke();
    g.beginPath();
    for (let i = 0; i <= pts; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / pts), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / pts);
      const y = yOf(val(this.hold, f0, f1));
      i ? g.lineTo((i / pts) * W, y) : g.moveTo(0, y);
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.stroke();

    // ── frequency axis
    const ay = sy + specH;
    g.fillStyle = '#000';
    g.fillRect(0, ay, W, axisH);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '500 9px ui-monospace, monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = this.xOf(f, W);
      g.fillRect(x, ay, 1, 4);
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, ay + 12);
    }

    // ── waterfall (one new row per frame, scrolls down)
    const ww = Math.max(1, Math.round(W)), wh = Math.max(1, Math.round(wfH));
    if (this.wf.width !== ww || this.wf.height !== wh) {
      this.wf.width = ww; this.wf.height = wh;
      this.wg.fillStyle = '#000'; this.wg.fillRect(0, 0, ww, wh);
      this.row = this.wg.createImageData(ww, 1);
    }
    this.wg.drawImage(this.wf, 0, 0, ww, wh - 1, 0, 1, ww, wh - 1);
    const d = this.row.data;
    for (let x = 0; x < ww; x++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, x / ww), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (x + 1) / ww);
      let v = (val(this.spec, f0, f1) + 105) / 85;
      v = Math.min(1, Math.max(0, v));
      const lum = Math.round(Math.pow(v, 1.6) * 255);
      d[x * 4] = d[x * 4 + 1] = d[x * 4 + 2] = lum;
      d[x * 4 + 3] = 255;
    }
    this.wg.putImageData(this.row, 0, 0);
    g.drawImage(this.wf, 0, wfY, W, wfH);

    // ── feedback-guard notch markers
    g.setLineDash([3, 3]);
    g.strokeStyle = '#fff';
    for (const n of this.notches) {
      const x = Math.round(this.xOf(n.freq, W)) + 0.5;
      g.beginPath(); g.moveTo(x, sy); g.lineTo(x, H); g.stroke();
      g.fillStyle = '#fff';
      g.fillRect(x - 13, sy + 2, 26, 12);
      g.fillStyle = '#000';
      g.font = '700 8px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText(`${Math.round(n.gain)}`, x, sy + 11);
      g.textAlign = 'left';
    }
    g.setLineDash([]);
    if (this.info) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, H - 20, W, 20);
      g.fillStyle = '#fff';
      g.font = '600 10px ui-monospace, monospace';
      g.fillText(this.info, 6, H - 6);
    }
  }
}
