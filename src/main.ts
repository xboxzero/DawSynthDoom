import { Registry, type ParamSpec } from './params';
import { knob, fader, toggle, button, segments, drawMeter, el } from './ui';
import { Engine, WETS, EQ_BANDS, PRE_BANDS, MOD_TYPES, IR_TYPES, INPUT_CHANNELS, faderGain, isTouchDevice, describeInputError, type BassReport, type WetId } from './engine';
import { LFO_SHAPES, LFO_DESTS } from './dsp-params';
import { EqEditor, type BandDef } from './eq';
import { Spectrum3D, KINDS } from './spectrum3d';
import { Pad3D } from './pad3d';
import { QubitChaos } from './chaos';
import { RACK_MODULES } from './rack';
import { Tone3000, redirectUri, type T3kModel, type T3kTone } from './tone3000';
import { NOTE_NAMES, SCALES, TEMPERAMENTS, noteName } from './temperament';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => {
  const e = document.querySelector<T>(s);
  if (!e) throw new Error(`missing ${s}`);
  return e;
};

const STATE_KEY = 'dsd.state.v4';
const STARTER = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/refs/heads/main/ui/public/';
const touch = isTouchDevice();

const reg = new Registry();
const engine = new Engine(reg);
const chaos = new QubitChaos();
const t3k = new Tone3000();
let pendingRack: { id: string; type: string; params: Record<string, number> }[] | null = null;

