// 3D frequency monitor: a perspective spectrogram (newest slice at the front,
// history receding into the distance). Each slice is coloured by what kind of
// sound it is: tonal, hum, or a noise colour (white / pink / brown / blue /
// violet) estimated from the spectral slope and flatness.
// Drag to tilt and turn the view.

import { fitCanvas } from './ui';

const F_MIN = 30, F_MAX = 16000, ROWS = 56, COLS = 110;

export interface NoiseKind { id: string; label: string; color: string; hint: string }
export const KINDS: Record<string, NoiseKind> = {
  silence: { id: 'silence', label: 'SILENCE', color: '#3a3a3a', hint: 'below -75 dBFS' },
  tonal: { id: 'tonal', label: 'TONAL', color: '#ffd23f', hint: 'clear pitch and harmonics' },
  hum: { id: 'hum', label: 'HUM', color: '#ff8c1a', hint: '50 / 60 Hz mains hum' },
  brown: { id: 'brown', label: 'BROWN', color: '#c06a2b', hint: 'about -6 dB/oct' },
  pink: { id: 'pink', label: 'PINK', color: '#ff6fb5', hint: 'about -3 dB/oct' },
  white: { id: 'white', label: 'WHITE', color: '#ffffff', hint: 'flat' },
  blue: { id: 'blue', label: 'BLUE', color: '#3fa9ff', hint: 'about +3 dB/oct' },
  violet: { id: 'violet', label: 'VIOLET', color: '#a35bff', hint: 'about +6 dB/oct' },
};

export interface Analysis { kind: NoiseKind; slope: number; flatness: number; level: number }

export class Spectrum3D {
  label = 'OUTPUT';
  info = '';
  notches: { freq: number; gain: number }[] = [];
  /** pitches being played; a bass note near 50/60 Hz is music, not hum */
  playing: number[] = [];
  last: Analysis = { kind: KINDS.silence, slope: 0, flatness: 0, level: -120 };
  private readonly rows: { v: Float32Array; kind: NoiseKind }[] = [];
  private spec: Float32Array<ArrayBuffer> | null = null;
  private time: Float32Array<ArrayBuffer> | null = null;
  private tilt = 0.55;
  private yaw = 0.18;

