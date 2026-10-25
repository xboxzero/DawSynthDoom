// End rack: optional modules at the end of the chain for live gigs.
// Each slot: input -> [dry + module*mix] -> output. Slots can be added,
// bypassed, reordered and removed while playing.

const sm = (p, v, ctx, t = 0.02) => { p.cancelScheduledValues(ctx.currentTime); p.setTargetAtTime(v, ctx.currentTime, t); };

function crushCurve(bits) {
  const n = 4096, c = new Float32Array(n), steps = Math.pow(2, bits);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * steps / 2) / (steps / 2); }
  return c;
}

function softCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
}

export const RACK_MODULES = {
  trem: {
    name: 'TREMOLO',
    params: {
      rate: { label: 'RATE', min: 0.5, max: 16, def: 5, scale: 'log', format: (v) => v.toFixed(1) + 'Hz' },
      depth: { label: 'DEPTH', def: 0.6, unit: '%' },
      shape: { label: 'SHAPE', min: 0, max: 2, def: 0, step: 1, options: ['SINE', 'SQUARE', 'TRI'] },
    },
    make(ctx) {
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const d = ctx.createGain();
      lfo.connect(d); d.connect(g.gain); lfo.start();
      let depth = 0.6;
      return {
        in: g, out: g,
        apply(n, v) {
          if (n === 'rate') sm(lfo.frequency, v, ctx);
          else if (n === 'shape') lfo.type = ['sine', 'square', 'triangle'][v];
          else { depth = v; sm(d.gain, depth / 2, ctx); sm(g.gain, 1 - depth / 2, ctx); }
        },
        destroy() { lfo.stop(); },
      };
    },
  },

  filter: {
    name: 'AUTO FILTER',
    params: {
      freq: { label: 'FREQ', min: 100, max: 8000, def: 800, scale: 'log', unit: 'Hz' },
      rate: { label: 'RATE', min: 0.05, max: 10, def: 0.4, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' },
      depth: { label: 'DEPTH', min: 0, max: 4, def: 2, format: (v) => v.toFixed(1) + 'oct' },
      reso: { label: 'RESO', min: 0.5, max: 15, def: 4, scale: 'log' },
    },
    make(ctx) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      const lfo = ctx.createOscillator(); const d = ctx.createGain();
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
      tone: { label: 'TONE', min: 800, max: 16000, def: 6000, scale: 'log', unit: 'Hz' },
      level: { label: 'LEVEL', def: 0.8, unit: '%' },
    },
    make(ctx) {
      const sh = ctx.createWaveShaper();
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const g = ctx.createGain();
      sh.connect(lp); lp.connect(g);
      return {
        in: sh, out: g,
        apply(n, v) {
          if (n === 'bits') sh.curve = crushCurve(v);
          else if (n === 'tone') sm(lp.frequency, v, ctx);
          else sm(g.gain, v, ctx);
        },
      };
    },
  },

  radio: {
    name: 'LO-FI RADIO',
    params: {
      center: { label: 'CENTER', min: 500, max: 3000, def: 1300, scale: 'log', unit: 'Hz' },
      drive: { label: 'DRIVE', min: 1, max: 12, def: 3 },
      level: { label: 'LEVEL', def: 0.7, unit: '%' },
    },
    make(ctx) {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const sh = ctx.createWaveShaper();
      const g = ctx.createGain();
      hp.connect(lp); lp.connect(sh); sh.connect(g);
      return {
        in: hp, out: g,
        apply(n, v) {
          if (n === 'center') { sm(hp.frequency, v / 3, ctx); sm(lp.frequency, v * 2.4, ctx); }
          else if (n === 'drive') sh.curve = softCurve(v);
          else sm(g.gain, v, ctx);
        },
      };
    },
  },

  stutter: {
    name: 'STUTTER',
    noMix: true,
    params: {
      slice: { label: 'SLICE', min: 0.04, max: 1, def: 0.125, scale: 'log', unit: 's' },
      level: { label: 'LEVEL', def: 1, unit: '%' },
    },
    buttons: ['HOLD'],
    make(ctx) {
      const inp = ctx.createGain(), out = ctx.createGain();
      const pass = ctx.createGain(), gate = ctx.createGain(), fb = ctx.createGain(), holdOut = ctx.createGain();
      const d = ctx.createDelay(2);
      gate.gain.value = 1; fb.gain.value = 0; holdOut.gain.value = 0;
      inp.connect(pass); pass.connect(out);
      inp.connect(gate); gate.connect(d); d.connect(fb); fb.connect(d); d.connect(holdOut); holdOut.connect(out);
      let held = false;
      return {
        in: inp, out,
        apply(n, v) { if (n === 'slice') d.delayTime.setValueAtTime(v, ctx.currentTime); else sm(holdOut.gain, held ? v : 0, ctx, 0.005); },
        press(name, btn, h) {
          held = !held;
          const t = ctx.currentTime;
          // capture the last slice, then loop it with unity feedback
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
    params: { level: { label: 'LOOP LVL', def: 0.9, unit: '%' } },
    buttons: ['REC', 'DUB', 'STOP', 'CLEAR'],
    make(ctx) {
      // A long DelayNode is the tape: record, then set the delay to the loop
      // length and close the feedback loop at unity gain.
      const inp = ctx.createGain(), out = ctx.createGain();
      const recGate = ctx.createGain(), fb = ctx.createGain(), loopOut = ctx.createGain(), lvl = ctx.createGain();
      const tape = ctx.createDelay(179);
      tape.delayTime.value = 179;
      recGate.gain.value = 0; fb.gain.value = 0; loopOut.gain.value = 0;
      inp.connect(out);
      inp.connect(recGate); recGate.connect(tape); tape.connect(fb); fb.connect(tape);
      tape.connect(loopOut); loopOut.connect(lvl); lvl.connect(out);
      let state = 'empty', t0 = 0, len = 0, statusEl = null;
      const status = (s) => { state = s; if (statusEl) statusEl.textContent = s.toUpperCase() + (len ? ` · ${len.toFixed(2)}s` : ''); };
      return {
        in: inp, out,
        apply(n, v) { sm(lvl.gain, v, ctx); },
        build(body) { statusEl = document.createElement('div'); statusEl.className = 'r-status'; body.appendChild(statusEl); status('empty'); },
        press(name) {
          const t = ctx.currentTime;
          if (name === 'REC') {
            if (state === 'empty' || state === 'stopped' && len === 0) {
              fb.gain.setValueAtTime(0, t); loopOut.gain.setValueAtTime(0, t);
              tape.delayTime.setValueAtTime(179, t);
              recGate.gain.setValueAtTime(1, t);
              t0 = t; len = 0; status('recording');
            } else if (state === 'recording') {
              len = Math.min(178, t - t0);
              tape.delayTime.setValueAtTime(len, t);
              fb.gain.setValueAtTime(1, t);
              recGate.gain.setValueAtTime(0, t);
              loopOut.gain.setValueAtTime(1, t);
              status('playing');
            } else if (state === 'stopped') {
              loopOut.gain.setValueAtTime(1, t); status('playing');
            }
          } else if (name === 'DUB' && (state === 'playing' || state === 'overdub')) {
            const on = state !== 'overdub';
            recGate.gain.setValueAtTime(on ? 1 : 0, t);
            status(on ? 'overdub' : 'playing');
          } else if (name === 'STOP' && state !== 'empty') {
            recGate.gain.setValueAtTime(0, t);
            if (state === 'recording') { len = Math.min(178, t - t0); tape.delayTime.setValueAtTime(len, t); fb.gain.setValueAtTime(1, t); }
            loopOut.gain.setValueAtTime(0, t);
            status('stopped');
          } else if (name === 'CLEAR') {
            recGate.gain.setValueAtTime(0, t); fb.gain.setValueAtTime(0, t); loopOut.gain.setValueAtTime(0, t);
            len = 0; status('empty');
          }
        },
      };
    },
  },
};

export class Rack {
  constructor(ctx, input, output, reg) {
    this.ctx = ctx;
    this.input = input;
    this.output = output;
    this.reg = reg;
    this.slots = [];
    this.uid = 1;
    this.onChange = () => {};
    this.wire();
  }

  add(type, saved) {
    const def = RACK_MODULES[type];
    if (!def) return null;
    const ctx = this.ctx;
    const id = saved?.id ?? `r${this.uid++}`;
    const n = Number(id.slice(1));
    if (n >= this.uid) this.uid = n + 1;
    const slot = { id, type, def, in: ctx.createGain(), out: ctx.createGain(), dry: ctx.createGain(), wet: ctx.createGain() };
    const h = { param: (name) => this.reg.get(`${id}.${name}`) };
    slot.h = h;
    slot.mod = def.make(ctx, h);
    slot.in.connect(slot.dry); slot.dry.connect(slot.out);
    slot.in.connect(slot.mod.in); slot.mod.out.connect(slot.wet); slot.wet.connect(slot.out);

    const pdefs = { ...def.params, on: { label: 'ON', def: 1, step: 1, morph: false } };
    if (!def.noMix) pdefs.mix = { label: 'MIX', def: 1, unit: '%' };
    for (const [name, spec] of Object.entries(pdefs)) {
      const pid = `${id}.${name}`;
      this.reg.define(pid, {
        ...spec,
        apply: (v) => {
          if (name === 'on' || name === 'mix') this.applyMix(slot);
          else slot.mod.apply?.(name, v);
        },
      });
      const v = saved?.params?.[name];
      if (v !== undefined) this.reg.set(pid, v, 'load'); else this.reg.param(pid).apply(this.reg.get(pid));
    }
    this.applyMix(slot);
    this.slots.push(slot);
    this.wire();
    this.onChange();
    return slot;
  }

  applyMix(slot) {
    const on = this.reg.get(`${slot.id}.on`) >= 0.5;
    const mix = slot.def.noMix ? 1 : this.reg.get(`${slot.id}.mix`) ?? 1;
    const t = this.ctx.currentTime;
    slot.dry.gain.setTargetAtTime(on ? (slot.def.noMix ? 0 : 1 - mix) : 1, t, 0.02);
    slot.wet.gain.setTargetAtTime(on ? mix : 0, t, 0.02);
  }

  remove(id) {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = this.slots.splice(i, 1);
    this.wire();
    try { s.out.disconnect(); s.mod.destroy?.(); } catch { /* best effort */ }
    for (const name of [...Object.keys(s.def.params), 'on', 'mix']) this.reg.params.delete(`${id}.${name}`);
    this.onChange();
  }

  move(id, dir) {
    const i = this.slots.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.slots.length) return;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this.wire();
    this.onChange();
  }

  wire() {
    try { this.input.disconnect(); } catch { /* fresh */ }
    for (const s of this.slots) { try { s.out.disconnect(); } catch { /* fresh */ } }
    let node = this.input;
    for (const s of this.slots) { node.connect(s.in); node = s.out; }
    node.connect(this.output);
  }

  save() {
    return this.slots.map((s) => ({
      id: s.id, type: s.type,
      params: Object.fromEntries([...Object.keys(s.def.params), 'on', 'mix'].filter((k) => this.reg.param(`${s.id}.${k}`)).map((k) => [k, this.reg.get(`${s.id}.${k}`)])),
    }));
  }

  clear() { for (const s of [...this.slots]) this.remove(s.id); }
}
