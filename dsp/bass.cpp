// DawSynthDoom bass voice — C++ compiled to WebAssembly (freestanding, no libc).
//
//  in ─ DC block ─┬─ envelope follower · auto level · onset ─────────────────────────┐ (dynamics follow the player)
//                 └─ LP + decimate ─ adaptive YIN (or ANY-signal estimate) ─ well temperament
//                      ─ ARP pattern (tempo-synced, in key) ─ glide ─ OSC + FIFTH + SUB + NOISE
//                      ─ LFO 1 / LFO 2 / ENV mod matrix ─ wavefolder ─ ladder ─ drive ─ out
//
// Build: see build.mjs (clang --target=wasm32 -nostdlib). The JS host copies
// 128-sample blocks into in_buf, writes params[], calls process(n) and reads out_buf.

#include <stdint.h>

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

// ───────────────────────── freestanding helpers ─────────────────────────
extern "C" void* memset(void* d, int c, unsigned long n) { auto* p = static_cast<unsigned char*>(d); while (n--) *p++ = static_cast<unsigned char>(c); return d; }
extern "C" void* memcpy(void* d, const void* s, unsigned long n) { auto* a = static_cast<unsigned char*>(d); auto* b = static_cast<const unsigned char*>(s); while (n--) *a++ = *b++; return d; }

namespace m {
constexpr float PI = 3.14159265358979f;
constexpr float TWO_PI = 6.28318530717959f;
inline float absf(float x) { return x < 0 ? -x : x; }
inline float minf(float a, float b) { return a < b ? a : b; }
inline float maxf(float a, float b) { return a > b ? a : b; }
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }
inline int floori(float x) { int i = static_cast<int>(x); return (x < 0 && static_cast<float>(i) != x) ? i - 1 : i; }
inline int roundi(float x) { return floori(x + 0.5f); }

inline float bits_to_float(uint32_t u) { return __builtin_bit_cast(float, u); }
inline uint32_t float_to_bits(float f) { return __builtin_bit_cast(uint32_t, f); }

// 2^x, ~1e-7 relative error
inline float exp2f(float x) {
  x = clampf(x, -126.f, 126.f);
  const int i = floori(x);
  const float f = x - static_cast<float>(i);
  const float p = 1.f + f * (0.6931472f + f * (0.2402265f + f * (0.0555041f + f * (0.0096181f + f * 0.0013333f))));
  return p * bits_to_float(static_cast<uint32_t>(i + 127) << 23);
}
inline float expf(float x) { return exp2f(x * 1.44269504f); }

inline float log2f(float x) {
  if (x <= 0) return -126.f;
  const uint32_t u = float_to_bits(x);
  const int e = static_cast<int>((u >> 23) & 255) - 127;
  const float mant = bits_to_float((u & 0x7FFFFF) | 0x3F800000);   // [1,2)
  const float t = (mant - 1.f) / (mant + 1.f), t2 = t * t;
  return static_cast<float>(e) + 2.8853900818f * t * (1.f + t2 * (0.3333333f + t2 * (0.2f + t2 * (0.1428571f + t2 * 0.1111111f))));
}

// sin(2*pi*phase) for any phase
inline float sin2pi(float phase) {
  phase -= static_cast<float>(floori(phase));
  float x = phase * TWO_PI;
  if (x > PI) x -= TWO_PI;
  if (x > PI * 0.5f) x = PI - x;
  else if (x < -PI * 0.5f) x = -PI - x;
  const float x2 = x * x;
  return x * (1.f + x2 * (-0.16666667f + x2 * (0.0083333333f + x2 * (-0.00019841270f + x2 * 2.7557319e-6f))));
}
inline float sinf(float x) { return sin2pi(x * (1.f / TWO_PI)); }

// Padé tanh, exact to ~1e-6 inside |x| < 4.97, saturates outside
inline float tanhf(float x) {
  if (x > 4.97f) return 1.f;
  if (x < -4.97f) return -1.f;
  const float x2 = x * x;
  return x * (135135.f + x2 * (17325.f + x2 * (378.f + x2))) / (135135.f + x2 * (62370.f + x2 * (3150.f + 28.f * x2)));
}

