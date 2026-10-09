// Time-stretch tanpa mengubah pitch (WSOLA: Waveform Similarity Overlap-Add), murni DSP tanpa DOM supaya bisa dites di Node.
// factor = durasi hasil / durasi asli (mis. vokal 126 BPM -> project 130 BPM: factor = 126/130 = 0.969, hasil sedikit lebih pendek).
// Semua channel memakai posisi potong yang sama (dicari dari campuran mono), jadi gambar stereo tidak bergeser.

export const STRETCH_MIN = 0.5, STRETCH_MAX = 2;

export function timeStretch(chs: Float32Array[], sr: number, factor: number, onProgress?: (p: number) => void): Float32Array[] {
  const n = chs[0].length, outLen = Math.max(1, Math.round(n * factor));
  if (Math.abs(factor - 1) < 1e-6 || n < 4096) return chs.map(c => resample(c, outLen));
  const Hs = Math.max(64, Math.round(sr * 0.0125)), N = 2 * Hs;           // frame 25 ms, loncat sintesis 12,5 ms (overlap 50%)
  const Ha = Hs / factor;                                                  // loncat analisis (sampel masukan per frame keluaran)
  const D = 4, delta = Math.round(sr * 0.015), dd = Math.ceil(delta / D);  // pencarian +-15 ms (kasar di sampel / 4, lalu dihaluskan)
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);   // Hann periodik: overlap 50% berjumlah 1

  const mono = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
  const m = Math.floor(n / D), dec = new Float32Array(m);                  // versi sampel / 4 (rata-rata 4 sampel) untuk pencarian kasar
  for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < D; j++) s += mono[i * D + j]; dec[i] = s / D; }

  const out = chs.map(() => new Float32Array(outLen + N));
  const wsum = new Float32Array(outLen + N);
  const frames = Math.ceil(outLen / Hs) + 1, Nd = Math.floor(N / D);
  let prev = 0;                                                            // posisi masukan frame sebelumnya
  for (let f = 0; f < frames; f++) {
    let pos = Math.round(f * Ha);
    if (f > 0) {                                                           // cari geser terbaik: mirip dengan lanjutan alami frame sebelumnya
      const tgt = Math.floor((prev + Hs) / D), lo = Math.floor(pos / D);
      let best = -Infinity, bj = 0;
      for (let j = -dd; j <= dd; j++) {
        const a = lo + j;
        if (a < 0 || a + Nd > m || tgt + Nd > m) continue;
        let xc = 0, e = 1e-9;
        for (let i = 0; i < Nd; i++) { const v = dec[a + i]; xc += v * dec[tgt + i]; e += v * v; }
        const sc = xc / Math.sqrt(e);                                      // korelasi ternormalisasi (energi target konstan)
        if (sc > best) { best = sc; bj = j; }
      }
      pos = (lo + bj) * D;
      const t0 = prev + Hs; let b2 = -Infinity, bk = 0;                    // penghalusan di resolusi penuh (+-D sampel)
      for (let k = -D; k <= D; k++) {
        const a = pos + k;
        if (a < 0 || a + N > n || t0 + N > n) continue;
        let xc = 0, e = 1e-9;
        for (let i = 0; i < N; i += 2) { const v = mono[a + i]; xc += v * mono[t0 + i]; e += v * v; }
        const sc = xc / Math.sqrt(e);
        if (sc > b2) { b2 = sc; bk = k; }
      }
      pos += bk;
    }
    pos = Math.max(0, Math.min(pos, n - 1));
    prev = pos;
    const o = f * Hs;
    if (o >= outLen) break;
    for (let i = 0; i < N; i++) {
      const w = win[i], si = pos + i;
      if (si < n) for (let c = 0; c < chs.length; c++) out[c][o + i] += chs[c][si] * w;
      wsum[o + i] += si < n ? w : 0;
    }
    if (onProgress && (f & 63) === 0) onProgress(Math.min(1, o / outLen));
  }
  return out.map(y => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = wsum[i] > 1e-3 ? y[i] / Math.max(wsum[i], 0.5) : 0;   // tepi: bagi jumlah window (bukan loncat volume)
    const fo = Math.min(outLen, Math.round(sr * 0.003));                   // ujung hasil: window terpotong habisnya masukan, redam 3 ms supaya tidak klik
    for (let i = 0; i < fo; i++) r[outLen - 1 - i] *= i / fo;
    return r;
  });
}

