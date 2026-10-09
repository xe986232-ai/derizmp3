// Tes KUALITAS pitch shift audio clip (Node, tanpa DOM): seberapa natural hasil dibanding vokal ASLI yang dinyanyikan langsung di nada target.
// Vokal sintetis: harmonik dengan tiga formant TETAP di frekuensi absolut (berganti vokal tiap ~0.75 s) + vibrato + luncuran pitch + napas.
// Referensi = vokal yang sama disintesis langsung di pitch target (formant tidak ikut bergeser). Pakai:  node tools/pitch-quality-test.ts [modul-lama.ts]
//   pitch      : galat pitch rata-rata (sen) terhadap kontur target
//   formant    : galat amplitudo harmonik terhadap referensi (dB, tanpa offset level) -> 0 = karakter vokal sama persis; resample biasa bisa 6-10 dB
//   noise      : kenaikan derau antar-harmonik dibanding referensi (dB; positif = lebih serak / metalik)
//   warble     : simpangan baku selisih level frame hasil vs referensi (dB) = amplitudo bergetar / flutter
//   level      : selisih level rata-rata hasil vs referensi (dB)
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { timeStretchPitch as newFn } from '../src/time-stretch.ts';

const oldPath = process.argv[2];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oldFn: any = oldPath ? (await import(pathToFileURL(resolve(oldPath)).href)).timeStretchPitch : null;
const SR = 44100;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const VOW = [[700, 1200, 2600], [330, 2100, 2900], [500, 900, 2500]];   // F1..F3 tiga vokal (a, i, o)
function formants(t: number): number[] {   // transisi mulus antar vokal tiap 0.75 s
  const u = t / 0.75, i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f), a = VOW[i % 3], b = VOW[(i + 1) % 3];
  return a.map((v, k) => v + (b[k] - v) * s);
}
const f0Of = (t: number, base: number, ratio: number): number => base * ratio * 2 ** ((0.25 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.4) + 1.5 * Math.sin(2 * Math.PI * 0.45 * t)) / 12);
function voice(base: number, ratio: number, dur: number, seed: number, stereo = false): Float32Array[] {   // amplitudo per harmonik = envelope di FREKUENSI ABSOLUT (tilt -11 dB/oktaf + formant): model sumber-filter, bukan tilt per nomor harmonik
  const SCALE = 1;
  const n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n), r = rng(seed), g = (): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  let ph = 0, pk = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f0Of(t, base, ratio), F = formants(t); ph += 2 * Math.PI * f / SR;
    const K = Math.floor(0.45 * SR / f); let v = 0;
    for (let k = 1; k <= K; k++) { const hz = k * f; v += Math.sin(k * ph) * (hz / 150) ** -1.1 * (1 + 3 * Math.exp(-(((hz - F[0]) / 150) ** 2)) + 2 * Math.exp(-(((hz - F[1]) / 250) ** 2)) + 1.5 * Math.exp(-(((hz - F[2]) / 300) ** 2))); }
    const env = Math.min(1, t / 0.05, (dur - t) / 0.05);
    L[i] = (v + 0.04 * g()) * env * SCALE; R[i] = (v * 0.9 + 0.04 * g()) * env * SCALE; pk = Math.max(pk, Math.abs(L[i]));
  }
  const rms = Math.sqrt(L.reduce((a, b) => a + b * b, 0) / n), g0 = 0.1 / rms;   // semua suara dinormalkan ke RMS yang sama (sumber dan referensi), seperti vokal yang direkam di level sama
  for (let i = 0; i < n; i++) { L[i] *= g0; R[i] *= g0; }
  return stereo ? [L, R] : [L];
}

