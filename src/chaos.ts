// Qubit chaos: a simulated 2-qubit state vector. Drifting rotations and an
// entangling controlled-rotation evolve it; random measurements collapse it.
// Its Bloch vector is a 3D point, which can drive the 3D pad directly.

export interface ChaosSettings { rate: number; entropy: number; entangle: number; glide: number }
export interface Bloch { x: number; y: number; z: number }

export class QubitChaos {
  private readonly re = new Float64Array([1, 0, 0, 0]);
  private readonly im = new Float64Array(4);
  private readonly drift = [1, 1, 1];
  p = [1, 0, 0, 0];
  bloch: Bloch = { x: 0, y: 0, z: 1 };
  /** smoothed 3D point in 0..1 for the pad */
  point = { x: 0.5, y: 0.5, z: 0.5 };
  lastMeasured = -1;
  flash = 0;

  private ry(q: 0 | 1, theta: number): void {
    const c = Math.cos(theta / 2), s = Math.sin(theta / 2), bit = q === 0 ? 2 : 1;
    for (let i = 0; i < 4; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const ar = this.re[i], ai = this.im[i], br = this.re[j], bi = this.im[j];
      this.re[i] = c * ar - s * br; this.im[i] = c * ai - s * bi;
      this.re[j] = s * ar + c * br; this.im[j] = s * ai + c * bi;
    }
  }

  private rz(q: 0 | 1, phi: number): void {
    const bit = q === 0 ? 2 : 1, c = Math.cos(phi), s = Math.sin(phi);
    for (let i = 0; i < 4; i++) {
      if (!(i & bit)) continue;
      const r = this.re[i], m = this.im[i];
      this.re[i] = r * c - m * s;
      this.im[i] = r * s + m * c;
    }
  }

  /** controlled-Ry: qubit A rotates qubit B, which entangles them */
  private cry(theta: number): void {
    const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
    const ar = this.re[2], ai = this.im[2], br = this.re[3], bi = this.im[3];
    this.re[2] = c * ar - s * br; this.im[2] = c * ai - s * bi;
    this.re[3] = s * ar + c * br; this.im[3] = s * ai + c * bi;
  }

  step(dt: number, o: ChaosSettings): void {
    dt = Math.min(dt, 0.1);
    for (let k = 0; k < 3; k++) this.drift[k] = Math.max(0.3, Math.min(2.2, this.drift[k] + (Math.random() - 0.5) * dt * 2));
    const w = o.rate * Math.PI * 2 * dt;
    this.ry(0, w * this.drift[0]);
    this.ry(1, w * 1.37 * this.drift[1]);
    this.rz(0, w * 0.71 * this.drift[2]);
    this.rz(1, -w * 0.53);
    this.cry(w * o.entangle * 2.2);
    let norm = 0;
    for (let i = 0; i < 4; i++) norm += this.re[i] ** 2 + this.im[i] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 4; i++) { this.re[i] /= norm; this.im[i] /= norm; this.p[i] = this.re[i] ** 2 + this.im[i] ** 2; }

    if (Math.random() < o.entropy * o.entropy * dt * 4) {
      let r = Math.random(), k = 0;
      while (k < 3 && r > this.p[k]) { r -= this.p[k]; k++; }
      this.re.fill(0); this.im.fill(0); this.re[k] = 1;
      this.p = [0, 0, 0, 0]; this.p[k] = 1;
      this.lastMeasured = k;
      this.flash = 1;
    }
    this.flash = Math.max(0, this.flash - dt * 1.5);

    let xr = 0, xi = 0;
    for (const [a, b] of [[0, 2], [1, 3]] as const) {
      xr += this.re[a] * this.re[b] + this.im[a] * this.im[b];
      xi += this.im[a] * this.re[b] - this.re[a] * this.im[b];
    }
    this.bloch = { x: 2 * xr, y: -2 * xi, z: this.p[0] + this.p[1] - this.p[2] - this.p[3] };

    const k = Math.exp(-dt / Math.max(0.01, o.glide));
    const tgt = { x: (this.bloch.x + 1) / 2, y: (this.bloch.z + 1) / 2, z: (this.bloch.y + 1) / 2 };
    this.point.x = this.point.x * k + tgt.x * (1 - k);
    this.point.y = this.point.y * k + tgt.y * (1 - k);
    this.point.z = this.point.z * k + tgt.z * (1 - k);
  }
}
