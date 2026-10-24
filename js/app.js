import { Registry } from './params.js';
import { knob, fader, toggle, button, hslider, drawMeter, el } from './ui.js';
import { Engine, STRIPS, EQ_BANDS, faderGain } from './engine.js';
import { Scope, noteName } from './scope.js';
import { EqEditor, BAND_COLORS } from './eq.js';
import { Automation, Scenes } from './automation.js';
import { Tone3000, redirectUri } from './tone3000.js';

const $ = (s) => document.querySelector(s);
const STATE_KEY = 'dsd.state.v1';
const STARTER_BASE = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/refs/heads/main/ui/public/';
const STARTERS = {
  nam: [
    { name: 'Vox AC10', url: STARTER_BASE + 'models/ac10.nam' },
    { name: 'Fender Deluxe Reverb', url: STARTER_BASE + 'models/deluxe.nam' },
  ],
  cab: [{ name: 'Celestion cab', url: STARTER_BASE + 'irs/celestion.wav' }],
  rev: [{ name: 'EMT 140 Plate', url: STARTER_BASE + 'irs/plate.wav' }],
};

const reg = new Registry();
const engine = new Engine(reg);
const autom = new Automation(reg);
const scenes = new Scenes(reg);
const t3k = new Tone3000();
const strip = Object.fromEntries(STRIPS.map((s) => [s.id, s]));
let selected = 'amp';
let scopeSource = 'out';