uint32_t rng = 0x9E3779B9u;
inline float noise() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return static_cast<float>(rng) * (2.f / 4294967296.f) - 1.f; }
}  // namespace m

// ───────────────────────── tuning tables ─────────────────────────
static const float TEMPER[5][12] = {
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                                                      // equal
  {0, -9.78f, -7.82f, -5.87f, -9.78f, -1.96f, -11.73f, -3.91f, -7.82f, -11.73f, -3.91f, -7.82f},  // Werckmeister III
  {0, -9.78f, -6.84f, -5.87f, -13.69f, -1.96f, -9.78f, -3.42f, -7.82f, -10.26f, -3.91f, -11.73f}, // Kirnberger III
  {0, -5.87f, -3.91f, -1.96f, -7.82f, 1.96f, -7.82f, -1.96f, -3.91f, -5.87f, 0, -9.78f},          // Vallotti
  {0, -9.8f, -3.9f, -5.9f, -7.8f, -2.0f, -11.7f, -2.0f, -7.8f, -5.9f, -3.9f, -9.8f},              // Young II
};
// scale masks, bit n = pitch class n above the key
static const uint16_t SCALE[6] = {
  0xFFF,                                                  // chromatic
  (1 << 0) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 9) | (1 << 11),   // major
  (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 10),   // natural minor
  (1 << 0) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 10),                          // minor pentatonic
  (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 9) | (1 << 10),   // dorian
  (1 << 0) | (1 << 1) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 10),   // phrygian
};

// ───────────────────────── parameters (order shared with src/dsp-params.ts) ─────────────────────────
enum P {
  GATE, SENS, KEY, SCALE_ID, TEMPER_ID, REF, QUANT, GLIDE, OCTAVE, RANGE,
  SHAPE, SUB, NOISE, BLEND, CUTOFF, RESO, ENV_AMT, DRIVE, FOLD, ATTACK, RELEASE, LEVEL,
  L1_RATE, L1_SHAPE, L1_DEPTH, L1_DEST, L2_RATE, L2_SHAPE, L2_DEPTH, L2_DEST, LFO_RETRIG,
  AUTO_GATE,
  RANGE_LO, TRACK_ANY, AUTO_LEVEL, ENV_DEST, ENV_DEPTH,
  ARP_MODE, BPM, ARP_GATE, SWING, LATCH, FIFTH,
  NPARAMS
};
enum Dest { D_NONE, D_CUTOFF, D_PITCH, D_AMP, D_FOLD, D_SHAPE, D_DRIVE, D_RESO, D_SUB, D_NOISE, D_OCTAVE, D_DIRECT, D_FIFTH, NDEST };

constexpr int BLOCK = 128;
constexpr int RING = 2048;
constexpr int DECIM = 4;

static float in_buf[BLOCK];
static float out_buf[BLOCK];
static float params[NPARAMS];
static float report[14];

static float sr = 48000.f, ana_rate = 12000.f;
static float clock_t;   // AudioContext time at the start of the block (arp grid)

// state
static float dc_x, dc_y, env, env_slow, peak_env = 0.01f, amp, hold;
static bool open_gate, voiced, locked, any_on;
static int miss;
static float gate_gain;            // smoothed gate for the direct path
static float floor_env = 0.001f;   // learned noise floor (linear)
static float ring[RING], buf[RING], diffv[512];
static int ring_pos, acc_n, hop;
static float lp, acc, period, f0, last_raw, any_f0;
static float log_f = 5.78f, log_target = 5.78f;   // log2(55)
static float root_midi = 33.f;                    // tempered target in fractional MIDI
static int root_note = 33;                        // integer note the arp builds on
static bool have_root;
static float fifth_ratio = 1.4983f;
static float phase, sub_phase, phase5;
static float s1, s2, s3, s4;
static float t_midi, t_cents, t_err;
static float lfo_phase[2], lfo_hold[2], lfo_prev[2], lfo_val[2];
static int report_count, arp_step = -1, rand_deg;
static float arp_env, arp_target = 33.f, last_onset = 1.f;

