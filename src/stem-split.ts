// Stem Splitter: memisahkan lagu jadi dua stem, VOKAL dan INSTRUMEN. Murni DSP (tanpa DOM / Web Audio / model ML) supaya bisa dites di Node,
// dijalankan di Worker (lihat stem-worker.ts), dan nanti diganti backend lain (mis. model ONNX / WASM) tanpa menyentuh UI.
//
// Cara kerja: STFT (4096 sample, hop 1024), lalu satu mask lunak per bin waktu-frekuensi yang menandai "ini milik vokal":
//   1. Pusat stereo  : vokal hampir selalu di tengah. Skor = 2·Re(L·R*) / (|L|² + |R|²): 1 kalau L = R (di tengah, sefase), turun ke 0 kalau
//                      dominan satu sisi atau beda fase. Dihaluskan sedikit di waktu-frekuensi. Mono tidak punya informasi ini (dilewati).
//   2. HPSS          : median magnitudo ke arah waktu (komponen harmonik / bernada, kandidat vokal) dan ke arah frekuensi (komponen
//                      perkusif, yaitu drum). Mask Wiener H² / (H² + P²) membuang kick / snare / hi-hat yang kebetulan di tengah.
//   3. Pita vokal    : di bawah bassCutoff (kick + bass di tengah) dan di atas ~16 kHz mask dimatikan, dengan lereng halus.
//   Mask = pusat^3 · harmonik, dipertajam (kontras) sesuai `strength`, lalu dikali pita vokal.
//   vokal     = mask · sinyal asli (kiri dan kanan memakai mask yang sama, jadi posisi stereo vokal terjaga)
//   instrumen = sinyal asli - vokal  -> vokal + instrumen selalu persis sama dengan aslinya (tidak ada yang hilang)
//
// Batas yang jujur: ini pemisahan klasik berbasis mask, bukan jaringan saraf. Hasil terbaik pada rekaman stereo dengan vokal di tengah.
// Instrumen harmonik yang juga di tengah (piano / pad mono, bass atas) bisa ikut masuk ke vokal, dan backing vocal yang di-pan lebar
// bisa ikut ke instrumen. Pada audio mono kualitasnya turun jauh karena hanya HPSS + pita yang bekerja.
// Diproses per potongan (~12 dtk) dengan margin konteks, jadi memori tetap kecil (aman untuk HP) dan hasilnya hampir sama dengan memproses utuh.

export interface SplitOptions {
  strength?: number;    // 0..1, default 0.5: kontras mask. Naik = mask lebih mendekati 0 / 1 (lebih tegas, lebih mudah "berlubang"); turun = lebih lembut. Di tes sintetis efeknya kecil (<1 dB), jadi bawaan sudah wajar
  bassCutoff?: number;  // Hz, default 120: di bawah ini tidak pernah dianggap vokal (kick + bass tetap di instrumen)
  chunkSec?: number;    // detik, default 12: panjang potongan; kecil = hemat memori
}
export interface StemResult { vocal: Float32Array[]; instrumental: Float32Array[] }

const N = 4096, HOP = N / 4, K = N / 2 + 1;   // hop N/4 + jendela sqrt-Hann (dua kali: analisis + sintesis) -> jumlah bobot persis 2 di tiap sample
const TIME_R = 5, FREQ_R = 10;                // jari-jari median: waktu 11 frame (~0,25 dtk @ 44,1 kHz), frekuensi 21 bin (~225 Hz)
const MARGIN = 16 * HOP;                      // konteks tiap sisi potongan; > ketergantungan terjauh (median 5 + haluskan 1 + overlap 4 frame)
const CENTER_POW = 3;                         // skor pusat dipangkatkan: sumber ber-pan 3:1 tetap kena redam kuat (tanpa ini 2ab/(a²+b²) terlalu longgar)
const HI_FULL = 12000, HI_ZERO = 16000;       // di atas ~16 kHz tidak ada vokal; mask turun halus mulai 12 kHz

const WIN = new Float64Array(N);
for (let i = 0; i < N; i++) WIN[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));   // sqrt(Hann periodik)

// FFT radix-2 di tempat (re, im panjang n). inv = true -> IFFT (sudah dibagi n).
function makeFFT(n: number): (re: Float64Array, im: Float64Array, inv: boolean) => void {
  const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n), cs = new Float64Array(n >> 1), sn = new Float64Array(n >> 1);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if ((i >> b) & 1) r |= 1 << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n >> 1; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
  return (re, im, inv) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { const a = re[i], b = im[i]; re[i] = re[j]; im[i] = im[j]; re[j] = a; im[j] = b; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cs[t], wi = inv ? sn[t] : -sn[t], a = s + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
}
const fft = makeFFT(N);

