// Qubit chaos: a simulated 2-qubit quantum state drives effect parameters.
// Rotations (with drifting, noisy angles) and an entangling controlled
// rotation evolve the state; random "measurements" collapse it to a basis
// state, which makes the modulation jump. Outputs are the four basis
// probabilities and the Bloch vector of qubit A, all in 0..1.

export const CHAOS_TARGETS = [
  { id: 'dly', label: 'DELAY SEND' },
  { id: 'rev', label: 'REVERB SEND' },
  { id: 'cho', label: 'CHORUS SEND' },
  { id: 'dbl', label: 'DOUBLER SEND' },
  { id: 'width', label: 'WIDTH' },
  { id: 'time', label: 'DELAY TIME' },
  { id: 'filter', label: 'WET FILTER' },
  { id: 'master', label: 'MASTER SWELL' },
];

export class QubitChaos {
  constructor() {
    // amplitudes for |00>, |01>, |10>, |11> as [re, im]
    this.re = new Float64Array([1, 0, 0, 0]);
    this.im = new Float64Array(4);
    this.p = [1, 0, 0, 0];
    this.out = {};
    this.smooth = {};
    this.drift = [1, 1, 1];
    this.bloch = { x: 0, y: 0, z: 1 };
    this.lastMeasured = -1;
    this.flash = 0;
    this.collapses = 0;
  }

  ry(q, theta) {
    const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
    const bit = q === 0 ? 2 : 1;
    for (let i = 0; i < 4; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const ar = this.re[i], ai = this.im[i], br = this.re[j], bi = this.im[j];
      this.re[i] = c * ar - s * br; this.im[i] = c * ai - s * bi;
      this.re[j] = s * ar + c * br; this.im[j] = s * ai + c * bi;
    }
  }

  rz(q, phi) {
    const bit = q === 0 ? 2 : 1;
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let i = 0; i < 4; i++) {
      if (!(i & bit)) continue;
      const r = this.re[i], m = this.im[i];
      this.re[i] = r * c - m * s;
      this.im[i] = r * s + m * c;
    }
  }

  // controlled-Ry: qubit A controls a rotation on qubit B (entangles them)
  cry(theta) {
    const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
    const ar = this.re[2], ai = this.im[2], br = this.re[3], bi = this.im[3];
    this.re[2] = c * ar - s * br; this.im[2] = c * ai - s * bi;
    this.re[3] = s * ar + c * br; this.im[3] = s * ai + c * bi;
  }

  normalize() {
    let n = 0;
    for (let i = 0; i < 4; i++) n += this.re[i] ** 2 + this.im[i] ** 2;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < 4; i++) { this.re[i] /= n; this.im[i] /= n; }
  }

  step(dt, { rate, entropy, entangle, glide }) {
    dt = Math.min(dt, 0.1);
    // random-walk drift keeps the motion from ever repeating exactly
    for (let k = 0; k < 3; k++) {
      this.drift[k] += (Math.random() - 0.5) * dt * 2;
      this.drift[k] = Math.max(0.3, Math.min(2.2, this.drift[k]));
    }
    const w = rate * Math.PI * 2 * dt;
    this.ry(0, w * this.drift[0]);
    this.ry(1, w * 1.37 * this.drift[1]);
    this.rz(0, w * 0.71 * this.drift[2]);
    this.rz(1, -w * 0.53);
    this.cry(w * entangle * 2.2);
    this.normalize();

    for (let i = 0; i < 4; i++) this.p[i] = this.re[i] ** 2 + this.im[i] ** 2;

    // measurement: collapse to one basis state
    if (Math.random() < entropy * entropy * dt * 4) {
      let r = Math.random(), k = 0;
      while (k < 3 && r > this.p[k]) { r -= this.p[k]; k++; }
      this.re.fill(0); this.im.fill(0);
      this.re[k] = 1;
      this.p = [0, 0, 0, 0]; this.p[k] = 1;
      this.lastMeasured = k;
      this.flash = 1;
      this.collapses++;
    }
    this.flash = Math.max(0, this.flash - dt * 1.5);

    // Bloch vector of qubit A (reduced density matrix)
    const r00 = this.p[0] + this.p[1], r11 = this.p[2] + this.p[3];
    let xr = 0, xi = 0;
    for (const [a, b] of [[0, 2], [1, 3]]) {
      // rho01 = sum a_i * conj(b_i)
      xr += this.re[a] * this.re[b] + this.im[a] * this.im[b];
      xi += this.im[a] * this.re[b] - this.re[a] * this.im[b];
    }
    this.bloch = { x: 2 * xr, y: -2 * xi, z: r00 - r11 };

    const clamp = (v) => Math.max(0, Math.min(1, v));
    const raw = {
      dly: clamp(this.p[0] * 2),
      rev: clamp(this.p[1] * 2),
      cho: clamp(this.p[2] * 2),
      dbl: clamp(this.p[3] * 2),
      width: (this.bloch.z + 1) / 2,
      time: (this.bloch.x + 1) / 2,
      filter: clamp((this.p[1] + this.p[2]) * 1.4),
      master: clamp((this.p[0] + this.p[3]) - 0.3),
    };
    const k = Math.exp(-dt / Math.max(0.01, glide));
    for (const [id, v] of Object.entries(raw)) {
      this.smooth[id] = this.smooth[id] === undefined ? v : this.smooth[id] * k + v * (1 - k);
      this.out[id] = this.smooth[id];
    }
    return this.out;
  }
}
