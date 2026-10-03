// Harness evaluasi MPCS (Node, tanpa DOM). Menilai tracker pitch, segmentasi, dan kualitas koreksi pada sinyal sintetis yang kebenarannya diketahui.
// Pakai:  node tools/mpcs-eval.ts [path-ke-mpcs-dsp.ts]      (default: src/mpcs-dsp.ts; kasih path versi lama buat banding)
// Metrik (ala Smuts: MSE di domain log2-pitch + "distortion" koreksi dua kali):
//   recall / falseV : frame bernada yang terdeteksi / frame hening yang salah dianggap bernada
//   RPA50, pitchRMS : akurasi pitch tracker (dalam 50 cent, RMS error cent)
//   corrRMS, corr>50: error pitch HASIL koreksi terhadap kontur ideal (diukur dengan estimator terpisah di rentang sempit)
//   maxJump         : lompatan error terbesar antar frame 5 ms (artefak "tangga" di perbatasan nada)
//   HNR             : harmonic-to-noise ratio hasil render (noise antar-harmonik dari grain), makin tinggi makin bersih
//   idemSNR         : koreksi dua kali -> hasil ke-2 harus sama dengan hasil ke-1; jarak spektrum magnitudo STFT (dB, makin tinggi makin baik)
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modPath = process.argv[2] ?? new URL('../src/mpcs-dsp.ts', import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dsp: any = await import(pathToFileURL(resolve(modPath)).href);
const SR = 44100;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

interface TNote { t0: number; t1: number; midi: number; g?: number }
interface Scn { name: string; dur: number; notes: TNote[]; glide: number; vibHz: number; vibCents: number; snr?: number; dips?: Array<[number, number]>; scoop?: boolean; decay?: number; breath?: number; rev?: number; trem?: number; weak?: number; dipDb?: number }

const contiguous = (a: TNote, b: TNote): boolean => Math.abs(a.t1 - b.t0) < 1e-6;

// kontur pitch (MIDI) per sample + mask bernada; base = pitch pusat tiap nada (asli atau target)
function contour(sc: Scn, base: (n: TNote) => number): { midi: Float64Array; voiced: Uint8Array } {
  const N = Math.round(sc.dur * SR), midi = new Float64Array(N), voiced = new Uint8Array(N), ns = sc.notes;
  for (const n of ns) { const s = Math.round(n.t0 * SR), e = Math.round(n.t1 * SR); for (let t = s; t < e && t < N; t++) { midi[t] = base(n); voiced[t] = 1; } }
  for (let i = 0; i + 1 < ns.length; i++) {
    if (!contiguous(ns[i], ns[i + 1])) continue;
    const c = Math.round(ns[i].t1 * SR), h = Math.round(sc.glide / 2 * SR), a = base(ns[i]), b = base(ns[i + 1]);
    for (let k = -h; k < h; k++) { const u = (k + h) / (2 * h), s = u * u * (3 - 2 * u); midi[c + k] = a + (b - a) * s; }
  }
  let chain = 0;
  for (let i = 0; i < ns.length; i++) {
    if (i > 0 && !contiguous(ns[i - 1], ns[i])) chain = i;
    const s = Math.round(ns[i].t0 * SR), e = Math.round(ns[i].t1 * SR), c0 = ns[chain].t0;
    for (let t = s; t < e && t < N; t++) {
      const tt = t / SR - c0;
      midi[t] += (sc.vibCents / 100) * Math.sin(2 * Math.PI * sc.vibHz * tt) * Math.min(1, tt / 0.25);
      if (sc.scoop && i === 0) { const u = Math.min(1, (t / SR - ns[0].t0) / 0.1); midi[t] += -1.5 * (1 - u * u * (3 - 2 * u)); }
    }
  }
  return { midi, voiced };
}

function synth(sc: Scn, seed: number): { x: Float32Array; midi: Float64Array; voiced: Uint8Array } {
  const r = rng(seed), g = (): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const { midi, voiced } = contour(sc, n => n.midi), N = midi.length, x = new Float32Array(N);
  const amp = new Float64Array(N).fill(0);
  const ns = sc.notes;
  for (let i = 0; i < ns.length; i++) {
    const s = Math.round(ns[i].t0 * SR), e = Math.round(ns[i].t1 * SR), a = Math.round(0.015 * SR), rl = Math.round(0.03 * SR);
    const startsNew = i === 0 || !contiguous(ns[i - 1], ns[i]), endsHere = i === ns.length - 1 || !contiguous(ns[i], ns[i + 1]);
    const gn = 10 ** ((ns[i].g ?? 0) / 20);
    for (let t = s; t < e && t < N; t++) { let v = 1; if (startsNew && t - s < a) v = (t - s) / a; if (endsHere && e - t < rl) v = Math.min(v, (e - t) / rl); if (sc.decay) v *= 10 ** (-sc.decay * (t - s) / SR / 20); if (sc.trem) v *= 1 - 0.6 * (0.5 - 0.5 * Math.cos(2 * Math.PI * sc.trem * t / SR)); amp[t] = v * gn; }
  }
  for (const [d0, dd] of sc.dips ?? []) {   // lembah energi (artikulasi ulang nada yang sama)
    const s = Math.round(d0 * SR), l = Math.round(dd * SR);
    for (let k = 0; k < l; k++) { const u = Math.sin(Math.PI * k / l); amp[s + k] *= 1 - u * (1 - 10 ** (-(sc.dipDb ?? 12) / 20)); }
  }
  let ph = 0, jt = 0, pk = 0;
  for (let t = 0; t < N; t++) {
    if (!voiced[t]) { x[t] = 0.004 * g(); continue; }
    jt = 0.99 * jt + 0.0003 * g();
    const f = hz(midi[t]) * (1 + jt); ph += 2 * Math.PI * f / SR;
    let v = 0; const K = Math.floor(0.45 * SR / f);
    for (let k = 1; k <= K; k++) v += Math.sin(k * ph) * k ** -1.1 * (1 + 2 * Math.exp(-(((k * f - 800) / 350) ** 2))) * (k === 1 && sc.weak ? 10 ** (-sc.weak / 20) : 1);
    x[t] = (v + (sc.breath ?? 0.02) * g()) * amp[t]; pk = Math.max(pk, Math.abs(x[t]));
  }
  if (sc.rev) { const R = rng(99), taps: Array<[number, number]> = []; for (let q = 0; q < 260; q++) { const d = Math.round(R() * sc.rev * SR); taps.push([d, (R() < .5 ? -1 : 1) * 0.35 * Math.exp(-6.9 * d / (sc.rev * SR))]); } const y = new Float32Array(N); for (let t = 0; t < N; t++) { let a = x[t]; for (const [d, w] of taps) if (t >= d) a += w * x[t - d] * 0.5; y[t] = a; } x.set(y); pk = 0; for (let t = 0; t < N; t++) pk = Math.max(pk, Math.abs(x[t])); }
  const sc2 = 0.5 / pk; let e = 0, c = 0;
  for (let t = 0; t < N; t++) { x[t] *= sc2; if (voiced[t]) { e += x[t] * x[t]; c++; } }
  if (sc.snr) { const ns2 = Math.sqrt(e / c) / 10 ** (sc.snr / 20); for (let t = 0; t < N; t++) x[t] += ns2 * g(); }
  return { x, midi, voiced };
}

// estimator pitch terpisah: autokorelasi ternormalisasi di rentang sempit sekitar pitch yang diharapkan
function measure(y: Float32Array, t: number, hzExp: number): { cents: number; r: number } | null {
  const T = SR / hzExp, W = Math.max(Math.round(3 * T), Math.round(0.025 * SR)), lo = Math.floor(T * 2 ** (-2 / 12)), hi = Math.ceil(T * 2 ** (2 / 12));
  const s = t - (W >> 1); if (s < 0 || s + W + hi + 2 >= y.length) return null;
  const rr = new Float64Array(hi + 2);
  let e0 = 0; for (let j = 0; j < W; j++) e0 += y[s + j] * y[s + j];
  for (let l = lo - 1; l <= hi + 1; l++) { let c = 0, e1 = 0; for (let j = 0; j < W; j++) { c += y[s + j] * y[s + j + l]; e1 += y[s + j + l] * y[s + j + l]; } rr[l] = c / Math.sqrt(e0 * e1 + 1e-12); }
  let b = lo; for (let l = lo; l <= hi; l++) if (rr[l] > rr[b]) b = l;
  const a = rr[b - 1], m = rr[b], c = rr[b + 1], den = a - 2 * m + c, lag = den < 0 ? b + 0.5 * (a - c) / den : b;
  return { cents: 1200 * Math.log2(T / lag), r: m };
}

// FFT radix-2 sederhana untuk jarak spektral (tidak peka terhadap pergeseran fase / waktu kecil yang wajar pada PSOLA)
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) {
      const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
function specDist(a: Float32Array, b: Float32Array): number {   // dB: 20log10(||S_a|| / ||S_a - S_b||) di atas magnitudo STFT; makin tinggi = makin mirip
  const N = 2048, hop = 1024; let num = 0, den = 0;
  for (let s = 0; s + N <= a.length; s += hop) {
    const ra = new Float64Array(N), ia = new Float64Array(N), rb = new Float64Array(N), ib = new Float64Array(N);
    for (let j = 0; j < N; j++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / N); ra[j] = a[s + j] * w; rb[j] = b[s + j] * w; }
    fft(ra, ia); fft(rb, ib);
    for (let k = 0; k < N / 2; k++) { const ma = Math.hypot(ra[k], ia[k]), mb = Math.hypot(rb[k], ib[k]); num += ma * ma; den += (ma - mb) ** 2; }
  }
  return 10 * Math.log10(num / (den + 1e-20));
}

