// Touch + mouse controls bound to registry params.
//
// Knobs: mouse drags up/down or sideways; on touch screens knobs turn with a
// LEFT/RIGHT swipe so a vertical swipe still scrolls the page.
// Faders: drag the thumb, or tap the track to jump. Double-tap resets anything.

import type { Param, Registry } from './params';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: Element | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

const ARC0 = -135, ARC1 = 135;
const polar = (r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [32 + r * Math.cos(a), 32 + r * Math.sin(a)];
};
const arc = (r: number, a0: number, a1: number): string => {
  const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

interface DragState { x: number; y: number; n: number; moved: boolean; touch: boolean; h: number; w: number }

interface DragOpts {
  onStart?: (e: PointerEvent, s: DragState) => void;
  onMove?: (e: PointerEvent, s: DragState) => void;
}

function bindDrag(node: HTMLElement, reg: Registry, p: Param, opts: DragOpts = {}): void {
  let s: DragState | null = null;
  let lastTap = 0;
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const now = performance.now();
    if (now - lastTap < 320) { reg.set(p.id, p.def, 'ui'); lastTap = 0; return; }
    lastTap = now;
    node.setPointerCapture(e.pointerId);
    node.classList.add('active');
    reg.touch(p.id, true);
    s = { x: e.clientX, y: e.clientY, n: p.toNorm(), moved: false, touch: e.pointerType === 'touch', h: 1, w: 1 };
    opts.onStart?.(e, s);
  });
  node.addEventListener('pointermove', (e) => {
    if (!s) return;
    const dx = e.clientX - s.x, dy = s.y - e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 4) { s.moved = true; lastTap = 0; }
    if (opts.onMove) { opts.onMove(e, s); return; }
    const fine = e.shiftKey || e.ctrlKey || e.metaKey ? 0.2 : 1;
    const d = s.touch ? dx : dy + dx;
    reg.set(p.id, p.fromNorm(s.n + (d / (s.touch ? 160 : 180)) * fine), 'ui');
  });
  const end = (e: PointerEvent): void => {
    if (!s) return;
    s = null;
    node.classList.remove('active');
    reg.touch(p.id, false);
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('wheel', (e) => {
    e.preventDefault();
    const stepN = p.step ? p.step / (p.max - p.min) : 0.02;
    reg.set(p.id, p.fromNorm(p.toNorm() + (e.deltaY < 0 ? 1 : -1) * stepN * (e.shiftKey ? 0.25 : 1)), 'ui');
  }, { passive: false });
  node.addEventListener('keydown', (e) => {
    const stepN = p.step ? p.step / (p.max - p.min) : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') reg.set(p.id, p.fromNorm(p.toNorm() + stepN), 'ui');
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') reg.set(p.id, p.fromNorm(p.toNorm() - stepN), 'ui');
    else if (e.key === 'Home' || e.key === 'Delete') reg.set(p.id, p.def, 'ui');
    else return;
    e.preventDefault();
  });
}

