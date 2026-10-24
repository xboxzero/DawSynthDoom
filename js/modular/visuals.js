// TouchDesigner-style visual nodes ("TOPs"): each one is a WebGL2 fragment
// shader rendering into its own texture. Textures flow along cables; DATA
// ports (from ANALYZE, LFO, ENVELOPE…) push numbers into the shaders so the
// visuals react to the sound.

export const TEX_W = 640, TEX_H = 360;

const VERT = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform float t, react, p0, p1, p2, p3, p4;
uniform vec2 res;
uniform sampler2D in0, in1, prev, sig;
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1), k, s);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
vec2 aspect(vec2 q) { return vec2((q.x - 0.5) * res.x / res.y, q.y - 0.5); }
`;

export class Visuals {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, alpha: false });
    this.gl = gl;
    if (!gl) return;
    this.programs = new Map();
    this.vao = gl.createVertexArray();
    this.blank = this.makeTex(1, 1, new Uint8Array([0, 0, 0, 255]));
    this.blit = this.program('blit', 'void main(){ o = texture(in0, uv); }');
    this.time0 = performance.now();
  }

  get ok() { return !!this.gl; }

  makeTex(w, h, data = null, internal, format, type) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal ?? gl.RGBA8, w, h, 0, format ?? gl.RGBA, type ?? gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  target() {
    const gl = this.gl;
    const tex = this.makeTex(TEX_W, TEX_H);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  freeTarget(tg) {
    if (!tg || !this.gl) return;
    this.gl.deleteTexture(tg.tex);
    this.gl.deleteFramebuffer(tg.fb);
  }

  // 1-row signal texture (waveform or spectrum) for WAVE / SPECTRUM TOPs.
  signalTex(existing, bytes) {
    const gl = this.gl;
    const tex = existing ?? this.makeTex(bytes.length, 1, null, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bytes.length, 1, gl.RED, gl.UNSIGNED_BYTE, bytes);
    return tex;
  }

  program(key, body) {
    if (this.programs.has(key)) return this.programs.get(key);
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + body));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(p)}`);
    const loc = {};
    for (const u of ['t', 'react', 'p0', 'p1', 'p2', 'p3', 'p4', 'res', 'in0', 'in1', 'prev', 'sig']) loc[u] = gl.getUniformLocation(p, u);
    const prog = { p, loc };
    this.programs.set(key, prog);
    return prog;
  }

  // Run a shader into a target. tex: { in0, in1, prev, sig }
  run(prog, target, u = {}, tex = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    if (target) gl.viewport(0, 0, TEX_W, TEX_H);
    gl.useProgram(prog.p);
    const L = prog.loc;
    gl.uniform1f(L.t, (performance.now() - this.time0) / 1000);
    gl.uniform2f(L.res, TEX_W, TEX_H);
    gl.uniform1f(L.react, u.react ?? 0);
    for (let i = 0; i < 5; i++) gl.uniform1f(L['p' + i], u['p' + i] ?? 0);
    ['in0', 'in1', 'prev', 'sig'].forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex[name] ?? this.blank);
      gl.uniform1i(L[name], unit);
    });
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Draw a texture into a rectangle of the visible canvas (y from the bottom).
  show(tex, x, y, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, y, w, h);
    this.run(this.blit, null, {}, { in0: tex ?? this.blank });
  }
}

// Shared shape of a TOP module: one main texture output, a REACT data input.
const reactIn = { id: 'react', kind: 'data', label: 'REACT' };
const texOut = [{ id: 'out', kind: 'tex', label: 'OUT' }];
const reactParam = { label: 'REACT', def: 0.5, unit: '%' };