const pct = (a: number[], p: number): number => { if (!a.length) return 0; const b = a.slice().sort((q, w) => q - w); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };

function evaluate(sc: Scn): Record<string, number | string> {
  const { x, midi, voiced } = synth(sc, 7), N = x.length;
  const pre = new Int32Array(N + 1); for (let t = 0; t < N; t++) pre[t + 1] = pre[t] + voiced[t];
  const vcount = (a: number, b: number): number => pre[Math.min(N, Math.max(0, b))] - pre[Math.min(N, Math.max(0, a))];
  const tol = (ms: number): number => Math.round(ms / 1000 * SR);

  let t0 = performance.now();
  const { pt, notes } = dsp.analyze(x, SR);
  const tA = performance.now() - t0;

  // --- tracker ---
  let nv = 0, rec = 0, rpa = 0, sq = 0, nq = 0, fv = 0, ne = 0;
  for (let fi = 0; fi < pt.f0.length; fi++) {
    const t = fi * pt.hop; if (t >= N) break;
    const a = t - tol(20), b = t + tol(20);
    if (vcount(a, b) === b - a) {
      nv++; if (pt.f0[fi] > 0) { rec++; const err = 1200 * Math.log2(pt.f0[fi] / hz(midi[t])); if (Math.abs(err) < 50) rpa++; sq += err * err; ne++; }
    }
    if (vcount(t - tol(40), t + tol(40)) === 0) { nq++; if (pt.f0[fi] > 0) fv++; }
  }

  if (process.env.DBG) {   // peta frame: # cocok, X nada tidak terdeteksi, F salah deteksi, . hening
    let line = '';
    for (let fi = 0; fi < pt.f0.length; fi++) { const t = fi * pt.hop; if (t >= N) break; const tv = vcount(t - tol(20), t + tol(20)) === 2 * tol(20), q = vcount(t - tol(40), t + tol(40)) === 0, d = pt.f0[fi] > 0; line += tv ? (d ? '#' : 'X') : q ? (d ? 'F' : '.') : (d ? '+' : '-'); }
    console.log(sc.name + '\n' + (line.match(/.{1,110}/g) ?? []).join('\n'));
  }

  // --- segmentasi ---
  let matched = 0, onset = 0;
  for (const tn of sc.notes) {
    const m = notes.find((d: { s: number; midi: number }) => Math.abs(d.s * pt.hop / SR - tn.t0) < 0.06 && Math.abs(d.midi - tn.midi) < 0.6);
    if (m) { matched++; onset += Math.abs(m.s * pt.hop / SR - tn.t0); }
  }

  // --- koreksi (snap semua) ---
  if (dsp.snapTargets) dsp.snapTargets(notes); else for (const n of notes) n.target = Math.round(n.midi);
  t0 = performance.now(); const y1: Float32Array = dsp.render(x, pt, notes); const tR = performance.now() - t0;
  const exp = contour(sc, n => Math.round(n.midi)).midi;
  const errs: number[] = [], seq: number[] = [], hnr: number[] = []; let tried = 0, failed = 0;
  const step = tol(5);
  for (let t = tol(60); t < N - tol(60); t += step) {
    if (vcount(t - tol(25), t + tol(25)) !== 2 * tol(25)) { seq.push(NaN); continue; }
    tried++; const m = measure(y1, t, hz(exp[t]));
    if (!m || m.r < 0.5) { failed++; seq.push(NaN); continue; }
    errs.push(m.cents); seq.push(m.cents); hnr.push(10 * Math.log10(m.r / (1 - m.r + 1e-6)));
  }
  if (process.env.DBG) console.log(sc.name + ' err(c) tiap 5ms: ' + seq.map(v => (Number.isNaN(v) ? '  .' : String(Math.round(v)).padStart(3))).join(' ').slice(0, 1400));
  const jumps: number[] = []; for (let i = 1; i < seq.length; i++) if (!Number.isNaN(seq[i]) && !Number.isNaN(seq[i - 1])) jumps.push(Math.abs(seq[i] - seq[i - 1]));

  // --- distortion: koreksi dua kali ---
  const r2 = dsp.analyze(y1, SR);
  if (dsp.snapTargets) dsp.snapTargets(r2.notes); else for (const n of r2.notes) n.target = Math.round(n.midi);
  const y2: Float32Array = dsp.render(y1, r2.pt, r2.notes);
  let s1 = 0, sd = 0, s2 = 0, sc12 = 0; for (let t = 0; t < N; t++) { s1 += y1[t] * y1[t]; s2 += y2[t] * y2[t]; sd += (y2[t] - y1[t]) ** 2; sc12 += y1[t] * y2[t]; }

  return {
    sc: sc.name, notes: `${notes.length}/${sc.notes.length}`, match: `${matched}/${sc.notes.length}`,
    recall: 100 * rec / Math.max(1, nv), falseV: 100 * fv / Math.max(1, nq), rpa50: 100 * rpa / Math.max(1, nv), pitchRMS: Math.sqrt(sq / Math.max(1, ne)),
    corrRMS: Math.sqrt(errs.reduce((a, c) => a + c * c, 0) / Math.max(1, errs.length)), corr50: 100 * (errs.filter(c => Math.abs(c) > 50).length + failed) / Math.max(1, tried),
    maxJump: Math.max(0, ...jumps), p99Jump: pct(jumps, 0.99), hnr: hnr.length ? hnr.reduce((a, c) => a + c, 0) / hnr.length : 0,
    idemSNR: specDist(y1, y2), idemNCC: sc12 / Math.sqrt(s1 * s2 + 1e-20), onsetMs: matched ? 1000 * onset / matched : 0, tA, tR
  };
}

