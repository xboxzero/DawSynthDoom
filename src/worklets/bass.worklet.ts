// AudioWorklet host for the C++/WebAssembly bass voice (dsp/bass.cpp).
// The main thread fetches dist/bass.wasm and hands the bytes over in processorOptions;
// each 128-sample block is copied into WASM memory, processed, and copied back.

import { DSP_PARAMS } from '../dsp-params';

interface BassExports {
  memory: WebAssembly.Memory;
  in_ptr(): number;
  out_ptr(): number;
  params_ptr(): number;
  report_ptr(): number;
  param_count(): number;
  init(sampleRate: number): void;
  process(n: number): void;
}

class BassHost extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return DSP_PARAMS.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'k-rate' as const }));
  }

  private ex: BassExports | null = null;
  private inB!: Float32Array;
  private outB!: Float32Array;
  private params!: Float32Array;
  private report!: Float32Array;

  constructor(options?: unknown) {
    super();
    const bytes = (options as { processorOptions?: { wasm?: ArrayBuffer } } | undefined)?.processorOptions?.wasm;
    if (!bytes) { this.port.postMessage({ error: 'no DSP binary' }); return; }
    try {
      this.setup(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
    } catch {
      // some engines refuse synchronous compilation; fall back to async (silent until ready)
      WebAssembly.instantiate(bytes, {})
        .then((r) => this.setup(r.instance))
        .catch((err: unknown) => this.port.postMessage({ error: String(err) }));
    }
  }

  private setup(inst: WebAssembly.Instance): void {
    const ex = inst.exports as unknown as BassExports;
    if (ex.param_count() !== DSP_PARAMS.length) {
      this.port.postMessage({ error: `DSP param mismatch: wasm ${ex.param_count()} vs host ${DSP_PARAMS.length}` });
      return;
    }
    ex.init(sampleRate);
    const buf = ex.memory.buffer;
    this.inB = new Float32Array(buf, ex.in_ptr(), 128);
    this.outB = new Float32Array(buf, ex.out_ptr(), 128);
    this.params = new Float32Array(buf, ex.params_ptr(), DSP_PARAMS.length);
    this.report = new Float32Array(buf, ex.report_ptr(), 10);
    this.ex = ex;
    this.port.postMessage({ ready: true });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], prm: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const ex = this.ex;
    if (!ex) { for (const ch of out) ch.fill(0); return true; }
    const n = out[0].length;
    for (let i = 0; i < DSP_PARAMS.length; i++) this.params[i] = prm[DSP_PARAMS[i][0]][0];
    const inp = inputs[0]?.[0];
    if (inp) this.inB.set(inp); else this.inB.fill(0);
    ex.process(n);
    out[0].set(this.outB.subarray(0, n));
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    const r = this.report;
    if (r[9] > 0) {
      r[9] = 0;
      this.port.postMessage({ f0: r[0], out: r[1], midi: r[2], cents: r[3], err: r[4], amp: r[5], gate: r[6] > 0.5, lfo1: r[7], lfo2: r[8] });
    }
    return true;
  }
}

registerProcessor('dsd-bass', BassHost);
