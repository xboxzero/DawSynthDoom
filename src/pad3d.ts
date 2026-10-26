// 3D effect pad: a point inside a cube. X, Y and Z each drive an assignable
// parameter. One finger / mouse drag moves X and Y; Z is set by the Z fader,
// the mouse wheel, or a two-finger pinch. The view slowly orbits so the depth reads.

import type { Registry } from './params';
import { fitCanvas } from './ui';

type V3 = [number, number, number];

export class Pad3D {
  private yaw = 0.6;
  private readonly pitch = 0.42;
  private readonly trail: V3[] = [];
  private pinch: { d: number; z: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly reg: Registry, private readonly labels: () => [string, string, string]) {
    let drag: { x: number; y: number; px: number; py: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: reg.get('pad.z') };
        drag = null;
        return;
      }
      for (const k of ['pad.x', 'pad.y', 'pad.z']) reg.touch(k, true);
      drag = { x: e.clientX, y: e.clientY, px: reg.get('pad.x'), py: reg.get('pad.y') };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        reg.set('pad.z', this.pinch.z + (Math.hypot(a.x - b.x, a.y - b.y) - this.pinch.d) / 200, 'ui');
        return;
      }
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const s = Math.min(r.width, r.height) * 0.6;
      reg.set('pad.x', drag.px + (e.clientX - drag.x) / s, 'ui');
      reg.set('pad.y', drag.py - (e.clientY - drag.y) / s, 'ui');
    });
    const end = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) { drag = null; for (const k of ['pad.x', 'pad.y', 'pad.z']) reg.touch(k, false); }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      reg.set('pad.z', reg.get('pad.z') + (e.deltaY < 0 ? 0.03 : -0.03), 'ui');
    }, { passive: false });
  }

  private proj(p: V3, w: number, h: number): [number, number, number] {
    const [x0, y0, z0] = [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy;
    const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp;
    const s = Math.min(w, h) * 0.5 / (1.9 + z2);
    return [w / 2 + x1 * s * 1.9, h / 2 - y2 * s * 1.9, z2];
  }

  draw(dt: number, spin: boolean): void {
    const fc = fitCanvas(this.canvas);
    if (!fc) return;
    const { g, w, h } = fc;
    if (spin) this.yaw += dt * 0.15;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const P = (p: V3) => this.proj(p, w, h);
    const corners: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    // floor grid
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      let a = P([t, 0, 0]), b = P([t, 0, 1]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      a = P([0, 0, t]); b = P([1, 0, t]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    for (const [i, j] of edges) {
      const a = P(corners[i]), b = P(corners[j]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    // axis labels
    const [lx, ly, lz] = this.labels();
    g.font = '13px "Permanent Marker", system-ui';
    g.fillStyle = '#fff';
    const ax = P([1.08, 0, 0]), ay = P([0, 1.08, 0]), az = P([0, 0, 1.1]);
    g.fillText(`X ${lx}`, ax[0] - 10, ax[1] + 14);
    g.fillText(`Y ${ly}`, ay[0] - 14, ay[1] - 4);
    g.fillText(`Z ${lz}`, az[0] - 10, az[1] + 14);

    const pt: V3 = [this.reg.get('pad.x'), this.reg.get('pad.y'), this.reg.get('pad.z')];
    this.trail.push(pt);
    if (this.trail.length > 90) this.trail.shift();
    // trail
    for (let i = 1; i < this.trail.length; i++) {
      const a = P(this.trail[i - 1]), b = P(this.trail[i]);
      g.strokeStyle = `rgba(255,255,255,${(i / this.trail.length) * 0.7})`;
      g.lineWidth = 1 + (i / this.trail.length) * 2;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    // projection lines to the floor and walls make depth readable
    const p = P(pt), floor = P([pt[0], 0, pt[2]]), back = P([pt[0], pt[1], 0]), side = P([0, pt[1], pt[2]]);
    g.setLineDash([3, 4]);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    for (const q of [floor, back, side]) { g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.4)';
    for (const q of [floor, back, side]) { g.beginPath(); g.arc(q[0], q[1], 3, 0, Math.PI * 2); g.fill(); }
    const r = 9 + (1 - (p[2] + 0.5)) * 6;
    g.beginPath(); g.arc(p[0], p[1], r + 6, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fill();
    g.beginPath(); g.arc(p[0], p[1], r, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.font = '600 10px ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(`x ${pt[0].toFixed(2)}  y ${pt[1].toFixed(2)}  z ${pt[2].toFixed(2)}`, 8, h - 8);
  }
}