const steady: TNote[] = [{ t0: 0.2, t1: 0.85, midi: 60.3 }, { t0: 1.0, t1: 1.6, midi: 63.7 }, { t0: 1.75, t1: 2.35, midi: 67.35 }];
const legato: TNote[] = [{ t0: 0.1, t1: 0.6, midi: 57.4 }, { t0: 0.6, t1: 1.1, midi: 60.7 }, { t0: 1.1, t1: 1.5, midi: 64.35 }, { t0: 1.5, t1: 2.1, midi: 62.6 }, { t0: 2.1, t1: 2.6, midi: 59.3 }];
const repeated: TNote[] = [{ t0: 0.1, t1: 0.5, midi: 62.35 }, { t0: 0.5, t1: 0.9, midi: 62.35 }, { t0: 0.9, t1: 1.4, midi: 62.35 }, { t0: 1.4, t1: 1.9, midi: 65.4 }];
const shift = (ns: TNote[], d: number): TNote[] => ns.map(n => ({ ...n, midi: n.midi + d }));
const pluck: TNote[] = [{ t0: 0.1, t1: 0.7, midi: 60.2 }, { t0: 0.8, t1: 1.4, midi: 64.3 }, { t0: 1.5, t1: 2.1, midi: 67.1 }, { t0: 2.2, t1: 2.8, midi: 62.4 }];
const run: TNote[] = Array.from({ length: 8 }, (_, k) => ({ t0: 0.1 + k * 0.14, t1: 0.1 + (k + 1) * 0.14, midi: [60.2, 62.3, 64.1, 65.4, 67.2, 65.3, 64.2, 62.1][k] }));
const mixedLvl: TNote[] = [{ t0: 0.1, t1: 0.7, midi: 60.2 }, { t0: 0.9, t1: 1.5, midi: 64.3, g: -34 }, { t0: 1.7, t1: 2.3, midi: 67.1 }];
const longN: TNote[] = [{ t0: 0.2, t1: 2.2, midi: 62.4 }];
const scenarios: Scn[] = [
  { name: 'clean steady', dur: 2.6, notes: steady, glide: 0.05, vibHz: 5.5, vibCents: 35 },
  { name: 'pluck decay', dur: 3.0, notes: pluck, glide: 0.05, vibHz: 0, vibCents: 0, decay: 30 },
  { name: 'piano decay+rev', dur: 3.0, notes: pluck, glide: 0.05, vibHz: 0, vibCents: 0, decay: 18, rev: 0.7 },
  { name: '808 bass', dur: 3.0, notes: shift(pluck, -30), glide: 0.05, vibHz: 0, vibCents: 0, decay: 10 },
  { name: 'high synth', dur: 3.0, notes: shift(pluck, 28), glide: 0.05, vibHz: 0, vibCents: 0 },
  { name: 'breathy 8dB', dur: 2.6, notes: steady, glide: 0.05, vibHz: 5, vibCents: 30, snr: 8, breath: 0.15 },
  { name: 'vocal+rev', dur: 2.9, notes: legato, glide: 0.08, vibHz: 5, vibCents: 25, rev: 0.9, breath: 0.08 },
  { name: 'weak f0 -20dB', dur: 2.6, notes: steady, glide: 0.05, vibHz: 5.5, vibCents: 30, weak: 20 },
  { name: 'tremolo 6Hz', dur: 2.6, notes: steady, glide: 0.05, vibHz: 5.5, vibCents: 30, trem: 6 },
  { name: 'long note dips', dur: 2.6, notes: longN, glide: 0.05, vibHz: 5, vibCents: 30, dips: [[0.8, 0.04], [1.4, 0.05]], dipDb: 9 },
  { name: 'quiet+loud', dur: 2.6, notes: mixedLvl, glide: 0.05, vibHz: 5, vibCents: 20 },
  { name: 'fast run', dur: 1.5, notes: run, glide: 0.03, vibHz: 0, vibCents: 0 }
];

