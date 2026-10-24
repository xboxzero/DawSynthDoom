// Patch editor: a node canvas for the modular synth + visual nodes.
// Drag a node by its title. Drag from an output dot to an input dot to patch.
// Grab an input dot that already has a cable to re-patch it. Tap a cable to delete it.
// Drag the background to pan; pinch or wheel to zoom.

import { Registry } from '../params.js';
import { knob } from '../ui.js';
import { MODULES, FAMILIES, KIND_COLORS, compatible } from './modules.js';
import { VISUALS, Visuals, TEX_W, TEX_H } from './visuals.js';

const ALL = { ...MODULES, ...VISUALS };
const SAVE_KEY = 'dsd.patch.v1';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
const SINGLE = new Set(['tex', 'data', 'gate']);  // inputs that take one cable

const reg = new Registry();
const nodes = new Map();
let edges = [];
let nextId = 1;
let ctx = null, master = null, vis = null;
const view = { x: 40, y: 40, z: 0.85 };
const stage = $('#stage'), world = $('#world'), wires = $('#wires');

function toast(text, kind = '') {
  const t = el('div', `toast ${kind}`, $('#toasts'));
  t.textContent = text;
  setTimeout(() => t.classList.add('out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// ───────────────────────── view ─────────────────────────
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  $('#zoomLabel').textContent = Math.round(view.z * 100) + '%';
}

function zoomAt(cx, cy, z) {
  z = Math.min(2, Math.max(0.25, z));
  const wx = (cx - view.x) / view.z, wy = (cy - view.y) / view.z;
  view.z = z;
  view.x = cx - wx * z;
  view.y = cy - wy * z;
  applyView();
}

function fit() {
  if (!nodes.size) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes.values()) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.el.offsetWidth); y1 = Math.max(y1, n.y + n.el.offsetHeight);
  }
  const r = stage.getBoundingClientRect();
  const z = Math.min(1.2, Math.max(0.25, Math.min((r.width - 40) / (x1 - x0), (r.height - 40) / (y1 - y0))));
  view.z = z;
  view.x = (r.width - (x1 - x0) * z) / 2 - x0 * z;
  view.y = (r.height - (y1 - y0) * z) / 2 - y0 * z;
  applyView();
}

function toWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return [(clientX - r.left - view.x) / view.z, (clientY - r.top - view.y) / view.z];
}

