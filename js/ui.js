// Touch + mouse friendly controls bound to registry params.
// Knob: drag up/down (or left/right), wheel, arrow keys. Double-click/tap resets.
// Fader: drag thumb, or tap anywhere on the track to jump there.

const el = (tag, cls, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
};
export { el };

const ARC_START = -135, ARC_END = 135;
const polar = (cx, cy, r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const arcPath = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

// Shared gesture logic: relative drag with double-tap reset.
function bindDrag(node, reg, p, { onStart, onMove, axis = 'both', sensitivity = 180 }) {
  let start = null;
  let lastTap = 0;
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap < 320) {
      reg.set(p.id, p.def, 'ui');
      lastTap = 0;
      return;
    }
    lastTap = now;
    node.setPointerCapture(e.pointerId);
    node.classList.add('active');
    reg.touch(p.id, true);
    start = { x: e.clientX, y: e.clientY, n: p.toNorm(), moved: false };
    onStart?.(e, start);
  });
  node.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = start.y - e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) { start.moved = true; lastTap = 0; }
    if (onMove) { onMove(e, start); return; }
    const fine = e.shiftKey || e.ctrlKey || e.metaKey ? 0.2 : 1;
    const d = axis === 'y' ? dy : dy + dx;
    reg.set(p.id, p.fromNorm(start.n + (d / sensitivity) * fine), 'ui');
  });
  const end = (e) => {
    if (!start) return;
    start = null;
    node.classList.remove('active');
    reg.touch(p.id, false);
    try { node.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('wheel', (e) => {
    e.preventDefault();
    const stepN = p.step ? p.step / (p.max - p.min) : 0.02;
    const dir = e.deltaY < 0 ? 1 : -1;
    reg.set(p.id, p.fromNorm(p.toNorm() + dir * stepN * (e.shiftKey ? 0.25 : 1)), 'ui');
  }, { passive: false });
  node.addEventListener('keydown', (e) => {
    const stepN = p.step ? p.step / (p.max - p.min) : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') reg.set(p.id, p.fromNorm(p.toNorm() + stepN), 'ui');
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') reg.set(p.id, p.fromNorm(p.toNorm() - stepN), 'ui');
    else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') reg.set(p.id, p.def, 'ui');
    else return;
    e.preventDefault();
  });
}

export function knob(parent, reg, id, { size = 'md', color, label } = {}) {
  const p = reg.param(id);
  const root = el('div', `knob knob-${size}`, parent);
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', label ?? p.label);
  if (color) root.style.setProperty('--accent', color);
  root.innerHTML = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="k-body" cx="32" cy="32" r="21"/>
      <path class="k-track" d="${arcPath(32, 32, 27, ARC_START, ARC_END)}"/>
      <path class="k-val"/>
      <line class="k-ptr" x1="32" y1="32" x2="32" y2="15"/>
    </svg>
    <div class="k-value"></div>
    <div class="k-label"></div>`;
  root.querySelector('.k-label').textContent = label ?? p.label;
  const val = root.querySelector('.k-val');
  const ptr = root.querySelector('.k-ptr');
  const txt = root.querySelector('.k-value');
  const bipolar = p.min < 0 && p.max > 0 && p.scale === 'lin';
  const w = {
    update(v) {
      const n = p.toNorm(v);
      const a = ARC_START + n * (ARC_END - ARC_START);
      const zero = bipolar ? ARC_START + p.toNorm(0) * (ARC_END - ARC_START) : ARC_START;
      const a0 = Math.min(zero, a), a1 = Math.max(zero, a);
      val.setAttribute('d', a1 - a0 < 0.5 ? '' : arcPath(32, 32, 27, a0, a1));
      ptr.setAttribute('transform', `rotate(${a} 32 32)`);
      txt.textContent = p.format(v);
      root.setAttribute('aria-valuetext', p.format(v));
    },
  };
  p.widgets.add(w);
  w.update(p.value);
  bindDrag(root, reg, p, {});
  return root;
}

export function fader(parent, reg, id, { color, meter = true } = {}) {
  const p = reg.param(id);
  const root = el('div', 'fader', parent);
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', p.label);
  if (color) root.style.setProperty('--accent', color);
  const track = el('div', 'f-track', root);
  const fill = el('div', 'f-fill', track);
  const thumb = el('div', 'f-thumb', track);
  let canvas = null;
  if (meter) canvas = el('canvas', 'f-meter', root);
  const txt = el('div', 'f-value', parent);

  const w = {
    update(v) {
      const n = p.toNorm(v);
      fill.style.height = (n * 100) + '%';
      thumb.style.bottom = `calc(${n * 100}% - 14px)`;
      txt.textContent = p.format(v);
      root.setAttribute('aria-valuetext', p.format(v));
    },
  };
  p.widgets.add(w);
  w.update(p.value);

  const normAt = (e) => {
    const r = track.getBoundingClientRect();
    return 1 - (e.clientY - r.top) / r.height;
  };
  bindDrag(root, reg, p, {
    axis: 'y',
    onStart(e, s) {
      // Tapping the track (not the thumb) jumps the fader there.
      if (e.target !== thumb) {
        reg.set(p.id, p.fromNorm(normAt(e)), 'ui');
        s.n = p.toNorm();
      }
      s.h = track.getBoundingClientRect().height;
    },
    onMove(e, s) {
      const fine = e.shiftKey ? 0.2 : 1;
      const dy = (s.y - e.clientY) / s.h;
      reg.set(p.id, p.fromNorm(s.n + dy * fine), 'ui');
    },
  });
  return { root, canvas };
}

export function toggle(parent, reg, id, { text, cls = '', title } = {}) {
  const p = reg.param(id);
  const b = el('button', `btn tog ${cls}`, parent);
  b.type = 'button';
  b.textContent = text ?? p.label;
  if (title) b.title = title;
  const w = { update(v) { b.classList.toggle('on', v >= 0.5); b.setAttribute('aria-pressed', v >= 0.5); } };
  p.widgets.add(w);
  w.update(p.value);
  b.addEventListener('click', () => reg.set(id, p.value >= 0.5 ? 0 : 1, 'ui'));
  return b;
}

export function button(parent, text, onClick, cls = '') {
  const b = el('button', `btn ${cls}`, parent);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

// Draw a vertical level meter (peak + rms in dBFS) into a canvas.
export function drawMeter(canvas, peak, rms, hold) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const toY = (lin) => {
    const db = 20 * Math.log10(Math.max(lin, 1e-6));
    const n = Math.min(1, Math.max(0, (db + 60) / 66));
    return h - n * h;
  };
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(0, 0, w, h);
  const yP = toY(peak), yR = toY(rms);
  g.fillStyle = '#fff';
  g.globalAlpha = 0.35;
  g.fillRect(0, yP, w, h - yP);
  g.globalAlpha = 1;
  g.fillRect(0, yR, w, h - yR);
  // 0 dBFS line
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fillRect(0, toY(1), w, 1);
  if (hold > 0) {
    const yH = toY(hold);
    g.fillStyle = '#fff';
    g.fillRect(0, yH, w, hold >= 0.999 ? 5 : 2);
  }
}

// Horizontal slider (used for the A/B scene morph).
export function hslider(parent, reg, id, { color, left = '', right = '' } = {}) {
  const p = reg.param(id);
  const wrap = el('div', 'hs-wrap', parent);
  if (left) el('span', 'hs-end', wrap).textContent = left;
  const root = el('div', 'hslider', wrap);
  if (right) el('span', 'hs-end', wrap).textContent = right;
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', p.label);
  if (color) root.style.setProperty('--accent', color);
  const fill = el('div', 'hs-fill', root);
  const thumb = el('div', 'hs-thumb', root);
  const w = {
    update(v) {
      const n = p.toNorm(v);
      fill.style.width = (n * 100) + '%';
      thumb.style.left = `calc(${n} * (100% - 32px))`;
      root.setAttribute('aria-valuetext', p.format(v));
    },
  };
  p.widgets.add(w);
  w.update(p.value);
  const normAt = (e) => {
    const r = root.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  };
  bindDrag(root, reg, p, {
    onStart(e, s) {
      if (e.target !== thumb) { reg.set(p.id, p.fromNorm(normAt(e)), 'ui'); s.n = p.toNorm(); }
      s.w = root.getBoundingClientRect().width;
    },
    onMove(e, s) {
      reg.set(p.id, p.fromNorm(s.n + (e.clientX - s.x) / s.w), 'ui');
    },
  });
  return root;
}