// ───────────────────────── toast ─────────────────────────
function toast(text, kind = '') {
  const t = el('div', `toast ${kind}`, $('#toasts'));
  t.textContent = text;
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

// ───────────────────────── parameters ─────────────────────────
const on = () => engine.started;
const dB = { unit: 'dB' };

function defineParams() {
  reg.define('in.trim', { label: 'INPUT', min: -24, max: 24, def: 0, ...dB, apply: (v) => on() && engine.inTrim.gain.setTargetAtTime(10 ** (v / 20), engine.ctx.currentTime, 0.02) });
  reg.define('in.ch', { label: 'CHANNEL', min: 0, max: 2, def: 0, step: 1, options: ['IN 1', 'IN 2', '1+2'], apply: (v) => engine.applyChannel(v) });

  reg.define('master.vol', { label: 'MASTER', def: 0.72, format: fmtFader, apply: (v) => on() && engine.master.gain.setTargetAtTime(faderGain(v), engine.ctx.currentTime, 0.015) });
  reg.define('master.comp', { label: 'GLUE', def: 0.25, unit: '%', apply: (v) => on() && engine.setComp(v) });
  reg.define('master.limit', { label: 'LIMIT', def: 1, step: 1, morph: false, apply: (v) => on() && engine.setLimiter(v >= 0.5) });
  reg.define('master.mon', { label: 'MONITOR', def: 1, step: 1, morph: false, persist: false, apply: (v) => on() && engine.monitor.gain.setTargetAtTime(v >= 0.5 ? 1 : 0, engine.ctx.currentTime, 0.01) });

  reg.define('eq.on', { label: 'EQ', def: 1, step: 1, morph: false, apply: () => applyEq() });
  EQ_BANDS.forEach((b, i) => {
    reg.define(`eq.${i}.f`, { label: 'FREQ', min: 20, max: 20000, def: b.f, scale: 'log', unit: 'Hz', apply: () => applyEq(i) });
    reg.define(`eq.${i}.g`, { label: 'GAIN', min: -18, max: 18, def: 0, ...dB, apply: () => applyEq(i) });
    reg.define(`eq.${i}.q`, { label: 'Q', min: 0.3, max: 10, def: b.q, scale: 'log', apply: () => applyEq(i) });
  });

  reg.define('mix.autolvl', { label: 'AUTO LEVEL', def: 0, step: 1, morph: false });
  reg.define('mix.target', { label: 'TARGET', min: -36, max: -8, def: -20, ...dB });
  reg.define('mix.morph', { label: 'A ⇄ B', def: 0, morph: false, apply: (v, src) => { if (src !== 'load') scenes.morph(v); } });
  reg.define('mix.autoMorph', { label: 'AUTO MORPH', def: 0, step: 1, morph: false });
  reg.define('mix.morphRate', { label: 'CYCLE', min: 2, max: 60, def: 16, scale: 'log', unit: 's' });
  reg.define('auto.len', { label: 'LOOP', min: 2, max: 32, def: 8, step: 1, format: (v) => v + 's', apply: (v) => { autom.length = v; } });
  reg.define('scope.zoom', { label: 'ZOOM', def: 0.45, morph: false, apply: (v) => { scope.zoom = v; } });

  const levels = { dry: 0.62, amp: 0.79, drv: 0, dly: 0.5, rev: 0.5, mod: 0, syn: 0 };
  for (const s of STRIPS) {
    reg.define(`${s.id}.lvl`, { label: 'LEVEL', def: levels[s.id], format: fmtFader, apply: (v) => engine.setLevel(s.id, v) });
    reg.define(`${s.id}.pan`, { label: 'PAN', min: -1, max: 1, def: 0, format: fmtPan, apply: (v) => engine.setPan(s.id, v) });
    reg.define(`${s.id}.mute`, { label: 'M', def: 0, step: 1, morph: false, apply: () => engine.updateSolo() });
    reg.define(`${s.id}.solo`, { label: 'S', def: 0, step: 1, morph: false, persist: false, apply: () => engine.updateSolo() });
  }

  const filt = (node) => (v) => on() && node().frequency.setTargetAtTime(v, engine.ctx.currentTime, 0.02);
  const S = (id) => engine.strips[id];
  reg.define('dry.lo', { label: 'LO CUT', min: 20, max: 600, def: 20, scale: 'log', unit: 'Hz', apply: filt(() => S('dry').lo) });
  reg.define('dry.hi', { label: 'HI CUT', min: 1000, max: 20000, def: 20000, scale: 'log', unit: 'Hz', apply: filt(() => S('dry').hi) });

  const gainDb = (node) => (v) => on() && node().gain.setTargetAtTime(10 ** (v / 20), engine.ctx.currentTime, 0.02);
  const shelf = (node) => (v) => on() && node().gain.setTargetAtTime(v, engine.ctx.currentTime, 0.02);
  reg.define('amp.gain', { label: 'GAIN', min: -24, max: 24, def: 0, ...dB, apply: gainDb(() => S('amp').pre) });
  reg.define('amp.out', { label: 'OUTPUT', min: -24, max: 12, def: 0, ...dB, apply: gainDb(() => S('amp').out) });
  reg.define('amp.bass', { label: 'BASS', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => S('amp').bass) });
  reg.define('amp.mid', { label: 'MID', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => S('amp').mid) });
  reg.define('amp.treb', { label: 'TREBLE', min: -12, max: 12, def: 0, ...dB, apply: shelf(() => S('amp').treb) });
  reg.define('amp.cab', { label: 'CAB IR', def: 1, step: 1, morph: false, apply: () => on() && engine.setCab(reg.get('amp.cab') >= 0.5, reg.get('amp.cabMix')) });
  reg.define('amp.cabMix', { label: 'CAB MIX', def: 1, unit: '%', apply: () => on() && engine.setCab(reg.get('amp.cab') >= 0.5, reg.get('amp.cabMix')) });
  reg.define('amp.norm', { label: 'NORMALIZE', def: 1, step: 1, morph: false, apply: () => engine.applyAmpRouting() });

  reg.define('drv.drive', { label: 'DRIVE', def: 0.45, unit: '%', apply: () => on() && engine.setDrive() });
  reg.define('drv.tone', { label: 'TONE', min: 400, max: 12000, def: 3800, scale: 'log', unit: 'Hz', apply: filt(() => S('drv').tone) });
  reg.define('drv.type', { label: 'TYPE', min: 0, max: 3, def: 0, step: 1, options: ['SOFT', 'HARD', 'FUZZ', 'FOLD'], apply: () => on() && engine.setDrive() });

  const send = (id) => (v) => on() && engine.setSendSource(id, v >= 0.5);
  reg.define('dly.time', { label: 'TIME', min: 0.03, max: 1.5, def: 0.38, scale: 'log', unit: 's', apply: (v) => on() && S('dly').delay.delayTime.setTargetAtTime(v, engine.ctx.currentTime, 0.05) });
  reg.define('dly.fb', { label: 'FEEDBACK', max: 0.92, def: 0.35, unit: '%', apply: (v) => on() && S('dly').fb.gain.setTargetAtTime(v, engine.ctx.currentTime, 0.02) });
  reg.define('dly.tone', { label: 'TONE', min: 500, max: 12000, def: 4500, scale: 'log', unit: 'Hz', apply: filt(() => S('dly').tone) });
  reg.define('dly.src', { label: 'SEND', min: 0, max: 1, def: 1, step: 1, options: ['INPUT', 'AMP'], apply: send('dly') });

  reg.define('rev.size', { label: 'SIZE', min: 0.4, max: 8, def: 2.4, scale: 'log', unit: 's', apply: () => on() && engine.regenReverb() });
  reg.define('rev.pre', { label: 'PRE-DLY', min: 0, max: 0.2, def: 0.02, unit: 's', apply: (v) => on() && S('rev').pre.delayTime.setTargetAtTime(v, engine.ctx.currentTime, 0.05) });
  reg.define('rev.tone', { label: 'TONE', min: 800, max: 16000, def: 6000, scale: 'log', unit: 'Hz', apply: filt(() => S('rev').tone) });
  reg.define('rev.src', { label: 'SEND', min: 0, max: 1, def: 1, step: 1, options: ['INPUT', 'AMP'], apply: send('rev') });

  reg.define('mod.rate', { label: 'RATE', min: 0.05, max: 8, def: 0.6, scale: 'log', unit: 'Hz', format: (v) => v.toFixed(2) + 'Hz', apply: () => on() && engine.setMod() });
  reg.define('mod.depth', { label: 'DEPTH', def: 0.5, unit: '%', apply: () => on() && engine.setMod() });
  reg.define('mod.fb', { label: 'FEEDBACK', max: 0.85, def: 0.1, unit: '%', apply: () => on() && engine.setMod() });
  reg.define('mod.src', { label: 'SEND', min: 0, max: 1, def: 1, step: 1, options: ['INPUT', 'AMP'], apply: send('mod') });

  const syn = (name, map = (v) => v) => (v) => on() && engine.setSynth(name, map(v));
  reg.define('syn.wave', { label: 'WAVE', min: 0, max: 3, def: 0, step: 1, options: ['SAW', 'SQUARE', 'TRI', 'SINE'], apply: syn('wave') });
  reg.define('syn.oct', { label: 'OCTAVE', min: -2, max: 2, def: 0, step: 1, format: (v) => (v > 0 ? '+' : '') + v + ' oct', apply: syn('octave') });
  reg.define('syn.cut', { label: 'CUTOFF', min: 60, max: 8000, def: 900, scale: 'log', unit: 'Hz', apply: syn('cutoff') });
  reg.define('syn.env', { label: 'ENV MOD', def: 0.6, unit: '%', apply: syn('envAmt') });
  reg.define('syn.reso', { label: 'RESO', max: 0.95, def: 0.45, unit: '%', apply: syn('reso') });
  reg.define('syn.sub', { label: 'SUB', def: 0.3, unit: '%', apply: syn('sub') });
  reg.define('syn.glide', { label: 'GLIDE', min: 0, max: 400, def: 25, format: (v) => Math.round(v) + 'ms', apply: syn('glide') });
  reg.define('syn.gate', { label: 'GATE', min: -70, max: -20, def: -48, ...dB, apply: syn('gate', (v) => 10 ** (v / 20)) });
}