function top(title, { params, inputs = [], shader, audio = false, signal = null, feedback = false, w }) {
  return {
    title, family: 'visual', visual: true, w,
    params: { ...params, react: reactParam },
    inputs: [...inputs, reactIn],
    outputs: texOut,
    make(ctx, h) {
      let target = null, back = null, an = null, sigTex = null, sigBuf = null;
      if (audio) {
        an = ctx.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0.6;
        sigBuf = new Uint8Array(signal === 'spectrum' ? an.frequencyBinCount / 2 : 1024);
      }
      return {
        inputs: audio ? { in: an } : {},
        render(v, ins) {
          if (!target) { target = v.target(); if (feedback) back = v.target(); }
          const keys = Object.keys(params);
          const u = { react: h.data('react') * h.param('react') };
          keys.forEach((k, i) => { u['p' + i] = h.param(k); });
          const tex = { in0: ins.in0, in1: ins.in1 };
          if (an) {
            if (signal === 'spectrum') {
              const full = new Uint8Array(an.frequencyBinCount);
              an.getByteFrequencyData(full);
              sigBuf.set(full.subarray(0, sigBuf.length));
            } else {
              const full = new Uint8Array(an.fftSize);
              an.getByteTimeDomainData(full);
              let s = 0;
              for (let i = 1; i < 1024; i++) if (full[i - 1] < 128 && full[i] >= 128) { s = i; break; }
              sigBuf.set(full.subarray(s, s + 1024));
            }
            sigTex = v.signalTex(sigTex, sigBuf);
            tex.sig = sigTex;
          }
          if (feedback) { tex.prev = target.tex; [target, back] = [back, target]; }
          v.run(v.program(title, shader), target, u, tex);
          return target.tex;
        },
        destroy(v) {
          v?.freeTarget(target); v?.freeTarget(back);
          if (sigTex) v?.gl.deleteTexture(sigTex);
        },
      };
    },
  };
}

