import { Registry } from './params.js';
import { knob, fader, toggle, button, drawMeter, el } from './ui.js';
import { Engine, WETS, PRE_BANDS, EQ_BANDS, faderGain } from './engine.js';
import { EqEditor } from './eq.js';
import { SdrDisplay } from './sdr.js';
import { QubitChaos, CHAOS_TARGETS } from './chaos.js';
import { RACK_MODULES } from './rack.js';
import { Tone3000, redirectUri } from './tone3000.js';

const $ = (s) => document.querySelector(s);
const STATE_KEY = 'dsd.state.v2';
const STARTER_BASE = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/refs/heads/main/ui/public/';
const STARTERS = {
  nam: [{ name: 'Vox AC10', url: STARTER_BASE + 'models/ac10.nam' }, { name: 'Fender Deluxe Reverb', url: STARTER_BASE + 'models/deluxe.nam' }],
  cab: [{ name: 'Celestion cab', url: STARTER_BASE + 'irs/celestion.wav' }],
  rev: [{ name: 'EMT 140 Plate', url: STARTER_BASE + 'irs/plate.wav' }],
};
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const reg = new Registry();
const engine = new Engine(reg);
const chaos = new QubitChaos();
const t3k = new Tone3000();
const on = () => engine.started;
let pendingRack = null;