const rows = scenarios.map(evaluate);
const cols: Array<[string, string, number, number]> = [
  ['sc', 'skenario', 13, 0], ['notes', 'nada', 6, 0], ['match', 'cocok', 6, 0], ['recall', 'recall%', 8, 1], ['falseV', 'falseV%', 8, 1], ['rpa50', 'RPA50%', 7, 1], ['pitchRMS', 'trkRMS c', 9, 1],
  ['corrRMS', 'corrRMS c', 10, 1], ['corr50', 'corr>50%', 9, 1], ['maxJump', 'maxJump c', 10, 1], ['hnr', 'HNR dB', 7, 1], ['idemSNR', 'idemSNR', 8, 1], ['tA', 'anls ms', 8, 0], ['tR', 'rndr ms', 8, 0]
];
console.log('MPCS eval: ' + modPath);
console.log(cols.map(c => c[1].padEnd(c[2])).join(' '));
for (const r of rows) console.log(cols.map(c => (typeof r[c[0]] === 'number' ? (r[c[0]] as number).toFixed(c[3]) : String(r[c[0]])).padEnd(c[2])).join(' '));
const avg = (k: string): number => rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length;
console.log('rata-rata    recall ' + avg('recall').toFixed(1) + '  falseV ' + avg('falseV').toFixed(1) + '  RPA50 ' + avg('rpa50').toFixed(1) + '  corrRMS ' + avg('corrRMS').toFixed(1) + 'c  corr>50 ' + avg('corr50').toFixed(1) + '%  maxJump ' + avg('maxJump').toFixed(1) + 'c  HNR ' + avg('hnr').toFixed(1) + 'dB  idemSNR ' + avg('idemSNR').toFixed(1) + 'dB');