EXPORT(in_ptr) float* in_ptr() { return in_buf; }
EXPORT(out_ptr) float* out_ptr() { return out_buf; }
EXPORT(params_ptr) float* params_ptr() { return params; }
EXPORT(report_ptr) float* report_ptr() { return report; }
EXPORT(param_count) int param_count() { return NPARAMS; }
EXPORT(set_clock) void set_clock(float t) { clock_t = t; }

EXPORT(init) void init(float sample_rate) {
  sr = sample_rate;
  ana_rate = sr / DECIM;
}

static inline float blep(float t, float dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1.f; }
  if (t > 1.f - dt) { t = (t - 1.f) / dt; return t * t + t + t + 1.f; }
  return 0.f;
}

// adaptive-window YIN on the decimated ring buffer; also keeps the deepest dip
// (any_f0) for ANY mode, so even noisy / unpitched sounds give a note
static void detect() {
  const int W = period > 0 ? static_cast<int>(m::clampf(period * 2.3f + 0.5f, 96.f, 480.f)) : 480;
  int tau_max = period > 0 ? static_cast<int>(period * 2.2f + 0.5f) : 440;
  if (tau_max > 440) tau_max = 440;
  if (tau_max > RING - W - 1) tau_max = RING - W - 1;
  int tau_min = static_cast<int>(ana_rate / 1200.f);
  if (tau_min < 2) tau_min = 2;
  const int n = W + tau_max;
  int p = (ring_pos - n + RING) % RING;
  for (int i = 0; i < n; i++) { buf[i] = ring[p]; p = (p + 1) % RING; }
  float run = 0.f;
  diffv[0] = 1.f;
  for (int tau = 1; tau <= tau_max; tau++) {
    float s = 0.f;
    for (int j = 0; j < W; j++) { const float d = buf[j] - buf[j + tau]; s += d * d; }
    run += s;
    diffv[tau] = run > 0.f ? (s * static_cast<float>(tau)) / run : 1.f;
  }
  // Only true local minima away from the search edges count: low-passed noise always
  // "dips" at the shortest lag, which would otherwise read as a steady pitch.
  int found = -1, any = -1;
  float any_v = 1e9f;
  for (int tau = tau_min + 2; tau < tau_max - 1; tau++) {
    if (diffv[tau] < any_v && diffv[tau] <= diffv[tau - 1] && diffv[tau] <= diffv[tau + 1]) { any_v = diffv[tau]; any = tau; }
  }
  if (any > 0 && any_v < 0.6f) any_f0 = ana_rate / static_cast<float>(any);
  else {
    // unpitched (drums, noise, breath): use the zero-crossing rate, roughly how bright it is
    int zc = 0;
    for (int i = 1; i < W; i++) if ((buf[i - 1] < 0.f) != (buf[i] < 0.f)) zc++;
    any_f0 = zc > 2 ? 0.5f * static_cast<float>(zc) * ana_rate / static_cast<float>(W) : 0.f;
  }
  for (int tau = tau_min + 2; tau < tau_max; tau++) {
    if (diffv[tau] < 0.15f) {
      while (tau + 1 < tau_max && diffv[tau + 1] < diffv[tau]) tau++;
      found = tau;
      break;
    }
  }
  if (found < 0 && any_v < 0.25f) found = any;   // YIN fallback: deepest dip if clearly periodic
  if (found < 1) { voiced = false; period = 0.f; return; }
  const float a = diffv[found - 1], b = diffv[found], c = diffv[found + 1];
  const float den = a + c - 2.f * b;
  const float exact = static_cast<float>(found) + (den != 0.f ? m::clampf((a - c) / (2.f * den), -1.f, 1.f) : 0.f);
  period = exact;
  f0 = ana_rate / exact;
  voiced = true;
}