// background pan + pinch zoom
const pointers = new Map();
let pan = null, pinch = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.target !== stage && e.target !== world && e.target !== wires) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const r = stage.getBoundingClientRect();
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: view.z, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
    pan = null;
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    zoomAt(pinch.cx, pinch.cy, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
  } else if (pan) {
    view.x = pan.vx + e.clientX - pan.x;
    view.y = pan.vy + e.clientY - pan.y;
    applyView();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { pan = null; saveSoon(); }
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, view.z * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// ───────────────────────── nodes ─────────────────────────
function helper(n) {
  return {
    param: (name) => reg.get(`${n.id}.${name}`),
    gate: (port, on, t) => {
      for (const e of edges) if (e.from.node === n.id && e.from.port === port) nodes.get(e.to.node)?.inst.onGate?.(e.to.port, on, t);
    },
    data: (port) => {
      const e = edges.find((x) => x.to.node === n.id && x.to.port === port);
      if (!e) return 0;
      return nodes.get(e.from.node)?.inst.data?.[e.from.port] ?? 0;
    },
    toast,
    changed: saveSoon,
    master,
  };
}

function addNode(type, x, y, { id, params, extra } = {}) {
  const def = ALL[type];
  if (!def) return null;
  const n = { id: id ?? `n${nextId++}`, type, def, x, y };
  const num = Number(n.id.slice(1));
  if (num >= nextId) nextId = num + 1;
  const color = FAMILIES[def.family].color;

  n.el = el('div', 'node', world);
  n.el.style.setProperty('--fam', color);
  if (def.w) n.el.style.width = def.w + 'px';
  n.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  const head = el('div', 'n-head', n.el);
  el('span', 'n-title', head).textContent = def.title;
  const del = el('button', 'n-del', head);
  del.type = 'button'; del.textContent = '✕'; del.title = 'Delete node';
  del.addEventListener('click', () => removeNode(n.id));
  dragNode(head, n);

  const body = el('div', 'n-body', n.el);
  const pin = el('div', 'n-ports in', body);
  const main = el('div', 'n-main', body);
  const pout = el('div', 'n-ports out', body);
  n.ports = { in: {}, out: {} };
  for (const p of def.inputs) n.ports.in[p.id] = portEl(pin, n, p, 'in');
  for (const p of def.outputs) n.ports.out[p.id] = portEl(pout, n, p, 'out');

  n.inst = def.make(ctx, helper(n));
  if (def.visual) n.thumb = el('canvas', 'n-thumb', main);
  n.inst.build?.(main);
  const names = Object.keys(def.params);
  if (names.length) {
    const grid = el('div', 'n-knobs', main);
    for (const name of names) {
      const pid = `${n.id}.${name}`;
      reg.define(pid, { ...def.params[name], apply: (v) => n.inst.apply?.(name, v) });
      knob(grid, reg, pid, { size: 'sm', color });
    }
    for (const name of names) {
      const pid = `${n.id}.${name}`;
      if (params && name in params) reg.set(pid, params[name], 'load');
      else n.inst.apply?.(name, reg.get(pid));
    }
  }
  if (extra) n.inst.load?.(extra);
  nodes.set(n.id, n);
  placeNode(n);
  return n;
}

function placeNode(n) { n.el.style.transform = `translate(${n.x}px, ${n.y}px)`; }

function dragNode(handle, n) {
  let s = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    s = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
    n.el.classList.add('dragging');
    world.appendChild(n.el);   // bring to front
  });
  handle.addEventListener('pointermove', (e) => {
    if (!s) return;
    n.x = s.nx + (e.clientX - s.x) / view.z;
    n.y = s.ny + (e.clientY - s.y) / view.z;
    placeNode(n);
    drawWires();
  });
  const end = () => { if (s) { s = null; n.el.classList.remove('dragging'); saveSoon(); } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function removeNode(id) {
  const n = nodes.get(id);
  if (!n) return;
  for (const e of edges.filter((x) => x.from.node === id || x.to.node === id)) removeEdge(e);
  try { n.inst.destroy?.(vis); } catch { /* best effort */ }
  for (const out of Object.values(n.inst.outputs ?? {})) { try { out.disconnect(); } catch { /* not connected */ } }
  for (const name of Object.keys(n.def.params)) reg.params.delete(`${id}.${name}`);
  n.el.remove();
  nodes.delete(id);
  saveSoon();
}

// ───────────────────────── ports + cables ─────────────────────────
function portEl(parent, n, p, dir) {
  const row = el('div', `port ${dir}`, parent);
  row.style.setProperty('--kind', KIND_COLORS[p.kind]);
  row.dataset.node = n.id; row.dataset.port = p.id; row.dataset.dir = dir; row.dataset.kind = p.kind;
  row.title = `${p.label} (${p.kind})`;
  const dot = el('i', 'dot', row);
  el('span', '', row).textContent = p.label;
  row.addEventListener('pointerdown', (e) => startWire(e, n, p, dir));
  return dot;
}

function portPos(nodeId, dir, port) {
  const n = nodes.get(nodeId);
  const dot = n?.ports[dir][port];
  if (!dot) return [0, 0];
  const r = dot.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function curve(x1, y1, x2, y2) {
  const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

let temp = null;
function startWire(e, n, p, dir) {
  e.preventDefault();
  e.stopPropagation();
  let from = { node: n.id, port: p.id, dir, kind: p.kind };
  if (dir === 'in') {
    // grab the existing cable on this input and carry it somewhere else
    const existing = [...edges].reverse().find((x) => x.to.node === n.id && x.to.port === p.id);
    if (existing) {
      removeEdge(existing);
      from = { node: existing.from.node, port: existing.from.port, dir: 'out', kind: existing.kind };
    }
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'wire temp');
  path.style.stroke = KIND_COLORS[from.kind];
  wires.appendChild(path);
  temp = { from, path };
  const move = (ev) => {
    const [px, py] = portPos(from.node, from.dir, from.port);
    const [mx, my] = toWorld(ev.clientX, ev.clientY);
    path.setAttribute('d', from.dir === 'out' ? curve(px, py, mx, my) : curve(mx, my, px, py));
    document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot'));
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port');
    if (over && canLink(from, over)) over.classList.add('hot');
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    path.remove();
    document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot'));
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port');
    if (over && canLink(from, over)) {
      const to = { node: over.dataset.node, port: over.dataset.port, dir: over.dataset.dir };
      const [a, b] = from.dir === 'out' ? [from, to] : [to, from];
      addEdge(a.node, a.port, b.node, b.port);
    }
    temp = null;
    saveSoon();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  move(e);
}

function canLink(from, portNode) {
  if (portNode.dataset.dir === from.dir || portNode.dataset.node === from.node) return false;
  const outKind = from.dir === 'out' ? from.kind : portNode.dataset.kind;
  const inKind = from.dir === 'out' ? portNode.dataset.kind : from.kind;
  return compatible(outKind, inKind);
}

function addEdge(fromNode, fromPort, toNode, toPort) {
  const a = nodes.get(fromNode), b = nodes.get(toNode);
  if (!a || !b) return;
  const fp = a.def.outputs.find((p) => p.id === fromPort);
  const tp = b.def.inputs.find((p) => p.id === toPort);
  if (!fp || !tp || !compatible(fp.kind, tp.kind)) return;
  if (edges.some((e) => e.from.node === fromNode && e.from.port === fromPort && e.to.node === toNode && e.to.port === toPort)) return;
  if (SINGLE.has(tp.kind)) for (const e of edges.filter((x) => x.to.node === toNode && x.to.port === toPort)) removeEdge(e);
  const edge = { from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }, kind: fp.kind };
  const src = a.inst.outputs?.[fromPort], dst = b.inst.inputs?.[toPort];
  if (src && dst) {
    try { src.connect(dst); edge.audio = true; } catch (err) { toast(`Cannot patch: ${err.message}`, 'err'); return; }
  }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hit.setAttribute('class', 'wire-hit');
  const vis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  vis.setAttribute('class', `wire k-${fp.kind}`);
  vis.style.stroke = KIND_COLORS[fp.kind];
  g.append(vis, hit);
  hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  // first tap selects a cable, a second tap deletes it (avoids accidents while panning)
  hit.addEventListener('click', () => {
    if (g.classList.contains('sel')) { removeEdge(edge); saveSoon(); return; }
    wires.querySelectorAll('g.sel').forEach((x) => x.classList.remove('sel'));
    g.classList.add('sel');
    setTimeout(() => g.classList.remove('sel'), 2500);
  });
  wires.appendChild(g);
  edge.g = g; edge.vis = vis; edge.hit = hit;
  edges.push(edge);
  drawWires();
}

function removeEdge(edge) {
  if (edge.audio) {
    const src = nodes.get(edge.from.node)?.inst.outputs?.[edge.from.port];
    const dst = nodes.get(edge.to.node)?.inst.inputs?.[edge.to.port];
    try { src?.disconnect(dst); } catch { /* already gone */ }
  }
  edge.g?.remove();
  edges = edges.filter((e) => e !== edge);
}

function drawWires() {
  for (const e of edges) {
    const [x1, y1] = portPos(e.from.node, 'out', e.from.port);
    const [x2, y2] = portPos(e.to.node, 'in', e.to.port);
    const d = curve(x1, y1, x2, y2);
    e.vis.setAttribute('d', d);
    e.hit.setAttribute('d', d);
  }
}

// ───────────────────────── patches ─────────────────────────
function serialize() {
  return {
    app: 'DawSynthDoom-patch', version: 1,
    view: { ...view },
    nodes: [...nodes.values()].map((n) => ({
      id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y),
      params: Object.fromEntries(Object.keys(n.def.params).map((k) => [k, reg.get(`${n.id}.${k}`)])),
      extra: n.inst.save?.(),
    })),
    edges: edges.map((e) => [e.from.node, e.from.port, e.to.node, e.to.port]),
  };
}

function clearPatch() {
  for (const id of [...nodes.keys()]) removeNode(id);
  edges = [];
  nextId = 1;
}

function loadPatch(p) {
  clearPatch();
  for (const n of p.nodes ?? []) addNode(n.type, n.x, n.y, { id: n.id, params: n.params, extra: n.extra });
  // ports are laid out once fonts and knobs settle
  requestAnimationFrame(() => {
    for (const [a, ap, b, bp] of p.edges ?? []) addEdge(a, ap, b, bp);
    if (p.view) { Object.assign(view, p.view); applyView(); } else fit();
  });
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); } catch { /* storage blocked */ } }, 500);
}
reg.onChange(() => saveSoon());