export const VISUALS = {
  noisetop: top('NOISE TOP', {
    params: {
      scale: { label: 'SCALE', min: 0.5, max: 20, def: 4, scale: 'log' },
      speed: { label: 'SPEED', min: 0, max: 2, def: 0.3 },
      hue: { label: 'HUE', def: 0.62 },
      contrast: { label: 'CONTRAST', min: 0.5, max: 4, def: 1.4 },
    },
    shader: `void main(){
      vec2 q = aspect(uv) * p0;
      float tt = t * (p1 + react * 1.5);
      float n = fbm(q + vec2(tt, -tt * 0.7) + fbm(q * 0.7 - tt * 0.3));
      n = pow(clamp(n, 0.0, 1.0), p3);
      o = vec4(hsv(p2 + n * 0.25, 0.75, n * (0.8 + react)), 1);
    }`,
  }),

  shapetop: top('SHAPE TOP', {
    params: {
      sides: { label: 'SIDES', min: 0, max: 8, def: 0, step: 1, format: (v) => (v < 3 ? 'circle' : String(v)) },
      radius: { label: 'RADIUS', min: 0.02, max: 0.5, def: 0.2 },
      thick: { label: 'LINE', min: 0.002, max: 0.2, def: 0.02, scale: 'log' },
      hue: { label: 'HUE', def: 0.05 },
      spin: { label: 'SPIN', min: -3, max: 3, def: 0.4 },
    },
    shader: `void main(){
      vec2 q = aspect(uv);
      float a = atan(q.y, q.x) + t * p4;
      float r = length(q);
      float R = p1 * (1.0 + react * 1.5);
      if (p0 >= 3.0) { float k = 6.2831853 / p0; r *= cos(k * 0.5) / cos(mod(a, k) - k * 0.5); }
      float d = abs(r - R);
      float line = smoothstep(p2, 0.0, d);
      float glow = 0.012 / (d + 0.012) * 0.35;
      o = vec4(hsv(p3 + react * 0.2, 0.8, 1.0) * (line + glow), 1);
    }`,
  }),

  wavetop: top('WAVE TOP', {
    audio: true, signal: 'wave',
    inputs: [{ id: 'in', kind: 'audio', label: 'AUDIO' }],
    params: {
      mode: { label: 'MODE', min: 0, max: 1, def: 0, step: 1, options: ['LINE', 'CIRCLE'] },
      gain: { label: 'GAIN', min: 0.5, max: 8, def: 2, scale: 'log' },
      thick: { label: 'LINE', min: 0.002, max: 0.05, def: 0.008, scale: 'log' },
      hue: { label: 'HUE', def: 0.08 },
    },
    shader: `float s(float x){ return (texture(sig, vec2(x, 0.5)).r - 0.5) * 2.0; }
    void main(){
      float d;
      if (p0 < 0.5) {
        float y = 0.5 + s(uv.x) * 0.45 * p1 / 2.0;
        d = abs(uv.y - y);
      } else {
        vec2 q = aspect(uv);
        float a = atan(q.y, q.x) / 6.2831853 + 0.5;
        float R = 0.22 + s(a) * 0.12 * p1 / 2.0 + react * 0.1;
        d = abs(length(q) - R);
      }
      float line = smoothstep(p2, 0.0, d) + 0.004 / (d + 0.004) * 0.4;
      o = vec4(hsv(p3 + react * 0.15, 0.7, 1.0) * line, 1);
    }`,
  }),

  spectop: top('SPECTRUM TOP', {
    audio: true, signal: 'spectrum',
    inputs: [{ id: 'in', kind: 'audio', label: 'AUDIO' }],
    params: {
      mode: { label: 'MODE', min: 0, max: 1, def: 0, step: 1, options: ['BARS', 'RADIAL'] },
      bands: { label: 'BANDS', min: 8, max: 128, def: 48, step: 1, format: (v) => String(v) },
      hue: { label: 'HUE', def: 0.55 },
      spread: { label: 'COLORS', def: 0.4 },
    },
    shader: `float sp(float x){ return texture(sig, vec2(pow(x, 2.0) * 0.98 + 0.01, 0.5)).r; }
    void main(){
      if (p0 < 0.5) {
        float b = floor(uv.x * p1) / p1;
        float v = sp(b + 0.5 / p1);
        float gap = step(0.15, fract(uv.x * p1));
        float on = step(uv.y, v) * gap;
        o = vec4(hsv(p2 + b * p3, 0.8, 1.0) * on * (0.5 + uv.y), 1);
      } else {
        vec2 q = aspect(uv);
        float a = abs(atan(q.y, q.x)) / 3.14159265;
        float b = floor(a * p1) / p1;
        float v = sp(b + 0.5 / p1);
        float r = length(q);
        float on = step(0.12, r) * step(r, 0.12 + v * 0.38) * step(0.2, fract(a * p1));
        o = vec4(hsv(p2 + b * p3 + react * 0.2, 0.8, 1.0) * on, 1);
      }
    }`,
  }),

  feedback: top('FEEDBACK', {
    feedback: true,
    inputs: [{ id: 'in0', kind: 'tex', label: 'IN' }],
    params: {
      zoom: { label: 'ZOOM', min: 0.9, max: 1.1, def: 1.012 },
      rot: { label: 'ROTATE', min: -0.05, max: 0.05, def: 0.006 },
      decay: { label: 'DECAY', min: 0.5, max: 0.995, def: 0.94 },
      hue: { label: 'HUE DRIFT', min: 0, max: 0.05, def: 0.006 },
    },
    shader: `vec3 rgb2hsv(vec3 c){
      vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
    }
    void main(){
      vec2 c = uv - 0.5;
      float z = p0 + react * 0.03;
      float a = p1 + react * 0.02;
      c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c / z;
      vec3 pr = texture(prev, c + 0.5).rgb;
      vec3 h = rgb2hsv(pr);
      pr = hsv(h.x + p3, h.y, h.z) * p2;
      vec3 cur = texture(in0, uv).rgb;
      o = vec4(max(pr, cur), 1);
    }`,
  }),

  colortop: top('COLOR', {
    inputs: [{ id: 'in0', kind: 'tex', label: 'IN' }],
    params: {
      hue: { label: 'HUE', min: -0.5, max: 0.5, def: 0 },
      sat: { label: 'SAT', min: 0, max: 2, def: 1 },
      bright: { label: 'BRIGHT', min: 0, max: 3, def: 1 },
      invert: { label: 'INVERT', min: 0, max: 1, def: 0, step: 1, options: ['OFF', 'ON'] },
    },
    shader: `void main(){
      vec3 c = texture(in0, uv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, p1);
      float a = (p0 + react * 0.5) * 6.2831853;
      vec3 k = vec3(0.57735);
      c = c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
      c *= p2 * (1.0 + react * 0.5);
      if (p3 > 0.5) c = 1.0 - c;
      o = vec4(c, 1);
    }`,
  }),

  blend: top('BLEND', {
    inputs: [{ id: 'in0', kind: 'tex', label: 'A' }, { id: 'in1', kind: 'tex', label: 'B' }],
    params: {
      mode: { label: 'MODE', min: 0, max: 4, def: 0, step: 1, options: ['ADD', 'SCREEN', 'MULT', 'DIFF', 'MIX'] },
      mix: { label: 'MIX', def: 0.5, unit: '%' },
    },
    shader: `void main(){
      vec3 a = texture(in0, uv).rgb, b = texture(in1, uv).rgb;
      float m = clamp(p1 + react * 0.5, 0.0, 1.0);
      vec3 c;
      if (p0 < 0.5) c = a + b * m * 2.0;
      else if (p0 < 1.5) c = 1.0 - (1.0 - a) * (1.0 - b * m * 2.0);
      else if (p0 < 2.5) c = mix(a, a * b, m * 2.0);
      else if (p0 < 3.5) c = abs(a - b * m * 2.0);
      else c = mix(a, b, m);
      o = vec4(c, 1);
    }`,
  }),

  kaleido: top('KALEIDO', {
    inputs: [{ id: 'in0', kind: 'tex', label: 'IN' }],
    params: {
      seg: { label: 'SEGMENTS', min: 2, max: 16, def: 6, step: 1, format: (v) => String(v) },
      rot: { label: 'ROTATE', min: -1, max: 1, def: 0.1 },
      zoom: { label: 'ZOOM', min: 0.3, max: 3, def: 1, scale: 'log' },
    },
    shader: `void main(){
      vec2 q = aspect(uv);
      float r = length(q) / p2;
      float a = atan(q.y, q.x) + t * p1 + react;
      float k = 6.2831853 / p0;
      a = abs(mod(a, k) - k * 0.5);
      vec2 s = vec2(cos(a), sin(a)) * r;
      s.x *= res.y / res.x;
      o = vec4(texture(in0, s + 0.5).rgb, 1);
    }`,
  }),

  warp: top('WARP', {
    inputs: [{ id: 'in0', kind: 'tex', label: 'IN' }],
    params: {
      amount: { label: 'AMOUNT', min: 0, max: 0.2, def: 0.03 },
      freq: { label: 'FREQ', min: 0.5, max: 30, def: 6, scale: 'log' },
      speed: { label: 'SPEED', min: 0, max: 4, def: 0.8 },
    },
    shader: `void main(){
      float amt = p0 * (1.0 + react * 3.0);
      vec2 d = vec2(fbm(uv * p1 + t * p2), fbm(uv * p1 - t * p2 + 7.3)) - 0.5;
      o = vec4(texture(in0, uv + d * amt).rgb, 1);
    }`,
  }),

  viewer: {
    title: 'VIEWER OUT', family: 'visual', visual: true,
    params: {},
    inputs: [{ id: 'in0', kind: 'tex', label: 'IN' }],
    outputs: [],
    make() { return { isViewer: true, render(v, ins) { return ins.in0; } }; },
  },
};