static inline float cents_of(const float* off, int note) { return off[((note % 12) + 12) % 12] - off[9]; }

// nearest note of key/scale in the temperament; returns target in fractional MIDI
static float temper(float midi, int key, int scale, int tid) {
  const float* off = TEMPER[tid < 0 || tid > 4 ? 0 : tid];
  const uint16_t mask = SCALE[scale < 0 || scale > 5 ? 0 : scale];
  const int base = m::floori(midi);
  float best = midi, best_dist = 1e9f;
  for (int n = base - 2; n <= base + 2; n++) {
    const int pc = ((n % 12) + 12) % 12;
    if (!(mask & (1 << ((pc - key + 12) % 12)))) continue;
    const float cents = cents_of(off, n);   // keep A on the reference pitch
    const float exact = static_cast<float>(n) + cents * 0.01f;
    const float dist = m::absf(midi - exact);
    if (dist < best_dist) { best_dist = dist; best = exact; t_midi = static_cast<float>(n); t_cents = cents; root_note = n; }
  }
  t_err = (midi - best) * 100.f;
  return best;
}

// nearest in-scale note (no side effects)
static int snap_scale(int note, int key, int scale) {
  const uint16_t mask = SCALE[scale < 0 || scale > 5 ? 0 : scale];
  for (int d = 0; d < 6; d++) {
    if (mask & (1 << ((((note - d - key) % 12) + 12) % 12))) return note - d;
    if (mask & (1 << ((((note + d - key) % 12) + 12) % 12))) return note + d;
  }
  return note;
}

// walk `deg` scale degrees up (or down) from an in-scale note
static int scale_step(int note, int deg, int key, int scale) {
  const uint16_t mask = SCALE[scale < 0 || scale > 5 ? 0 : scale];
  const int dir = deg >= 0 ? 1 : -1;
  for (int k = 0; k != deg; k += dir) {
    do { note += dir; } while (!(mask & (1 << ((((note - key) % 12) + 12) % 12))));
  }
  return note;
}

// ───────────────────────── bass patterns (16 sixteenths, scale degrees) ─────────────────────────
// R = rest, O = octave up, F = the fifth (7 semitones, snapped into the scale), X = random degree
constexpr signed char R = -100, O = 100, F = 50, X = 60;
static const signed char PATTERNS[10][16] = {
  {0},                                                         // 0 off
  {0, R, 0, R, 0, R, 0, R, 0, R, 0, R, 0, R, 0, R},            // 1 ROOT 8THS
  {0, R, O, R, 0, R, O, R, 0, R, O, R, 0, R, O, R},            // 2 OCTAVES
  {0, R, 0, R, F, R, 0, R, 0, R, 0, R, F, R, 0, F},            // 3 ROOT-FIFTH
  {0, R, R, R, 1, R, R, R, 2, R, R, R, 4, R, R, R},            // 4 WALKING
  {0, R, O, R, 0, R, O, R, 0, R, O, R, 0, R, O, 0},            // 5 DISCO
  {0, 0, O, 0, 2, 0, O, 4, 0, 0, O, 0, 6, O, 4, 2},            // 6 ACID
  {0, R, R, R, R, R, 0, R, R, R, R, R, F, R, R, R},            // 7 DUB
  {0, R, 0, 0, 0, R, 0, 0, 0, R, 0, 0, F, R, F, F},            // 8 GALLOP
  {X, R, X, R, X, R, X, X, X, R, X, R, X, R, X, X},            // 9 RANDOM (in key)
};
static const uint16_t ACCENTS[10] = {0, 0x1111, 0x1111, 0x1111, 0x1111, 0x4444, 0x9124, 0x1041, 0x1111, 0x1111};

