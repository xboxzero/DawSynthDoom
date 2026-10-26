// End rack: optional gig modules at the end of the chain.
// Each slot: in -> [dry + module * mix] -> out. Add, bypass, reorder, remove while playing.

import type { ParamSpec, Registry } from './params';

const sm = (p: AudioParam, v: number, ctx: BaseAudioContext, t = 0.02): void => {
  p.cancelScheduledValues(ctx.currentTime);
  p.setTargetAtTime(v, ctx.currentTime, t);
};

function curve(n: number, f: (x: number) => number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = f((i / (n - 1)) * 2 - 1);
  return c;
}

export interface SlotHelper { param(name: string): number }
export interface RackInstance {
  in: AudioNode;
  out: AudioNode;
  apply?(name: string, v: number): void;
  press?(name: string, btn: HTMLButtonElement): void;
  build?(body: HTMLElement): void;
  destroy?(): void;
}
export interface RackModuleDef {
  name: string;
  noMix?: boolean;
  buttons?: string[];
  params: Record<string, ParamSpec>;
  make(ctx: AudioContext, h: SlotHelper): RackInstance;
}

export const RACK_MODULES: Record<string, RackModuleDef> = {
  phaser: {
    name: 'PHASER',
    params: {
      rate: { label: 'RATE', min: 0.05, max: 8, def: 0.4, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' },
      depth: { label: 'DEPTH', def: 0.7, unit: '%' },
      center: { label: 'CENTER', min: 200, max: 4000, def: 900, scale: 'log', unit: 'Hz' },
    },
    make(ctx) {
      // four all-pass stages swept by one LFO
      const stages = Array.from({ length: 4 }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.7; return f; });
      const lfo = ctx.createOscillator(), d = ctx.createGain();
      lfo.connect(d); lfo.start();
      for (let i = 0; i < 3; i++) stages[i].connect(stages[i + 1]);
      for (const st of stages) d.connect(st.detune);
      return {
        in: stages[0], out: stages[3],
        apply(n, v) {
          if (n === 'rate') sm(lfo.frequency, v, ctx);
          else if (n === 'depth') sm(d.gain, v * 2400, ctx);
          else for (const st of stages) sm(st.frequency, v, ctx);
        },
        destroy() { lfo.stop(); },
      };
    },
  },
  trem: {
    name: 'TREMOLO',
    params: {
      rate: { label: 'RATE', min: 0.5, max: 16, def: 5, scale: 'log', format: (v) => v.toFixed(1) + 'Hz' },
      depth: { label: 'DEPTH', def: 0.6, unit: '%' },
      shape: { label: 'SHAPE', min: 0, max: 2, def: 0, step: 1, options: ['SINE', 'SQUARE', 'TRI'] },
    },
    make(ctx) {
      const g = ctx.createGain(), lfo = ctx.createOscillator(), d = ctx.createGain();
      lfo.connect(d); d.connect(g.gain); lfo.start();
      return {
        in: g, out: g,
        apply(n, v) {
          if (n === 'rate') sm(lfo.frequency, v, ctx);
          else if (n === 'shape') lfo.type = (['sine', 'square', 'triangle'] as const)[v] ?? 'sine';
          else { sm(d.gain, v / 2, ctx); sm(g.gain, 1 - v / 2, ctx); }
        },
        destroy() { lfo.stop(); },
      };
    },
  },
  filter: {
    name: 'AUTO FILTER',
    params: {
      freq: { label: 'FREQ', min: 60, max: 6000, def: 500, scale: 'log', unit: 'Hz' },
      rate: { label: 'RATE', min: 0.05, max: 10, def: 0.5, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' },
      depth: { label: 'DEPTH', min: 0, max: 4, def: 2, format: (v) => v.toFixed(1) + 'oct' },
      reso: { label: 'RESO', min: 0.5, max: 15, def: 5, scale: 'log' },
    },
    make(ctx) {
      const f = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), d = ctx.createGain();
      f.type = 'lowpass';
      lfo.connect(d); d.connect(f.detune); lfo.start();
      return {
        in: f, out: f,
        apply(n, v) {
          if (n === 'freq') sm(f.frequency, v, ctx);
          else if (n === 'rate') sm(lfo.frequency, v, ctx);
          else if (n === 'depth') sm(d.gain, v * 1200, ctx);
          else sm(f.Q, v, ctx);
        },
        destroy() { lfo.stop(); },
      };
    },
  },
  crush: {
    name: 'BITCRUSH',
    params: {
      bits: { label: 'BITS', min: 2, max: 12, def: 6, step: 1, format: (v) => v + 'bit' },
      tone: { label: 'TONE', min: 400, max: 16000, def: 5000, scale: 'log', unit: 'Hz' },
      level: { label: 'LEVEL', def: 0.8, unit: '%' },
    },
    make(ctx) {
      const sh = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = 'lowpass';
      sh.connect(lp); lp.connect(g);
      return {
        in: sh, out: g,
        apply(n, v) {
          if (n === 'bits') { const st = 2 ** v / 2; sh.curve = curve(4096, (x) => Math.round(x * st) / st); }
          else if (n === 'tone') sm(lp.frequency, v, ctx);
          else sm(g.gain, v, ctx);
        },
      };
    },
  },
  stutter: {
    name: 'STUTTER',
    noMix: true,
    buttons: ['HOLD'],
    params: {
      slice: { label: 'SLICE', min: 0.04, max: 1, def: 0.125, scale: 'log', unit: 's' },
      level: { label: 'LEVEL', def: 1, unit: '%' },
    },
    make(ctx, h) {
      const inp = ctx.createGain(), out = ctx.createGain(), pass = ctx.createGain(), gate = ctx.createGain();
      const fb = ctx.createGain(), holdOut = ctx.createGain(), d = ctx.createDelay(2);
      fb.gain.value = 0; holdOut.gain.value = 0;
      inp.connect(pass); pass.connect(out);
      inp.connect(gate); gate.connect(d); d.connect(fb); fb.connect(d); d.connect(holdOut); holdOut.connect(out);
      let held = false;
      return {
        in: inp, out,
        apply(n, v) { if (n === 'slice') d.delayTime.setValueAtTime(v, ctx.currentTime); else sm(holdOut.gain, held ? v : 0, ctx, 0.005); },
        press(_n, btn) {
          held = !held;
          const t = ctx.currentTime;
          gate.gain.setValueAtTime(held ? 0 : 1, t);
          fb.gain.setValueAtTime(held ? 1 : 0, t);
          sm(holdOut.gain, held ? h.param('level') : 0, ctx, 0.005);
          sm(pass.gain, held ? 0 : 1, ctx, 0.005);
          btn.classList.toggle('on', held);
        },
      };
    },
  },
  looper: {
    name: 'LOOPER',
    noMix: true,
    buttons: ['REC', 'DUB', 'STOP', 'CLEAR'],
    params: { level: { label: 'LOOP LVL', def: 0.9, unit: '%' } },
    make(ctx) {
      // A long DelayNode is the tape: record, then set the delay to the loop
      // length and close the feedback loop at unity gain.
      const inp = ctx.createGain(), out = ctx.createGain(), rec = ctx.createGain(), fb = ctx.createGain();
      const loopOut = ctx.createGain(), lvl = ctx.createGain(), tape = ctx.createDelay(179);
      tape.delayTime.value = 179;
      rec.gain.value = 0; fb.gain.value = 0; loopOut.gain.value = 0;
      inp.connect(out);
      inp.connect(rec); rec.connect(tape); tape.connect(fb); fb.connect(tape);
      tape.connect(loopOut); loopOut.connect(lvl); lvl.connect(out);
      let state: 'empty' | 'recording' | 'playing' | 'overdub' | 'stopped' = 'empty';
      let t0 = 0, len = 0, statusEl: HTMLElement | null = null;
      const status = (s: typeof state): void => {
        state = s;
        if (statusEl) statusEl.textContent = s.toUpperCase() + (len ? ` · ${len.toFixed(2)}s` : '');
      };
      return {
        in: inp, out,
        apply(_n, v) { sm(lvl.gain, v, ctx); },
        build(body) { statusEl = document.createElement('div'); statusEl.className = 'r-status'; body.appendChild(statusEl); status('empty'); },
        press(name) {
          const t = ctx.currentTime;
          if (name === 'REC') {
            if (state === 'empty') {
              fb.gain.setValueAtTime(0, t); loopOut.gain.setValueAtTime(0, t);
              tape.delayTime.setValueAtTime(179, t);
              rec.gain.setValueAtTime(1, t);
              t0 = t; len = 0; status('recording');
            } else if (state === 'recording') {
              len = Math.min(178, t - t0);
              tape.delayTime.setValueAtTime(len, t);
              fb.gain.setValueAtTime(1, t); rec.gain.setValueAtTime(0, t); loopOut.gain.setValueAtTime(1, t);
              status('playing');
            } else if (state === 'stopped') { loopOut.gain.setValueAtTime(1, t); status('playing'); }
          } else if (name === 'DUB' && (state === 'playing' || state === 'overdub')) {
            const dub = state === 'playing';
            rec.gain.setValueAtTime(dub ? 1 : 0, t);
            status(dub ? 'overdub' : 'playing');
          } else if (name === 'STOP' && state !== 'empty') {
            rec.gain.setValueAtTime(0, t);
            if (state === 'recording') { len = Math.min(178, t - t0); tape.delayTime.setValueAtTime(len, t); fb.gain.setValueAtTime(1, t); }
            loopOut.gain.setValueAtTime(0, t);
            status('stopped');
          } else if (name === 'CLEAR') {
            rec.gain.setValueAtTime(0, t); fb.gain.setValueAtTime(0, t); loopOut.gain.setValueAtTime(0, t);
            len = 0; status('empty');
          }
        },
      };
    },
  },
};

