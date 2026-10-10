// BPMTUNE: mesin DSP murni (tanpa DOM, bisa dites di Node dan dijalankan di Worker).
//   1. Tempo: audio -> envelope onset (spectral flux per pita, log) -> autokorelasi (FFT) dengan prior tempo -> penyempurnaan comb halus + fase ketukan.
//   2. Pitch: YIN (de Cheveigné & Kawahara 2002) dengan interpolasi parabola, lalu nama nada + cent terhadap A4 acuan.
// Pengujian: node tools/bpmtune-test.ts

// ---------- FFT radix-2 (in-place) ----------
const twCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();
function tables(n: number) {
  let t = twCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  t = { cos, sin, rev }; twCache.set(n, t);
  return t;
}
/** FFT kompleks in-place; inverse=true menghasilkan hasil tanpa pembagian n (pembagian dilakukan pemanggil). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length, { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = inverse ? -sin[w] : sin[w];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

// ======================================================================
//  TEMPO
// ======================================================================
export interface TempoResult {
  bpm: number;        // tempo terbaik (sudah dihaluskan, 2 desimal)
  conf: number;       // 0..1, seberapa menonjol puncak tempo (kasar)
  offset: number;     // detik: posisi ketukan pertama di dalam audio
  env: Float32Array;  // envelope kekuatan onset (dinormalkan)
  fps: number;        // frame envelope per detik
  delay: number;      // detik: waktu frame ke-i = i / fps + delay (pusat jendela analisis)
  alt: number[];      // kandidat lain (setengah / dua kali / lainnya), terurut skor
}
export const BPM_LO = 70, BPM_HI = 180;   // rentang pencarian utama; di luar itu pakai tombol ÷2 / ×2
export const TUNE = { prior: 115, sig: 1.0, w2: 0.3, w4: 0.1, wHalf: 0.3 };   // bobot pemilihan oktaf, disetel lewat sapuan di tools/bpmtune-test.ts (oktaf tetap bisa meleset: pakai ÷2 / ×2)

const FRAME = 512, HOP = 128, NBAND = 24;

/** Envelope onset: spectral flux log per pita, setengah gelombang, dikurangi rata-rata lokal. */
export function onsetEnvelope(x: Float32Array, sr: number): { env: Float32Array; fps: number; delay: number } {
  const d = Math.max(1, Math.round(sr / 11025)), n2 = Math.floor(x.length / d), sr2 = sr / d;
  const y = new Float32Array(n2);
  for (let i = 0; i < n2; i++) { let s = 0; const o = i * d; for (let k = 0; k < d; k++) s += x[o + k]; y[i] = s / d; }
  const frames = Math.max(0, Math.floor((n2 - FRAME) / HOP) + 1);
  const fps = sr2 / HOP;
  if (frames < 8) return { env: new Float32Array(Math.max(frames, 0)), fps, delay: FRAME / 2 / sr2 };
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  // batas pita: log-spasi dari bin 2 sampai FRAME/2-1
  const edges: number[] = [];
  const lo = 2, hi = FRAME / 2 - 1;
  for (let b = 0; b <= NBAND; b++) edges.push(Math.round(lo * Math.pow(hi / lo, b / NBAND)));
  for (let b = 1; b <= NBAND; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = new Float64Array(NBAND), cur = new Float64Array(NBAND);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = y[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < NBAND; b++) {
      let e = 0; const a = edges[b], z = Math.min(edges[b + 1], FRAME / 2);
      for (let k = a; k < z; k++) e += Math.hypot(re[k], im[k]);
      cur[b] = Math.log1p(60 * e / Math.max(1, z - a));
    }
    if (f > 0) { let fl = 0; for (let b = 0; b < NBAND; b++) { const dv = cur[b] - prev[b]; if (dv > 0) fl += dv; } env[f] = fl / NBAND; }
    const t = prev; prev = cur; cur = t;
  }
  // buang rata-rata lokal (~0,6 detik), potong negatif, normalkan
  const w = Math.max(3, Math.round(fps * 0.6)), cs = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cs[i + 1] = cs[i] + env[i];
  const out = new Float32Array(frames);
  let sum2 = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - (w >> 1)), b = Math.min(frames, i + (w >> 1) + 1);
    const v = Math.max(0, env[i] - (cs[b] - cs[a]) / (b - a));
    out[i] = v; sum2 += v * v;
  }
  const sd = Math.sqrt(sum2 / frames) || 1;
  for (let i = 0; i < frames; i++) out[i] /= sd;
  return { env: out, fps, delay: FRAME / 2 / sr2 };
}