  constructor(private readonly canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number; tilt: number; yaw: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, tilt: this.tilt, yaw: this.yaw };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.tilt = Math.min(0.9, Math.max(0.15, drag.tilt + (e.clientY - drag.y) / 300));
      this.yaw = Math.min(0.6, Math.max(-0.6, drag.yaw + (e.clientX - drag.x) / 400));
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointercancel', () => { drag = null; });
  }

  /** classify the current spectrum (dB per bin) */
  private classify(spec: Float32Array, rate: number): Analysis {
    const bins = spec.length, hz = rate / 2 / bins;
    const binOf = (f: number): number => Math.min(bins - 1, Math.max(1, Math.round(f / hz)));
    // flatness + level over 40 Hz – 16 kHz
    let logSum = 0, linSum = 0, cnt = 0;
    for (let i = binOf(40); i <= binOf(16000); i++) {
      const p = Math.pow(10, spec[i] / 10) + 1e-20;
      logSum += Math.log(p); linSum += p; cnt++;
    }
    const level = 10 * Math.log10(linSum / cnt + 1e-20) + 10 * Math.log10(cnt);
    const flatness = Math.exp(logSum / cnt) / (linSum / cnt);
    // slope: regression of band density (dB) against octaves, 1/3-octave bands
    const xs: number[] = [], ys: number[] = [];
    for (let f = 50; f < 14000; f *= Math.pow(2, 1 / 3)) {
      const a = binOf(f), b = Math.max(a, binOf(f * Math.pow(2, 1 / 3)));
      let s = 0;
      for (let i = a; i <= b; i++) s += Math.pow(10, spec[i] / 10);
      xs.push(Math.log2(f)); ys.push(10 * Math.log10(s / (b - a + 1) + 1e-20));
    }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
    const slope = num / den;
    // hum: strong narrow peaks at 50/60 Hz and their low harmonics
    const peakness = (f: number): number => { const i = binOf(f); return spec[i] - (spec[binOf(f * 0.8)] + spec[binOf(f * 1.25)]) / 2; };
    // hum = a full 50/100/150 (or 60/120/180) series that no played note explains
    const series = (b: number): number => Math.min(peakness(b), peakness(b * 2), peakness(b * 3));
    const explained = (b: number): boolean => this.playing.some((f) => f > 0 && [1, 2, 3].some((k) => Math.abs((b * k) / f - Math.round((b * k) / f)) < 0.04 && Math.round((b * k) / f) >= 1));
    const hum = Math.max(explained(50) ? 0 : series(50), explained(60) ? 0 : series(60));

    let kind: NoiseKind;
    if (level < -75) kind = KINDS.silence;
    else if (hum > 12) kind = KINDS.hum;
    else if (flatness < 0.2) kind = KINDS.tonal;
    else if (slope < -4.5) kind = KINDS.brown;
    else if (slope < -1.5) kind = KINDS.pink;
    else if (slope < 1.5) kind = KINDS.white;
    else if (slope < 4.5) kind = KINDS.blue;
    else kind = KINDS.violet;
    return { kind, slope, flatness, level };
  }

  draw(an: AnalyserNode | null): void {
    const fc = fitCanvas(this.canvas);
    if (!fc) return;
    const { g, w: W, h: H } = fc;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (!an) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.font = '15px "Permanent Marker", system-ui';
      g.textAlign = 'center';
      g.fillText('PRESS START', W / 2, H / 2);
      g.textAlign = 'left';
      return;
    }
    const bins = an.frequencyBinCount, rate = an.context.sampleRate;
    if (!this.spec || this.spec.length !== bins) { this.spec = new Float32Array(bins); this.time = new Float32Array(an.fftSize); }
    an.getFloatFrequencyData(this.spec);
    an.getFloatTimeDomainData(this.time!);
    const spec = this.spec, time = this.time!;

    this.last = this.classify(spec, rate);
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / COLS), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / COLS);
      const a = Math.max(1, Math.round((f0 / (rate / 2)) * bins)), b = Math.max(a, Math.round((f1 / (rate / 2)) * bins));
      let m = -200;
      for (let i = a; i <= b && i < bins; i++) if (spec[i] > m) m = spec[i];
      row[c] = Math.min(1, Math.max(0, (m + 100) / 90));
    }
    this.rows.unshift({ v: row, kind: this.last.kind });
    if (this.rows.length > ROWS) this.rows.pop();

    // ── waveform strip
    const waveH = Math.min(56, H * 0.14);
    let start = 0;
    for (let i = 1; i < 2048; i++) if (time[i - 1] < 0 && time[i] >= 0) { start = i; break; }
    g.strokeStyle = this.last.kind.color;
    g.lineWidth = 1.4;
    g.beginPath();
    for (let i = 0; i < 1600; i += 3) {
      const x = (i / 1600) * W, y = waveH / 2 + 2 - (time[start + i] || 0) * (waveH / 2 - 4);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();

    // ── 3D terrain
    const top = waveH + 46, bottom = H - 18;
    const horizon = top + (bottom - top) * (1 - this.tilt) * 0.6;
    const depthScale = (z: number): number => 1 / (1 + z * 1.8);
    const project = (u: number, v: number, z: number): [number, number] => {
      const s = depthScale(z);
      const floor = horizon + (bottom - horizon) * ((s - depthScale(1)) / (1 - depthScale(1)));
      const x = W / 2 + (u - 0.5) * W * 0.96 * s + this.yaw * z * W * 0.5;
      const y = floor - v * (bottom - top) * 0.45 * s * (0.6 + this.tilt * 0.6);
      return [x, y];
    };
    for (let r = this.rows.length - 1; r >= 0; r--) {
      const { v, kind } = this.rows[r];
      const z = r / (ROWS - 1);
      g.beginPath();
      const [x0, y0] = project(0, 0, z);
      g.moveTo(x0, y0);
      for (let c = 0; c < COLS; c++) { const [x, y] = project(c / (COLS - 1), v[c], z); g.lineTo(x, y); }
      const [x1, y1] = project(1, 0, z);
      g.lineTo(x1, y1);
      g.closePath();
      g.fillStyle = '#000';
      g.fill();
      g.globalAlpha = r === 0 ? 1 : Math.max(0.12, 1 - z * 0.9);
      g.strokeStyle = kind.color;
      g.lineWidth = r === 0 ? 2 : 1;
      g.stroke();
      if (r === 0) { g.globalAlpha = 0.18; g.fillStyle = kind.color; g.fill(); }
      g.globalAlpha = 1;
    }
    // frequency labels along the front edge
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '500 9px ui-monospace, monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const u = Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
      const [x, y] = project(u, 0, 0);
      g.fillRect(x, y, 1, 4);
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, y + 12);
    }
    // feedback-guard notch markers
    g.setLineDash([3, 3]);
    g.strokeStyle = '#fff';
    for (const n of this.notches) {
      const u = Math.log(n.freq / F_MIN) / Math.log(F_MAX / F_MIN);
      const [xb, yb] = project(u, 0, 0), [xt, yt] = project(u, 0, 1);
      g.beginPath(); g.moveTo(xb, yb); g.lineTo(xt, yt); g.stroke();
    }
    g.setLineDash([]);

    // ── readouts (top row, clear of the frequency labels)
    const a = this.last;
    const ry = waveH + 16;
    g.font = '600 10px ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(this.label, 6, ry);
    g.textAlign = 'right';
    g.fillText(`${a.level < -110 ? '-∞' : a.level.toFixed(1)} dBFS`, W - 6, ry);
    g.fillText(this.info || `${a.slope >= 0 ? '+' : ''}${a.slope.toFixed(1)} dB/oct · flat ${a.flatness.toFixed(2)}`, W - 6, ry + 22);
    g.textAlign = 'left';
    g.fillStyle = a.kind.color;
    g.font = '20px "Permanent Marker", system-ui';
    g.fillText(a.kind.label, 6, ry + 24);
  }
}