function resample(c: Float32Array, len: number): Float32Array {   // jalan pintas (factor 1 / audio sangat pendek): pemetaan linear
  const r = new Float32Array(len), k = c.length / len;
  for (let i = 0; i < len; i++) { const p = i * k, a = Math.floor(p), f = p - a; r[i] = (c[a] ?? 0) * (1 - f) + (c[Math.min(a + 1, c.length - 1)] ?? 0) * f; }
  return r;
}

// ---------- Pitch shift (durasi tetap) ----------
// Pitch naik/turun `semitones` tanpa mengubah durasi, dengan suara tetap natural:
//  1. Phase vocoder (STFT 2048, overlap 75%) + identity phase locking (Laroche-Dolson): tiap puncak spektrum membawa seluruh daerah di sekitarnya,
//     jadi harmonik tidak saling lepas fase (tidak "bergetar / metalik" seperti WSOLA yang jauh dari factor 1). Onset (konsonan, ketukan) memicu reset fase supaya tetap tajam.
//     Semua channel diputar dengan sudut fase yang SAMA (dihitung dari campuran mono) -> gambar stereo tidak bergeser.
//  2. Koreksi FORMANT: envelope spektrum (cepstrum "true envelope") frame asli dipetakan ke frekuensi baru, jadi karakter suara / warna instrumen tidak ikut
//     bergeser (tanpa ini suara naik jadi "chipmunk", turun jadi "monster" karena resample menggeser formant bersama pitch).
//  3. Resample sinc berjendela Kaiser (anti-aliasing otomatis) ke durasi akhir: memutar r kali lebih cepat menaikkan nada sebesar r (r = 2^(semitone/12)).
// Durasi akhir = n x factor, sama persis dengan timeStretch(): factor 1 = durasi asli. factor bisa digabung dengan tempo (mis. 126 -> 130 BPM sekaligus +3 semitone).
export const CLIP_PITCH_MIN = -12, CLIP_PITCH_MAX = 12;

export function timeStretchPitch(chs: Float32Array[], sr: number, factor: number, semitones: number, onProgress?: (p: number) => void): Float32Array[] {
  if (Math.abs(semitones) < 1e-4) return timeStretch(chs, sr, factor, onProgress);
  const r = 2 ** (semitones / 12), outLen = Math.max(1, Math.round(chs[0].length * factor));
  const y = phaseVocoder(chs, sr, factor * r, r, onProgress);
  const o = y.map(c => resampleSinc(c, outLen));
  let pk = 0; for (const c of o) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > pk) pk = v; }
  if (pk > 1) { const g = 1 / pk; for (const c of o) for (let i = 0; i < c.length; i++) c[i] *= g; }   // sumber sangat keras: hasil tidak boleh melewati full scale (semua channel diturunkan sama, stereo tetap)
  return o;
}