// Starter patches: [type, x, y, params?] and edges [from, port, to, port]
const P = (nodesList, edgeList) => ({
  nodes: nodesList.map(([id, type, x, y, params, extra]) => ({ id, type, x, y, params, extra })),
  edges: edgeList,
});
const PATCHES = {
  'Synth voice + visuals': P([
    ['n1', 'seq', 0, 0, { bpm: 118 }],
    ['n2', 'osc', 360, -20, { wave: 2, freq: 110 }],
    ['n3', 'lfo', 0, 330, { rate: 0.15, depth: 0.6 }],
    ['n4', 'adsr', 360, 330, { a: 0.004, d: 0.3, s: 0.2, r: 0.25 }],
    ['n5', 'vcf', 640, -20, { cut: 500, q: 8, amt: 3.5 }],
    ['n6', 'vca', 900, -20],
    ['n7', 'delay', 1150, -20, { time: 0.38, fb: 0.45, mix: 0.35 }],
    ['n8', 'reverb', 1420, -20, { size: 3, mix: 0.3 }],
    ['n9', 'output', 1690, -20, { vol: 0.6 }],
    ['n10', 'analyze', 1420, 330],
    ['n11', 'wavetop', 1690, 250, { mode: 1, gain: 3 }],
    ['n12', 'shapetop', 1690, 640, { sides: 6, radius: 0.18 }],
    ['n13', 'blend', 1990, 400, { mode: 1 }],
    ['n14', 'feedback', 2260, 400],
    ['n15', 'kaleido', 2530, 400, { seg: 8 }],
    ['n16', 'viewer', 2800, 420],
  ], [
    ['n1', 'pitch', 'n2', 'pitch'], ['n1', 'gate', 'n4', 'gate'],
    ['n2', 'out', 'n5', 'in'], ['n4', 'out', 'n5', 'cut'], ['n3', 'out', 'n5', 'cut'],
    ['n5', 'out', 'n6', 'in'], ['n4', 'out', 'n6', 'cv'],
    ['n6', 'out', 'n7', 'in'], ['n7', 'out', 'n8', 'in'], ['n8', 'out', 'n9', 'in'],
    ['n8', 'out', 'n10', 'in'], ['n8', 'out', 'n11', 'in'],
    ['n10', 'level', 'n11', 'react'], ['n10', 'low', 'n12', 'react'],
    ['n11', 'out', 'n13', 'in0'], ['n12', 'out', 'n13', 'in1'],
    ['n13', 'out', 'n14', 'in0'], ['n10', 'mid', 'n14', 'react'],
    ['n14', 'out', 'n15', 'in0'], ['n10', 'high', 'n15', 'react'],
    ['n15', 'out', 'n16', 'in0'],
  ]),
  'Guitar rig (live input)': P([
    ['n1', 'input', 0, 0],
    ['n2', 'drive', 280, 0, { drive: 0.2, level: 0.6 }],
    ['n3', 'nam', 560, 0],
    ['n4', 'cab', 840, 0],
    ['n5', 'delay', 1120, 0, { time: 0.42, fb: 0.35, mix: 0.25 }],
    ['n6', 'reverb', 1400, 0, { size: 2.2, mix: 0.25 }],
    ['n7', 'output', 1680, 0, { vol: 0.6 }],
    ['n8', 'scope', 1680, 300],
    ['n9', 'spectop', 1120, 380, { mode: 1 }],
    ['n10', 'analyze', 840, 380],
    ['n11', 'feedback', 1400, 380, { zoom: 1.02, decay: 0.9 }],
    ['n12', 'viewer', 1680, 560],
  ], [
    ['n1', 'out', 'n2', 'in'], ['n2', 'out', 'n3', 'in'], ['n3', 'out', 'n4', 'in'], ['n4', 'out', 'n5', 'in'],
    ['n5', 'out', 'n6', 'in'], ['n6', 'out', 'n7', 'in'], ['n6', 'out', 'n8', 'in'],
    ['n6', 'out', 'n9', 'in'], ['n6', 'out', 'n10', 'in'], ['n10', 'level', 'n9', 'react'],
    ['n9', 'out', 'n11', 'in0'], ['n10', 'low', 'n11', 'react'], ['n11', 'out', 'n12', 'in0'],
  ]),
  'Audio-reactive visuals (mic)': P([
    ['n1', 'input', 0, 0],
    ['n2', 'analyze', 300, 0, { gain: 2.5 }],
    ['n3', 'noisetop', 600, -60, { scale: 3, hue: 0.7 }],
    ['n4', 'wavetop', 600, 300, { mode: 0, gain: 4 }],
    ['n5', 'blend', 900, 100, { mode: 0, mix: 0.7 }],
    ['n6', 'warp', 1180, 100],
    ['n7', 'feedback', 1460, 100, { zoom: 0.99, rot: -0.01 }],
    ['n8', 'colortop', 1740, 100],
    ['n9', 'viewer', 2020, 140],
  ], [
    ['n1', 'out', 'n2', 'in'], ['n1', 'out', 'n4', 'in'],
    ['n2', 'level', 'n3', 'react'], ['n2', 'high', 'n4', 'react'],
    ['n3', 'out', 'n5', 'in0'], ['n4', 'out', 'n5', 'in1'],
    ['n5', 'out', 'n6', 'in0'], ['n2', 'low', 'n6', 'react'],
    ['n6', 'out', 'n7', 'in0'], ['n2', 'mid', 'n7', 'react'],
    ['n7', 'out', 'n8', 'in0'], ['n2', 'level', 'n8', 'react'],
    ['n8', 'out', 'n9', 'in0'],
  ]),
  'Empty': P([['n1', 'output', 400, 100]], []),
};