static int pattern_note(int mode, int step, int key, int scale) {
  const signed char d = PATTERNS[mode][step];
  if (d == R) return -1;
  if (d == O) return root_note + 12;
  if (d == F) return snap_scale(root_note + 7, key, scale);   // the fifth, kept in key
  if (d == X) return scale_step(root_note, rand_deg, key, scale);
  return scale_step(root_note, d, key, scale);
}

// one LFO step. shapes: 0 sine 1 triangle 2 saw up 3 square 4 sample&hold 5 smooth random
//                       6 saw down 7 decay (pluck) 8 stairs (4 steps)
static float lfo_step(int i, float rate, int shape, int n) {
  float ph = lfo_phase[i] + rate * static_cast<float>(n) / sr;
  bool wrapped = false;
  if (ph >= 1.f) { ph -= static_cast<float>(m::floori(ph)); wrapped = true; }
  lfo_phase[i] = ph;
  if (wrapped) { lfo_prev[i] = lfo_hold[i]; lfo_hold[i] = m::noise(); }
  switch (shape) {
    case 1: return 1.f - 4.f * m::absf(ph - 0.5f);
    case 2: return 2.f * ph - 1.f;
    case 3: return ph < 0.5f ? 1.f : -1.f;
    case 4: return lfo_hold[i];
    case 5: { const float t = ph * ph * (3.f - 2.f * ph); return lfo_prev[i] + (lfo_hold[i] - lfo_prev[i]) * t; }
    case 6: return 1.f - 2.f * ph;
    case 7: return 2.f * m::expf(-5.f * ph) - 1.f;
    case 8: return static_cast<float>(m::floori(ph * 4.f)) * (2.f / 3.f) - 1.f;
    default: return m::sin2pi(ph);
  }
}

