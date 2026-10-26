// Types for the vendored NAM WebAssembly engine (tone-3000/neural-amp-modeler-wasm).

export interface NamModelInfo {
  slimmable: boolean;
  slimmableBreakpoints: number[];
  hasLoudness: boolean;
  loudness: number;
  expectedSampleRate: number;
}

export declare class NamNode extends AudioWorkletNode {
  loadModel(json: string, options?: { slimSize?: number }): Promise<NamModelInfo>;
  unloadModel(): Promise<void>;
  setSlimSize(slimSize: number): Promise<void>;
  dispose(): Promise<void>;
}

export declare class NamEngine {
  readonly context: BaseAudioContext;
  static attach(context: BaseAudioContext, assets?: { assetBaseUrl?: string | URL }): Promise<NamEngine>;
  createNode(): Promise<NamNode>;
}