// ───────────────────────── palette + toolbar ─────────────────────────
function buildPalette() {
  const pal = $('#palette');
  for (const [fam, info] of Object.entries(FAMILIES)) {
    const sec = el('div', 'p-sec', pal);
    const h = el('div', 'p-title', sec);
    h.textContent = info.label;
    h.style.color = info.color;
    for (const [type, def] of Object.entries(ALL)) {
      if (def.family !== fam) continue;
      const b = el('button', 'p-item', sec);
      b.type = 'button';
      b.textContent = def.title;
      b.style.setProperty('--fam', info.color);
      b.addEventListener('click', () => {
        const r = stage.getBoundingClientRect();
        const [x, y] = toWorld(r.left + r.width / 2 - 100 + (Math.random() - 0.5) * 60, r.top + r.height / 2 - 80 + (Math.random() - 0.5) * 60);
        addNode(type, x, y);
        saveSoon();
        if (window.innerWidth < 860) document.body.classList.remove('palette-open');
      });
    }
  }
}

function buildToolbar() {
  const sel = $('#patchSel');
  const add = (v, t) => { const o = el('option', '', sel); o.value = v; o.textContent = t; };
  add('', 'Patches…');
  for (const name of Object.keys(PATCHES)) add(name, name);
  add('__export', 'Export to file…');
  add('__import', 'Import from file…');
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (v === '__export') {
      const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dawsynthdoom-patch.json';
      a.click();
    } else if (v === '__import') $('#patchFile').click();
    else if (v) { loadPatch(PATCHES[v]); toast(`Patch: ${v}`); saveSoon(); }
  });
  $('#patchFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { loadPatch(JSON.parse(await f.text())); toast(`Imported ${f.name}`); saveSoon(); } catch (err) { toast(`Bad patch: ${err.message}`, 'err'); }
  });
  $('#addBtn').addEventListener('click', () => document.body.classList.toggle('palette-open'));
  $('#fitBtn').addEventListener('click', fit);
  $('#zoomIn').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.z * 1.2); });
  $('#zoomOut').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.z / 1.2); });
  $('#viewerBtn').addEventListener('click', () => document.body.classList.toggle('viewer-hidden'));
  $('#fullBtn').addEventListener('click', () => {
    const v = $('#viewer');
    if (document.fullscreenElement) document.exitFullscreen();
    else (v.requestFullscreen ?? v.webkitRequestFullscreen)?.call(v);
  });
  $('#panicBtn').addEventListener('click', () => {
    if (!master) return;
    const muted = master.gain.value < 0.5;
    master.gain.setTargetAtTime(muted ? 1 : 0, ctx.currentTime, 0.01);
    $('#panicBtn').classList.toggle('on', !muted);
    $('#panicBtn').textContent = muted ? 'MUTE' : 'MUTED';
  });
}