export function knob(parent: Element, reg: Registry, id: string, { size = 'sm', label }: { size?: 'sm' | 'md'; label?: string } = {}): HTMLElement {
  const p = reg.param(id);
  const root = el('div', `knob knob-${size}`, parent);
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', label ?? p.label);
  root.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="k-body" cx="32" cy="32" r="21"/><path class="k-track" d="${arc(27, ARC0, ARC1)}"/><path class="k-val"/><line class="k-ptr" x1="32" y1="32" x2="32" y2="15"/></svg><div class="k-value"></div><div class="k-label"></div>`;
  root.querySelector('.k-label')!.textContent = label ?? p.label;
  const val = root.querySelector<SVGPathElement>('.k-val')!;
  const ptr = root.querySelector<SVGLineElement>('.k-ptr')!;
  const txt = root.querySelector<HTMLElement>('.k-value')!;
  const bipolar = p.min < 0 && p.max > 0 && p.scale === 'lin';
  const w = {
    update(v: number) {
      const a = ARC0 + p.toNorm(v) * (ARC1 - ARC0);
      const zero = bipolar ? ARC0 + p.toNorm(0) * (ARC1 - ARC0) : ARC0;
      const a0 = Math.min(zero, a), a1 = Math.max(zero, a);
      val.setAttribute('d', a1 - a0 < 0.5 ? '' : arc(27, a0, a1));
      ptr.setAttribute('transform', `rotate(${a} 32 32)`);
      txt.textContent = p.format(v);
      root.setAttribute('aria-valuetext', p.format(v));
    },
  };
  p.widgets.add(w);
  w.update(p.value);
  bindDrag(root, reg, p);
  return root;
}

export function fader(parent: Element, reg: Registry, id: string): { root: HTMLElement; canvas: HTMLCanvasElement } {
  const p = reg.param(id);
  const root = el('div', 'fader', parent);
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', p.label);
  const track = el('div', 'f-track', root);
  const fill = el('div', 'f-fill', track);
  const thumb = el('div', 'f-thumb', track);
  const canvas = el('canvas', 'f-meter', root);
  const txt = el('div', 'f-value', parent);
  const w = {
    update(v: number) {
      const n = p.toNorm(v);
      fill.style.height = `${n * 100}%`;
      thumb.style.bottom = `calc(${n} * (100% - 28px))`;
      txt.textContent = p.format(v);
      root.setAttribute('aria-valuetext', p.format(v));
    },
  };
  p.widgets.add(w);
  w.update(p.value);
  const normAt = (e: PointerEvent): number => {
    const r = track.getBoundingClientRect();
    return 1 - (e.clientY - r.top - 14) / (r.height - 28);
  };
  bindDrag(root, reg, p, {
    onStart(e, s) {
      if (e.target !== thumb) { reg.set(p.id, p.fromNorm(normAt(e)), 'ui'); s.n = p.toNorm(); }
      s.h = track.getBoundingClientRect().height - 28;
    },
    onMove(e, s) {
      reg.set(p.id, p.fromNorm(s.n + ((s.y - e.clientY) / s.h) * (e.shiftKey ? 0.2 : 1)), 'ui');
    },
  });
  return { root, canvas };
}

export function toggle(parent: Element, reg: Registry, id: string, { text, cls = '', title }: { text?: string; cls?: string; title?: string } = {}): HTMLButtonElement {
  const p = reg.param(id);
  const b = el('button', `btn tog ${cls}`, parent);
  b.type = 'button';
  b.textContent = text ?? p.label;
  if (title) b.title = title;
  const w = { update(v: number) { b.classList.toggle('on', v >= 0.5); b.setAttribute('aria-pressed', String(v >= 0.5)); } };
  p.widgets.add(w);
  w.update(p.value);
  b.addEventListener('click', () => reg.set(id, p.value >= 0.5 ? 0 : 1, 'ui'));
  return b;
}

export function button(parent: Element, text: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = el('button', `btn ${cls}`, parent);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** Segmented choice for a stepped param (bigger touch targets than a knob). */
export function segments(parent: Element, reg: Registry, id: string): HTMLElement {
  const p = reg.param(id);
  const wrap = el('div', 'seg-group', parent);
  const opts = p.options ?? [];
  const btns = opts.map((label, i) => button(wrap, label, () => reg.set(id, p.min + i, 'ui'), 'seg'));
  const w = { update(v: number) { btns.forEach((b, i) => b.classList.toggle('on', Math.round(v - p.min) === i)); } };
  p.widgets.add(w);
  w.update(p.value);
  return wrap;
}

export function fitCanvas(canvas: HTMLCanvasElement, maxDpr = 2): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

export function drawMeter(canvas: HTMLCanvasElement, peak: number, rms: number, hold: number): void {
  const c = fitCanvas(canvas);
  if (!c) return;
  const { g, w, h } = c;
  const y = (lin: number): number => h - Math.min(1, Math.max(0, (20 * Math.log10(Math.max(lin, 1e-6)) + 60) / 66)) * h;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.globalAlpha = 0.35;
  g.fillRect(0, y(peak), w, h - y(peak));
  g.globalAlpha = 1;
  g.fillRect(0, y(rms), w, h - y(rms));
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fillRect(0, y(1), w, 1);
  if (hold > 0) { g.fillStyle = '#fff'; g.fillRect(0, y(hold), w, hold >= 0.999 ? 5 : 2); }
}