class FFT {   // radix-2 iteratif dengan tabel; transform() in-place, inv = true -> dibagi n
  readonly n: number; private cs: Float64Array; private sn: Float64Array; private rev: Uint32Array;
  constructor(n: number) {
    this.n = n; this.cs = new Float64Array(n >> 1); this.sn = new Float64Array(n >> 1); this.rev = new Uint32Array(n);
    for (let i = 0; i < n >> 1; i++) { this.cs[i] = Math.cos(2 * Math.PI * i / n); this.sn[i] = -Math.sin(2 * Math.PI * i / n); }
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) { let v = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) v |= 1 << (bits - 1 - b); this.rev[i] = v; }
  }
  transform(re: Float64Array, im: Float64Array, inv: boolean): void {
    const n = this.n, rev = this.rev, cs = this.cs, sn = this.sn, sg = inv ? -1 : 1;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cs[k], wi = sg * sn[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

const GAIN_MAX_DB = 15, GAIN_MIN_DB = -24;   // batas koreksi formant per bin (menahan derau lantai agar tidak diangkat berlebihan)
const ONSET_RATIO = 0.9;                     // flux spektral (kenaikan magnitudo / magnitudo frame sebelumnya) di atas ini = onset -> reset fase

// Time-stretch phase vocoder: durasi hasil = n x S. fr != 1 -> sekaligus koreksi formant untuk pergeseran nada sebesar fr (dipakai sebelum resample ke durasi akhir).
function phaseVocoder(chs: Float32Array[], sr: number, S: number, fr: number, onProgress?: (p: number) => void): Float32Array[] {
  const n = chs[0].length, C = chs.length, outLen = Math.max(1, Math.round(n * S));
  let N = 1024; while (N < sr * 0.04) N <<= 1;                       // 44.1 / 48 kHz -> 2048
  const half = N >> 1, Hs = N >> 2, Ha = Hs / S, fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const frames = Math.ceil((outLen + half) / Hs) + 1, total = frames * Hs + N;
  const out = chs.map(() => new Float32Array(total)), wsum = new Float32Array(total);
  const zr = new Float64Array(N), zi = new Float64Array(N);
  const Ar = chs.map(() => new Float64Array(half + 1)), Ai = chs.map(() => new Float64Array(half + 1));
  const mag = new Float64Array(half + 1), prevMag = new Float64Array(half + 1), phi = new Float64Array(half + 1), prevPhi = new Float64Array(half + 1);
  const psi = new Float64Array(half + 1), th = new Float64Array(half + 1), gain = new Float64Array(half + 1).fill(1);
  const peaks = new Int32Array(half + 1);
  const useEnv = Math.abs(fr - 1) > 1e-4, env = useEnv ? new Envelope(N, sr) : null;
  const w2pi = 2 * Math.PI / N, lastDone = { v: -1 };
  let first = true, E: Float64Array | null = null;

  for (let f = 0; f < frames; f++) {
    const s = Math.round(f * Ha) - half, o = f * Hs;
    // --- analisis: dua channel dikemas satu FFT kompleks (kiri = real, kanan = imajiner) ---
    for (let c = 0; c < C; c += 2) {
      const a = chs[c], b = c + 1 < C ? chs[c + 1] : null;
      for (let i = 0; i < N; i++) { const t = s + i; if (t >= 0 && t < n) { zr[i] = a[t] * win[i]; zi[i] = b ? b[t] * win[i] : 0; } else { zr[i] = 0; zi[i] = 0; } }
      fft.transform(zr, zi, false);
      for (let k = 0; k <= half; k++) {
        const j = (N - k) & (N - 1);
        Ar[c][k] = (zr[k] + zr[j]) / 2; Ai[c][k] = (zi[k] - zi[j]) / 2;
        if (b) { Ar[c + 1][k] = (zi[k] + zi[j]) / 2; Ai[c + 1][k] = -(zr[k] - zr[j]) / 2; }
      }
    }
    // --- campuran mono: dasar deteksi puncak / fase / envelope ---
    let flux = 0, prevSum = 0;
    for (let k = 0; k <= half; k++) {
      let mr = 0, mi = 0; for (let c = 0; c < C; c++) { mr += Ar[c][k]; mi += Ai[c][k]; }
      mr /= C; mi /= C; mag[k] = Math.hypot(mr, mi); phi[k] = Math.atan2(mi, mr);
      if (k < half * 0.75) { flux += Math.max(0, mag[k] - prevMag[k]); prevSum += prevMag[k]; }
    }
    // --- puncak spektrum (harmonik / sinusoid): dasar identity phase locking ---
    let np = 0, pm = 0;
    for (let k = 2; k < half - 1; k++) { const m = mag[k]; if (m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2] && m > pm * 1e-4) peaks[np++] = k; if (m > pm) pm = m; }
    // --- fase sintesis (identity phase locking) ---
    if (first || Math.abs(S - 1) < 1e-9 || flux > ONSET_RATIO * prevSum + 1e-6 * half) {   // frame pertama / tanpa stretch / onset: fase asli dipertahankan
      th.fill(0); for (let k = 0; k <= half; k++) psi[k] = phi[k];
    } else if (np === 0) {
      for (let k = 0; k <= half; k++) { let d = phi[k] - prevPhi[k] - w2pi * k * Ha; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); psi[k] = psi[k] + (w2pi * k + d / Ha) * Hs; th[k] = psi[k] - phi[k]; }
    } else {
      let lo = 0;
      for (let pi = 0; pi < np; pi++) {
        const p = peaks[pi];
        let hi = half + 1;
        if (pi + 1 < np) { const q = peaks[pi + 1]; let mb = p, mv = Infinity; for (let k = p; k <= q; k++) if (mag[k] < mv) { mv = mag[k]; mb = k; } hi = mb + 1; }   // batas daerah = lembah antar puncak
        let d = phi[p] - prevPhi[p] - w2pi * p * Ha; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));   // deviasi fase -> frekuensi sesaat
        const t = psi[p] + (w2pi * p + d / Ha) * Hs - phi[p];
        for (let k = lo; k < hi; k++) { th[k] = t; psi[k] = phi[k] + t; }
        lo = hi;
      }
    }
    for (let k = 0; k <= half; k++) { prevMag[k] = mag[k]; prevPhi[k] = phi[k]; }
    th[0] = 0; th[half] = 0;
    // --- koreksi formant ---
    if (env) {
      if (!E || (f & 1) === 0) E = env.compute(mag);   // envelope tiap 2 frame (formant berubah jauh lebih lambat dari 11 ms)
      let e0 = 0, e1 = 0;
      for (let k = 0; k <= half; k++) {
        const x = Math.min(k * fr, half), i0 = Math.min(Math.floor(x), half - 1), fx = x - i0;
        const e2 = E[i0] * (1 - fx) + E[i0 + 1] * fx;
        gain[k] = Math.exp(Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, (e2 - E[k]) * 8.685889638)) / 8.685889638);   // E dalam ln (nepir), batas dalam dB
        e0 += mag[k] * mag[k]; e1 += mag[k] * mag[k] * gain[k] * gain[k];
      }
      // loudness tetap: harmonik jadi lebih jarang (nada naik) / rapat (turun), jadi energi frame ikut berubah kalau hanya envelope yang dijaga -> samakan dengan energi frame asli
      const norm = e1 > 1e-20 ? Math.max(1 / 32, Math.min(32, Math.sqrt(e0 / e1))) : 1;   // lebar: spektrum jarang (sinus, bass 808) bisa kehilangan envelope di frekuensi tujuan -> semua gain kecil, normalisasi yang memulihkan levelnya
      for (let k = 0; k <= half; k++) gain[k] *= norm;
    }
    // --- sintesis: putar fase tiap bin, kalikan gain, kembalikan ke waktu, window + overlap-add ---
    for (let c = 0; c < C; c += 2) {
      const b = c + 1 < C;
      for (let k = 0; k <= half; k++) {
        const cs = Math.cos(th[k]) * gain[k], sn = Math.sin(th[k]) * gain[k];
        let r = Ar[c][k], im = Ai[c][k]; Ar[c][k] = r * cs - im * sn; Ai[c][k] = r * sn + im * cs;
        if (b) { r = Ar[c + 1][k]; im = Ai[c + 1][k]; Ar[c + 1][k] = r * cs - im * sn; Ai[c + 1][k] = r * sn + im * cs; }
      }
      for (let k = 0; k <= half; k++) {
        const Br = b ? Ar[c + 1][k] : 0, Bi = b ? Ai[c + 1][k] : 0;
        zr[k] = Ar[c][k] - Bi; zi[k] = Ai[c][k] + Br;
        if (k > 0 && k < half) { zr[N - k] = Ar[c][k] + Bi; zi[N - k] = -Ai[c][k] + Br; }
      }
      fft.transform(zr, zi, true);
      const a = out[c], bb = b ? out[c + 1] : null;
      for (let i = 0; i < N; i++) { a[o + i] += zr[i] * win[i]; if (bb) bb[o + i] += zi[i] * win[i]; }
    }
    for (let i = 0; i < N; i++) wsum[o + i] += win[i] * win[i];
    first = false;
    if (onProgress && (f & 63) === 0 && f !== lastDone.v) { lastDone.v = f; onProgress(Math.min(1, f / frames)); }
  }
  return out.map(y => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) { const w = wsum[i + half]; r[i] = w > 1e-3 ? y[i + half] / Math.max(w, 0.5) : 0; }
    const fo = Math.min(outLen, Math.round(sr * 0.003)), fi = Math.min(outLen, Math.round(sr * 0.002));   // ujung hasil redam 3 ms (tanpa klik); awal 2 ms (frame pertama setengah kosong -> lonjakan sesaat)
    for (let i = 0; i < fo; i++) r[outLen - 1 - i] *= i / fo;
    for (let i = 0; i < fi; i++) r[i] *= i / fi;
    return r;
  });
}