function toast(text, kind = '') {
  const t = el('div', `toast ${kind}`, $('#toasts'));
  t.textContent = text;
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

const fmtFader = (v) => { const g = faderGain(v); return g <= 0 ? '-∞' : ((g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1)); };
const fmtPan = (v) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
const dB = { unit: 'dB' };
const T = (fn) => (v) => on() && fn(v);
const now = () => engine.ctx.currentTime;

// ───────────────────────── parameters ─────────────────────────
function defineParams() {
  reg.define('in.trim', { label: 'INPUT', min: -24, max: 24, def: 0, ...dB, apply: T((v) => engine.inTrim.gain.setTargetAtTime(10 ** (v / 20), now(), 0.02)) });
  reg.define('in.ch', { label: 'CHANNEL', min: 0, max: 2, def: 0, step: 1, options: ['IN 1', 'IN 2', '1+2'], apply: (v) => engine.applyChannel(v) });
  reg.define('gate.on', { label: 'GATE', def: 1, step: 1, apply: T((v) => engine.setFront('gateOn', v)) });
  reg.define('gate.thr', { label: 'THRESH', min: -80, max: -20, def: -56, ...dB, apply: T((v) => engine.setFront('gateThresh', 10 ** (v / 20))) });

  reg.define('pre.on', { label: 'PRE EQ', def: 1, step: 1, apply: () => applyPre() });
  reg.define('pre.hp', { label: 'LOW CUT', min: 20, max: 400, def: 60, scale: 'log', unit: 'Hz', apply: T((v) => engine.preHp.frequency.setTargetAtTime(reg.get('pre.on') >= 0.5 ? v : 10, now(), 0.02)) });
  PRE_BANDS.forEach((b, i) => {
    reg.define(`pre.${i}.f`, { label: 'FREQ', min: 20, max: 20000, def: b.f, scale: 'log', unit: 'Hz', apply: () => applyPre(i) });
    reg.define(`pre.${i}.g`, { label: 'GAIN', min: -18, max: 18, def: 0, ...dB, apply: () => applyPre(i) });
    reg.define(`pre.${i}.q`, { label: 'Q', min: 0.3, max: 10, def: b.q, scale: 'log', apply: () => applyPre(i) });
  });

  const front = (name, map = (v) => v) => T((v) => engine.setFront(name, map(v)));
  reg.define('tune.on', { label: 'AUTOTUNE', def: 0, step: 1, apply: front('tuneOn') });
  reg.define('tune.key', { label: 'KEY', min: 0, max: 11, def: 9, step: 1, options: KEYS, apply: front('key') });
  reg.define('tune.scale', { label: 'SCALE', min: 0, max: 5, def: 0, step: 1, options: ['CHROM', 'MAJOR', 'MINOR', 'PENT MAJ', 'PENT MIN', 'DORIAN'], apply: front('scale') });
  reg.define('tune.temper', { label: 'TEMPERAMENT', min: 0, max: 4, def: 1, step: 1, options: ['EQUAL', 'WERCK III', 'KIRNB III', 'VALLOTTI', 'YOUNG II'], apply: front('temper') });
  reg.define('tune.ref', { label: 'A4 REF', min: 415, max: 466, def: 440, step: 0.5, format: (v) => v.toFixed(1) + 'Hz', apply: front('ref') });
  reg.define('tune.amount', { label: 'STRENGTH', def: 1, unit: '%', apply: front('amount') });
  reg.define('tune.speed', { label: 'RETUNE', min: 0, max: 400, def: 40, format: (v) => Math.round(v) + 'ms', apply: front('speed') });
  reg.define('tune.mix', { label: 'MIX', def: 1, unit: '%', apply: front('mix') });

  const ampR = () => engine.applyAmpRouting();
  const gainDb = (node) => T((v) => node().gain.setTargetAtTime(10 ** (v / 20), now(), 0.02));
  const shelf = (node) => T((v) => node().gain.setTargetAtTime(v, now(), 0.02));
  reg.define('amp.on', { label: 'AMP', def: 1, step: 1, apply: ampR });
  reg.define('amp.boost', { label: 'BOOST', def: 0, step: 1, apply: T(() => engine.setBoost(reg.get('amp.boost') >= 0.5, reg.get('amp.drive'))) });
  reg.define('amp.drive', { label: 'DRIVE', def: 0.35, unit: '%', apply: T(() => engine.setBoost(reg.get('amp.boost') >= 0.5, reg.get('amp.drive'))) });
  reg.define('amp.gain', { label: 'GAIN', min: -24, max: 24, def: 0, ...dB, apply: gainDb(() => engine.ampPre) });
  reg.define('amp.bass', { label: 'BASS', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => engine.bass) });
  reg.define('amp.mid', { label: 'MID', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => engine.mid) });
  reg.define('amp.treb', { label: 'TREBLE', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => engine.treb) });
  reg.define('amp.out', { label: 'OUTPUT', min: -24, max: 12, def: 0, ...dB, apply: gainDb(() => engine.ampLevel) });
  reg.define('amp.cab', { label: 'CAB IR', def: 1, step: 1, apply: ampR });
  reg.define('amp.norm', { label: 'NORMALIZE', def: 1, step: 1, apply: ampR });

  reg.define('wdw.dry', { label: 'DRY', def: 0.79, format: fmtFader, apply: T((v) => engine.dryGain.gain.setTargetAtTime(faderGain(v), now(), 0.015)) });
  reg.define('wdw.pos', { label: 'DRY POS', min: -1, max: 1, def: 0, format: fmtPan, apply: T((v) => engine.dryPan.pan.setTargetAtTime(v, now(), 0.02)) });
  reg.define('wdw.wet', { label: 'WET', def: 0.72, format: fmtFader, apply: T((v) => engine.wetGain.gain.setTargetAtTime(faderGain(v), now(), 0.015)) });
  reg.define('wdw.width', { label: 'WIDTH', min: 0, max: 2, def: 1.3, format: (v) => Math.round(v * 100) + '%', apply: T(() => engine.applyWidth()) });
  reg.define('wdw.mode', { label: 'W/D/W', def: 1, step: 1, apply: T(() => engine.applyWidth()) });

  const sends = { dly: 0.55, rev: 0.6, cho: 0, dbl: 0 };
  for (const w of WETS) {
    reg.define(`${w.id}.send`, { label: 'SEND', def: sends[w.id], format: fmtFader, apply: (v) => engine.setWetSend(w.id, v) });
    reg.define(`${w.id}.mute`, { label: 'M', def: 0, step: 1, apply: (v) => engine.setWetMute(w.id, v >= 0.5) });
  }
  reg.define('dly.time', { label: 'TIME', min: 0.05, max: 1.5, def: 0.38, scale: 'log', unit: 's', apply: T(() => engine.applyDelayTime()) });
  reg.define('dly.fb', { label: 'REPEATS', max: 0.85, def: 0.32, unit: '%', apply: T((v) => engine.setDelayFeedback(v)) });
  reg.define('dly.tone', { label: 'TONE', min: 800, max: 12000, def: 4000, scale: 'log', unit: 'Hz', apply: T((v) => engine.wet.dly.tone.frequency.setTargetAtTime(v, now(), 0.02)) });
  reg.define('dly.spread', { label: 'SPREAD', def: 0.3, unit: '%', apply: T(() => engine.applyDelayTime()) });
  reg.define('rev.size', { label: 'SIZE', min: 0.4, max: 8, def: 2.6, scale: 'log', unit: 's', apply: T(() => engine.regenReverb()) });
  reg.define('rev.pre', { label: 'PRE-DLY', min: 0, max: 0.2, def: 0.025, unit: 's', apply: T((v) => engine.wet.rev.pre.delayTime.setTargetAtTime(v, now(), 0.05)) });
  reg.define('rev.tone', { label: 'TONE', min: 1000, max: 16000, def: 6500, scale: 'log', unit: 'Hz', apply: T((v) => engine.wet.rev.tone.frequency.setTargetAtTime(v, now(), 0.02)) });
  reg.define('cho.rate', { label: 'RATE', min: 0.05, max: 6, def: 0.7, scale: 'log', format: (v) => v.toFixed(2) + 'Hz', apply: T(() => engine.setChorus()) });
  reg.define('cho.depth', { label: 'DEPTH', def: 0.5, unit: '%', apply: T(() => engine.setChorus()) });
  reg.define('cho.tone', { label: 'TONE', min: 1000, max: 16000, def: 9000, scale: 'log', unit: 'Hz', apply: T((v) => engine.wet.cho.tone.frequency.setTargetAtTime(v, now(), 0.02)) });
  reg.define('dbl.time', { label: 'SPREAD', min: 0.006, max: 0.045, def: 0.018, unit: 's', apply: T(() => engine.setDoubler()) });

  reg.define('chaos.on', { label: 'QUBIT CHAOS', def: 0, step: 1 });
  reg.define('chaos.rate', { label: 'RATE', min: 0.02, max: 4, def: 0.25, scale: 'log', format: (v) => v.toFixed(2) + 'Hz' });
  reg.define('chaos.entropy', { label: 'ENTROPY', def: 0.35, unit: '%' });
  reg.define('chaos.entangle', { label: 'ENTANGLE', def: 0.5, unit: '%' });
  reg.define('chaos.depth', { label: 'DEPTH', def: 0.5, unit: '%' });
  reg.define('chaos.glide', { label: 'GLIDE', min: 0.02, max: 3, def: 0.4, scale: 'log', unit: 's' });
  const chaosDefaults = { dly: 1, rev: 1, cho: 1, dbl: 1, width: 1, time: 0, filter: 0, master: 0 };
  for (const t of CHAOS_TARGETS) reg.define(`chaos.t.${t.id}`, { label: t.label, def: chaosDefaults[t.id], step: 1 });

  reg.define('eq.on', { label: 'EQ', def: 1, step: 1, apply: () => applyEq() });
  EQ_BANDS.forEach((b, i) => {
    reg.define(`eq.${i}.f`, { label: 'FREQ', min: 20, max: 20000, def: b.f, scale: 'log', unit: 'Hz', apply: () => applyEq(i) });
    reg.define(`eq.${i}.g`, { label: 'GAIN', min: -18, max: 18, def: 0, ...dB, apply: () => applyEq(i) });
    reg.define(`eq.${i}.q`, { label: 'Q', min: 0.3, max: 10, def: b.q, scale: 'log', apply: () => applyEq(i) });
  });
  reg.define('master.comp', { label: 'GLUE', def: 0.2, unit: '%', apply: T((v) => engine.setComp(v)) });
  reg.define('guard.on', { label: 'FB GUARD', def: 1, step: 1 });
  reg.define('guard.sens', { label: 'SENSE', def: 0.5, unit: '%' });
  reg.define('master.vol', { label: 'MASTER', def: 0.62, format: fmtFader, apply: T((v) => engine.master.gain.setTargetAtTime(faderGain(v), now(), 0.015)) });
  reg.define('master.mon', { label: 'MONITOR', def: 0, step: 1, persist: false, apply: T((v) => engine.monitor.gain.setTargetAtTime(v >= 0.5 ? 1 : 0, now(), 0.01)) });
}