function toast(text: string, kind: '' | 'warn' | 'err' = ''): void {
  const t = el('div', `toast ${kind}`, $('#toasts'));
  t.textContent = text;
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

const fmtFader = (v: number): string => { const g = faderGain(v); return g <= 0 ? '-∞' : (g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1); };
const fmtPan = (v: number): string => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
const live = (fn: (v: number) => void) => (v: number): void => { if (engine.started) fn(v); };
const D = (spec: ParamSpec & { id: string }): void => { reg.define(spec.id, spec); };

// ───────────────────────── parameters ─────────────────────────
const PAD_TARGETS: readonly { label: string; id: string | null }[] = [
  { label: 'NONE', id: null },
  { label: 'CUTOFF', id: 'bass.cutoff' }, { label: 'RESO', id: 'bass.reso' }, { label: 'DRIVE', id: 'bass.drive' },
  { label: 'FOLD', id: 'bass.fold' }, { label: 'SHAPE', id: 'bass.shape' }, { label: 'SUB', id: 'bass.sub' },
  { label: 'ENV MOD', id: 'bass.env' }, { label: 'SPACE', id: 'wdw.wet' }, { label: 'DELAY', id: 'dly.send' },
  { label: 'REVERB', id: 'rev.send' }, { label: 'MOD', id: 'mod.send' }, { label: 'WIDTH', id: 'wdw.width' },
  { label: 'DLY TIME', id: 'dly.time' }, { label: 'GLIDE', id: 'tune.glide' },
  { label: 'LFO1 DEPTH', id: 'lfo1.depth' }, { label: 'LFO1 RATE', id: 'lfo1.rate' }, { label: 'LFO2 DEPTH', id: 'lfo2.depth' },
  { label: 'MOD RATE', id: 'mod.rate' }, { label: 'MOD DEPTH', id: 'mod.depth' }, { label: 'IR MIX', id: 'ir.mix' },
];
const padLabels = PAD_TARGETS.map((t) => t.label);

function defineParams(): void {
  const bass = (name: string) => live((v) => engine.setBass(name, v));
  D({ id: 'in.trim', label: 'INPUT', min: -24, max: 24, def: 0, unit: 'dB', apply: live((v) => engine.inTrim.gain.setTargetAtTime(10 ** (v / 20), engine.ctx.currentTime, 0.02)) });
  D({ id: 'in.ch', label: 'CHANNEL', min: 0, max: INPUT_CHANNELS.length - 1, def: 0, step: 1, options: INPUT_CHANNELS, apply: live((v) => engine.applyChannel(v)) });
  D({ id: 'safe.on', label: 'PHONE SAFE', def: touch ? 1 : 0, step: 1, apply: live((v) => { engine.setSafe(v >= 0.5); void reopenInput(); }) });
  D({ id: 'sys.low', label: 'LOWEST LATENCY', def: 1, step: 1 });
  D({ id: 'bass.gate', label: 'GATE', min: -80, max: -20, def: -54, unit: 'dB', apply: live((v) => engine.setBass('gateThresh', 10 ** (v / 20))) });
  D({ id: 'bass.sens', label: 'SENS', min: 0.5, max: 20, def: 6, scale: 'log', apply: bass('sens') });
  D({ id: 'in.auto', label: 'AUTO CHANNEL', def: 1, step: 1 });

  D({ id: 'tune.key', label: 'KEY', min: 0, max: 11, def: 0, step: 1, options: NOTE_NAMES, apply: bass('key') });
  D({ id: 'tune.scale', label: 'SCALE', min: 0, max: SCALES.length - 1, def: 2, step: 1, options: SCALES.map((s) => s.name), apply: bass('scale') });
  D({ id: 'tune.temper', label: 'TEMPERAMENT', min: 0, max: TEMPERAMENTS.length - 1, def: 1, step: 1, options: TEMPERAMENTS.map((t) => t.name), apply: bass('temper') });
  D({ id: 'tune.ref', label: 'A4 REF', min: 415, max: 466, def: 440, step: 0.5, format: (v) => v.toFixed(1) + 'Hz', apply: bass('ref') });
  D({ id: 'tune.quant', label: 'SNAP', def: 1, unit: '%', apply: bass('quant') });
  D({ id: 'tune.glide', label: 'GLIDE', min: 0, max: 600, def: 12, unit: 'ms', apply: bass('glide') });
  D({ id: 'tune.octave', label: 'OCTAVE', min: -3, max: 1, def: -1, step: 1, format: (v) => (v > 0 ? '+' : '') + v, apply: bass('octave') });
  D({ id: 'tune.range', label: 'BASS RANGE', def: 1, step: 1, apply: bass('range') });

  D({ id: 'bass.shape', label: 'SHAPE', def: 0.2, format: (v) => (v < 0.5 ? (v < 0.05 ? 'SAW' : 'SAW→SQ') : v < 0.55 ? 'SQUARE' : 'PULSE'), apply: bass('shape') });
  D({ id: 'bass.sub', label: 'SUB', def: 0.5, unit: '%', apply: bass('sub') });
  D({ id: 'bass.noise', label: 'GRIT', max: 0.5, def: 0, unit: '%', apply: bass('noise') });
  D({ id: 'bass.fold', label: 'FOLD', def: 0, unit: '%', apply: bass('fold') });
  D({ id: 'bass.cutoff', label: 'CUTOFF', min: 30, max: 12000, def: 380, scale: 'log', unit: 'Hz', apply: bass('cutoff') });
  D({ id: 'bass.reso', label: 'RESO', def: 0.35, unit: '%', apply: bass('reso') });
  D({ id: 'bass.env', label: 'ENV MOD', def: 0.5, unit: '%', apply: bass('envAmt') });
  D({ id: 'bass.drive', label: 'DRIVE', def: 0.25, unit: '%', apply: bass('drive') });
  D({ id: 'bass.attack', label: 'ATTACK', min: 0.5, max: 200, def: 3, scale: 'log', unit: 'ms', apply: bass('attack') });
  D({ id: 'bass.release', label: 'RELEASE', min: 5, max: 2000, def: 120, scale: 'log', unit: 'ms', apply: bass('release') });
  D({ id: 'bass.level', label: 'LEVEL', max: 1.5, def: 0.8, unit: '%', apply: bass('level') });
  // DIRECT: your input itself, always audible even when the bass voice can't find a pitch
  D({ id: 'bass.blend', label: 'DIRECT', def: 0.35, unit: '%', apply: bass('blend') });

  const amp = live(() => engine.applyAmpRouting());
  D({ id: 'amp.on', label: 'NAM AMP', def: 0, step: 1, apply: amp });
  D({ id: 'amp.gain', label: 'AMP GAIN', min: -24, max: 24, def: 0, unit: 'dB', apply: live((v) => engine.setAmpGain(v)) });
  D({ id: 'amp.out', label: 'AMP OUT', min: -24, max: 12, def: 0, unit: 'dB', apply: live((v) => engine.ampLevel.gain.setTargetAtTime(10 ** (v / 20), engine.ctx.currentTime, 0.02)) });
  D({ id: 'amp.cab', label: 'CAB IR', def: 1, step: 1, apply: amp });
  D({ id: 'amp.norm', label: 'NORMALIZE', def: 1, step: 1, apply: amp });

  D({ id: 'wdw.dry', label: 'DRY', def: 0.79, format: fmtFader, apply: live((v) => engine.dryGain.gain.setTargetAtTime(faderGain(v), engine.ctx.currentTime, 0.015)) });
  D({ id: 'wdw.pos', label: 'DRY POS', min: -1, max: 1, def: 0, format: fmtPan, apply: live((v) => engine.dryPan.pan.setTargetAtTime(v, engine.ctx.currentTime, 0.02)) });
  D({ id: 'wdw.wet', label: 'WET', def: 0.62, format: fmtFader, apply: live((v) => engine.wetGain.gain.setTargetAtTime(faderGain(v), engine.ctx.currentTime, 0.015)) });
  D({ id: 'wdw.width', label: 'WIDTH', min: 0, max: 2, def: 1.3, format: (v) => Math.round(v * 100) + '%', apply: live(() => engine.applyWidth()) });
  D({ id: 'wdw.mode', label: 'W/D/W', def: 1, step: 1, apply: live(() => engine.applyWidth()) });
  const sends: Record<WetId, number> = { dly: 0.5, rev: 0.5, mod: 0.35, dbl: 0 };
  for (const w of WETS) {
    D({ id: `${w.id}.send`, label: 'SEND', def: sends[w.id], format: fmtFader, apply: live((v) => engine.setWetSend(w.id, v)) });
    D({ id: `${w.id}.mute`, label: 'MUTE', def: 0, step: 1, apply: live((v) => engine.setWetMute(w.id, v >= 0.5)) });
  }
  D({ id: 'dly.time', label: 'TIME', min: 0.05, max: 1.5, def: 0.38, scale: 'log', unit: 's', apply: live(() => engine.applyDelayTime()) });
  D({ id: 'dly.fb', label: 'REPEATS', max: 0.85, def: 0.3, unit: '%', apply: live((v) => engine.setDelayFeedback(v)) });
  D({ id: 'dly.tone', label: 'TONE', min: 500, max: 12000, def: 3000, scale: 'log', unit: 'Hz', apply: live((v) => engine.setTone('dly', v)) });
  D({ id: 'dly.spread', label: 'SPREAD', def: 0.3, unit: '%', apply: live(() => engine.applyDelayTime()) });
  D({ id: 'rev.size', label: 'SIZE', min: 0.4, max: 8, def: 2.2, scale: 'log', unit: 's', apply: live(() => engine.regenReverb()) });
  D({ id: 'rev.pre', label: 'PRE-DLY', min: 0, max: 0.2, def: 0.03, unit: 's', apply: live((v) => engine.setReverbPre(v)) });
  D({ id: 'rev.tone', label: 'TONE', min: 800, max: 14000, def: 5000, scale: 'log', unit: 'Hz', apply: live((v) => engine.setTone('rev', v)) });
  const mod = live(() => engine.setMod());
  D({ id: 'mod.type', label: 'TYPE', min: 0, max: MOD_TYPES.length - 1, def: 0, step: 1, options: MOD_TYPES, apply: mod });
  D({ id: 'mod.rate', label: 'RATE', min: 0.05, max: 12, def: 0.6, scale: 'log', format: (v) => v.toFixed(2) + 'Hz', apply: mod });
  D({ id: 'mod.depth', label: 'DEPTH', def: 0.5, unit: '%', apply: mod });
  D({ id: 'mod.fb', label: 'FEEDBACK', max: 0.9, def: 0.4, unit: '%', apply: mod });
  D({ id: 'mod.shape', label: 'LFO', min: 0, max: 3, def: 0, step: 1, options: ['SINE', 'TRI', 'SQUARE', 'SAW'], apply: mod });
  D({ id: 'mod.spread', label: 'SPREAD', def: 1, unit: '%', apply: mod });
  D({ id: 'mod.ring', label: 'RING HZ', min: 20, max: 2000, def: 220, scale: 'log', unit: 'Hz', apply: mod });
  D({ id: 'mod.tone', label: 'TONE', min: 800, max: 16000, def: 9000, scale: 'log', unit: 'Hz', apply: mod });

  // pre-amp EQ (between the bass voice and the amp)
  D({ id: 'pre.on', label: 'PRE EQ', def: 1, step: 1, apply: () => applyPre() });
  D({ id: 'pre.hp', label: 'LOW CUT', min: 10, max: 300, def: 25, scale: 'log', unit: 'Hz', apply: () => applyPre() });
  PRE_BANDS.forEach((b, i) => {
    D({ id: `pre.${i}.f`, label: 'FREQ', min: 20, max: 20000, def: b.f, scale: 'log', unit: 'Hz', apply: () => applyPre(i) });
    D({ id: `pre.${i}.g`, label: 'GAIN', min: -18, max: 18, def: 0, unit: 'dB', apply: () => applyPre(i) });
    D({ id: `pre.${i}.q`, label: 'Q', min: 0.3, max: 10, def: b.q, scale: 'log', apply: () => applyPre(i) });
  });

  // modulation matrix: two LFOs on the bass voice (runs inside the C++ DSP)
  D({ id: 'tempo.bpm', label: 'BPM', min: 40, max: 240, def: 120, step: 1, format: (v) => String(v), apply: () => { applyLfoRate(1); applyLfoRate(2); } });
  D({ id: 'lfo.retrig', label: 'RETRIG', def: 0, step: 1, apply: bass('lfoRetrig') });
  const lfoDefs: Record<number, { rate: number; dest: number; depth: number }> = { 1: { rate: 2, dest: 1, depth: 0 }, 2: { rate: 0.3, dest: 4, depth: 0 } };
  for (const n of [1, 2]) {
    const d = lfoDefs[n];
    D({ id: `lfo${n}.rate`, label: 'RATE', min: 0.02, max: 30, def: d.rate, scale: 'log', format: (v) => v.toFixed(2) + 'Hz', apply: () => applyLfoRate(n) });
    D({ id: `lfo${n}.sync`, label: 'SYNC', def: 0, step: 1, apply: () => applyLfoRate(n) });
    D({ id: `lfo${n}.div`, label: 'DIVISION', min: 0, max: LFO_DIVS.length - 1, def: 3, step: 1, options: LFO_DIVS.map((x) => x[0]), apply: () => applyLfoRate(n) });
    D({ id: `lfo${n}.shape`, label: 'SHAPE', min: 0, max: LFO_SHAPES.length - 1, def: 0, step: 1, options: LFO_SHAPES, apply: bass(`l${n}Shape`) });
    D({ id: `lfo${n}.depth`, label: 'DEPTH', def: d.depth, unit: '%', apply: bass(`l${n}Depth`) });
    D({ id: `lfo${n}.dest`, label: 'TARGET', min: 0, max: LFO_DESTS.length - 1, def: d.dest, step: 1, options: LFO_DESTS, apply: bass(`l${n}Dest`) });
  }

  // IR sim at the end of the chain
  const ir = live(() => engine.applyIR());
  D({ id: 'ir.on', label: 'IR SIM', def: 0, step: 1, apply: ir });
  D({ id: 'ir.type', label: 'TYPE', min: 0, max: IR_TYPES.length - 1, def: 0, step: 1, options: IR_TYPES, apply: live(() => { engine.useBuiltInIR(); }) });
  D({ id: 'ir.mix', label: 'MIX', def: 0.3, unit: '%', apply: ir });
  D({ id: 'ir.lo', label: 'LOW CUT', min: 20, max: 600, def: 60, scale: 'log', unit: 'Hz', apply: ir });
  D({ id: 'ir.hi', label: 'HIGH CUT', min: 1000, max: 20000, def: 12000, scale: 'log', unit: 'Hz', apply: ir });
  D({ id: 'ir.gain', label: 'LEVEL', min: -24, max: 12, def: 0, unit: 'dB', apply: ir });
  D({ id: 'dbl.time', label: 'SPREAD', min: 0.006, max: 0.045, def: 0.018, unit: 's', apply: live(() => engine.setDoubler()) });

  const padApply = (axis: 'x' | 'y' | 'z') => (v: number): void => {
    const t = PAD_TARGETS[Math.round(reg.get(`pad.t${axis}`))]?.id;
    if (t && reg.has(t)) reg.set(t, reg.param(t).fromNorm(v), 'pad');
  };
  D({ id: 'pad.x', label: 'X', def: 0.35, apply: padApply('x') });
  D({ id: 'pad.y', label: 'Y', def: 0.2, apply: padApply('y') });
  D({ id: 'pad.z', label: 'Z', def: 0.55, apply: padApply('z') });
  D({ id: 'pad.tx', label: 'X AXIS', min: 0, max: PAD_TARGETS.length - 1, def: 1, step: 1, options: padLabels, apply: () => padApply('x')(reg.get('pad.x')) });
  D({ id: 'pad.ty', label: 'Y AXIS', min: 0, max: PAD_TARGETS.length - 1, def: 4, step: 1, options: padLabels, apply: () => padApply('y')(reg.get('pad.y')) });
  D({ id: 'pad.tz', label: 'Z AXIS', min: 0, max: PAD_TARGETS.length - 1, def: 8, step: 1, options: padLabels, apply: () => padApply('z')(reg.get('pad.z')) });
  D({ id: 'pad.mode', label: 'MOTION', min: 0, max: 2, def: 0, step: 1, options: ['HOLD', 'ORBIT', 'QUBIT'], apply: () => { motionCenter = null; } });
  D({ id: 'pad.speed', label: 'SPEED', min: 0.02, max: 3, def: 0.2, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' });
  D({ id: 'pad.size', label: 'SIZE', max: 0.5, def: 0.25, unit: '%' });
  D({ id: 'pad.spin', label: 'SPIN VIEW', def: 1, step: 1 });
  D({ id: 'chaos.entropy', label: 'ENTROPY', def: 0.35, unit: '%' });
  D({ id: 'chaos.entangle', label: 'ENTANGLE', def: 0.5, unit: '%' });
  D({ id: 'chaos.glide', label: 'GLIDE', min: 0.02, max: 3, def: 0.35, scale: 'log', unit: 's' });

  D({ id: 'eq.on', label: 'EQ', def: 1, step: 1, apply: () => applyEq() });
  EQ_BANDS.forEach((b, i) => {
    D({ id: `eq.${i}.f`, label: 'FREQ', min: 20, max: 20000, def: b.f, scale: 'log', unit: 'Hz', apply: () => applyEq(i) });
    D({ id: `eq.${i}.g`, label: 'GAIN', min: -18, max: 18, def: 0, unit: 'dB', apply: () => applyEq(i) });
    D({ id: `eq.${i}.q`, label: 'Q', min: 0.3, max: 10, def: b.q, scale: 'log', apply: () => applyEq(i) });
  });
  D({ id: 'master.comp', label: 'GLUE', def: 0.25, unit: '%', apply: live((v) => engine.setComp(v)) });
  D({ id: 'guard.on', label: 'FB GUARD', def: 1, step: 1 });
  D({ id: 'guard.sens', label: 'SENSE', def: 0.5, unit: '%' });
  D({ id: 'master.vol', label: 'MASTER', def: 0.62, format: fmtFader, apply: live((v) => engine.master.gain.setTargetAtTime(faderGain(v), engine.ctx.currentTime, 0.015)) });
  D({ id: 'master.mon', label: 'MONITOR', def: 0, step: 1, persist: false, apply: live((v) => engine.monitor.gain.setTargetAtTime(v >= 0.5 ? 1 : 0, engine.ctx.currentTime, 0.01)) });
}

// tempo divisions in beats: [label, beats]
const LFO_DIVS: readonly [string, number][] = [['1/1', 4], ['1/2', 2], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/4.', 1.5], ['1/8.', 0.75], ['1/4T', 2 / 3], ['1/8T', 1 / 3]];

function applyLfoRate(n: number): void {
  if (!engine.started || !reg.has(`lfo${n}.rate`)) return;
  const hz = reg.on(`lfo${n}.sync`)
    ? reg.get('tempo.bpm') / 60 / (LFO_DIVS[Math.round(reg.get(`lfo${n}.div`))]?.[1] ?? 1)
    : reg.get(`lfo${n}.rate`);
  engine.setBass(`l${n}Rate`, hz);
}

function applyPre(only?: number): void {
  if (!engine.started) return;
  const on = reg.on('pre.on');
  PRE_BANDS.forEach((_, i) => {
    if (only === undefined || only === i) engine.setPre(i, on, reg.get(`pre.${i}.f`), reg.get(`pre.${i}.g`), reg.get(`pre.${i}.q`));
  });
  engine.setPreLowCut(on, reg.get('pre.hp'));
}

function applyEq(only?: number): void {
  if (!engine.started) return;
  EQ_BANDS.forEach((_, i) => {
    if (only === undefined || only === i) engine.setEq(i, reg.on('eq.on'), reg.get(`eq.${i}.f`), reg.get(`eq.${i}.g`), reg.get(`eq.${i}.q`));
  });
}

// ───────────────────────── panels ─────────────────────────
interface Meter { canvas: HTMLCanvasElement; analyser: () => AnalyserNode | undefined; hold: number; t: number }
const meters: Meter[] = [];
const addMeter = (canvas: HTMLCanvasElement, analyser: () => AnalyserNode | undefined): void => { meters.push({ canvas, analyser, hold: 0, t: 0 }); };

function head(host: HTMLElement, title: string, hint?: string): HTMLElement {
  const h = el('div', 'panel-head', host);
  el('h2', '', h).textContent = title;
  if (hint) el('span', 'hint', h).textContent = hint;
  return h;
}
const knobs = (host: HTMLElement, ids: string[]): HTMLElement => {
  const g = el('div', 'k-grid', host);
  for (const id of ids) knob(g, reg, id);
  return g;
};

function buildInput(): void {
  const host = $('#input');
  const h = head(host, 'INPUT');
  toggle(h, reg, 'safe.on', { text: 'PHONE SAFE', title: 'Echo cancellation + output cap for phones without headphones' });
  const row = el('div', 'p-row', host);
  knobs(row, ['in.trim', 'bass.blend', 'bass.gate', 'bass.sens']);
  addMeter(el('canvas', 'v-meter', row), () => engine.inAnalyser);
  segments(host, reg, 'in.ch');
  // one live meter per physical input: shows which channel your instrument is on
  const cm = el('div', 'ch-meters', host);
  cm.id = 'chMeters';
  INPUT_CHANNELS.slice(0, 4).forEach((label, i) => {
    const c = el('div', 'ch', cm);
    el('i', '', c);
    el('span', '', c).textContent = label;
    c.addEventListener('click', () => reg.set('in.ch', i));
  });
  toggle(host, reg, 'in.auto', { text: 'AUTO CHANNEL', cls: 'small', title: 'Switch to the input that has signal' });
  const st = el('div', 'in-status', host);
  st.id = 'inStatus';
  st.textContent = 'Press START, then allow audio input.';
  const b = el('div', 'p-btns', host);
  button(b, 'RETRY INPUT', () => void retryInput(), 'small').id = 'retryBtn';
  toggle(b, reg, 'sys.low', { text: 'LOWEST LATENCY', title: 'Smallest audio buffer (applies on next start)' });
  el('span', 'gate-led', b).id = 'gateLed';
}

let preEq: EqEditor;
function eqPanel(host: HTMLElement, prefix: string, bands: readonly BandDef[], onId: string, extra: string[]): EqEditor {
  const canvas = el('canvas', 'eq-canvas', host);
  const tabs = el('div', 'eq-bands', host);
  const kr = el('div', 'eq-knobs', host);
  let ed: EqEditor | null = null;
  const tabBtns = bands.map((_, i) => button(tabs, String(i + 1), () => ed?.select(i), 'band'));
  const show = (i: number): void => {
    tabBtns.forEach((b, k) => b.classList.toggle('on', k === i));
    kr.innerHTML = '';
    for (const k of ['f', 'g', 'q']) knob(kr, reg, `${prefix}.${i}.${k}`);
    for (const id of extra) knob(kr, reg, id);
  };
  ed = new EqEditor(canvas, reg, { prefix, bands, onId, onSelect: show });
  show(0);
  return ed;
}

function buildPreEq(): void {
  const host = $('#preeq');
  const h = head(host, 'PRE-AMP EQ');
  toggle(h, reg, 'pre.on', { text: 'ON', cls: 'small' });
  button(h, 'FLAT', () => PRE_BANDS.forEach((b, i) => { reg.set(`pre.${i}.g`, 0); reg.set(`pre.${i}.f`, b.f); reg.set(`pre.${i}.q`, b.q); }), 'ghost small');
  preEq = eqPanel(host, 'pre', PRE_BANDS, 'pre.on', ['pre.hp']);
}

function buildLfos(): void {
  const host = $('#lfos');
  const h = head(host, 'MODULATION', 'two LFOs on the bass voice');
  toggle(h, reg, 'lfo.retrig', { text: 'RETRIG ON NOTE', cls: 'small' });
  knob(h, reg, 'tempo.bpm');
  for (const n of [1, 2]) {
    const card = el('div', 'lfo-card', host);
    const ch = el('div', 'lfo-head', card);
    el('span', 's-name', ch).textContent = `LFO ${n}`;
    const bar = el('div', 'lfo-bar', ch);
    el('i', '', bar).id = `lfo${n}Bar`;
    toggle(ch, reg, `lfo${n}.sync`, { text: 'SYNC', cls: 'small' });
    knobs(card, [`lfo${n}.rate`, `lfo${n}.div`, `lfo${n}.depth`]);
    el('div', 'l-title', card).textContent = 'SHAPE';
    segments(card, reg, `lfo${n}.shape`);
    el('div', 'l-title', card).textContent = 'TARGET';
    segments(card, reg, `lfo${n}.dest`);
  }
}

function buildIrSim(): void {
  const host = $('#irsim');
  host.innerHTML = '';
  const h = head(host, 'IR SIM', 'last effect before the master');
  toggle(h, reg, 'ir.on', { text: 'ON', cls: 'small' });
  segments(host, reg, 'ir.type');
  knobs(host, ['ir.mix', 'ir.lo', 'ir.hi', 'ir.gain']);
  loader(host, 'IMPULSE RESPONSE', engine.started ? engine.irName : IR_TYPES[Math.round(reg.get('ir.type'))], '.wav,.aif,.aiff,.flac', 'ir', []);
  const b = el('div', 'p-btns', host);
  button(b, 'TONE3000 IR', () => openT3k(), 'small');
  button(b, 'BUILT-IN', () => { if (engine.started) { engine.useBuiltInIR(); } }, 'ghost small');
}

function buildTuning(): void {
  const host = $('#tuning');
  const h = head(host, 'WELL TEMPERED');
  toggle(h, reg, 'tune.range', { text: 'BASS RANGE', title: 'Fold every note into E1 – D#3' });
  const t = el('div', 'tuner', host);
  t.innerHTML = '<div class="t-note" id="tNote">—</div><div class="t-scale"><i id="tNeedle"></i><b></b></div><div class="t-info" id="tInfo">play your synth</div>';
  segments(host, reg, 'tune.temper');
  knobs(host, ['tune.key', 'tune.scale', 'tune.ref', 'tune.octave', 'tune.quant', 'tune.glide']);
}

function buildVoice(): void {
  const host = $('#voice');
  head(host, 'BASS VOICE', 'follows your synth');
  knobs(host, ['bass.shape', 'bass.sub', 'bass.fold', 'bass.noise', 'bass.cutoff', 'bass.reso', 'bass.env', 'bass.drive', 'bass.attack', 'bass.release', 'bass.level']);
}

function buildAmp(): void {
  const host = $('#amp');
  host.innerHTML = '';
  const h = head(host, 'BASS AMP');
  toggle(h, reg, 'amp.on', { text: 'NAM ON' });
  knobs(host, ['amp.gain', 'amp.out']);
  const b = el('div', 'p-btns', host);
  toggle(b, reg, 'amp.cab', { text: 'CAB IR' });
  toggle(b, reg, 'amp.norm', { text: 'NORMALIZE' });
  loader(host, 'NAM MODEL', engine.nam.loaded ? engine.nam.name : 'none — the synth bass goes straight through', '.nam', 'nam', [
    ['Vox AC10', STARTER + 'models/ac10.nam'], ['Deluxe', STARTER + 'models/deluxe.nam'],
  ]);
  loader(host, 'CAB IR', engine.cab.name, '.wav,.aif,.aiff,.flac', 'cab', []);
  const tb = el('div', 'p-btns', host);
  button(tb, 'TONE3000', () => openT3k());
  if (engine.nam.loaded) button(tb, 'UNLOAD', async () => { await engine.unloadNam(); buildAmp(); }, 'ghost');
  el('p', 'hint', host).textContent = 'Tip: search TONE3000 for bass amp captures (SVT, B-15, Darkglass).';
}

type Target = 'nam' | 'cab' | 'rev' | 'ir';
function loader(host: HTMLElement, title: string, current: string, accept: string, target: Target, starters: [string, string][]): void {
  const box = el('div', 'loader', host);
  el('div', 'l-title', box).textContent = title;
  el('div', 'l-name', box).textContent = current;
  const row = el('div', 'p-btns', box);
  const input = el('input', '', row);
  input.type = 'file'; input.accept = accept; input.hidden = true;
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void loadFile(f, target); input.value = ''; });
  button(row, 'LOAD', () => input.click(), 'small');
  for (const [name, url] of starters) button(row, name, () => void loadUrl(url, name, target), 'ghost small');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop'); const f = e.dataTransfer?.files[0]; if (f) void loadFile(f, target); });
}

let pad: Pad3D;
function buildPad(): void {
  const host = $('#pad');
  const h = head(host, '3D FX PAD');
  toggle(h, reg, 'pad.spin', { text: 'SPIN', cls: 'small' });
  const wrap = el('div', 'pad-wrap', host);
  const canvas = el('canvas', 'pad-canvas', wrap);
  const zc = el('div', 'pad-z', wrap);
  const f = fader(zc, reg, 'pad.z');
  f.canvas.remove();
  el('div', 'k-label', zc).textContent = 'Z';
  pad = new Pad3D(canvas, reg, () => [reg.param('pad.tx').format(), reg.param('pad.ty').format(), reg.param('pad.tz').format()]);
  const axes = el('div', 'k-grid', host);
  for (const id of ['pad.tx', 'pad.ty', 'pad.tz']) knob(axes, reg, id);
  el('div', 'l-title', host).textContent = 'MOTION';
  segments(host, reg, 'pad.mode');
  knobs(host, ['pad.speed', 'pad.size', 'chaos.entropy', 'chaos.entangle', 'chaos.glide']);
  el('p', 'hint', host).textContent = 'Drag in the cube for X/Y. Z: fader, wheel or two-finger pinch. ORBIT loops a 3D path; QUBIT lets a simulated quantum state steer the point.';
}

const WET_KNOBS: Record<WetId, string[]> = { dly: ['dly.time', 'dly.fb', 'dly.tone', 'dly.spread'], rev: ['rev.size', 'rev.pre', 'rev.tone'], mod: ['mod.rate', 'mod.depth', 'mod.fb', 'mod.shape', 'mod.spread', 'mod.ring', 'mod.tone'], dbl: ['dbl.time'] };

function buildWdw(): void {
  const host = $('#wdwGrid');
  const left = el('div', 'wdw-side', host), center = el('div', 'wdw-center', host), right = el('div', 'wdw-side', host);
  for (const w of WETS) {
    const s = el('div', 'strip', w.side === 'L' ? left : right);
    const hd = el('div', 's-head', s);
    el('span', 's-name', hd).textContent = w.name;
    el('span', 's-sub', hd).textContent = `WET · ${w.side}`;
    if (w.id === 'mod') segments(s, reg, 'mod.type');
    const k = el('div', 's-knobs', s);
    for (const id of WET_KNOBS[w.id]) knob(k, reg, id);
    if (w.id === 'rev') loader(s, 'IR', engine.revIR.name, '.wav,.aif,.aiff,.flac', 'rev', [['Plate', STARTER + 'irs/plate.wav']]);
    const fb = el('div', 's-bottom', s);
    const f = fader(fb, reg, `${w.id}.send`);
    addMeter(f.canvas, () => engine.wet[w.id]?.meter);
    toggle(s, reg, `${w.id}.mute`, { text: 'MUTE', cls: 'small' });
  }
  const dry = el('div', 'strip dry', center);
  const dh = el('div', 's-head', dry);
  el('span', 's-name', dh).textContent = 'DRY';
  el('span', 's-sub', dh).textContent = 'MONO · CENTRE';
  const df = fader(el('div', 's-bottom', dry), reg, 'wdw.dry');
  addMeter(df.canvas, () => engine.dryAnalyser);
  knob(dry, reg, 'wdw.pos');
  const wm = el('div', 'strip', center);
  const wh = el('div', 's-head', wm);
  el('span', 's-name', wh).textContent = 'WET';
  el('span', 's-sub', wh).textContent = 'STEREO';
  const wf = fader(el('div', 's-bottom', wm), reg, 'wdw.wet');
  addMeter(wf.canvas, () => engine.wetAnalyser);
  knob(wm, reg, 'wdw.width');
  toggle(wm, reg, 'wdw.mode', { text: 'W/D/W', cls: 'small' });
}

function buildRack(): void {
  const host = $('#rack');
  const h = head(host, 'END RACK', 'gig modules, last in the chain');
  const sel = el('select', '', h);
  sel.setAttribute('aria-label', 'Add module');
  el('option', '', sel).textContent = '+ ADD MODULE';
  sel.options[0].value = '';
  for (const [type, def] of Object.entries(RACK_MODULES)) { const o = el('option', '', sel); o.value = type; o.textContent = def.name; }
  sel.addEventListener('change', async () => {
    const type = sel.value;
    sel.value = '';
    if (type && (await ensureStarted())) engine.rack.add(type);
  });
  el('div', 'rack-slots', host).id = 'rackSlots';
}

function renderRack(): void {
  const host = $('#rackSlots');
  host.innerHTML = '';
  const slots = engine.started ? engine.rack.slots : [];
  if (!slots.length) { el('div', 'hint empty', host).textContent = 'Add a phaser, tremolo, auto filter, bitcrush, stutter or looper.'; return; }
  slots.forEach((s, i) => {
    const card = el('div', 'slot', host);
    const hd = el('div', 'slot-head', card);
    el('span', 's-num', hd).textContent = String(i + 1);
    el('span', 's-name', hd).textContent = s.def.name;
    button(hd, '◀', () => engine.rack.move(s.id, -1), 'ghost tiny');
    button(hd, '▶', () => engine.rack.move(s.id, 1), 'ghost tiny');
    button(hd, '✕', () => engine.rack.remove(s.id), 'ghost tiny');
    toggle(card, reg, `${s.id}.on`, { text: 'ON', cls: 'small' });
    const k = el('div', 's-knobs', card);
    for (const name of Object.keys(s.def.params)) knob(k, reg, `${s.id}.${name}`);
    if (!s.def.noMix) knob(k, reg, `${s.id}.mix`);
    if (s.def.buttons) {
      const b = el('div', 'p-btns', card);
      for (const name of s.def.buttons) { const btn = button(b, name, () => s.mod.press?.(name, btn), 'small'); }
    }
    s.mod.build?.(card);
  });
}

let masterEq: EqEditor;
function buildMaster(): void {
  const host = $('#master');
  head(host, 'MASTER');
  const wrap = el('div', 'm-wrap', host);
  const eqBox = el('div', 'm-eq', wrap);
  const eh = el('div', 'p-btns', eqBox);
  el('span', 'l-title', eh).textContent = 'EQ';
  toggle(eh, reg, 'eq.on', { text: 'ON', cls: 'small' });
  button(eh, 'FLAT', () => EQ_BANDS.forEach((b, i) => { reg.set(`eq.${i}.g`, 0); reg.set(`eq.${i}.f`, b.f); reg.set(`eq.${i}.q`, b.q); }), 'ghost small');
  const canvas = el('canvas', 'eq-canvas', eqBox);
  const tabs = el('div', 'eq-bands', eqBox);
  const kr = el('div', 'eq-knobs', eqBox);
  const tabBtns = EQ_BANDS.map((_, i) => button(tabs, String(i + 1), () => masterEq.select(i), 'band'));
  const show = (i: number): void => {
    tabBtns.forEach((b, k) => b.classList.toggle('on', k === i));
    kr.innerHTML = '';
    for (const k of ['f', 'g', 'q']) knob(kr, reg, `eq.${i}.${k}`);
  };
  masterEq = new EqEditor(canvas, reg, { prefix: 'eq', bands: EQ_BANDS, onId: 'eq.on', onSelect: show });
  show(0);
  const side = el('div', 'm-side', wrap);
  const g = el('div', 'guard', side);
  toggle(el('div', 'p-btns', g), reg, 'guard.on', { text: 'FEEDBACK GUARD' });
  knobs(g, ['guard.sens', 'master.comp']);
  el('div', 'g-list', g).id = 'guardList';
  button(g, 'RESET NOTCHES', () => engine.resetGuard(), 'ghost small');
  const vol = el('div', 'm-vol', side);
  const f = fader(vol, reg, 'master.vol');
  f.root.classList.add('big');
  addMeter(f.canvas, () => engine.outAnalyser);
  toggle(vol, reg, 'master.mon', { text: 'MONITOR', cls: 'mon' });
}

// ───────────────────────── loading ─────────────────────────
async function ensureStarted(): Promise<boolean> {
  if (!engine.started) await startAudio();
  return engine.started;
}

async function loadBytes(bytes: ArrayBuffer, name: string, target: Target): Promise<void> {
  if (!(await ensureStarted())) return;
  try {
    if (target === 'nam') {
      const json = new TextDecoder().decode(bytes);
      JSON.parse(json);
      await engine.loadNam(json, name);
      reg.set('amp.on', 1);
      toast(`Bass amp: ${name}`);
    } else if (target === 'cab') {
      await engine.loadCabIR(bytes, name);
      reg.set('amp.cab', 1);
      toast(`Cab IR: ${name}`);
    } else if (target === 'rev') {
      await engine.loadReverbIR(bytes, name);
      toast(`Reverb IR: ${name}`);
    } else {
      await engine.loadIR(bytes, name);
      reg.set('ir.on', 1);
      toast(`IR sim: ${name}`);
    }
  } catch (err) {
    toast(`Could not load ${name}: ${(err as Error).message}`, 'err');
  }
  buildAmp();
  buildIrSim();
}

async function loadFile(file: File, target: Target): Promise<void> {
  if (target === 'nam' && !/\.nam$/i.test(file.name)) target = 'cab';
  await loadBytes(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''), target);
}

async function loadUrl(url: string, name: string, target: Target): Promise<void> {
  toast(`Downloading ${name}…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    await loadBytes(await res.arrayBuffer(), name, target);
  } catch (err) { toast(`Download failed: ${(err as Error).message}`, 'err'); }
}

// ───────────────────────── devices + start ─────────────────────────
let currentInput: string | undefined;

async function refreshDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const { inputs, outputs } = await engine.listDevices();
  const sel = $<HTMLSelectElement>('#inputSel');
  const cur = sel.value;
  sel.innerHTML = '';
  const add = (v: string, t: string): void => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  inputs.forEach((d, i) => add(d.deviceId, d.label || `Audio input ${i + 1}`));
  add('demo', 'Demo synth line');
  add('file', 'Audio file…');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const out = $<HTMLSelectElement>('#outputSel');
  if ('setSinkId' in AudioContext.prototype) {
    const oc = out.value;
    out.innerHTML = '';
    const o0 = el('option', '', out); o0.value = ''; o0.textContent = 'Default output';
    outputs.filter((d) => d.deviceId !== 'default').forEach((d, i) => { const o = el('option', '', out); o.value = d.deviceId; o.textContent = d.label || `Output ${i + 1}`; });
    if (oc) out.value = oc;
    out.parentElement!.hidden = false;
  }
}

function inputStatus(text: string, error = false): void {
  const st = $('#inStatus');
  st.textContent = text;
  st.classList.toggle('err', error);
}

async function openInput(id: string | undefined): Promise<void> {
  inputStatus('Opening input…');
  let label: string;
  try {
    label = await engine.useDevice(id, reg.on('safe.on'));
  } catch (err) {
    inputStatus(describeInputError(err), true);
    throw err;
  }
  currentInput = id;
  $('#inputName').textContent = label;
  inputStatus(`● ${label || 'audio input'} · ${engine.inputChannels} ch${reg.on('safe.on') ? ' · phone safe' : ''}`);
  if (reg.on('safe.on') && !touch && !/built-?in|internal|default|microphone|mic\b/i.test(label)) {
    toast('This looks like an audio interface: you can turn PHONE SAFE off for the rawest signal.', 'warn');
  }
}

async function reopenInput(): Promise<void> {
  if (!engine.started || currentInput === 'demo' || currentInput === 'file') return;
  try { await openInput(currentInput); } catch (err) { toast(describeInputError(err), 'err'); }
}

async function retryInput(): Promise<void> {
  if (!(await ensureStarted())) return;
  try {
    await openInput(currentInput === 'demo' || currentInput === 'file' ? undefined : currentInput);
    await refreshDevices();
  } catch (err) { toast(describeInputError(err), 'err'); }
}

async function chooseInput(value: string): Promise<void> {
  if (!(await ensureStarted())) return;
  try {
    if (value === 'demo') { engine.useDemo(); currentInput = 'demo'; $('#inputName').textContent = 'Demo synth line'; }
    else if (value === 'file') { $<HTMLInputElement>('#fileInput').click(); }
    else {
      await openInput(value);
      try { localStorage.setItem('dsd.input', value); } catch { /* storage blocked */ }
      await refreshDevices();
      $<HTMLSelectElement>('#inputSel').value = value;
    }
  } catch (err) { toast(describeInputError(err), 'err'); }
}

async function startAudio(): Promise<void> {
  const btn = $<HTMLButtonElement>('#startBtn');
  try {
    btn.disabled = true;
    btn.textContent = 'STARTING…';
    await engine.start(reg.on('sys.low'));
    engine.rack.onChange = () => { renderRack(); saveState(); };
    if (pendingRack) { for (const s of pendingRack) engine.rack.add(s.type, s); pendingRack = null; }
    renderRack();
    engine.setSafe(reg.on('safe.on'));
    document.body.classList.add('live');
    btn.textContent = 'LIVE';
    btn.classList.add('live');
    $('#latency').textContent = `${engine.sampleRate / 1000} kHz · ${engine.latencyMs().toFixed(1)} ms`;
    let saved: string | null = null;
    try { saved = localStorage.getItem('dsd.input'); } catch { /* storage blocked */ }
    try {
      await openInput(saved && saved !== 'demo' ? saved : undefined);
      await refreshDevices();
    } catch (err) {
      // keep the error visible (with RETRY) instead of silently switching to the demo
      await refreshDevices().catch(() => {});
      $('#inputName').textContent = 'input error';
      toast(describeInputError(err), 'err');
    }
    $<HTMLDialogElement>('#monitorDialog').showModal();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'START';
    toast(`Audio failed to start: ${(err as Error).message}`, 'err');
  }
}

// ───────────────────────── TONE3000 ─────────────────────────
let t3kTone: T3kTone | null = null;
function openT3k(): void {
  $<HTMLInputElement>('#t3kKey').value = t3k.key;
  $('#t3kRedirect').textContent = redirectUri();
  renderT3k();
  $<HTMLDialogElement>('#t3kDialog').showModal();
}

function renderT3k(models?: T3kModel[]): void {
  if (!$('#t3kStatus').classList.contains('err') && !$('#t3kStatus').classList.contains('wait')) $('#t3kStatus').textContent = t3k.connected ? 'Connected to TONE3000' : 'Not connected';
  const list = $('#t3kModels');
  list.innerHTML = '';
  if (!t3kTone) return;
  el('div', 't3k-tone', list).textContent = t3kTone.title + (t3kTone.user ? ` — by ${t3kTone.user.display_name ?? t3kTone.user.username}` : '');
  if (!models) { el('div', 'hint', list).textContent = 'Loading models…'; return; }
  if (!models.length) { el('div', 'hint', list).textContent = 'No downloadable models for that architecture.'; return; }
  for (const m of models) {
    const row = el('div', 't3k-row', list);
    el('span', '', row).textContent = `${m.name}${m.size ? ' · ' + m.size : ''}${m.architecture_version ? ' · A' + m.architecture_version : ''}`;
    const isIr = t3kTone.format === 'ir' || /\.(wav|aiff?)$/i.test(m.model_url);
    const targets: [string, Target][] = isIr ? [['→ CAB', 'cab'], ['→ REVERB', 'rev'], ['→ END IR', 'ir']] : [['→ AMP', 'nam']];
    for (const [label, target] of targets) {
      button(row, label, async () => {
        try { toast(`Downloading ${m.name}…`); await loadBytes(await t3k.file(m.model_url), `${t3kTone!.title} · ${m.name}`, target); }
        catch (err) { toast((err as Error).message, 'err'); }
      }, 'small');
    }
  }
}

function t3kStatus(text: string, kind: '' | 'err' | 'wait' = ''): void {
  const st = $('#t3kStatus');
  st.textContent = text;
  st.className = `t3k-status ${kind}`;
  $('#t3kCancel').hidden = kind !== 'wait';
}

async function showTone(toneId: string, format: string, architecture: string | undefined): Promise<void> {
  t3kTone = await t3k.tone(toneId);
  renderT3k();
  renderT3k(await t3k.models(toneId, format === 'ir' ? undefined : architecture));
  t3kStatus('Connected — pick a model below.');
}

// must stay synchronous up to t3k.select(): the popup has to open inside the click
function t3kPick(kind: 'amp' | 'nam' | 'ir'): void {
  t3k.setKey($<HTMLInputElement>('#t3kKey').value);
  const arch = $<HTMLSelectElement>('#t3kArch').value;
  const opts = kind === 'ir' ? { format: 'ir' as const } : { format: 'nam' as const, gears: kind === 'amp' ? 'amp_amp-cab_pedal' : undefined, architecture: arch };
  t3kStatus('Waiting for TONE3000… sign in and pick a tone in the popup.', 'wait');
  t3k.select(opts)
    .then(({ toneId }) => showTone(toneId, opts.format, 'architecture' in opts ? opts.architecture : undefined))
    .catch((err: unknown) => { t3kStatus((err as Error).message, 'err'); renderT3k(); });
}


// ───────────────────────── presets + persistence ─────────────────────────
const PRESETS: Record<string, Record<string, number>> = {
  'Deep Sub': { 'bass.shape': 0.55, 'bass.sub': 0.9, 'bass.cutoff': 180, 'bass.reso': 0.1, 'bass.env': 0.2, 'bass.drive': 0.15, 'bass.fold': 0, 'tune.octave': -1, 'pad.mode': 0, 'wdw.wet': 0.3 },
  'Acid Line': { 'bass.shape': 0, 'bass.sub': 0.2, 'bass.cutoff': 220, 'bass.reso': 0.82, 'bass.env': 0.85, 'bass.drive': 0.55, 'tune.glide': 60, 'tune.octave': 0, 'pad.tx': 1, 'pad.ty': 2, 'pad.mode': 1, 'pad.speed': 0.25 },
  'Fold Growl': { 'bass.shape': 0.3, 'bass.sub': 0.5, 'bass.fold': 0.6, 'bass.cutoff': 900, 'bass.reso': 0.4, 'bass.drive': 0.6, 'pad.tx': 4, 'pad.ty': 1, 'pad.mode': 2, 'pad.speed': 0.4, 'chaos.entropy': 0.5 },
  'Dub Space': { 'bass.shape': 0.55, 'bass.sub': 0.7, 'bass.cutoff': 300, 'dly.send': 0.7, 'dly.fb': 0.6, 'dly.time': 0.5, 'rev.send': 0.65, 'rev.size': 4.5, 'wdw.wet': 0.8, 'pad.tz': 8, 'pad.mode': 1, 'pad.speed': 0.08 },
  'Clean Tempered': { 'bass.shape': 0.15, 'bass.sub': 0.4, 'bass.fold': 0, 'bass.cutoff': 1200, 'bass.reso': 0.2, 'bass.env': 0.3, 'bass.drive': 0.1, 'tune.quant': 1, 'tune.glide': 5, 'pad.mode': 0, 'wdw.wet': 0.45 },
};

const persistSnap = (): Record<string, number> => reg.snapshot((p) => p.persist && !/^r\d+\./.test(p.id));
let saveTimer = 0;
function saveState(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(STATE_KEY, JSON.stringify({ params: persistSnap(), rack: engine.started ? engine.rack.save() : pendingRack ?? [] })); } catch { /* storage blocked */ }
  }, 500);
}

function loadState(): void {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as { params?: Record<string, number>; rack?: typeof pendingRack } | null;
    if (!s) return;
    reg.restore(s.params, 'load');
    pendingRack = s.rack ?? null;
  } catch { /* ignore broken state */ }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function buildPresets(): void {
  const sel = $<HTMLSelectElement>('#presetSel');
  const add = (v: string, t: string): void => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  add('', 'PRESETS');
  for (const n of Object.keys(PRESETS)) add(n, n);
  add('__export', 'Export to file…');
  add('__import', 'Import from file…');
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (v === '__export') download(new Blob([JSON.stringify({ app: 'DawSynthDoom', version: 3, params: persistSnap(), rack: engine.started ? engine.rack.save() : [] }, null, 2)], { type: 'application/json' }), 'dawsynthdoom-preset.json');
    else if (v === '__import') $<HTMLInputElement>('#presetFile').click();
    else if (v) {
      const keep = /^(in\.|eq\.|master\.|guard\.|safe\.|sys\.|tune\.(key|scale|temper|ref))/;
      const defaults: Record<string, number> = {};
      for (const p of reg.params.values()) if (p.persist && !keep.test(p.id) && !/^r\d+\./.test(p.id) && !/^pad\.[xyz]$/.test(p.id)) defaults[p.id] = p.def;
      reg.restore({ ...defaults, ...PRESETS[v] }, 'ui');
      toast(`Preset: ${v}`);
    }
  });
  $<HTMLInputElement>('#presetFile').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const o = JSON.parse(await f.text()) as { params?: Record<string, number>; rack?: { id: string; type: string; params: Record<string, number> }[] };
      reg.restore(o.params, 'ui');
      if (o.rack && engine.started) { engine.rack.clear(); for (const s of o.rack) engine.rack.add(s.type, s); }
      toast(`Preset imported: ${f.name}`);
    } catch (err) { toast(`Bad preset file: ${(err as Error).message}`, 'err'); }
  });
}

// ───────────────────────── live loop ─────────────────────────
const spectrum = new Spectrum3D($<HTMLCanvasElement>('#specCanvas'));
let specSource: 'in' | 'out' = 'out';
let motionCenter: { x: number; y: number; z: number } | null = null;
let motionT = 0;
let lastT = performance.now(), lastGuard = 0;
const meterBuf = new Float32Array(1024);

function runMotion(dt: number): void {
  const mode = Math.round(reg.get('pad.mode'));
  if (mode === 0) return;
  const touched = reg.touched.has('pad.x') || reg.touched.has('pad.z');
  if (touched || !motionCenter) { motionCenter = { x: reg.get('pad.x'), y: reg.get('pad.y'), z: reg.get('pad.z') }; motionT = 0; if (touched) return; }
  const size = reg.get('pad.size'), f = reg.get('pad.speed');
  motionT += dt;
  let dx: number, dy: number, dz: number;
  if (mode === 1) {
    const w = 2 * Math.PI * f * motionT;
    dx = Math.sin(w); dy = Math.sin(w * 1.31 + 1); dz = Math.sin(w * 0.73 + 2);
  } else {
    chaos.step(dt, { rate: f, entropy: reg.get('chaos.entropy'), entangle: reg.get('chaos.entangle'), glide: reg.get('chaos.glide') });
    dx = chaos.point.x * 2 - 1; dy = chaos.point.y * 2 - 1; dz = chaos.point.z * 2 - 1;
  }
  const c = motionCenter;
  reg.set('pad.x', c.x + dx * size, 'auto');
  reg.set('pad.y', c.y + dy * size, 'auto');
  reg.set('pad.z', c.z + dz * size, 'auto');
}

function drawLegend(): void {
  const host = $('#legend');
  if (host.childElementCount) {
    for (const n of host.children) (n as HTMLElement).classList.toggle('on', (n as HTMLElement).dataset.k === spectrum.last.kind.id);
    return;
  }
  for (const k of Object.values(KINDS)) {
    const s = el('span', '', host);
    s.dataset.k = k.id;
    s.style.setProperty('--k', k.color);
    s.textContent = k.label;
    s.title = k.hint;
  }
}

let silentSince = 0, otherSince = 0, otherCh = -1, noSignalShown = false;
function inputWatch(t: number): void {
  if (!engine.started || currentInput === 'demo' || currentInput === 'file') return;
  const lv = engine.channelLevels();
  const meters = document.querySelectorAll<HTMLElement>('#chMeters .ch');
  lv.forEach((db, i) => {
    const m = meters[i];
    if (!m) return;
    m.querySelector('i')!.style.height = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`;
    m.classList.toggle('sel', Math.round(reg.get('in.ch')) === i || (reg.get('in.ch') === 4 && i < 2));
    m.classList.toggle('dead', i >= engine.inputChannels);
  });
  const ch = Math.round(reg.get('in.ch'));
  const cur = ch === 4 ? Math.max(lv[0], lv[1]) : lv[ch] ?? -120;
  const loudest = lv.reduce((b, v, i) => (v > lv[b] ? i : b), 0);
  if (cur > -60) { silentSince = 0; noSignalShown = false; }
  else if (!silentSince) silentSince = t;
  // auto channel: the selected input is silent but another one has a real signal
  if (reg.on('in.auto') && ch !== 4 && loudest !== ch && lv[loudest] > -45 && cur < -60) {
    if (otherCh !== loudest) { otherCh = loudest; otherSince = t; }
    else if (t - otherSince > 300) {
      reg.set('in.ch', loudest);
      toast(`Signal found on ${INPUT_CHANNELS[loudest]} — switched to it.`, 'warn');
      otherCh = -1;
    }
  } else otherCh = -1;
  if (silentSince && t - silentSince > 5000 && !noSignalShown && Math.max(...lv) < -60) {
    noSignalShown = true;
    inputStatus('No signal on any input. Check the cable, turn up the gain knob on your interface, and make sure the right device is selected above.', true);
  } else if (!silentSince && noSignalShown === false && $('#inStatus').classList.contains('err') && /No signal/.test($('#inStatus').textContent ?? '')) {
    inputStatus(`● ${engine.inputLabel || 'audio input'} · ${engine.inputChannels} ch`);
  }
}