// Median bergeser jendela (2r+1) sepanjang len elemen (src[off + i*stride]); di tepi jendela menyusut. `win` = buffer kerja >= 2r+1.
function medianRun(src: Float32Array, dst: Float32Array, off: number, stride: number, len: number, r: number, win: Float32Array): void {
  let cnt = 0;
  const lower = (v: number): number => { let lo = 0, hi = cnt; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } return lo; };
  const ins = (v: number): void => { const p = lower(v); for (let j = cnt; j > p; j--) win[j] = win[j - 1]; win[p] = v; cnt++; };
  const del = (v: number): void => { const p = lower(v); for (let j = p; j < cnt - 1; j++) win[j] = win[j + 1]; cnt--; };
  for (let i = 0; i <= Math.min(r, len - 1); i++) ins(src[off + i * stride]);
  for (let i = 0; i < len; i++) {
    dst[off + i * stride] = win[cnt >> 1];
    const add = i + r + 1, drop = i - r;
    if (add < len) ins(src[off + add * stride]);
    if (drop >= 0) del(src[off + drop * stride]);
  }
}

// Rata-rata kotak 2D dipisah: ±fr bin, lalu ±tr frame (tepi: rata-rata atas elemen yang ada). a = F*K, hasil menimpa a.
function boxSmooth(a: Float32Array, F: number, fr: number, tr: number, kHi: number): void {
  const tmp = new Float32Array(F * K);
  for (let f = 0; f < F; f++) {
    const o = f * K;
    for (let k = 0; k <= kHi; k++) {
      const lo = Math.max(0, k - fr), hi = Math.min(kHi, k + fr); let s = 0;
      for (let j = lo; j <= hi; j++) s += a[o + j];
      tmp[o + k] = s / (hi - lo + 1);
    }
  }
  for (let f = 0; f < F; f++) {
    const lo = Math.max(0, f - tr), hi = Math.min(F - 1, f + tr);
    for (let k = 0; k <= kHi; k++) { let s = 0; for (let j = lo; j <= hi; j++) s += tmp[j * K + k]; a[f * K + k] = s / (hi - lo + 1); }
  }
}