function applyPre(only) {
  if (!on()) return;
  const enabled = reg.get('pre.on') >= 0.5;
  PRE_BANDS.forEach((_, i) => {
    if (only !== undefined && only !== i) return;
    engine.setPre(i, enabled, reg.get(`pre.${i}.f`), reg.get(`pre.${i}.g`), reg.get(`pre.${i}.q`));
  });
  if (only === undefined) engine.preHp.frequency.setTargetAtTime(enabled ? reg.get('pre.hp') : 10, now(), 0.02);
}

function applyEq(only) {
  if (!on()) return;
  const enabled = reg.get('eq.on') >= 0.5;
  EQ_BANDS.forEach((_, i) => {
    if (only !== undefined && only !== i) return;
    engine.setEq(i, enabled, reg.get(`eq.${i}.f`), reg.get(`eq.${i}.g`), reg.get(`eq.${i}.q`));
  });
}

// ───────────────────────── panels ─────────────────────────
const meters = [];   // { canvas, analyser(), hold, t }
const addMeter = (canvas, analyser) => meters.push({ canvas, analyser, hold: 0, t: 0 });

function head(host, title, hint) {
  const h = el('div', 'panel-head', host);
  el('h2', '', h).textContent = title;
  if (hint) el('span', 'hint', h).textContent = hint;
  return h;
}

function buildInput() {
  const host = $('#input');
  head(host, 'INPUT');
  const row = el('div', 'p-row', host);
  const col = el('div', 'p-col', row);
  knob(col, reg, 'in.trim');
  knob(col, reg, 'gate.thr', { size: 'sm' });
  const m = el('canvas', 'v-meter', row);
  addMeter(m, () => engine.inAnalyser);
  const btns = el('div', 'p-btns', host);
  toggle(btns, reg, 'gate.on', { text: 'NOISE GATE' });
  el('div', 'gate-led', btns).id = 'gateLed';
}

function bandTabs(host, prefix, bands, editorRef) {
  const tabs = el('div', 'eq-bands', host);
  const knobsRow = el('div', 'eq-knobs', host);
  const buttons = bands.map((_, i) => button(tabs, String(i + 1), () => editorRef().select(i), 'band'));
  return (i) => {
    buttons.forEach((b, k) => b.classList.toggle('on', k === i));
    knobsRow.innerHTML = '';
    for (const k of ['f', 'g', 'q']) knob(knobsRow, reg, `${prefix}.${i}.${k}`, { size: 'sm' });
  };
}

function buildPreEq() {
  const host = $('#preeq');
  const h = head(host, 'PRE EQ');
  toggle(h, reg, 'pre.on', { text: 'ON' });
  button(h, 'FLAT', () => PRE_BANDS.forEach((b, i) => { reg.set(`pre.${i}.g`, 0, 'ui'); reg.set(`pre.${i}.f`, b.f, 'ui'); reg.set(`pre.${i}.q`, b.q, 'ui'); }), 'ghost small');
  const canvas = el('canvas', 'eq-canvas small', host);
  let ed;
  const show = bandTabs(host, 'pre', PRE_BANDS, () => ed);
  ed = new EqEditor(canvas, reg, { prefix: 'pre', bands: PRE_BANDS, onId: 'pre.on', onSelect: show });
  const extra = el('div', 'eq-knobs', host);
  knob(extra, reg, 'pre.hp', { size: 'sm' });
  show(0);
  return ed;
}

function buildTune() {
  const host = $('#tune');
  const h = head(host, 'AUTOTUNE');
  toggle(h, reg, 'tune.on', { text: 'ON' });
  const tuner = el('div', 'tuner', host);
  tuner.innerHTML = '<div class="t-note" id="tNote">—</div><div class="t-scale"><i id="tNeedle"></i><b></b></div><div class="t-info" id="tInfo">well-tempered pitch correction</div>';
  const grid = el('div', 'k-grid', host);
  for (const id of ['tune.key', 'tune.scale', 'tune.temper', 'tune.ref', 'tune.amount', 'tune.speed', 'tune.mix']) knob(grid, reg, id, { size: 'sm' });
}