function autocorr(env: Float32Array, maxLag: number): Float64Array {
  let n = 1; while (n < env.length * 2) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < env.length; i++) re[i] = env[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  const out = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag && l < env.length; l++) out[l] = re[l] / n / (env.length - l);   // dinormalkan terhadap jumlah pasangan
  return out;
}

const at = (e: Float32Array, p: number): number => {   // interpolasi linear
  const i = Math.floor(p); if (i < 0 || i + 1 >= e.length) return 0;
  const f = p - i; return e[i] * (1 - f) + e[i + 1] * f;
};

/** Skor comb: rata-rata envelope pada kelipatan periode P (frame), fase terbaik dicari per frame. */
function combScore(env: Float32Array, P: number): { score: number; phase: number } {
  let best = -1, bp = 0;
  const steps = Math.max(1, Math.ceil(P));
  for (let s = 0; s < steps; s++) {
    let sum = 0, cnt = 0;
    for (let p = s; p < env.length - 1; p += P) { sum += at(env, p); cnt++; }
    const sc = cnt ? sum / cnt : 0;
    if (sc > best) { best = sc; bp = s; }
  }
  return { score: best, phase: bp };
}

/** Deteksi tempo dari PCM mono. Rentang utama BPM_LO..BPM_HI. */
export function detectTempo(x: Float32Array, sr: number, lo = BPM_LO, hi = BPM_HI): TempoResult | null {
  const { env, fps, delay } = onsetEnvelope(x, sr);
  if (env.length < fps * 3) return null;   // minimal ~3 detik
  const lagLo = Math.floor((fps * 60) / hi), lagHi = Math.ceil((fps * 60) / lo);
  const ac = autocorr(env, Math.min(env.length - 1, lagHi * 4 + 2));
  const A = (lag: number): number => { const i = Math.floor(lag), f = lag - i; return (ac[i] ?? 0) * (1 - f) + (ac[i + 1] ?? 0) * f; };
  const PRIOR = TUNE.prior, SIG = TUNE.sig;   // prior log-Gauss lebar (oktaf): hanya menengahi kalau puncak setara
  const cands: { bpm: number; s: number }[] = [];
  for (let lag = lagLo; lag <= lagHi; lag++) {
    const bpm = (fps * 60) / lag, g = Math.log2(bpm / PRIOR);
    const prior = Math.exp(-0.5 * (g / SIG) * (g / SIG));
    const s = (A(lag) + TUNE.w2 * A(lag * 2) + TUNE.w4 * A(lag * 4) + TUNE.wHalf * A(lag / 2)) * prior;
    cands.push({ bpm, s });
  }
  // puncak lokal
  const peaks: { bpm: number; s: number }[] = [];
  for (let i = 1; i < cands.length - 1; i++) if (cands[i].s > cands[i - 1].s && cands[i].s >= cands[i + 1].s) peaks.push(cands[i]);
  if (!peaks.length) return null;
  peaks.sort((a, b) => b.s - a.s);
  const sorted = cands.map(c => c.s).sort((a, b) => a - b), med = sorted[sorted.length >> 1] || 1e-9;
  // penyempurnaan: comb halus di sekitar tiap kandidat teratas
  const refine = (b0: number): { bpm: number; score: number; phase: number } => {
    let bb = b0, bs = -1, bph = 0;
    for (let k = -30; k <= 30; k++) {
      const b = b0 * (1 + k * 0.001);   // +-3% langkah 0,1%
      const r = combScore(env, (fps * 60) / b);
      if (r.score > bs) { bs = r.score; bb = b; bph = r.phase; }
    }
    // langkah kedua lebih halus
    const c0 = bb;
    for (let k = -10; k <= 10; k++) {
      const b = c0 * (1 + k * 0.0001);
      const r = combScore(env, (fps * 60) / b);
      if (r.score > bs) { bs = r.score; bb = b; bph = r.phase; }
    }
    return { bpm: bb, score: bs, phase: bph };
  };
  const top = peaks.slice(0, 3).map(p => ({ ...refine(p.bpm), s: p.s }));
  // pilih: skor autokorelasi berprior menentukan urutan; comb hanya menyempurnakan nilai
  const win = top[0];
  const conf = Math.max(0, Math.min(1, (peaks[0].s / med - 1) / 6));
  const alt = [win.bpm / 2, win.bpm * 2].filter(v => v >= 40 && v <= 240).concat(top.slice(1).map(t => t.bpm));
  return { bpm: Math.round(win.bpm * 100) / 100, conf, offset: win.phase / fps + delay, env, fps, delay, alt };
}