EXPORT(process) void process(int n) {
  if (n > BLOCK) n = BLOCK;
  const float* P_ = params;
  const float thr = P_[GATE], sens = P_[SENS];
  const int key = m::roundi(P_[KEY]), scale = m::roundi(P_[SCALE_ID]), tid = m::roundi(P_[TEMPER_ID]);
  const float ref = P_[REF], quant = P_[QUANT];
  const int octave = m::roundi(P_[OCTAVE]);
  const bool range = P_[RANGE] >= 0.5f;
  const float range_lo = P_[RANGE_LO];
  const bool track_any = P_[TRACK_ANY] >= 0.5f, auto_level = P_[AUTO_LEVEL] >= 0.5f;
  const int arp_mode = m::roundi(P_[ARP_MODE]);
  const bool latch = P_[LATCH] >= 0.5f;
  const float env_amt = P_[ENV_AMT], level = P_[LEVEL];

  // ── modulation matrix: two LFOs + the input envelope, evaluated per block (~2.7 ms)
  float mod[NDEST] = {};
  float amp_mod = 1.f;
  for (int i = 0; i < 2; i++) {
    const int base = i == 0 ? L1_RATE : L2_RATE;
    const float v = lfo_step(i, P_[base], m::roundi(P_[base + 1]), n);
    lfo_val[i] = v;
    const int dest = m::roundi(P_[base + 3]);
    const float depth = P_[base + 2];
    if (dest == D_AMP) amp_mod *= 1.f - depth * (0.5f - 0.5f * v);   // tremolo between 1 and 1-depth
    else if (dest > 0 && dest < NDEST) mod[dest] += v * depth;
  }
  const float env_norm = m::minf(1.f, auto_level ? env / m::maxf(peak_env * 0.6f, 1e-4f) : env * sens);
  { const int d = m::roundi(P_[ENV_DEST]); if (d > 0 && d < NDEST && d != D_AMP) mod[d] += env_norm * P_[ENV_DEPTH] * 2.f; }

  const float shape = m::clampf(P_[SHAPE] + mod[D_SHAPE] * 0.5f, 0.f, 1.f);
  const float fold = m::clampf(P_[FOLD] + mod[D_FOLD] * 0.5f, 0.f, 1.f);
  const float drive = m::clampf(P_[DRIVE] + mod[D_DRIVE] * 0.5f, 0.f, 1.f);
  const float k = m::clampf(P_[RESO] + mod[D_RESO] * 0.4f, 0.f, 1.f) * 3.9f;
  const float sub_mix = m::clampf(P_[SUB] + mod[D_SUB] * 0.5f, 0.f, 1.f);
  const float noise_amt = m::clampf(P_[NOISE] + mod[D_NOISE] * 0.3f, 0.f, 0.6f);
  const float blend = m::clampf(P_[BLEND] + mod[D_DIRECT] * 0.5f, 0.f, 1.f);
  const float fifth_mix = m::clampf(P_[FIFTH] + mod[D_FIFTH] * 0.5f, 0.f, 1.f);
  const float cutoff = P_[CUTOFF] * m::exp2f(mod[D_CUTOFF] * 4.f);          // ±4 octaves
  const float pitch_mod = mod[D_PITCH] * (1.f / 12.f) + (mod[D_OCTAVE] > 0.25f ? 1.f : 0.f);

  const float glide_ms = P_[GLIDE];
  const float glide = glide_ms <= 0 ? 1.f : 1.f - m::expf(-1.f / (glide_ms * 0.001f * sr));
  const float atk = 1.f - m::expf(-1.f / (P_[ATTACK] * 0.001f * sr));
  const float rel = 1.f - m::expf(-1.f / (P_[RELEASE] * 0.001f * sr));
  const float env_atk = 1.f - m::expf(-1.f / (0.0008f * sr));
  const float env_rel = 1.f - m::expf(-1.f / (0.04f * sr));
  const float slow_c = 1.f - m::expf(-1.f / (0.12f * sr));
  const float peak_rel = 1.f - m::expf(-1.f / (3.f * sr));
  const float lp_coef = 1.f - m::expf(-m::TWO_PI * 1500.f / sr);
  const float dg = 1.f + drive * 7.f;
  const float d_norm = 1.f / m::tanhf(dg);
  const float fg = (1.f + fold * 5.f) * 1.2f;
  const float fold_mix = m::minf(1.f, fold * 2.5f);
  const float hold_samples = sr * 0.03f;
  const float nyq = sr * 0.42f;
  const bool auto_gate = P_[AUTO_GATE] >= 0.5f;
  const float floor_down = 1.f - m::expf(-1.f / (0.05f * sr));
  const float floor_up = 1.f - m::expf(-1.f / (2.f * sr));
  const float gg_open = 1.f - m::expf(-1.f / (0.001f * sr));
  const float gg_close = 1.f - m::expf(-1.f / (0.06f * sr));
  // arp grid (sixteenths, swing on the off-sixteenths)
  const float step_len = 15.f / m::clampf(P_[BPM], 40.f, 240.f);
  const float swing = m::clampf(P_[SWING], 0.f, 0.45f);
  const float arp_gate = m::clampf(P_[ARP_GATE], 0.05f, 1.f);

  // fold + snap a detected frequency into a tempered note; sets root
  auto set_note = [&](float hz) {
    float midi = 69.f + 12.f * m::log2f(hz / ref) + static_cast<float>(octave * 12);
    if (range) { while (midi >= range_lo + 24.f) midi -= 12.f; while (midi < range_lo) midi += 12.f; }
    const float snapped = temper(midi, key, scale, tid);
    const float tm = midi + (snapped - midi) * quant;
    const float prev = root_midi;
    root_midi = tm;
    have_root = true;
    const float* off = TEMPER[tid < 0 || tid > 4 ? 0 : tid];
    fifth_ratio = m::exp2f((7.f + (cents_of(off, root_note + 7) - cents_of(off, root_note)) * 0.01f) / 12.f);
    if (P_[LFO_RETRIG] >= 0.5f && m::absf(tm - prev) > 0.4f) { lfo_phase[0] = 0.f; lfo_phase[1] = 0.f; }
  };

  for (int i = 0; i < n; i++) {
    const float raw = in_buf[i];
    const float x = raw - dc_x + 0.995f * dc_y;
    dc_x = raw;
    dc_y = x;

    const float ax = m::absf(x);
    env += (ax - env) * (ax > env ? env_atk : env_rel);
    env_slow += (env - env_slow) * slow_c;
    if (env > peak_env) peak_env = env; else peak_env += (env - peak_env) * peak_rel;
    if (env < floor_env) floor_env += (env - floor_env) * floor_down;
    else if (!locked) floor_env += (env - floor_env) * floor_up;
    if (floor_env > peak_env * 0.1f) floor_env = peak_env * 0.1f;   // the floor stays ≥ 20 dB under your playing
    const float gthr = auto_gate ? m::minf(m::maxf(thr, floor_env * 3.2f), 0.1f) : thr;
    const bool was_open = open_gate;
    if (env > gthr) { open_gate = true; hold = hold_samples; }
    else if (env < gthr * 0.5f) { if (hold > 0) hold -= 1.f; else open_gate = false; }
    gate_gain += ((open_gate ? 1.f : 0.f) - gate_gain) * (open_gate ? gg_open : gg_close);
    // onset: a new hit or note (used by ANY mode and the random pattern)
    // onset: a real hit or attack (at least twice the gate level); steady hiss never counts
    const bool onset = open_gate && env > gthr * 2.f && (!was_open || env > env_slow * 1.8f);
    if (onset) last_onset = 0.f; else last_onset += 1.f / sr;
    if (onset) rand_deg = static_cast<int>((m::noise() * 0.5f + 0.5f) * 8.f);

    lp += (x - lp) * lp_coef;
    acc += lp;
    if (++acc_n == DECIM) {
      ring[ring_pos] = acc * (1.f / DECIM);
      ring_pos = (ring_pos + 1) % RING;
      acc = 0.f;
      acc_n = 0;
      if (++hop >= 48) {
        hop = 0;
        if (open_gate) {
          detect();
          // retune only when two detections in a row agree (rejects octave blips)
          const bool agree = voiced && last_raw > 0 && m::absf(m::log2f(f0 / last_raw)) < 0.04f;
          last_raw = voiced ? f0 : 0.f;
          if (agree) { locked = true; miss = 0; any_on = false; set_note(f0); }
          else if (++miss >= 4) locked = false;
          // ANY mode: no clear pitch, but something is playing — give it a note in key
          // (starts only on a real onset, within 50 ms of it, so steady hiss never plays notes)
          if (track_any && !locked && any_f0 > 0 && last_onset < 0.05f) { set_note(any_f0); any_on = true; }
        } else {
          voiced = false;
          locked = false;
          any_on = false;
          period = 0.f;
          last_raw = 0.f;
        }
      }
    }

    // pitch: tracked note, or the arp pattern built on it
    float target = root_midi;
    bool arp_on = false;
    if (arp_mode > 0 && have_root) {
      const float pos = clock_t + static_cast<float>(i) / sr;
      const float pair_len = 2.f * step_len, first = step_len * (1.f + swing);
      const int pair = m::floori(pos / pair_len);
      const float r = pos - static_cast<float>(pair) * pair_len;
      const int step = (pair * 2 + (r < first ? 0 : 1)) & 15;
      const float local = r < first ? r / first : (r - first) / (step_len * (1.f - swing));
      if (step != arp_step) { arp_step = step; if (PATTERNS[arp_mode][step] == X) rand_deg = static_cast<int>((m::noise() * 0.5f + 0.5f) * 8.f); }
      const int note = pattern_note(arp_mode, step, key, scale);
      if (note >= 0 && local < arp_gate) {
        const float* off = TEMPER[tid < 0 || tid > 4 ? 0 : tid];
        arp_target = static_cast<float>(note) + cents_of(off, note) * 0.01f;
        arp_on = true;
      }
      target = arp_target;   // rests keep the last pitch, so release tails don't jump
      const float accent = (ACCENTS[arp_mode] >> step) & 1 ? 1.f : 0.78f;
      arp_env = arp_on ? accent : 0.f;
    }
    log_target = m::log2f(ref) + (target - 69.f) / 12.f;

    log_f += (log_target - log_f) * glide;
    const float f = m::minf(m::exp2f(log_f + pitch_mod), sr * 0.45f);
    const float dt = f / sr;
    const float t = phase;
    const float saw = 2.f * t - 1.f - blep(t, dt);
    float osc;
    if (shape < 0.5f) {
      float t2 = t + 0.5f;
      if (t2 >= 1.f) t2 -= 1.f;
      const float sq = (t < 0.5f ? 1.f : -1.f) + blep(t, dt) - blep(t2, dt);
      osc = saw + (sq - saw) * shape * 2.f;
    } else {
      const float pw = 0.5f - (shape - 0.5f) * 0.85f;
      float t2 = t + pw;
      if (t2 >= 1.f) t2 -= 1.f;
      osc = (saw - (2.f * t2 - 1.f - blep(t2, dt))) * 0.7f;
    }
    phase += dt;
    if (phase >= 1.f) phase -= 1.f;
    sub_phase += dt * 0.5f;
    if (sub_phase >= 1.f) sub_phase -= 1.f;
    const float sub = m::tanhf(m::sin2pi(sub_phase) * 2.2f) * 0.9f;
    float y = osc * (1.f - sub_mix * 0.45f) + sub * sub_mix + m::noise() * noise_amt;
    if (fifth_mix > 0.001f) {   // power-fifth layer, tuned to the temperament's own fifth
      const float dt5 = m::minf(dt * fifth_ratio, 0.45f);
      y += (2.f * phase5 - 1.f - blep(phase5, dt5)) * fifth_mix * 0.6f;
      phase5 += dt5;
      if (phase5 >= 1.f) phase5 -= 1.f;
    }
    if (fold > 0.001f) y += (m::sinf(y * fg) - y) * fold_mix;

    // level: the player's envelope, normalised (AUTO LEVEL) so any input level gives a full bass
    const float drive_in = auto_level ? env / m::maxf(peak_env * 0.6f, gthr * 1.5f) : env * sens;
    const float dyn = m::minf(1.f, drive_in < 1.f ? drive_in * (2.f - drive_in) : 1.f);
    const bool sounding = open_gate && (locked || any_on || (voiced && amp > 0.002f));
    float want;
    if (arp_mode > 0) want = arp_env * ((sounding || (latch && have_root)) ? (open_gate ? m::maxf(dyn, 0.6f) : 0.85f) : 0.f);
    else want = sounding ? dyn : 0.f;
    amp += (want - amp) * (want > amp ? atk : rel);

    const float fc = m::minf(cutoff * m::exp2f(env_amt * 5.f * env_norm), nyq);
    const float g = 1.f - m::expf(-m::TWO_PI * fc / sr);
    const float u = m::tanhf(y - k * s4);
    s1 += g * (u - s1);
    s2 += g * (s1 - s2);
    s3 += g * (s2 - s3);
    s4 += g * (s3 - s4);
    float z = s4 * (1.f + k * 0.35f);
    z = m::tanhf(z * dg) * d_norm * 0.85f;
    out_buf[i] = z * amp * amp_mod * level + x * blend * gate_gain;   // direct input is gated too
  }

  if (++report_count >= 12) {
    report_count = 0;
    report[0] = voiced ? f0 : (any_on ? any_f0 : 0.f);
    report[1] = m::exp2f(log_f);
    report[2] = t_midi;
    report[3] = t_cents;
    report[4] = t_err;
    report[5] = amp;
    report[6] = open_gate ? 1.f : 0.f;
    report[7] = lfo_val[0];
    report[8] = lfo_val[1];
    report[9] = 1.f;   // fresh report flag
    report[10] = floor_env;
    report[11] = locked ? 1.f : 0.f;
    report[12] = static_cast<float>(arp_mode > 0 ? arp_step : -1);
    report[13] = any_on ? 1.f : 0.f;
  }
}