// ───────────────────────── run loops ─────────────────────────
const viewerCanvas = $('#viewerCanvas');
let frameNo = 0;

function renderVisuals() {
  if (!vis?.ok) return;
  const cache = new Map();
  const visiting = new Set();
  const render = (n) => {
    if (cache.has(n.id)) return cache.get(n.id);
    if (visiting.has(n.id)) return n.lastTex ?? null;
    visiting.add(n.id);
    const ins = {};
    for (const p of n.def.inputs) {
      if (p.kind !== 'tex') continue;
      const e = edges.find((x) => x.to.node === n.id && x.to.port === p.id);
      const src = e && nodes.get(e.from.node);
      ins[p.id] = src?.def.visual ? render(src) : null;
    }
    let tex = null;
    try { tex = n.inst.render(vis, ins); } catch (err) { if (!n.err) { n.err = true; toast(`${n.def.title}: ${err.message}`, 'err'); } }
    visiting.delete(n.id);
    cache.set(n.id, tex);
    n.lastTex = tex;
    return tex;
  };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vw = Math.max(200, Math.round(viewerCanvas.clientWidth * dpr));
  const vh = Math.max(120, Math.round(viewerCanvas.clientHeight * dpr));
  if (viewerCanvas.width !== vw || viewerCanvas.height !== vh) { viewerCanvas.width = vw; viewerCanvas.height = vh; }

  let viewerTex = null;
  for (const n of nodes.values()) {
    if (!n.def.visual) continue;
    const tex = render(n);
    if (n.inst.isViewer && tex) viewerTex = tex;
  }
  // node thumbnails: draw each texture small, then copy it out
  const thumbs = [...nodes.values()].filter((n) => n.thumb);
  if (thumbs.length && frameNo % 2 === 0) {
    const tw = 160, th = 90;
    for (const n of thumbs) {
      const tex = cache.get(n.id);
      vis.show(tex, 0, 0, tw, th);
      if (n.thumb.width !== tw) { n.thumb.width = tw; n.thumb.height = th; }
      n.thumb.getContext('2d').drawImage(viewerCanvas, 0, viewerCanvas.height - th, tw, th, 0, 0, tw, th);
    }
  }
  // the viewer, letterboxed to the texture aspect
  const gl = vis.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, vw, vh);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const a = TEX_W / TEX_H;
  let w = vw, h = Math.round(vw / a);
  if (h > vh) { h = vh; w = Math.round(vh * a); }
  vis.show(viewerTex, Math.round((vw - w) / 2), Math.round((vh - h) / 2), w, h);
}