interface M { pitch: number; formant: number; noise: number; warble: number; level: number; air: number }
function measure(y: Float32Array, ref: Float32Array, base: number, ratio: number): M {
  const N = 4096, hop = 1024, w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const spec = (x: Float32Array, s: number): Float64Array => { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (x[s + i] ?? 0) * w[i]; fft(re, im); const m = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) m[k] = Math.hypot(re[k], im[k]); return m; };
  const bin = (hz: number): number => hz * N / SR;
  const peakAt = (m: Float64Array, hz: number): number => { const c = Math.round(bin(hz)); let v = 0; for (let k = c - 2; k <= c + 2; k++) v = Math.max(v, m[k] ?? 0); return v; };
  let pc = 0, fe = 0, nz = 0, lv = 0, nF = 0, air = 0, rmsY = 0, rmsR = 0; const dl: number[] = [];
  for (let s = Math.round(0.3 * SR); s + N < Math.min(y.length, ref.length) - 0.3 * SR; s += hop) {
    const t = (s + N / 2) / SR, f0 = f0Of(t, base, ratio), my = spec(y, s), mr = spec(ref, s);
    const est = (m: Float64Array): number => { let best = -1, bc = 0; for (let c = -100; c <= 100; c += 2) { const f = f0 * 2 ** (c / 1200); let sum = 0; for (let k = 1; k <= 8; k++) sum += peakAt(m, k * f); if (sum > best) { best = sum; bc = c; } } return bc; };
    pc += Math.abs(est(my) - est(mr));   // selisih terhadap referensi lewat estimator yang sama (bias estimator hilang)
    let hy = 0, hr = 0, iy = 0, ir = 0, cnt = 0; const dif: number[] = [];
    for (let k = 1; k * f0 < 5000; k++) {
      const a = peakAt(my, k * f0), b = peakAt(mr, k * f0); dif.push(20 * Math.log10((a + 1e-9) / (b + 1e-9))); hy += a * a; hr += b * b;
      const ia = peakAt(my, (k + 0.5) * f0), ib = peakAt(mr, (k + 0.5) * f0); iy += ia * ia; ir += ib * ib; cnt++;
    }
    dif.sort((a, b) => a - b); const med = dif[dif.length >> 1]; fe += dif.reduce((s2, d) => s2 + Math.abs(d - med), 0) / dif.length; lv += med;
    nz += 10 * Math.log10(iy / hy) - 10 * Math.log10(ir / hr);
    let ay = 0, ar = 0; for (let k = Math.round(bin(6000)); k < bin(10000); k++) { ay += my[k] ** 2; ar += mr[k] ** 2; } air += 10 * Math.log10((ay + 1e-12) / (hy + 1e-12)) - 10 * Math.log10((ar + 1e-12) / (hr + 1e-12));   // energi 6-10 kHz (napas / desis) relatif ke energi harmonik, dibanding referensi
    let ey = 0, er = 0; for (let i = 0; i < N; i++) { ey += (y[s + i] ?? 0) ** 2; er += (ref[s + i] ?? 0) ** 2; }
    dl.push(10 * Math.log10((ey + 1e-12) / (er + 1e-12))); nF++; rmsY += ey; rmsR += er;
  }
  const mean = dl.reduce((a, b) => a + b, 0) / dl.length, sd = Math.sqrt(dl.reduce((a, b) => a + (b - mean) ** 2, 0) / dl.length);
  return { pitch: pc / nF, formant: fe / nF, noise: nz / nF, warble: sd, level: 10 * Math.log10((rmsY + 1e-12) / (rmsR + 1e-12)), air: air / nF };
}

const fmt = (m: M): string => `pitch ${m.pitch.toFixed(1).padStart(5)} sen | formant ${m.formant.toFixed(2).padStart(5)} dB | noise ${(m.noise >= 0 ? '+' : '') + m.noise.toFixed(1).padStart(4)} dB | warble ${m.warble.toFixed(2).padStart(5)} dB | level ${(m.level >= 0 ? '+' : '') + m.level.toFixed(1)} dB | air ${(m.air >= 0 ? '+' : '') + m.air.toFixed(1)} dB`;
const dur = 4;
const sums: Record<string, number[]> = { old: [0, 0, 0, 0], new: [0, 0, 0, 0] }; let cases = 0;
for (const base of [130, 240]) {
  for (const st of [-12, -7, -3, 3, 5, 7, 12]) {
    const src = voice(base, 1, dur, 3), ref = voice(base, 2 ** (st / 12), dur, 3)[0];   // level yang diharapkan = sama dengan sumber (RMS sama), jadi 'level' = selisih hasil vs referensi di RMS yang sama
    const row: string[] = []; cases++;
    for (const [name, fn] of [['old', oldFn], ['new', newFn]] as const) {
      if (!fn) continue;
      const t0 = Date.now(), y = fn(src, SR, 1, st)[0], ms = Date.now() - t0, m = measure(y, ref, base, 2 ** (st / 12));
      row.push(`  ${name}: ${fmt(m)} (${ms} ms)`); sums[name][0] += m.pitch; sums[name][1] += m.formant; sums[name][2] += Math.abs(m.noise); sums[name][3] += m.warble;
    }
    console.log(`f0 ${base} Hz, ${st >= 0 ? '+' : ''}${st} st\n${row.join('\n')}`);
  }
}
console.log('\nRata-rata ' + cases + ' kasus (pitch sen / formant dB / |noise| dB / warble dB):');
for (const k of Object.keys(sums)) if (sums[k][0] || sums[k][1]) console.log('  ' + k + ': ' + sums[k].map(v => (v / cases).toFixed(2)).join(' / '));