// Envelope spektrum (ln magnitudo) per frame: max-pool 4 bin (otomatis menempel ke puncak harmonik) -> cepstrum + lifter + iterasi "true envelope" pada FFT 4x lebih kecil.
const POOL = 4;
const ENV_ITERS = 10, ENV_LIFT = 600;   // iterasi true envelope (10 sudah menempel ke puncak harmonik; 16 hanya menambah waktu); lifter ~ pisahkan harmonik sampai 600 Hz
class Envelope {
  readonly out: Float64Array; private fft: FFT; private P: number; private M: number;
  private cr: Float64Array; private ci: Float64Array; private a0: Float64Array; private cur: Float64Array; private lift: Float64Array;
  constructor(N: number, sr: number) {
    const half = N >> 1, P = half / POOL + 1, M = 2 * (P - 1), Lq = Math.max(4, Math.min(P - 2, Math.round(sr / ENV_LIFT)));
    this.P = P; this.M = M; this.fft = new FFT(M); this.out = new Float64Array(half + 1);
    this.cr = new Float64Array(M); this.ci = new Float64Array(M); this.a0 = new Float64Array(P); this.cur = new Float64Array(P); this.lift = new Float64Array(P);
    for (let q = 0; q <= Lq; q++) this.lift[q] = q <= Lq / 2 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (q - Lq / 2) / (Lq / 2));
  }
  compute(mag: Float64Array): Float64Array {
    const { P, M, fft, cr, ci, a0, cur, lift, out } = this, half = mag.length - 1;
    let top = 0; for (let k = 0; k <= half; k++) if (mag[k] > top) top = mag[k];
    const floor = Math.max(top * 1e-5, 1e-12);                         // lantai -100 dB dari puncak: bin kosong tidak menyeret envelope ke -tak-hingga
    for (let j = 0; j < P; j++) {
      let m = 0; for (let k = Math.max(0, j * POOL - 2), e = Math.min(half, j * POOL + 1); k <= e; k++) if (mag[k] > m) m = mag[k];
      a0[j] = Math.log(Math.max(m, floor)); cur[j] = a0[j];
    }
    for (let it = 0; it < ENV_ITERS; it++) {
      for (let j = 0; j < P; j++) { cr[j] = cur[j]; if (j > 0 && j < P - 1) cr[M - j] = cur[j]; }
      ci.fill(0); fft.transform(cr, ci, true);                         // cepstrum (nyata, simetris)
      for (let q = 0; q < P; q++) { const l = lift[q]; cr[q] *= l; if (q > 0 && q < P - 1) cr[M - q] *= l; }
      ci.fill(0); fft.transform(cr, ci, false);                        // kembali ke spektrum log yang sudah dihaluskan
      for (let j = 0; j < P; j++) cur[j] = Math.max(a0[j], cr[j]);
    }
    for (let k = 0; k <= half; k++) { const x = k / POOL, j = Math.min(Math.floor(x), P - 2), f = x - j; out[k] = cr[j] * (1 - f) + cr[j + 1] * f; }
    return out;
  }
}