function frame() {
  requestAnimationFrame(frame);
  frameNo++;
  for (const n of nodes.values()) { try { n.inst.frame?.(); } catch { /* keep the loop alive */ } }
  renderVisuals();
}

async function boot() {
  $('#startOverlay').hidden = true;
  const isFirefox = /firefox/i.test(navigator.userAgent);
  ctx = new AudioContext(isFirefox ? { latencyHint: 'interactive' } : { latencyHint: 'interactive', sampleRate: 48000 });
  await ctx.resume();
  master = ctx.createGain();
  master.connect(ctx.destination);
  vis = new Visuals(viewerCanvas);
  if (!vis.ok) toast('WebGL2 is not available: visual nodes are disabled', 'err');
  buildPalette();
  buildToolbar();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { /* ignore */ }
  loadPatch(saved?.nodes?.length ? saved : PATCHES['Synth voice + visuals']);
  setInterval(() => { for (const n of nodes.values()) { try { n.inst.schedule?.(); } catch { /* keep scheduling */ } } }, 25);
  requestAnimationFrame(frame);
  window.addEventListener('resize', drawWires);
}

applyView();
$('#startBtn').addEventListener('click', () => boot().catch((err) => toast(`Could not start: ${err.message}`, 'err')));

// expose for debugging in the console
window.dsdPatch = { nodes, get edges() { return edges; }, addNode, addEdge, loadPatch, serialize };