function fmtFader(v) {
  const g = faderGain(v);
  if (g <= 0) return '-∞';
  const d = 20 * Math.log10(g);
  return (d > 0 ? '+' : '') + d.toFixed(1);
}
function fmtPan(v) {
  if (Math.abs(v) < 0.02) return 'C';
  return (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
}

function applyEq(only) {
  if (!on()) return;
  const enabled = reg.get('eq.on') >= 0.5;
  EQ_BANDS.forEach((_, i) => {
    if (only !== undefined && only !== i) return;
    engine.setEq(i, enabled, reg.get(`eq.${i}.f`), reg.get(`eq.${i}.g`), reg.get(`eq.${i}.q`));
  });
}

// ───────────────────────── mixer strips ─────────────────────────
const MAIN_KNOBS = {
  dry: ['dry.lo', 'dry.hi'],
  amp: ['amp.gain', 'amp.out'],
  drv: ['drv.drive', 'drv.tone'],
  dly: ['dly.time', 'dly.fb'],
  rev: ['rev.size', 'rev.tone'],
  mod: ['mod.rate', 'mod.depth'],
  syn: ['syn.wave', 'syn.cut'],
};
const DETAIL_KNOBS = {
  dry: ['dry.lo', 'dry.hi'],
  amp: ['amp.gain', 'amp.bass', 'amp.mid', 'amp.treb', 'amp.out', 'amp.cabMix'],
  drv: ['drv.drive', 'drv.tone', 'drv.type'],
  dly: ['dly.time', 'dly.fb', 'dly.tone', 'dly.src'],
  rev: ['rev.size', 'rev.pre', 'rev.tone', 'rev.src'],
  mod: ['mod.rate', 'mod.depth', 'mod.fb', 'mod.src'],
  syn: ['syn.wave', 'syn.oct', 'syn.cut', 'syn.env', 'syn.reso', 'syn.sub', 'syn.glide', 'syn.gate'],
};
const meters = [];   // { canvas, analyser(), hold, t }

function buildStrips() {
  const host = $('#strips');
  for (const s of STRIPS) {
    const root = el('div', 'strip', host);
    root.dataset.id = s.id;
    root.style.setProperty('--accent', s.color);
    const head = el('button', 's-head', root);
    head.type = 'button';
    head.innerHTML = `<span class="s-name"></span><span class="s-sub"></span>`;
    head.querySelector('.s-name').textContent = s.name;
    head.addEventListener('click', () => select(s.id));
    const knobs = el('div', 's-knobs', root);
    for (const id of MAIN_KNOBS[s.id]) knob(knobs, reg, id, { size: 'md', color: s.color });
    const mid = el('div', 's-mid', root);
    knob(mid, reg, `${s.id}.pan`, { size: 'sm', color: s.color });
    const ms = el('div', 's-ms', mid);
    toggle(ms, reg, `${s.id}.mute`, { text: 'M', cls: 'mute', title: 'Mute' });
    toggle(ms, reg, `${s.id}.solo`, { text: 'S', cls: 'solo', title: 'Solo' });
    const fw = el('div', 's-fader', root);
    const f = fader(fw, reg, `${s.id}.lvl`, { color: s.color });
    meters.push({ canvas: f.canvas, analyser: () => engine.strips[s.id]?.post, hold: 0, t: 0 });
    el('div', 's-auto', root).dataset.auto = s.id;
  }
}

function select(id) {
  selected = id;
  document.querySelectorAll('.strip').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
  buildDetail();
  if (scopeSource !== 'in' && scopeSource !== 'out') setScopeSource(id);
}

function stripSub() {
  const subs = {
    amp: engine.nam.loaded ? engine.nam.name : 'built-in amp',
    rev: engine.revIR.name,
    dly: `from ${reg.param('dly.src').format()}`,
    mod: `from ${reg.param('mod.src').format()}`,
    syn: 'pitch tracking',
    drv: reg.param('drv.type').format(),
    dry: 'clean input',
  };
  document.querySelectorAll('.strip').forEach((n) => {
    n.querySelector('.s-sub').textContent = subs[n.dataset.id] ?? '';
  });
}

// ───────────────────────── detail panel ─────────────────────────
function buildDetail() {
  const host = $('#detail');
  host.innerHTML = '';
  const s = strip[selected];
  host.style.setProperty('--accent', s.color);
  const h = el('div', 'panel-head', host);
  el('h2', '', h).textContent = s.name;
  el('span', 'hint', h).textContent = 'tap a strip name to edit it here';
  const grid = el('div', 'd-knobs', host);
  for (const id of DETAIL_KNOBS[selected]) knob(grid, reg, id, { size: 'md', color: s.color });

  if (selected === 'amp') {
    const t = el('div', 'd-row', host);
    toggle(t, reg, 'amp.cab', { text: 'CAB IR' });
    toggle(t, reg, 'amp.norm', { text: 'NORMALIZE', title: 'Match loudness of NAM models' });
    loaderBlock(host, 'NAM AMP MODEL', engine.nam.loaded ? engine.nam.name : 'Built-in amp (no model loaded)', '.nam', 'nam');
    loaderBlock(host, 'CAB IMPULSE RESPONSE', engine.cab.name, '.wav,.aif,.aiff,.flac,.mp3', 'cab');
    const tb = el('div', 'd-row', host);
    button(tb, '◎ TONE3000', () => openT3k(), 'accent');
    if (engine.nam.loaded) button(tb, 'Unload model', async () => { await engine.unloadNam(); stripSub(); buildDetail(); });
  } else if (selected === 'rev') {
    loaderBlock(host, 'REVERB IMPULSE RESPONSE', engine.revIR.name, '.wav,.aif,.aiff,.flac,.mp3', 'rev');
    const tb = el('div', 'd-row', host);
    button(tb, '◎ TONE3000 IR', () => openT3k(), 'accent');
    if (engine.revIR.user) button(tb, 'Use built-in', () => { engine.resetReverbIR(); stripSub(); buildDetail(); });
  } else if (selected === 'dly') {
    const t = el('div', 'd-row', host);
    let taps = [];
    button(t, 'TAP TEMPO', () => {
      const now = performance.now();
      taps = taps.filter((x) => now - x < 2500);
      taps.push(now);
      if (taps.length >= 2) {
        const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1) / 1000;
        reg.set('dly.time', avg, 'ui');
      }
    }, 'big');
    for (const [label, div] of [['1/4', 1], ['1/8.', 0.75], ['1/8', 0.5], ['1/16', 0.25]]) {
      button(t, label, () => {
        const beat = Number($('#bpm').value) || 120;
        reg.set('dly.time', (60 / beat) * div, 'ui');
      });
    }
    const bpm = el('label', 'bpm', t);
    bpm.innerHTML = 'BPM <input id="bpm" type="number" min="40" max="240" value="120">';
  } else if (selected === 'syn') {
    const p = el('div', 'd-pitch', host);
    p.innerHTML = '<span class="note" id="synNote">—</span><span class="hz" id="synHz">play a single note</span>';
    el('p', 'hint', host).textContent = 'Monophonic: the synth follows the pitch and loudness of your instrument or voice. Play single notes cleanly; raise GATE if it chatters.';
  } else if (selected === 'dry') {
    el('p', 'hint', host).textContent = 'The clean input, straight to the mix bus. Every other branch runs in parallel next to it.';
  }
}

