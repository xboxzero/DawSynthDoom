// Parameters of the C++ bass voice, in the exact order of `enum P` in dsp/bass.cpp.
// [name, default, min, max]
export const DSP_PARAMS = [
  ['gateThresh', 0.004, 0, 1], ['sens', 4, 0.5, 20],
  ['key', 9, 0, 11], ['scale', 0, 0, 5], ['temper', 1, 0, 4], ['ref', 440, 400, 480],
  ['quant', 1, 0, 1], ['glide', 12, 0, 600], ['octave', -1, -3, 1], ['range', 1, 0, 1],
  ['shape', 0.2, 0, 1], ['sub', 0.5, 0, 1], ['noise', 0, 0, 0.5], ['blend', 0, 0, 1],
  ['cutoff', 400, 30, 12000], ['reso', 0.35, 0, 1], ['envAmt', 0.5, 0, 1], ['drive', 0.25, 0, 1],
  ['fold', 0, 0, 1], ['attack', 3, 0.5, 200], ['release', 120, 5, 2000], ['level', 0.8, 0, 1.5],
  ['l1Rate', 2, 0.01, 40], ['l1Shape', 0, 0, 5], ['l1Depth', 0, 0, 1], ['l1Dest', 1, 0, 8],
  ['l2Rate', 0.3, 0.01, 40], ['l2Shape', 0, 0, 5], ['l2Depth', 0, 0, 1], ['l2Dest', 4, 0, 8],
  ['lfoRetrig', 0, 0, 1],
] as const;

export type DspParam = (typeof DSP_PARAMS)[number][0];

export interface BassReport { f0: number; out: number; midi: number; cents: number; err: number; amp: number; gate: boolean; lfo1: number; lfo2: number }

export const LFO_SHAPES = ['SINE', 'TRI', 'SAW', 'SQUARE', 'S&H', 'SMOOTH'] as const;
export const LFO_DESTS = ['NONE', 'CUTOFF', 'PITCH', 'AMP', 'FOLD', 'SHAPE', 'DRIVE', 'RESO', 'SUB'] as const;
