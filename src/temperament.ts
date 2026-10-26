// Tuning tables shared by the UI and the audio worklet.
// Historical well temperaments, as cents offsets from equal temperament on C.
// Offsets are re-centred so A always sits exactly on the reference pitch.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface Temperament { readonly name: string; readonly cents: readonly number[] }

export const TEMPERAMENTS: readonly Temperament[] = [
  { name: 'EQUAL', cents: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'WERCK III', cents: [0, -9.78, -7.82, -5.87, -9.78, -1.96, -11.73, -3.91, -7.82, -11.73, -3.91, -7.82] },
  { name: 'KIRNB III', cents: [0, -9.78, -6.84, -5.87, -13.69, -1.96, -9.78, -3.42, -7.82, -10.26, -3.91, -11.73] },
  { name: 'VALLOTTI', cents: [0, -5.87, -3.91, -1.96, -7.82, 1.96, -7.82, -1.96, -3.91, -5.87, 0, -9.78] },
  { name: 'YOUNG II', cents: [0, -9.8, -3.9, -5.9, -7.8, -2.0, -11.7, -2.0, -7.8, -5.9, -3.9, -9.8] },
];

export const SCALES: readonly { name: string; steps: readonly number[] }[] = [
  { name: 'CHROM', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: 'MAJOR', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'MINOR', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'PENT MIN', steps: [0, 3, 5, 7, 10] },
  { name: 'DORIAN', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'PHRYGIAN', steps: [0, 1, 3, 5, 7, 8, 10] },
];

export interface TunedNote {
  /** MIDI note number of the target */
  midi: number;
  /** exact target pitch in fractional MIDI (includes the temperament offset) */
  exact: number;
  /** cents offset of this pitch class in the temperament (A = 0) */
  cents: number;
}

/** Nearest note of the key/scale in the given temperament. */
export function nearestTempered(midi: number, key: number, scale: number, temper: number): TunedNote | null {
  const off = (TEMPERAMENTS[temper] ?? TEMPERAMENTS[0]).cents;
  const steps = (SCALES[scale] ?? SCALES[0]).steps;
  const base = Math.floor(midi);
  let best: TunedNote | null = null;
  let bestDist = Infinity;
  for (let n = base - 2; n <= base + 2; n++) {
    const pc = ((n % 12) + 12) % 12;
    if (!steps.includes((pc - key + 12) % 12)) continue;
    const cents = off[pc] - off[9];
    const exact = n + cents / 100;
    const dist = Math.abs(midi - exact);
    if (dist < bestDist) { bestDist = dist; best = { midi: n, exact, cents }; }
  }
  return best;
}

export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1);
}