function loaderBlock(host, title, current, accept, target) {
  const box = el('div', 'loader', host);
  el('div', 'l-title', box).textContent = title;
  el('div', 'l-name', box).textContent = current;
  const row = el('div', 'd-row', box);
  const input = el('input', '', row);
  input.type = 'file';
  input.accept = accept;
  input.hidden = true;
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0], target); input.value = ''; });
  button(row, 'Load file…', () => input.click());
  const starters = STARTERS[target] ?? [];
  for (const st of starters) button(row, st.name, () => loadUrl(st.url, st.name, target), 'ghost');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f, target);
  });
}

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
      const info = await engine.loadNam(json, name);
      const rate = info?.expectedSampleRate > 0 ? info.expectedSampleRate : parsed.sample_rate;
      toast(`Amp model loaded: ${name}${parsed.architecture ? ' · ' + parsed.architecture : ''}`);
      if (rate && rate !== engine.sampleRate) toast(`Model trained at ${rate} Hz; running at ${engine.sampleRate} Hz`, 'warn');
    } else if (target === 'cab') {
      await engine.loadCabIR(bytes, name);
      reg.set('amp.cab', 1, 'ui');
      toast(`Cab IR loaded: ${name}`);
    } else if (target === 'rev') {
      await engine.loadReverbIR(bytes, name);
      toast(`Reverb IR loaded: ${name}`);
    }
  } catch (err) {
    toast(`Could not load ${name}: ${err.message}`, 'err');
  }
  stripSub();
  buildDetail();
}