function buildAmp() {
  const host = $('#amp');
  host.innerHTML = '';
  const h = head(host, 'AMP');
  toggle(h, reg, 'amp.on', { text: 'ON' });
  toggle(h, reg, 'amp.boost', { text: 'BOOST' });
  const grid = el('div', 'k-grid', host);
  for (const id of ['amp.drive', 'amp.gain', 'amp.bass', 'amp.mid', 'amp.treb', 'amp.out']) knob(grid, reg, id, { size: 'sm' });
  const row = el('div', 'p-btns', host);
  toggle(row, reg, 'amp.cab', { text: 'CAB IR' });
  toggle(row, reg, 'amp.norm', { text: 'NORMALIZE' });
  loaderBlock(host, 'NAM MODEL', engine.nam.loaded ? engine.nam.name : 'built-in amp', '.nam', 'nam');
  loaderBlock(host, 'CAB IR', engine.cab.name, '.wav,.aif,.aiff,.flac,.mp3', 'cab');
  const tb = el('div', 'p-btns', host);
  button(tb, 'TONE3000', () => openT3k(), 'accent');
  if (engine.nam.loaded) button(tb, 'UNLOAD', async () => { await engine.unloadNam(); buildAmp(); }, 'ghost');
}

function loaderBlock(host, title, current, accept, target) {
  const box = el('div', 'loader', host);
  el('div', 'l-title', box).textContent = title;
  el('div', 'l-name', box).textContent = current;
  const row = el('div', 'p-btns', box);
  const input = el('input', '', row);
  input.type = 'file'; input.accept = accept; input.hidden = true;
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0], target); input.value = ''; });
  button(row, 'LOAD', () => input.click(), 'small');
  for (const st of STARTERS[target] ?? []) button(row, st.name, () => loadUrl(st.url, st.name, target), 'ghost small');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0], target); });
}

const WET_KNOBS = { dly: ['dly.time', 'dly.fb', 'dly.tone', 'dly.spread'], rev: ['rev.size', 'rev.pre', 'rev.tone'], cho: ['cho.rate', 'cho.depth', 'cho.tone'], dbl: ['dbl.time'] };

function wetStrip(host, w) {
  const s = el('div', 'strip', host);
  s.dataset.id = w.id;
  const hd = el('div', 's-head', s);
  el('span', 's-name', hd).textContent = w.name;
  el('span', 's-sub', hd).textContent = `WET · ${w.side}`;
  const k = el('div', 's-knobs', s);
  for (const id of WET_KNOBS[w.id]) knob(k, reg, id, { size: 'sm' });
  if (w.id === 'rev') {
    const b = el('div', 'p-btns', s);
    const input = el('input', '', b);
    input.type = 'file'; input.accept = 'audio/*,.wav'; input.hidden = true;
    input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0], 'rev'); input.value = ''; });
    button(b, 'IR', () => input.click(), 'small');
    button(b, 'PLATE', () => loadUrl(STARTERS.rev[0].url, STARTERS.rev[0].name, 'rev'), 'ghost small');
  }
  if (w.id === 'dly') {
    let taps = [];
    button(el('div', 'p-btns', s), 'TAP', () => {
      const t = performance.now();
      taps = taps.filter((x) => t - x < 2500);
      taps.push(t);
      if (taps.length >= 2) reg.set('dly.time', (taps[taps.length - 1] - taps[0]) / (taps.length - 1) / 1000, 'ui');
    }, 'small');
  }
  const bottom = el('div', 's-bottom', s);
  const f = fader(bottom, reg, `${w.id}.send`);
  addMeter(f.canvas, () => engine.wet[w.id]?.meter);
  toggle(s, reg, `${w.id}.mute`, { text: 'MUTE', cls: 'mute small' });
}

function buildWdw() {
  const host = $('#wdwGrid');
  const left = el('div', 'wdw-side', host);
  const center = el('div', 'wdw-center', host);
  const right = el('div', 'wdw-side', host);
  for (const w of WETS) wetStrip(w.side === 'L' ? left : right, w);

  const dry = el('div', 'strip dry', center);
  const hd = el('div', 's-head', dry);
  el('span', 's-name', hd).textContent = 'DRY';
  el('span', 's-sub', hd).textContent = 'AMP · CENTER';
  const df = el('div', 's-bottom', dry);
  const f = fader(df, reg, 'wdw.dry');
  addMeter(f.canvas, () => engine.dryAnalyser);
  knob(dry, reg, 'wdw.pos', { size: 'sm' });

  const wm = el('div', 'strip wetmaster', center);
  const wh = el('div', 's-head', wm);
  el('span', 's-name', wh).textContent = 'WET';
  el('span', 's-sub', wh).textContent = 'RETURN · STEREO';
  const wf = el('div', 's-bottom', wm);
  const f2 = fader(wf, reg, 'wdw.wet');
  addMeter(f2.canvas, () => engine.wetAnalyser);
  knob(wm, reg, 'wdw.width', { size: 'sm' });
  toggle(wm, reg, 'wdw.mode', { text: 'W/D/W', title: 'Wet on the sides, dry in the centre' });
}

function buildRack() {
  const host = $('#rack');
  const h = head(host, 'END RACK', 'optional gig modules, last in the chain');
  const sel = el('select', '', h);
  sel.setAttribute('aria-label', 'Add module');
  const o0 = el('option', '', sel); o0.value = ''; o0.textContent = '+ ADD MODULE';
  for (const [type, def] of Object.entries(RACK_MODULES)) { const o = el('option', '', sel); o.value = type; o.textContent = def.name; }
  sel.addEventListener('change', async () => {
    const type = sel.value;
    sel.value = '';
    if (!type || !(await ensureStarted())) return;
    engine.rack.add(type);
    saveState();
  });
  el('div', 'rack-slots', host).id = 'rackSlots';
}