export interface Slot {
  id: string;
  type: string;
  def: RackModuleDef;
  mod: RackInstance;
  in: GainNode;
  out: GainNode;
  dry: GainNode;
  wet: GainNode;
}

export interface SavedSlot { id: string; type: string; params: Record<string, number> }

export class Rack {
  slots: Slot[] = [];
  onChange: () => void = () => {};
  private uid = 1;

  constructor(private readonly ctx: AudioContext, private readonly input: GainNode, private readonly output: AudioNode, private readonly reg: Registry) {
    this.wire();
  }

  private paramNames(s: { def: RackModuleDef }): string[] {
    return [...Object.keys(s.def.params), 'on', ...(s.def.noMix ? [] : ['mix'])];
  }

  add(type: string, saved?: Partial<SavedSlot>): Slot | null {
    const def = RACK_MODULES[type];
    if (!def) return null;
    const ctx = this.ctx;
    const id = saved?.id ?? `r${this.uid++}`;
    this.uid = Math.max(this.uid, Number(id.slice(1)) + 1);
    const mod = def.make(ctx, { param: (name) => this.reg.get(`${id}.${name}`) });
    const slot: Slot = { id, type, def, mod, in: ctx.createGain(), out: ctx.createGain(), dry: ctx.createGain(), wet: ctx.createGain() };
    slot.in.connect(slot.dry); slot.dry.connect(slot.out);
    slot.in.connect(mod.in); mod.out.connect(slot.wet); slot.wet.connect(slot.out);
    const specs: Record<string, ParamSpec> = { ...def.params, on: { label: 'ON', def: 1, step: 1 } };
    if (!def.noMix) specs.mix = { label: 'MIX', def: 1, unit: '%' };
    for (const [name, spec] of Object.entries(specs)) {
      const pid = `${id}.${name}`;
      const p = this.reg.define(pid, { ...spec, apply: (v) => (name === 'on' || name === 'mix' ? this.applyMix(slot) : mod.apply?.(name, v)) });
      const v = saved?.params?.[name];
      if (v !== undefined) this.reg.set(pid, v, 'load'); else p.apply?.(p.value, 'load');
    }
    this.applyMix(slot);
    this.slots.push(slot);
    this.wire();
    this.onChange();
    return slot;
  }