async function loadFile(file, target) {
  const name = file.name.replace(/\.[^.]+$/, '');
  if (target === 'nam' && !/\.nam$/i.test(file.name) && /\.(wav|aiff?|flac|mp3)$/i.test(file.name)) target = 'cab';
  await loadBytes(await file.arrayBuffer(), name, target);
}

async function loadUrl(url, name, target) {
  toast(`Downloading ${name}…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    await loadBytes(await res.arrayBuffer(), name, target);
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'err');
  }
}

// ───────────────────────── master + eq + auto panels ─────────────────────────
function buildMaster() {
  const m = $('#master');
  const row = el('div', 'm-row', m);
  const inCol = el('div', 'm-col', row);
  knob(inCol, reg, 'in.trim', { size: 'md', color: '#9aa7bd' });
  const inMeter = el('canvas', 'm-meter', inCol);
  meters.push({ canvas: inMeter, analyser: () => engine.inAnalyser, hold: 0, t: 0 });
  const mid = el('div', 'm-col', row);
  knob(mid, reg, 'master.comp', { size: 'md', color: '#2fb4ff' });
  toggle(mid, reg, 'master.limit', { text: 'LIMIT' });
  toggle(mid, reg, 'master.mon', { text: 'MONITOR', cls: 'mon', title: 'Turn off to silence the output (feedback panic)' });
  const out = el('div', 'm-col m-out', row);
  const f = fader(out, reg, 'master.vol', { color: '#e8ecf4' });
  meters.push({ canvas: f.canvas, analyser: () => engine.outAnalyser, hold: 0, t: 0 });
}

function buildEq() {
  const host = $('#eq');
  const head = el('div', 'panel-head', host);
  el('h2', '', head).textContent = 'MASTER EQ';
  toggle(head, reg, 'eq.on', { text: 'ON' });
  button(head, 'FLAT', () => EQ_BANDS.forEach((b, i) => { reg.set(`eq.${i}.g`, 0, 'ui'); reg.set(`eq.${i}.q`, b.q, 'ui'); reg.set(`eq.${i}.f`, b.f, 'ui'); }), 'ghost');
  const canvas = el('canvas', 'eq-canvas', host);
  const bandRow = el('div', 'eq-bands', host);
  const knobsRow = el('div', 'eq-knobs', host);
  const tabs = EQ_BANDS.map((b, i) => {
    const t = button(bandRow, String(i + 1), () => editor.select(i), 'band');
    t.style.setProperty('--accent', BAND_COLORS[i]);
    t.title = b.type;
    return t;
  });
  const showBand = (i) => {
    tabs.forEach((t, k) => t.classList.toggle('on', k === i));
    knobsRow.innerHTML = '';
    for (const k of ['f', 'g', 'q']) knob(knobsRow, reg, `eq.${i}.${k}`, { size: 'md', color: BAND_COLORS[i] });
  };
  const editor = new EqEditor(canvas, reg, showBand);
  showBand(0);
  return editor;
}

function buildAuto() {
  const host = $('#auto');
  el('div', 'panel-head', host).innerHTML = '<h2>AUTO MIX</h2>';

  const lvl = el('div', 'a-sec', host);
  el('div', 'a-title', lvl).textContent = 'Auto level: keeps every branch at the same loudness';
  const lr = el('div', 'a-row', lvl);
  toggle(lr, reg, 'mix.autolvl', { text: 'AUTO LEVEL', cls: 'wide' });
  knob(lr, reg, 'mix.target', { size: 'sm', color: '#1fd18b' });

  const sc = el('div', 'a-sec', host);
  el('div', 'a-title', sc).textContent = 'Scenes: store two mixes, then slide or auto-morph between them';
  const sr = el('div', 'a-row', sc);
  button(sr, 'STORE A', () => { scenes.store('a'); toast('Scene A stored'); saveState(); }, 'scene');
  hslider(sr, reg, 'mix.morph', { color: '#ffd23f', left: 'A', right: 'B' });
  button(sr, 'STORE B', () => { scenes.store('b'); toast('Scene B stored'); saveState(); }, 'scene');
  const sr2 = el('div', 'a-row', sc);
  toggle(sr2, reg, 'mix.autoMorph', { text: 'AUTO MORPH', cls: 'wide' });
  knob(sr2, reg, 'mix.morphRate', { size: 'sm', color: '#ffd23f' });

  const au = el('div', 'a-sec', host);
  el('div', 'a-title', au).textContent = 'Automation: record knob and fader moves, then loop them';
  const ar = el('div', 'a-row', au);
  const rec = button(ar, '● REC', () => autom.setState(autom.state === 'rec' ? 'play' : 'rec'), 'rec');
  const play = button(ar, '▶ PLAY', () => autom.setState(autom.state === 'idle' ? 'play' : 'idle'), 'play');
  button(ar, 'CLEAR', () => { autom.clear(); toast('Automation cleared'); saveState(); }, 'ghost');
  knob(ar, reg, 'auto.len', { size: 'sm', color: '#ff3b5c' });
  const bar = el('div', 'a-progress', au);
  el('div', 'a-bar', bar);
  autom.onState = (s) => {
    rec.classList.toggle('on', s === 'rec');
    play.classList.toggle('on', s !== 'idle');
    play.textContent = s === 'idle' ? '▶ PLAY' : '■ STOP';
    if (s === 'idle') saveState();
  };
}

// ───────────────────────── display ─────────────────────────
const scope = new Scope($('#scope'));

function setScopeSource(src) {
  scopeSource = src;
  document.querySelectorAll('#scopeSrc .btn').forEach((b) => b.classList.toggle('on', b.dataset.src === (src === 'in' || src === 'out' ? src : 'strip')));
}

function buildDisplay() {
  const modes = $('#scopeMode');
  for (const [m, label] of [['scope', 'SCOPE'], ['roll', 'ROLL'], ['spectrum', 'SPECTRUM'], ['both', 'BOTH']]) {
    const b = button(modes, label, () => {
      scope.mode = m;
      modes.querySelectorAll('.btn').forEach((x) => x.classList.toggle('on', x === b));
      try { localStorage.setItem('dsd.scopeMode', m); } catch { /* storage blocked */ }
    }, 'seg');
    b.dataset.mode = m;
  }
  let saved = 'both';
  try { saved = localStorage.getItem('dsd.scopeMode') || 'both'; } catch { /* storage blocked */ }
  scope.mode = saved;
  modes.querySelector(`[data-mode="${saved}"]`)?.classList.add('on');
  const srcs = $('#scopeSrc');
  for (const [s, label] of [['in', 'IN'], ['out', 'OUT'], ['strip', 'STRIP']]) {
    const b = button(srcs, label, () => setScopeSource(s === 'strip' ? selected : s), 'seg');
    b.dataset.src = s;
  }
  setScopeSource('out');
  knob($('#scopeZoom'), reg, 'scope.zoom', { size: 'sm', color: '#ff7a2f' });
}

// ───────────────────────── input / output devices ─────────────────────────
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const { inputs, outputs } = await engine.listInputs();
  const sel = $('#inputSel');
  const cur = sel.value;
  sel.innerHTML = '';
  const add = (v, t) => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  inputs.forEach((d, i) => add(d.deviceId, d.label || `Audio input ${i + 1}`));
  add('demo', 'Demo riff (no interface)');
  add('file', 'Audio file…');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const out = $('#outputSel');
  if (engine.ctx?.setSinkId || (window.AudioContext && 'setSinkId' in AudioContext.prototype)) {
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
    else if (value === 'file') { $('#fileInput').click(); return; }
    else {
      const label = await engine.useDevice(value);
      setInputLabel(label);
      try { localStorage.setItem('dsd.input', value); } catch { /* storage blocked */ }
      await refreshDevices();
      $('#inputSel').value = value || $('#inputSel').value;
    }
  } catch (err) {
    toast(`Input error: ${err.message}`, 'err');
  }
}

function setInputLabel(text) { $('#inputName').textContent = text; }

async function startAudio() {
  const btn = $('#startBtn');
  try {
    btn.disabled = true;
    btn.textContent = 'STARTING…';
    await engine.start();
    document.body.classList.add('live');
    btn.textContent = '● LIVE';
    btn.classList.add('live');
    $('#latency').textContent = `${engine.sampleRate / 1000} kHz · ${engine.latencyMs().toFixed(1)} ms`;
    let saved = null;
    try { saved = localStorage.getItem('dsd.input'); } catch { /* storage blocked */ }
    try {
      const label = await engine.useDevice(saved && saved !== 'demo' ? saved : undefined);
      setInputLabel(label);
      await refreshDevices();
      const match = [...$('#inputSel').options].find((o) => o.textContent === label);
      if (match) $('#inputSel').value = match.value;
      toast('Live input on. Use headphones to avoid feedback.', 'warn');
    } catch (err) {
      await refreshDevices();
      $('#inputSel').value = 'demo';
      engine.useDemo();
      setInputLabel('Demo riff');
      toast(`No input (${err.name || err.message}). Playing the demo riff instead.`, 'warn');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '▶ START AUDIO';
    toast(`Audio failed to start: ${err.message}`, 'err');
  }
}

// ───────────────────────── TONE3000 dialog ─────────────────────────
let t3kTone = null;
function openT3k() {
  const d = $('#t3kDialog');
  $('#t3kKey').value = t3k.key;
  $('#t3kRedirect').textContent = redirectUri();
  renderT3k();
  d.showModal();
}

function renderT3k(models) {
  $('#t3kStatus').textContent = t3k.connected ? 'Connected to TONE3000' : 'Not connected';
  const list = $('#t3kModels');
  list.innerHTML = '';
  if (!t3kTone) return;
  el('div', 't3k-tone', list).textContent = `${t3kTone.title}${t3kTone.user ? ' — by ' + (t3kTone.user.display_name || t3kTone.user.username) : ''}`;
  if (!models) { el('div', 'hint', list).textContent = 'Loading models…'; return; }
  if (!models.length) { el('div', 'hint', list).textContent = 'No downloadable models in this tone for that architecture.'; return; }
  for (const m of models) {
    const row = el('div', 't3k-row', list);
    el('span', '', row).textContent = `${m.name}${m.size ? ' · ' + m.size : ''}${m.architecture_version ? ' · A' + m.architecture_version : ''}`;
    const isIr = t3kTone.format === 'ir' || /\.(wav|aiff?)$/i.test(m.model_url);
    const targets = isIr ? [['→ CAB', 'cab'], ['→ REVERB', 'rev']] : [['→ AMP', 'nam']];
    for (const [label, target] of targets) {
      button(row, label, async () => {
        try {
          toast(`Downloading ${m.name}…`);
          const bytes = await t3k.file(m.model_url);
          await loadBytes(bytes, `${t3kTone.title} · ${m.name}`, target);
        } catch (err) { toast(err.message, 'err'); }
      }, 'small');
    }
  }
}

async function t3kPick(kind) {
  t3k.setKey($('#t3kKey').value);
  const arch = $('#t3kArch').value;
  const opts = kind === 'ir'
    ? { format: 'ir' }
    : { format: 'nam', gears: kind === 'amp' ? 'amp_amp-cab_pedal' : undefined, architecture: arch };
  try {
    const { toneId } = await t3k.select(opts);
    t3kTone = await t3k.tone(toneId);
    renderT3k();
    const models = await t3k.models(toneId, kind === 'ir' ? undefined : arch);
    renderT3k(models);
  } catch (err) {
    toast(err.message, 'err');
    renderT3k();
  }
}

// ───────────────────────── presets + persistence ─────────────────────────
const PRESETS = {
  'Clean + Space': { 'dry.lvl': 0.7, 'amp.lvl': 0.4, 'amp.gain': -6, 'drv.lvl': 0, 'dly.lvl': 0.55, 'rev.lvl': 0.62, 'rev.size': 3.5, 'mod.lvl': 0.45, 'syn.lvl': 0 },
  'Crunch Rhythm': { 'dry.lvl': 0, 'amp.lvl': 0.82, 'amp.gain': 8, 'amp.mid': 3, 'drv.lvl': 0.35, 'drv.drive': 0.3, 'dly.lvl': 0.25, 'rev.lvl': 0.35, 'rev.size': 1.2, 'mod.lvl': 0, 'syn.lvl': 0 },
  'Synth Lead': { 'dry.lvl': 0.3, 'amp.lvl': 0.35, 'drv.lvl': 0, 'dly.lvl': 0.5, 'dly.time': 0.33, 'rev.lvl': 0.5, 'mod.lvl': 0.3, 'syn.lvl': 0.8, 'syn.wave': 0, 'syn.cut': 700, 'syn.env': 0.75, 'syn.reso': 0.6 },
  'Bass Synth': { 'dry.lvl': 0.4, 'amp.lvl': 0, 'drv.lvl': 0.25, 'drv.type': 2, 'dly.lvl': 0, 'rev.lvl': 0.2, 'mod.lvl': 0, 'syn.lvl': 0.85, 'syn.wave': 1, 'syn.oct': -1, 'syn.sub': 0.7, 'syn.cut': 400 },
  'Ambient Wash': { 'dry.lvl': 0.35, 'amp.lvl': 0.3, 'drv.lvl': 0, 'dly.lvl': 0.65, 'dly.fb': 0.7, 'dly.time': 0.62, 'rev.lvl': 0.8, 'rev.size': 7, 'mod.lvl': 0.55, 'mod.rate': 0.2, 'syn.lvl': 0.25, 'syn.wave': 3, 'syn.oct': 1 },
};

function persistSnapshot() { return reg.snapshot((p) => p.persist); }

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ params: persistSnapshot(), scenes: scenes.toJSON(), automation: autom.toJSON() }));
    } catch { /* storage blocked or full */ }
  }, 400);
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    reg.restore(s.params, 'load');
    scenes.fromJSON(s.scenes);
    autom.fromJSON(s.automation);
  } catch { /* ignore broken state */ }
}

function applyPreset(name) {
  const defaults = {};
  for (const p of reg.params.values()) if (p.persist && !p.id.startsWith('eq.') && !p.id.startsWith('in.') && !p.id.startsWith('master.') && !p.id.startsWith('mix.') && !p.id.startsWith('auto.') && !p.id.startsWith('scope.')) defaults[p.id] = p.def;
  reg.restore({ ...defaults, ...PRESETS[name] }, 'ui');
  toast(`Preset: ${name}`);
}

function buildPresets() {
  const sel = $('#presetSel');
  const add = (v, t) => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  add('', 'Presets…');
  for (const n of Object.keys(PRESETS)) add(n, n);
  add('__export', 'Export to file…');
  add('__import', 'Import from file…');
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (v === '__export') {
      const blob = new Blob([JSON.stringify({ app: 'DawSynthDoom', version: 1, params: persistSnapshot(), scenes: scenes.toJSON(), automation: autom.toJSON() }, null, 2)], { type: 'application/json' });
      download(blob, 'dawsynthdoom-preset.json');
    } else if (v === '__import') {
      $('#presetFile').click();
    } else if (v) applyPreset(v);
  });
  $('#presetFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      reg.restore(o.params, 'ui');
      scenes.fromJSON(o.scenes);
      autom.fromJSON(o.automation);
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

// ───────────────────────── main loop ─────────────────────────
let lastAuto = 0;
let morphT0 = performance.now() / 1000;
const meterBuf = new Float32Array(1024);

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();

  const prog = autom.tick();
  const bar = document.querySelector('.a-bar');
  if (bar) bar.style.width = (autom.state === 'idle' ? 0 : prog * 100) + '%';

  if (reg.get('mix.autoMorph') >= 0.5) {
    const period = reg.get('mix.morphRate');
    const t = now / 1000 - morphT0;
    if (!reg.touched.has('mix.morph')) reg.set('mix.morph', 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period), 'auto');
  } else {
    morphT0 = now / 1000 - Math.acos(1 - 2 * reg.get('mix.morph')) / (2 * Math.PI) * reg.get('mix.morphRate');
  }

  if (now - lastAuto > 60) {
    lastAuto = now;
    engine.autoLevelTick(reg.get('mix.autolvl') >= 0.5, reg.get('mix.target'));
    document.querySelectorAll('.s-auto').forEach((n) => {
      const s = engine.strips[n.dataset.auto];
      const auto = reg.get('mix.autolvl') >= 0.5 && s;
      n.textContent = auto ? `auto ${(20 * Math.log10(s.autoGain)).toFixed(1)} dB` : '';
    });
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
    if (peak >= m.hold || now - m.t > 1200) { m.hold = Math.max(peak, m.hold * 0.9); if (peak >= m.hold) m.t = now; }
    drawMeter(m.canvas, peak, rms, m.hold);
  }

  if (engine.started) {
    let src = engine.outAnalyser, ref = engine.inAnalyser, color = '#ff7a2f', label = 'OUTPUT';
    if (scopeSource === 'in') { src = engine.inAnalyser; ref = null; color = '#9aa7bd'; label = 'INPUT'; }
    else if (scopeSource !== 'out') { src = engine.strips[scopeSource].post; color = strip[scopeSource].color; label = strip[scopeSource].name; }
    scope.color = color;
    scope.label = label + (ref ? '  vs  INPUT' : '');
    scope.draw(src, ref, engine.sampleRate);
    eqEditor.draw(engine.mixAnalyser);
  } else {
    scope.draw(null);
    eqEditor.draw(null);
  }
}

// ───────────────────────── boot ─────────────────────────
defineParams();
buildDisplay();
buildMaster();
buildStrips();
const eqEditor = buildEq();
buildAuto();
buildPresets();
loadState();
select('amp');
stripSub();

engine.onStatus = (kind, text) => {
  if (kind.endsWith('error')) toast(text, 'err');
  stripSub();
  if (selected === 'amp') buildDetail();
};
let lastPitch = 0;
engine.onPitch = (d) => {
  scope.info = reg.get('syn.lvl') > 0 && d.freq ? `♪ ${noteName(d.freq)}  ${d.freq.toFixed(1)} Hz` : '';
  if (selected !== 'syn') return;
  const n = $('#synNote'), hz = $('#synHz');
  if (!n) return;
  if (d.freq) { n.textContent = noteName(d.freq); hz.textContent = `${d.freq.toFixed(1)} Hz`; lastPitch = performance.now(); }
  else if (performance.now() - lastPitch > 600) { n.textContent = '—'; hz.textContent = 'play a single note'; }
};

reg.onChange((id) => {
  saveState();
  if (id === 'drv.type' || id.endsWith('.src')) stripSub();
});

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
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());
refreshDevices();

let recording = false;
$('#recBtn').addEventListener('click', async () => {
  if (!(await ensureStarted())) return;
  const b = $('#recBtn');
  if (!recording) {
    try { engine.startRecording(); } catch (err) { toast(`Recording unsupported: ${err.message}`, 'err'); return; }
    recording = true;
    b.classList.add('on');
    b.textContent = '■ STOP REC';
  } else {
    recording = false;
    b.classList.remove('on');
    b.textContent = '● REC';
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

// Drop a .nam or IR anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.nam$/i.test(f.name)) loadFile(f, 'nam');
  else if (/\.(wav|aiff?|flac|mp3)$/i.test(f.name)) loadFile(f, selected === 'rev' ? 'rev' : 'cab');
  else if (/\.json$/i.test(f.name)) { const dt = new DataTransfer(); dt.items.add(f); $('#presetFile').files = dt.files; $('#presetFile').dispatchEvent(new Event('change')); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, [role="slider"]')) return;
  if (e.code === 'Space') { e.preventDefault(); if (!engine.started) startAudio(); else reg.set('master.mon', reg.get('master.mon') >= 0.5 ? 0 : 1, 'ui'); }
});

requestAnimationFrame(frame);