function renderRack() {
  const host = $('#rackSlots');
  host.innerHTML = '';
  const slots = engine.rack?.slots ?? [];
  if (!slots.length) { el('div', 'hint empty', host).textContent = 'No modules yet. Add a tremolo, auto filter, bitcrush, lo-fi radio, stutter or looper.'; return; }
  slots.forEach((s, i) => {
    const card = el('div', 'slot', host);
    const hd = el('div', 'slot-head', card);
    el('span', 's-num', hd).textContent = String(i + 1);
    el('span', 's-name', hd).textContent = s.def.name;
    button(hd, '◀', () => { engine.rack.move(s.id, -1); saveState(); }, 'ghost tiny');
    button(hd, '▶', () => { engine.rack.move(s.id, 1); saveState(); }, 'ghost tiny');
    button(hd, '✕', () => { engine.rack.remove(s.id); saveState(); }, 'ghost tiny');
    toggle(card, reg, `${s.id}.on`, { text: 'ON', cls: 'small' });
    const k = el('div', 's-knobs', card);
    for (const name of Object.keys(s.def.params)) knob(k, reg, `${s.id}.${name}`, { size: 'sm' });
    if (!s.def.noMix) knob(k, reg, `${s.id}.mix`, { size: 'sm' });
    if (s.def.buttons) {
      const b = el('div', 'p-btns', card);
      for (const name of s.def.buttons) {
        const btn = button(b, name, () => s.mod.press(name, btn, s.h), name === 'REC' || name === 'HOLD' ? 'big-ish' : 'small');
      }
    }
    s.mod.build?.(card);
  });
}

function buildChaos() {
  const host = $('#chaos');
  const h = head(host, 'QUBIT CHAOS');
  toggle(h, reg, 'chaos.on', { text: 'ON' });
  const viz = el('canvas', 'chaos-viz', host);
  viz.id = 'chaosViz';
  const grid = el('div', 'k-grid', host);
  for (const id of ['chaos.rate', 'chaos.entropy', 'chaos.entangle', 'chaos.depth', 'chaos.glide']) knob(grid, reg, id, { size: 'sm' });
  el('div', 'l-title', host).textContent = 'CONTROLS';
  const chips = el('div', 'chips', host);
  for (const t of CHAOS_TARGETS) toggle(chips, reg, `chaos.t.${t.id}`, { text: t.label, cls: 'chip' });
}

function buildMaster() {
  const host = $('#master');
  head(host, 'MASTER');
  const wrap = el('div', 'm-wrap', host);
  const eqBox = el('div', 'm-eq', wrap);
  const eh = el('div', 'p-btns', eqBox);
  el('span', 'l-title', eh).textContent = 'MASTER EQ';
  toggle(eh, reg, 'eq.on', { text: 'ON', cls: 'small' });
  button(eh, 'FLAT', () => EQ_BANDS.forEach((b, i) => { reg.set(`eq.${i}.g`, 0, 'ui'); reg.set(`eq.${i}.f`, b.f, 'ui'); reg.set(`eq.${i}.q`, b.q, 'ui'); }), 'ghost small');
  const canvas = el('canvas', 'eq-canvas', eqBox);
  let ed;
  const show = bandTabs(eqBox, 'eq', EQ_BANDS, () => ed);
  ed = new EqEditor(canvas, reg, { prefix: 'eq', bands: EQ_BANDS, onId: 'eq.on', onSelect: show });
  show(0);

  const side = el('div', 'm-side', wrap);
  const g = el('div', 'guard', side);
  const gh = el('div', 'p-btns', g);
  toggle(gh, reg, 'guard.on', { text: 'FEEDBACK GUARD' });
  const gk = el('div', 'p-btns', g);
  knob(gk, reg, 'guard.sens', { size: 'sm' });
  knob(gk, reg, 'master.comp', { size: 'sm' });
  el('div', 'g-list', g).id = 'guardList';
  button(g, 'RESET NOTCHES', () => { engine.resetGuard(); }, 'ghost small');

  const vol = el('div', 'm-vol', side);
  const f = fader(vol, reg, 'master.vol');
  f.root.classList.add('big');
  addMeter(f.canvas, () => engine.outAnalyser);
  toggle(vol, reg, 'master.mon', { text: 'MONITOR', cls: 'mon', title: 'Output to speakers/headphones. Use headphones to avoid feedback.' });
  return ed;
}

// ───────────────────────── loading ─────────────────────────
async function ensureStarted() {
  if (!engine.started) await startAudio();
  return engine.started;
}

async function loadBytes(bytes, name, target) {
  if (!(await ensureStarted())) return;
  try {
    if (target === 'nam') {
      const json = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(json);
      await engine.loadNam(json, name);
      toast(`Amp model: ${name}${parsed.architecture ? ' · ' + parsed.architecture : ''}`);
    } else if (target === 'cab') {
      await engine.loadCabIR(bytes, name);
      reg.set('amp.cab', 1, 'ui');
      toast(`Cab IR: ${name}`);
    } else if (target === 'rev') {
      await engine.loadReverbIR(bytes, name);
      toast(`Reverb IR: ${name}`);
    }
  } catch (err) {
    toast(`Could not load ${name}: ${err.message}`, 'err');
  }
  buildAmp();
}

async function loadFile(file, target) {
  if (target === 'nam' && !/\.nam$/i.test(file.name)) target = 'cab';
  await loadBytes(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''), target);
}