  private applyMix(slot: Slot): void {
    const on = this.reg.on(`${slot.id}.on`);
    const mix = slot.def.noMix ? 1 : this.reg.get(`${slot.id}.mix`);
    const t = this.ctx.currentTime;
    slot.dry.gain.setTargetAtTime(on ? (slot.def.noMix ? 0 : 1 - mix) : 1, t, 0.02);
    slot.wet.gain.setTargetAtTime(on ? mix : 0, t, 0.02);
  }

  remove(id: string): void {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = this.slots.splice(i, 1);
    this.wire();
    s.out.disconnect();
    s.mod.destroy?.();
    for (const name of this.paramNames(s)) this.reg.params.delete(`${id}.${name}`);
    this.onChange();
  }

  move(id: string, dir: number): void {
    const i = this.slots.findIndex((s) => s.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= this.slots.length) return;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this.wire();
    this.onChange();
  }

  private wire(): void {
    this.input.disconnect();
    for (const s of this.slots) s.out.disconnect();
    let node: AudioNode = this.input;
    for (const s of this.slots) { node.connect(s.in); node = s.out; }
    node.connect(this.output);
  }

  save(): SavedSlot[] {
    return this.slots.map((s) => ({ id: s.id, type: s.type, params: Object.fromEntries(this.paramNames(s).map((k) => [k, this.reg.get(`${s.id}.${k}`)])) }));
  }

  clear(): void { for (const s of [...this.slots]) this.remove(s.id); }
}