function frame(): void {
  requestAnimationFrame(frame);
  const t = performance.now(), dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  runMotion(dt);
  inputWatch(t);
  $('#muteBanner').hidden = !engine.started || reg.on('master.mon');
  pad.draw(dt, reg.on('pad.spin'));

  if (engine.started && t - lastGuard > 100) {
    lastGuard = t;
    const safe = reg.on('safe.on');
    engine.guardTick(reg.on('guard.on'), safe ? Math.max(0.75, reg.get('guard.sens')) : reg.get('guard.sens'));
    const ns = engine.guard.notches;
    const list = $('#guardList');
    list.textContent = !reg.on('guard.on') ? 'off' : ns.length ? ns.map((n) => `${n.freq < 1000 ? Math.round(n.freq) : (n.freq / 1000).toFixed(2) + 'k'} ${Math.round(n.gain)}dB`).join(' · ') : 'listening · no feedback';
    list.classList.toggle('alert', engine.guard.duck);
    spectrum.notches = ns;
  }

  for (const m of meters) {
    const a = m.analyser();
    let peak = 0, rms = 0;
    if (a && engine.started) {
      a.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (const s of meterBuf) { const v = Math.abs(s); if (v > peak) peak = v; sum += v * v; }
      rms = Math.sqrt(sum / meterBuf.length);
    }
    if (peak >= m.hold || t - m.t > 1200) { m.hold = Math.max(peak, m.hold * 0.9); if (peak >= m.hold) m.t = t; }
    drawMeter(m.canvas, peak, rms, m.hold);
  }

  spectrum.label = specSource === 'in' ? 'SYNTH IN' : 'BASS OUT';
  spectrum.draw(engine.started ? (specSource === 'in' ? engine.inAnalyser : engine.outAnalyser) : null);
  drawLegend();
  masterEq.draw(engine.started ? engine.mixAnalyser : null);
  preEq.draw(engine.started ? engine.preAnalyser : null);
}