// ======================================================================
//  PITCH (YIN)
// ======================================================================
export interface PitchResult { hz: number; prob: number; rms: number }

/** YIN. buf = jendela mono (disarankan 4096 sampel). Mengembalikan null kalau tidak ada nada stabil / terlalu sepi. */
export function yin(buf: Float32Array, sr: number, minHz = 50, maxHz = 1500, thresh = 0.12): PitchResult | null {
  let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
  const rms = Math.sqrt(e / buf.length);
  if (rms < 0.004) return null;
  const tauMax = Math.min(Math.floor(sr / minHz), Math.floor(buf.length / 2)), tauMin = Math.max(2, Math.floor(sr / maxHz));
  const W = buf.length - tauMax;
  if (W < 512) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const v = buf[j] - buf[j + tau]; s += v * v; }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  const cm = new Float32Array(tauMax + 1); cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (cm[t] < thresh) { while (t + 1 < tauMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
  }
  if (tau < 0) {   // tidak ada yang lolos ambang: terima minimum global kalau cukup rendah
    let m = tauMin; for (let t = tauMin; t < tauMax; t++) if (cm[t] < cm[m]) m = t;
    if (cm[m] > 0.25) return null;
    tau = m;
  }
  let t0 = tau;
  if (tau > 1 && tau < tauMax) {   // interpolasi parabola
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) t0 = tau + (a - c) / (2 * den);
  }
  return { hz: sr / t0, prob: Math.max(0, 1 - cm[tau]), rms };
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export interface NoteInfo { name: string; octave: number; cents: number; midi: number; target: number }
/** Hz -> nada terdekat relatif A4 acuan. cents -50..+50. target = Hz nada tepat. */
export function hzToNote(hz: number, a4 = 440): NoteInfo {
  const m = 69 + 12 * Math.log2(hz / a4), n = Math.round(m);
  return { name: NOTE_NAMES[((n % 12) + 12) % 12], octave: Math.floor(n / 12) - 1, cents: (m - n) * 100, midi: n, target: a4 * Math.pow(2, (n - 69) / 12) };
}

/** Mono-kan AudioBuffer-like (array channel) ke satu Float32Array. */
export function toMono(chs: Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n), k = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] * k;
  return out;
}

/** Tap tempo: dari daftar waktu ketukan (ms), kembalikan BPM rata-rata (median interval) atau null. */
export function tapBpm(times: number[]): number | null {
  if (times.length < 2) return null;
  const iv: number[] = []; for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
  iv.sort((a, b) => a - b);
  const mid = iv[iv.length >> 1];
  return mid > 0 ? 60000 / mid : null;
}