// Resample sinc berjendela Kaiser ke panjang `len`. Pemutaran lebih cepat (c lebih panjang dari len) otomatis diberi low-pass di Nyquist baru (anti-aliasing).
const SINC_T = 8, SINC_RES = 256, KAISER_BETA = 9;
let sincTab: Float32Array | null = null;
function i0(x: number): number { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
function sincTable(): Float32Array {
  if (sincTab) return sincTab;
  const t = new Float32Array(SINC_T * SINC_RES + 2), d = i0(KAISER_BETA);
  for (let i = 0; i < t.length; i++) {
    const x = i / SINC_RES, u = x / SINC_T;
    t[i] = u >= 1 ? 0 : (x < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * i0(KAISER_BETA * Math.sqrt(1 - u * u)) / d;
  }
  return (sincTab = t);
}
function resampleSinc(c: Float32Array, len: number): Float32Array {
  const r = new Float32Array(len), k = c.length / len, sc = Math.max(1, k), W = Math.ceil(SINC_T * sc / 0.97), tab = sincTable(), last = c.length - 1, cut = 0.97 / sc;   // cut: sedikit di bawah Nyquist baru
  for (let i = 0; i < len; i++) {
    const p = i * k, i1 = Math.floor(p), a = Math.max(0, i1 - W + 1), b = Math.min(last, i1 + W);
    let sum = 0, ws = 0;
    for (let j = a; j <= b; j++) {
      const x = Math.abs(j - p) * cut, pos = x * SINC_RES, ip = Math.floor(pos);
      if (ip >= SINC_T * SINC_RES) continue;
      const h = tab[ip] + (tab[ip + 1] - tab[ip]) * (pos - ip);
      sum += c[j] * h; ws += h;
    }
    r[i] = ws > 1e-6 ? sum / ws : 0;
  }
  return r;
}