function onBass(d: BassReport): void {
  for (const [n, v] of [[1, d.lfo1], [2, d.lfo2]] as const) {
    const bar = document.getElementById(`lfo${n}Bar`);
    if (bar) bar.style.left = `${(v * 0.5 + 0.5) * 100}%`;
  }
  $('#gateLed').classList.toggle('open', d.gate);
  engine.playing = d.gate ? [d.out, d.f0] : [];
  spectrum.playing = engine.playing;
  if (!d.f0) return;
  $('#tNote').textContent = noteName(d.midi);
  const err = Math.max(-50, Math.min(50, d.err));
  $('#tNeedle').style.left = `${50 + err}%`;
  $('#tInfo').textContent = `in ${d.f0.toFixed(1)} Hz → out ${d.out.toFixed(1)} Hz · ${err >= 0 ? '+' : ''}${err.toFixed(0)}¢ · ${reg.param('tune.temper').format()} ${d.cents >= 0 ? '+' : ''}${d.cents.toFixed(1)}¢`;
}

// ───────────────────────── tabs (phones) ─────────────────────────
function setTab(tab: string): void {
  document.body.dataset.tab = tab;
  document.querySelectorAll<HTMLElement>('#tabs .btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  try { localStorage.setItem('dsd.tab', tab); } catch { /* storage blocked */ }
  window.scrollTo({ top: 0 });
}

// ───────────────────────── boot ─────────────────────────
defineParams();
buildInput();
buildTuning();
buildVoice();
buildAmp();
buildPad();
buildWdw();
buildRack();
buildMaster();
buildPreEq();
buildLfos();
buildIrSim();
buildPresets();
loadState();
renderRack();
engine.onBass = onBass;
engine.onStatus = (kind, text) => {
  if (kind === 'ctx') {
    if (text !== 'running' && engine.started) toast('Audio paused by the device. Tap anywhere to resume.', 'warn');
    return;
  }
  if (kind === 'input-ended') { inputStatus(`${text} Reconnect it and press RETRY INPUT.`, true); toast(text, 'err'); return; }
  if (kind === 'ir') { buildIrSim(); return; }
  if (kind.endsWith('error')) toast(text, 'err');
  else if (kind === 'guard') toast(text, 'warn');
  if (kind.startsWith('nam')) buildAmp();
};
// iOS / Android may suspend audio (calls, screen lock, mic start); any touch resumes it
document.addEventListener('pointerdown', () => { if (engine.started && engine.ctx.state !== 'running') void engine.ctx.resume(); }, true);
reg.onChange(() => saveState());

for (const [tab, label] of [['bass', 'BASS'], ['pad', '3D'], ['fx', 'FX'], ['master', 'MASTER']] as const) {
  const b = button($('#tabs'), label, () => setTab(tab), 'tab');
  b.dataset.tab = tab;
}
let savedTab = 'bass';
try { savedTab = localStorage.getItem('dsd.tab') ?? 'bass'; } catch { /* storage blocked */ }
setTab(savedTab);

for (const [src, label] of [['in', 'IN'], ['out', 'OUT']] as const) {
  const b = button($('#specSrc'), label, () => {
    specSource = src;
    document.querySelectorAll('#specSrc .btn').forEach((x) => x.classList.toggle('on', x === b));
  }, 'seg');
  b.classList.toggle('on', src === specSource);
}

$('#startBtn').addEventListener('click', () => { if (!engine.started) void startAudio(); });
$<HTMLSelectElement>('#inputSel').addEventListener('change', (e) => void chooseInput((e.target as HTMLSelectElement).value));
$<HTMLInputElement>('#fileInput').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try { await engine.useFile(f); currentInput = 'file'; $('#inputName').textContent = f.name; } catch (err) { toast(`Could not play ${f.name}: ${(err as Error).message}`, 'err'); }
});
$<HTMLSelectElement>('#outputSel').addEventListener('change', async (e) => {
  try { await engine.setOutputDevice((e.target as HTMLSelectElement).value); toast('Output device changed'); } catch (err) { toast(`Output error: ${(err as Error).message}`, 'err'); }
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

$('#muteBanner').addEventListener('click', () => {
  reg.set('master.mon', 1);
  toast('Sound on. Use headphones if you play through a microphone.', 'warn');
});
$('#monYes').addEventListener('click', () => { reg.set('master.mon', 1); $<HTMLDialogElement>('#monitorDialog').close(); });
$('#monNo').addEventListener('click', () => { $<HTMLDialogElement>('#monitorDialog').close(); toast('Monitor is off. Turn it on in MASTER when you have headphones.', 'warn'); });

let recording = false;
$('#recBtn').addEventListener('click', async () => {
  if (!(await ensureStarted())) return;
  const b = $('#recBtn');
  if (!recording) {
    try { engine.startRecording(); } catch (err) { toast(`Recording unsupported: ${(err as Error).message}`, 'err'); return; }
    recording = true;
    b.classList.add('on');
    b.textContent = 'STOP REC';
  } else {
    recording = false;
    b.classList.remove('on');
    b.textContent = 'REC';
    const blob = await engine.stopRecording();
    if (blob) {
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      download(blob, `dawsynthdoom-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`);
      toast('Recording saved');
    }
  }
});

$('#t3kClose').addEventListener('click', () => $<HTMLDialogElement>('#t3kDialog').close());
$<HTMLInputElement>('#t3kKey').addEventListener('change', (e) => t3k.setKey((e.target as HTMLInputElement).value));
$('#t3kAmp').addEventListener('click', () => t3kPick('amp'));
$('#t3kAll').addEventListener('click', () => t3kPick('nam'));
$('#t3kIr').addEventListener('click', () => t3kPick('ir'));
$('#t3kCancel').addEventListener('click', () => t3k.cancel());
// came back from a same-tab TONE3000 sign-in (popups were blocked)
void t3k.resumeRedirect().then((r) => {
  if (!r) return;
  openT3k();
  t3kStatus('Loading your tone…', 'wait');
  return showTone(r.toneId, r.format, r.architecture || undefined);
}).catch((err: unknown) => { openT3k(); t3kStatus((err as Error).message, 'err'); });
$('#t3kCopy').addEventListener('click', () => void navigator.clipboard?.writeText(redirectUri()).then(() => toast('Redirect URL copied')));
$('#t3kDisconnect').addEventListener('click', () => { t3k.disconnect(); t3kTone = null; renderT3k(); });
$('#helpBtn').addEventListener('click', () => $<HTMLDialogElement>('#helpDialog').showModal());
$('#helpClose').addEventListener('click', () => $<HTMLDialogElement>('#helpDialog').close());

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  if (/\.nam$/i.test(f.name)) void loadFile(f, 'nam');
  else if (/\.(wav|aiff?|flac)$/i.test(f.name)) void loadFile(f, 'cab');
});

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea, [role="slider"]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!engine.started) void startAudio();
    else reg.set('master.mon', reg.on('master.mon') ? 0 : 1);
  }
});

requestAnimationFrame(frame);

// console handle for debugging
Object.assign(window, { dsd: { engine, reg } });
