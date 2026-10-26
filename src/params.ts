// Central parameter registry: every control is a Param, so widgets, presets,
// the 3D pad, motion modes and qubit chaos all speak one language.

export type Source = 'ui' | 'auto' | 'load' | 'pad';

export interface ParamSpec {
  label?: string;
  min?: number;
  max?: number;
  def?: number;
  step?: number;
  scale?: 'lin' | 'log';
  unit?: '' | 'Hz' | 'dB' | 's' | '%' | 'ms';
  options?: readonly string[];
  persist?: boolean;
  format?: (v: number) => string;
  apply?: (v: number, source: Source) => void;
}

export interface Widget { update(v: number): void }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class Param {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly def: number;
  readonly step: number;
  readonly scale: 'lin' | 'log';
  readonly unit: string;
  readonly options: readonly string[] | null;
  readonly persist: boolean;
  readonly widgets = new Set<Widget>();
  value: number;
  private readonly fmt: ((v: number) => string) | null;
  readonly apply: ((v: number, source: Source) => void) | null;

  constructor(readonly id: string, o: ParamSpec) {
    this.label = o.label ?? id;
    this.min = o.min ?? 0;
    this.max = o.max ?? 1;
    this.def = o.def ?? this.min;
    this.step = o.step ?? 0;
    this.scale = o.scale ?? 'lin';
    this.unit = o.unit ?? '';
    this.options = o.options ?? null;
    this.persist = o.persist ?? true;
    this.fmt = o.format ?? null;
    this.apply = o.apply ?? null;
    this.value = this.def;
  }

  toNorm(v = this.value): number {
    if (this.scale === 'log') return Math.log(v / this.min) / Math.log(this.max / this.min);
    return (v - this.min) / (this.max - this.min);
  }

  fromNorm(n: number): number {
    n = clamp(n, 0, 1);
    if (this.scale === 'log') return this.min * Math.pow(this.max / this.min, n);
    return this.min + n * (this.max - this.min);
  }

  format(v = this.value): string {
    if (this.fmt) return this.fmt(v);
    if (this.options) return this.options[Math.round(v - this.min)] ?? String(v);
    switch (this.unit) {
      case 'Hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : String(Math.round(v));
      case 'dB': return (v > 0 ? '+' : '') + v.toFixed(1);
      case 's': return v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
      case 'ms': return Math.round(v) + 'ms';
      case '%': return Math.round(v * 100) + '%';
      default: return Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2);
    }
  }
}

export type ChangeListener = (id: string, v: number, source: Source) => void;

export class Registry {
  readonly params = new Map<string, Param>();
  readonly touched = new Set<string>();
  private readonly listeners = new Set<ChangeListener>();

  define(id: string, spec: ParamSpec): Param {
    const p = new Param(id, spec);
    this.params.set(id, p);
    return p;
  }

  param(id: string): Param {
    const p = this.params.get(id);
    if (!p) throw new Error(`Unknown param ${id}`);
    return p;
  }

  has(id: string): boolean { return this.params.has(id); }
  get(id: string): number { return this.params.get(id)?.value ?? 0; }
  on(id: string): boolean { return this.get(id) >= 0.5; }

  set(id: string, raw: number, source: Source = 'ui'): void {
    const p = this.params.get(id);
    if (!p) return;
    let v = clamp(Number(raw), p.min, p.max);
    if (p.step) v = Math.round((v - p.min) / p.step) * p.step + p.min;
    if (Number.isNaN(v)) return;
    const changed = v !== p.value;
    p.value = v;
    p.apply?.(v, source);
    for (const w of p.widgets) w.update(v);
    if (changed) for (const fn of this.listeners) fn(id, v, source);
  }

  touch(id: string, on: boolean): void {
    if (on) this.touched.add(id); else this.touched.delete(id);
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  applyAll(): void {
    for (const p of this.params.values()) p.apply?.(p.value, 'load');
  }

  snapshot(filter: (p: Param) => boolean = () => true): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.params.values()) if (filter(p)) out[p.id] = p.value;
    return out;
  }

  restore(obj: Record<string, number> | null | undefined, source: Source = 'load'): void {
    if (!obj) return;
    for (const [id, v] of Object.entries(obj)) if (this.params.has(id)) this.set(id, v, source);
  }
}