interface Params { strength: number; bassCutoff: number }
const smooth01 = (t: number): number => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// Satu potongan: ch = 1 atau 2 kanal (panjang sama). Mengembalikan stem vokal potongan itu (tanpa instrumen; dihitung di luar sebagai selisih).
function vocalOfSegment(ch: Float32Array[], sr: number, P: Params): Float32Array[] {
  const stereo = ch.length > 1, Ls = ch[0].length, total = Ls + 2 * N, F = Math.floor((total - N) / HOP) + 1;
  const kHi = Math.min(K - 1, Math.floor(HI_ZERO * N / sr));            // bin di atasnya pasti bukan vokal (mask 0), tidak perlu dihitung
  const bin = (k: number): number => k * sr / N;
  const band = new Float32Array(K);                                      // bobot pita vokal per bin
  for (let k = 0; k <= kHi; k++) {
    const f = bin(k);
    band[k] = smooth01((f - P.bassCutoff) / (0.6 * P.bassCutoff)) * (1 - smooth01((f - HI_FULL) / (HI_ZERO - HI_FULL)));
  }

  // 1) STFT. Dua kanal dikemas jadi satu FFT kompleks (z = L + iR) lalu dipisah lagi lewat simetri Hermitian.
  const pad = [new Float32Array(total), new Float32Array(total)];
  pad[0].set(ch[0], N); if (stereo) pad[1].set(ch[1], N);
  const Lr = new Float32Array(F * K), Li = new Float32Array(F * K), Rr = new Float32Array(F * K), Ri = new Float32Array(F * K);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < F; f++) {
    const p = f * HOP;
    for (let n = 0; n < N; n++) { re[n] = WIN[n] * pad[0][p + n]; im[n] = stereo ? WIN[n] * pad[1][p + n] : 0; }
    fft(re, im, false);
    for (let k = 0; k < K; k++) {
      const kk = (N - k) & (N - 1), a = re[k], b = im[k], c = re[kk], d = im[kk], o = f * K + k;
      Lr[o] = (a + c) / 2; Li[o] = (b - d) / 2; Rr[o] = (b + d) / 2; Ri[o] = -(a - c) / 2;
    }
  }

  // 2) HPSS pada magnitudo "tengah" (rata-rata L dan R)
  const mag = new Float32Array(F * K), Hm = new Float32Array(F * K), Pm = new Float32Array(F * K);
  for (let i = 0; i < F * K; i++) mag[i] = stereo ? Math.hypot((Lr[i] + Rr[i]) / 2, (Li[i] + Ri[i]) / 2) : Math.hypot(Lr[i], Li[i]);
  const w = new Float32Array(2 * Math.max(TIME_R, FREQ_R) + 2);
  for (let k = 0; k <= kHi; k++) medianRun(mag, Hm, k, K, F, TIME_R, w);       // sepanjang waktu -> harmonik
  for (let f = 0; f < F; f++) medianRun(mag, Pm, f * K, 1, kHi + 1, FREQ_R, w); // sepanjang frekuensi -> perkusif

  // 3) skor pusat stereo (dihaluskan) + mask akhir
  const mask = new Float32Array(F * K);
  if (stereo) {
    for (let i = 0; i < F * K; i++) {
      const e = Lr[i] * Lr[i] + Li[i] * Li[i] + Rr[i] * Rr[i] + Ri[i] * Ri[i];
      mask[i] = e > 1e-18 ? Math.max(0, Math.min(1, 2 * (Lr[i] * Rr[i] + Li[i] * Ri[i]) / e)) : 0;
    }
    boxSmooth(mask, F, 2, 1, kHi);
  }
  const g = 1 + 2 * P.strength;                                         // kontras sigmoid v^g / (v^g + (1-v)^g)
  for (let f = 0; f < F; f++) {
    for (let k = 0; k <= kHi; k++) {
      const i = f * K + k, h2 = Hm[i] * Hm[i], p2 = Pm[i] * Pm[i], harm = h2 / (h2 + p2 + 1e-18);
      let v = (stereo ? mask[i] ** CENTER_POW : 1) * harm;
      v = v > 0 ? v ** g / (v ** g + (1 - v) ** g) : 0;
      mask[i] = v * band[k];
    }
    for (let k = kHi + 1; k < K; k++) mask[f * K + k] = 0;               // di atas batas vokal: semuanya instrumen
  }

  // 4) terapkan mask ke L dan R, ISTFT (OLA)
  const out = [new Float32Array(total), new Float32Array(total)];
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < K; k++) {
      const m = mask[f * K + k], o = f * K + k;
      const vlr = m * Lr[o], vli = m * Li[o], vrr = m * Rr[o], vri = m * Ri[o];
      re[k] = vlr - vri; im[k] = vli + vrr;                              // Y = VL + i·VR untuk k <= N/2
      if (k > 0 && k < N / 2) { re[N - k] = vlr + vri; im[N - k] = -vli + vrr; }   // k > N/2: conj(VL) + i·conj(VR)
    }
    fft(re, im, true);
    const p = f * HOP;
    for (let n = 0; n < N; n++) { out[0][p + n] += WIN[n] * re[n]; if (stereo) out[1][p + n] += WIN[n] * im[n]; }
  }
  return ch.map((_, c) => { const y = out[c].slice(N, N + Ls); for (let i = 0; i < Ls; i++) y[i] *= 0.5; return y; });   // jumlah bobot jendela = 2
}

// Pisahkan stem vokal dan instrumen. chs: 1 (mono) atau 2 (stereo) kanal; sr: sample rate (Hz).
// Panjang dan jumlah kanal hasil sama dengan masukan; vocal + instrumental == masukan (selisih hanya pembulatan float).
export function separate(chs: Float32Array[], sr: number, opts: SplitOptions = {}, onProgress?: (p: number) => void): StemResult {
  if (chs.length < 1 || chs.length > 2) throw new Error('Stem splitter mendukung 1 (mono) atau 2 (stereo) kanal, bukan ' + chs.length);
  const n = chs[0].length;
  for (const c of chs) if (c.length !== n) throw new Error('Panjang kanal tidak sama');
  const P: Params = { strength: Math.max(0, Math.min(1, opts.strength ?? 0.5)), bassCutoff: Math.max(20, opts.bassCutoff ?? 120) };
  const chunk = Math.max(8 * HOP, Math.round((opts.chunkSec ?? 12) * sr / HOP) * HOP);
  const vocal = chs.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += chunk) {
    const e = Math.min(n, s + chunk), a = s - MARGIN, b = e + MARGIN, from = Math.max(0, a), to = Math.min(n, b);
    const seg = chs.map(c => { const o = new Float32Array(b - a); o.set(c.subarray(from, to), from - a); return o; });   // di luar sinyal = nol
    const y = vocalOfSegment(seg, sr, P);
    for (let c = 0; c < chs.length; c++) vocal[c].set(y[c].subarray(MARGIN, MARGIN + (e - s)), s);
    onProgress?.(e / n);
  }
  const instrumental = chs.map((c, i) => { const o = new Float32Array(n), v = vocal[i]; for (let j = 0; j < n; j++) o[j] = c[j] - v[j]; return o; });
  return { vocal, instrumental };
}