async function loadUrl(url, name, target) {
  toast(`Downloading ${name}…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    await loadBytes(await res.arrayBuffer(), name, target);
  } catch (err) { toast(`Download failed: ${err.message}`, 'err'); }
}

// ───────────────────────── devices + start ─────────────────────────
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const { inputs, outputs } = await engine.listDevices();
  const sel = $('#inputSel');
  const cur = sel.value;
  sel.innerHTML = '';
  const add = (v, t) => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  inputs.forEach((d, i) => add(d.deviceId, d.label || `Audio input ${i + 1}`));
  add('demo', 'Demo riff (no interface)');
  add('file', 'Audio file…');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const out = $('#outputSel');
  if (window.AudioContext && 'setSinkId' in AudioContext.prototype) {
    const oc = out.value;
    out.innerHTML = '';
    const o0 = el('option', '', out); o0.value = ''; o0.textContent = 'Default output';
    outputs.filter((d) => d.deviceId !== 'default').forEach((d, i) => { const o = el('option', '', out); o.value = d.deviceId; o.textContent = d.label || `Output ${i + 1}`; });
    if (oc) out.value = oc;
    out.parentElement.hidden = false;
  }
}

async function chooseInput(value) {
  if (!(await ensureStarted())) return;
  try {
    if (value === 'demo') { engine.useDemo(); setInputLabel('Demo riff'); }
    else if (value === 'file') { $('#fileInput').click(); }
    else {
      setInputLabel(await engine.useDevice(value));
      try { localStorage.setItem('dsd.input', value); } catch { /* storage blocked */ }
      await refreshDevices();
      $('#inputSel').value = value;
    }
  } catch (err) { toast(`Input error: ${err.message}`, 'err'); }
}

function setInputLabel(text) { $('#inputName').textContent = text; }

async function startAudio() {
  const btn = $('#startBtn');
  try {
    btn.disabled = true;
    btn.textContent = 'STARTING…';
    await engine.start();
    engine.rack.onChange = () => { renderRack(); saveState(); };
    if (pendingRack) { for (const s of pendingRack) engine.rack.add(s.type, s); pendingRack = null; }
    renderRack();
    document.body.classList.add('live');
    btn.textContent = 'LIVE';
    btn.classList.add('live');
    $('#latency').textContent = `${engine.sampleRate / 1000} kHz · ${engine.latencyMs().toFixed(1)} ms`;
    let saved = null;
    try { saved = localStorage.getItem('dsd.input'); } catch { /* storage blocked */ }
    try {
      setInputLabel(await engine.useDevice(saved && saved !== 'demo' ? saved : undefined));
      await refreshDevices();
    } catch (err) {
      await refreshDevices();
      $('#inputSel').value = 'demo';
      engine.useDemo();
      setInputLabel('Demo riff');
      toast(`No input (${err.name || err.message}). Playing the demo riff.`, 'warn');
    }
    $('#monitorDialog').showModal();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'START';
    toast(`Audio failed to start: ${err.message}`, 'err');
  }
}

// ───────────────────────── TONE3000 ─────────────────────────
let t3kTone = null;
function openT3k() {
  $('#t3kKey').value = t3k.key;
  $('#t3kRedirect').textContent = redirectUri();
  renderT3k();
  $('#t3kDialog').showModal();
}

function renderT3k(models) {
  $('#t3kStatus').textContent = t3k.connected ? 'Connected to TONE3000' : 'Not connected';
  const list = $('#t3kModels');
  list.innerHTML = '';
  if (!t3kTone) return;
  el('div', 't3k-tone', list).textContent = `${t3kTone.title}${t3kTone.user ? ' — by ' + (t3kTone.user.display_name || t3kTone.user.username) : ''}`;
  if (!models) { el('div', 'hint', list).textContent = 'Loading models…'; return; }
  if (!models.length) { el('div', 'hint', list).textContent = 'No downloadable models for that architecture.'; return; }
  for (const m of models) {
    const row = el('div', 't3k-row', list);
    el('span', '', row).textContent = `${m.name}${m.size ? ' · ' + m.size : ''}${m.architecture_version ? ' · A' + m.architecture_version : ''}`;
    const isIr = t3kTone.format === 'ir' || /\.(wav|aiff?)$/i.test(m.model_url);
    for (const [label, target] of isIr ? [['→ CAB', 'cab'], ['→ REVERB', 'rev']] : [['→ AMP', 'nam']]) {
      button(row, label, async () => {
        try { toast(`Downloading ${m.name}…`); await loadBytes(await t3k.file(m.model_url), `${t3kTone.title} · ${m.name}`, target); }
        catch (err) { toast(err.message, 'err'); }
      }, 'small');
    }
  }
}

async function t3kPick(kind) {
  t3k.setKey($('#t3kKey').value);
  const arch = $('#t3kArch').value;
  const opts = kind === 'ir' ? { format: 'ir' } : { format: 'nam', gears: kind === 'amp' ? 'amp_amp-cab_pedal' : undefined, architecture: arch };
  try {
    const { toneId } = await t3k.select(opts);
    t3kTone = await t3k.tone(toneId);
    renderT3k();
    renderT3k(await t3k.models(toneId, kind === 'ir' ? undefined : arch));
  } catch (err) { toast(err.message, 'err'); renderT3k(); }
}

// ───────────────────────── presets + persistence ─────────────────────────
const PRESETS = {
  'Clean W/D/W': { 'amp.gain': -4, 'amp.boost': 0, 'wdw.dry': 0.79, 'wdw.wet': 0.72, 'wdw.width': 1.3, 'wdw.mode': 1, 'dly.send': 0.55, 'rev.send': 0.6, 'cho.send': 0.45, 'dbl.send': 0, 'dly.time': 0.38, 'dly.fb': 0.3, 'rev.size': 2.6, 'chaos.on': 0 },
  'Tight Rhythm': { 'amp.gain': 8, 'amp.boost': 1, 'amp.drive': 0.3, 'amp.mid': 2, 'wdw.dry': 0.82, 'wdw.wet': 0.5, 'dly.send': 0.3, 'rev.send': 0.35, 'rev.size': 1.1, 'cho.send': 0, 'dbl.send': 0.6, 'chaos.on': 0 },
  'Ambient Wide': { 'amp.gain': -2, 'wdw.dry': 0.6, 'wdw.wet': 0.85, 'wdw.width': 1.8, 'dly.send': 0.7, 'dly.fb': 0.6, 'dly.time': 0.62, 'rev.send': 0.8, 'rev.size': 7, 'cho.send': 0.55, 'cho.rate': 0.25, 'chaos.on': 0 },
  'Chaos Garden': { 'wdw.dry': 0.7, 'wdw.wet': 0.8, 'dly.send': 0.6, 'rev.send': 0.65, 'cho.send': 0.5, 'dbl.send': 0.4, 'chaos.on': 1, 'chaos.rate': 0.4, 'chaos.entropy': 0.5, 'chaos.depth': 0.7, 'chaos.t.time': 1, 'chaos.t.filter': 1 },
  'Vocal Tune (Werckmeister)': { 'tune.on': 1, 'tune.temper': 1, 'tune.scale': 1, 'tune.speed': 25, 'tune.amount': 1, 'amp.on': 0, 'wdw.dry': 0.8, 'wdw.wet': 0.6, 'dly.send': 0.4, 'rev.send': 0.55, 'cho.send': 0, 'dbl.send': 0.35, 'gate.thr': -50 },
};

const persistSnap = () => reg.snapshot((p) => p.persist && !/^r\d+\./.test(p.id));

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STATE_KEY, JSON.stringify({ params: persistSnap(), rack: engine.rack?.save() ?? pendingRack ?? [] })); } catch { /* storage blocked */ }
  }, 400);
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    reg.restore(s.params, 'load');
    pendingRack = s.rack ?? null;
  } catch { /* ignore broken state */ }
}

function buildPresets() {
  const sel = $('#presetSel');
  const add = (v, t) => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  add('', 'PRESETS');
  for (const n of Object.keys(PRESETS)) add(n, n);
  add('__export', 'Export to file…');
  add('__import', 'Import from file…');
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (v === '__export') {
      download(new Blob([JSON.stringify({ app: 'DawSynthDoom', version: 2, params: persistSnap(), rack: engine.rack?.save() ?? [] }, null, 2)], { type: 'application/json' }), 'dawsynthdoom-preset.json');
    } else if (v === '__import') $('#presetFile').click();
    else if (v) {
      const keep = /^(in\.|eq\.|pre\.|master\.|guard\.|gate\.)/;
      const defaults = {};
      for (const p of reg.params.values()) if (p.persist && !keep.test(p.id) && !/^r\d+\./.test(p.id)) defaults[p.id] = p.def;
      reg.restore({ ...defaults, ...PRESETS[v] }, 'ui');
      toast(`Preset: ${v}`);
    }
  });
  $('#presetFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      reg.restore(o.params, 'ui');
      if (o.rack && engine.rack) { engine.rack.clear(); for (const s of o.rack) engine.rack.add(s.type, s); }
      toast(`Preset imported: ${f.name}`);
    } catch (err) { toast(`Bad preset file: ${err.message}`, 'err'); }
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ───────────────────────── live views ─────────────────────────
const sdr = new SdrDisplay($('#sdrCanvas'));
let sdrSource = 'out';

function drawChaos() {
  const c = $('#chaosViz');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  const active = reg.get('chaos.on') >= 0.5;
  // Bloch sphere of qubit A (x/z projection, y as dot size)
  const r = Math.min(h / 2 - 12, 56), cx = r + 14, cy = h / 2;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.ellipse(cx, cy, r, r * 0.3, 0, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();
  const b = chaos.bloch;
  const px = cx + b.x * r, py = cy - b.z * r;
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(px, py); g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(px, py, 4 + (b.y + 1) * 2, 0, Math.PI * 2); g.fill();
  g.font = '600 9px ui-monospace, monospace';
  g.fillText('|0⟩', cx - 8, cy - r - 3);
  g.fillText('|1⟩', cx - 8, cy + r + 10);
  // basis probabilities
  const labels = ['00', '01', '10', '11'];
  const bx = cx + r + 26, bw = (w - bx - 10) / 4;
  chaos.p.forEach((p, i) => {
    const x = bx + i * bw, bh = (h - 34) * p;
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(x + 3, 10, bw - 6, h - 34);
    g.fillStyle = chaos.lastMeasured === i && chaos.flash > 0 ? '#fff' : 'rgba(255,255,255,0.8)';
    g.fillRect(x + 3, 10 + (h - 34) - bh, bw - 6, bh);
    g.fillStyle = '#fff';
    g.fillText(`|${labels[i]}⟩`, x + bw / 2 - 12, h - 10);
  });
  if (chaos.flash > 0 && active) {
    g.globalAlpha = chaos.flash;
    g.fillStyle = '#fff';
    g.font = '14px "Permanent Marker", system-ui';
    g.fillText(`MEASURED |${labels[chaos.lastMeasured]}⟩`, bx, 24);
    g.globalAlpha = 1;
  }
  if (!active) { g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, w, h); }
}

let lastT = performance.now(), lastGuard = 0;
const meterBuf = new Float32Array(1024);
let preEd, masterEd;

function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  const dt = (t - lastT) / 1000;
  lastT = t;

  const chaosOn = reg.get('chaos.on') >= 0.5;
  if (chaosOn) {
    const out = chaos.step(dt, { rate: reg.get('chaos.rate'), entropy: reg.get('chaos.entropy'), entangle: reg.get('chaos.entangle'), glide: reg.get('chaos.glide') });
    engine.applyChaos(out, reg.get('chaos.depth'));
  } else if (engine.chaos) engine.applyChaos(null, 0);
  drawChaos();

  if (engine.started && t - lastGuard > 100) {
    lastGuard = t;
    engine.guardTick(reg.get('guard.on') >= 0.5, reg.get('guard.sens'));
    const list = $('#guardList');
    const ns = engine.guard.notches;
    list.textContent = reg.get('guard.on') < 0.5 ? 'off' : ns.length
      ? ns.map((n) => `${n.freq < 1000 ? Math.round(n.freq) : (n.freq / 1000).toFixed(2) + 'k'} ${Math.round(n.gain)}dB`).join(' · ')
      : 'listening · no feedback';
    list.classList.toggle('alert', engine.guard.duck === 1);
    sdr.notches = ns;
  }

  for (const m of meters) {
    const a = m.analyser?.();
    let peak = 0, rms = 0;
    if (a && engine.started) {
      a.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > peak) peak = v; sum += v * v; }
      rms = Math.sqrt(sum / meterBuf.length);
    }
    if (peak >= m.hold || t - m.t > 1200) { m.hold = Math.max(peak, m.hold * 0.9); if (peak >= m.hold) m.t = t; }
    drawMeter(m.canvas, peak, rms, m.hold);
  }

  if (engine.started) {
    const src = sdrSource === 'in' ? engine.inAnalyser : engine.outAnalyser;
    sdr.label = sdrSource === 'in' ? 'INPUT' : 'OUTPUT';
    sdr.draw(src);
    preEd.draw(engine.preAnalyser);
    masterEd.draw(engine.mixAnalyser);
  } else {
    sdr.draw(null);
    preEd.draw(null);
    masterEd.draw(null);
  }
}

// ───────────────────────── boot ─────────────────────────
defineParams();
buildInput();
preEd = buildPreEq();
buildTune();
buildAmp();
buildWdw();
buildRack();
buildChaos();
masterEd = buildMaster();
buildPresets();
loadState();
renderRack();

engine.onStatus = (kind, text) => {
  if (kind.endsWith('error')) toast(text, 'err');
  else if (kind === 'guard') toast(text, 'warn');
  if (kind.startsWith('nam')) buildAmp();
};
engine.onFront = (d) => {
  const led = $('#gateLed');
  if (led) led.classList.toggle('open', d.gate > 0.5);
  if (reg.get('tune.on') < 0.5) { $('#tNote').textContent = '—'; $('#tInfo').textContent = 'well-tempered pitch correction'; sdr.info = ''; return; }
  if (d.f0) {
    $('#tNote').textContent = d.target;
    const err = Math.max(-50, Math.min(50, d.err));
    $('#tNeedle').style.left = `${50 + err}%`;
    $('#tInfo').textContent = `${d.f0.toFixed(1)} Hz · ${err > 0 ? '+' : ''}${err.toFixed(0)}¢ · ${reg.param('tune.temper').format()} ${d.tcents >= 0 ? '+' : ''}${d.tcents.toFixed(1)}¢`;
    sdr.info = `TUNE ${d.target} ${err > 0 ? '+' : ''}${err.toFixed(0)}¢ → ${reg.param('tune.temper').format()}`;
  }
};
reg.onChange(() => saveState());

$('#startBtn').addEventListener('click', () => { if (!engine.started) startAudio(); });
$('#inputSel').addEventListener('change', (e) => chooseInput(e.target.value));
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await engine.useFile(f); setInputLabel(f.name); } catch (err) { toast(`Could not play ${f.name}: ${err.message}`, 'err'); }
});
$('#outputSel').addEventListener('change', async (e) => {
  try { await engine.setOutputDevice(e.target.value); toast('Output device changed'); } catch (err) { toast(`Output error: ${err.message}`, 'err'); }
});
const chHost = $('#chSel');
for (let i = 0; i < 3; i++) {
  const b = button(chHost, reg.param('in.ch').options[i], () => reg.set('in.ch', i, 'ui'), 'seg');
  reg.param('in.ch').widgets.add({ update: (v) => b.classList.toggle('on', v === i) });
  b.classList.toggle('on', reg.get('in.ch') === i);
}
for (const [src, label] of [['in', 'IN'], ['out', 'OUT']]) {
  const b = button($('#sdrSrc'), label, () => {
    sdrSource = src;
    document.querySelectorAll('#sdrSrc .btn').forEach((x) => x.classList.toggle('on', x === b));
  }, 'seg');
  b.classList.toggle('on', src === sdrSource);
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());
refreshDevices();

$('#monYes').addEventListener('click', () => { reg.set('master.mon', 1, 'ui'); $('#monitorDialog').close(); });
$('#monNo').addEventListener('click', () => { $('#monitorDialog').close(); toast('Monitor is off. Turn it on in MASTER when you have headphones.', 'warn'); });

let recording = false;
$('#recBtn').addEventListener('click', async () => {
  if (!(await ensureStarted())) return;
  const b = $('#recBtn');
  if (!recording) {
    try { engine.startRecording(); } catch (err) { toast(`Recording unsupported: ${err.message}`, 'err'); return; }
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

$('#t3kBtn').addEventListener('click', openT3k);
$('#t3kClose').addEventListener('click', () => $('#t3kDialog').close());
$('#t3kKey').addEventListener('change', (e) => t3k.setKey(e.target.value));
$('#t3kAmp').addEventListener('click', () => t3kPick('amp'));
$('#t3kAll').addEventListener('click', () => t3kPick('nam'));
$('#t3kIr').addEventListener('click', () => t3kPick('ir'));
$('#t3kCopy').addEventListener('click', () => navigator.clipboard?.writeText(redirectUri()).then(() => toast('Redirect URL copied')));
$('#t3kDisconnect').addEventListener('click', () => { t3k.disconnect(); t3kTone = null; renderT3k(); });
$('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpClose').addEventListener('click', () => $('#helpDialog').close());

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.nam$/i.test(f.name)) loadFile(f, 'nam');
  else if (/\.(wav|aiff?|flac|mp3)$/i.test(f.name)) loadFile(f, 'cab');
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, [role="slider"]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!engine.started) startAudio();
    else reg.set('master.mon', reg.get('master.mon') >= 0.5 ? 0 : 1, 'ui');
  }
});

requestAnimationFrame(frame);

// console handle for debugging
window.dsd = { engine, reg };
