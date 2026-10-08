// SPECTRUM GAYA 2: inti DSP, murni (tanpa DOM / Web Audio) supaya bisa dites di Node (tools/spectrum2-test.ts). Gambarnya ada di spectrum2.ts.
// Gaya 2 bekerja di ranah FREKUENSI (gaya 1 di ranah waktu):
//   - BandMap     : memetakan hasil FFT (dB per bin, spasi linear) ke N pita berspasi LOGARITMIK, dinormalkan 0..1
//   - BarDynamics : naik cepat, turun pelan + penanda puncak yang tertahan sebentar lalu jatuh dipercepat (gravitasi)
//   - loudestPeak : frekuensi paling keras (interpolasi parabola) untuk pembacaan "Hz · nada"
//   - buildPalette: palet warna sendiri (indigo -> lavender -> cyan -> putih hangat) untuk spectrogram dan bar

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const FMIN = 30, FMAX = 18000;       // rentang tampil (Hz)
export const DB_FLOOR = -88, DB_CEIL = -12;  // rentang dB yang dipetakan ke 0..1

const LOGR = Math.log(FMAX / FMIN);
export const hzToPos = (hz: number): number => clamp(Math.log(hz / FMIN) / LOGR, 0, 1);   // 0 = FMIN, 1 = FMAX
export const posToHz = (p: number): number => FMIN * Math.exp(p * LOGR);

// dB (boleh -Infinity / NaN dari analyser saat senyap) -> 0..1
export const dbToLevel = (db: number): number => (Number.isFinite(db) ? clamp((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR), 0, 1) : 0);

// ---------- pita logaritmik ----------
export class BandMap {
  readonly n: number;
  readonly centers: Float32Array;   // frekuensi tengah tiap pita (Hz), naik dari FMIN ke FMAX
  private fa: Float32Array; private fb: Float32Array; private tilt: Float32Array;
  readonly bins: number; readonly sr: number;
  // bins = jumlah bin analyser (fftSize / 2); tiltDbPerOct = pengangkat sisi tinggi (spektrum musik miring ke bawah ~ -3..-4,5 dB/oktaf)
  constructor(n: number, bins: number, sr: number, tiltDbPerOct = 3) {
    this.n = n; this.bins = bins; this.sr = sr;
    this.centers = new Float32Array(n); this.fa = new Float32Array(n); this.fb = new Float32Array(n); this.tilt = new Float32Array(n);
    const binHz = sr / 2 / bins;
    for (let i = 0; i < n; i++) {
      const lo = posToHz(i / n), hi = posToHz((i + 1) / n), c = posToHz((i + 0.5) / n);
      this.centers[i] = c; this.fa[i] = lo / binHz; this.fb[i] = hi / binHz;
      this.tilt[i] = tiltDbPerOct * Math.log2(c / 1000);
    }
  }
  // db: bin 0..bins-1 (dB). out: n nilai 0..1 (pita ke-0 = frekuensi terendah)
  map(db: Float32Array, out: Float32Array): void {
    const last = Math.min(db.length, this.bins) - 1;
    for (let i = 0; i < this.n; i++) {
      const a = this.fa[i], b = this.fb[i];
      let v: number;
      if (b - a < 1) {   // pita lebih sempit dari satu bin (bass): interpolasi linear di titik tengah
        const c = clamp((a + b) / 2, 0, last), k = Math.floor(c), f = c - k, x0 = db[k], x1 = db[Math.min(last, k + 1)];
        v = (Number.isFinite(x0) ? x0 : -200) * (1 - f) + (Number.isFinite(x1) ? x1 : -200) * f;
      } else {            // pita lebar: puncak tertinggi di dalam pita
        v = -200;
        for (let k = Math.max(0, Math.ceil(a)), e = Math.min(last, Math.floor(b)); k <= e; k++) { const x = db[k]; if (Number.isFinite(x) && x > v) v = x; }
      }
      out[i] = dbToLevel(v + this.tilt[i]);
    }
  }
}

// ---------- dinamika bar ----------
export class BarDynamics {
  level: Float32Array; peak: Float32Array; private hold: Float32Array; private vel: Float32Array;
  readonly attack: number; readonly release: number; readonly holdSec: number; readonly gravity: number;   // detik naik / turun, lama tahan puncak, percepatan jatuh (satuan tinggi / detik^2)
  constructor(n: number, attack = 0.022, release = 0.16, holdSec = 0.5, gravity = 2.6) {
    this.attack = attack; this.release = release; this.holdSec = holdSec; this.gravity = gravity;
    this.level = new Float32Array(n); this.peak = new Float32Array(n); this.hold = new Float32Array(n); this.vel = new Float32Array(n);
  }
  get n(): number { return this.level.length; }
  resize(n: number): void { if (n !== this.n) { this.level = new Float32Array(n); this.peak = new Float32Array(n); this.hold = new Float32Array(n); this.vel = new Float32Array(n); } }
  reset(): void { this.level.fill(0); this.peak.fill(0); this.hold.fill(0); this.vel.fill(0); }
  update(target: Float32Array, dt: number): void {
    const ka = 1 - Math.exp(-dt / this.attack), kr = 1 - Math.exp(-dt / this.release);
    for (let i = 0; i < this.n; i++) {
      const t = target[i], l = this.level[i];
      const nl = t > l ? l + (t - l) * ka : l + (t - l) * kr;
      this.level[i] = nl;
      if (nl >= this.peak[i]) { this.peak[i] = nl; this.hold[i] = this.holdSec; this.vel[i] = 0; }
      else if (this.hold[i] > 0) this.hold[i] -= dt;
      else { this.vel[i] += this.gravity * dt; this.peak[i] = Math.max(nl, this.peak[i] - this.vel[i] * dt); }
    }
  }
}

// ---------- frekuensi paling keras ----------
export interface Loudest { hz: number; db: number }
export function loudestPeak(db: Float32Array, sr: number, minDb = -62): Loudest | null {
  const bins = db.length, binHz = sr / 2 / bins;
  const lo = Math.max(1, Math.ceil(FMIN / binHz)), hi = Math.min(bins - 2, Math.floor(FMAX / binHz));
  let k = -1, best = -Infinity;
  for (let i = lo; i <= hi; i++) { const v = db[i]; if (Number.isFinite(v) && v > best) { best = v; k = i; } }
  if (k < 0 || best < minDb) return null;
  const a = db[k - 1], b = db[k], c = db[k + 1], den = a - 2 * b + c;
  const d = Number.isFinite(den) && den < -1e-9 ? clamp(0.5 * (a - c) / den, -0.5, 0.5) : 0;
  return { hz: (k + d) * binHz, db: b };
}

// ---------- palet ----------
// 0 = hampir sama dengan latar panel (#0e0e14), lalu indigo gelap -> ungu -> lavender (warna aksen aplikasi) -> cyan lembut -> putih hangat
const STOPS: [number, number, number, number][] = [
  [0.00, 14, 14, 20], [0.16, 34, 26, 86], [0.40, 112, 84, 206], [0.64, 179, 161, 247], [0.84, 126, 226, 240], [1.00, 255, 250, 234],
];
export function paletteAt(v: number): [number, number, number] {
  const x = clamp(v, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const p = STOPS[i - 1], q = STOPS[i], t = (x - p[0]) / (q[0] - p[0]);
      return [p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t];
    }
  }
  const e = STOPS[STOPS.length - 1]; return [e[1], e[2], e[3]];
}
// 256 warna RGBA berurutan (Uint8ClampedArray, 1 piksel = 4 byte), alfa penuh
export function buildPalette(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { const [r, g, b] = paletteAt(i / 255); out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255; }
  return out;
}
// Lengkung kontras spectrogram: lantai derau sedikit digelapkan supaya yang penting menonjol
export const contrast = (v: number): number => Math.pow(clamp(v, 0, 1), 1.35);

// ---------- format pembacaan ----------
export const fmtHz = (hz: number): string => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz' : Math.round(hz) + ' Hz');

// =====================================================================================================
// MODUL TAMBAHAN GAYA 2 (mengikuti daftar modul referensi: Waveform multi-band, Peak/LUFS, Stereometer)
// =====================================================================================================

// ---------- Waveform multi-band: warna per rentang frekuensi (rendah / menengah / tinggi) ----------
export interface BandEnergy { low: number; mid: number; high: number }   // 0..1
const EDGES = [30, 250, 4000, 16000];                                    // batas rentang (Hz)
const COMP = [0, 4, 9];                                                  // pengangkat dB per rentang (musik miring ke bawah)
export function bandEnergies(db: Float32Array, sr: number, out: BandEnergy): void {
  const bins = db.length, binHz = sr / 2 / bins, p = [0, 0, 0];
  for (let b = 0; b < 3; b++) {
    const a = Math.max(1, Math.ceil(EDGES[b] / binHz)), e = Math.min(bins - 1, Math.floor(EDGES[b + 1] / binHz));
    let s = 0; for (let k = a; k <= e; k++) { const x = db[k]; if (Number.isFinite(x)) s += Math.pow(10, x / 10); }
    p[b] = s > 0 ? dbToLevel(10 * Math.log10(s) + COMP[b]) : 0;
  }
  out.low = p[0]; out.mid = p[1]; out.high = p[2];
}
const C_LOW: [number, number, number] = [255, 107, 129], C_MID: [number, number, number] = [179, 161, 247], C_HIGH: [number, number, number] = [126, 226, 240];   // koral, lavender, cyan
export function waveRGB(e: BandEnergy, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  // bobot relatif terhadap rentang terkuat, dipangkatkan 3: rentang yang jelas dominan mewarnai kolom, yang seimbang bercampur
  const mx = Math.max(e.low, e.mid, e.high);
  if (mx < 0.02) { out[0] = C_MID[0]; out[1] = C_MID[1]; out[2] = C_MID[2]; return out; }
  const wl = Math.pow(e.low / mx, 3), wm = Math.pow(e.mid / mx, 3), wh = Math.pow(e.high / mx, 3), s = wl + wm + wh;
  for (let i = 0; i < 3; i++) out[i] = (C_LOW[i] * wl + C_MID[i] * wm + C_HIGH[i] * wh) / s;
  return out;
}

// ---------- Peak ----------
export function peakAbs(x: Float32Array, n: number): number {
  let p = 0; for (let i = Math.max(0, x.length - n); i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return p;
}
export const ampToDb = (a: number): number => (a > 1e-6 ? 20 * Math.log10(a) : -120);
export const PEAK_FLOOR_DB = -60;
export const dbToMeter = (db: number): number => clamp((db - PEAK_FLOOR_DB) / -PEAK_FLOOR_DB, 0, 1);   // -60..0 dBFS -> 0..1

// ---------- LUFS momentari (ITU-R BS.1770: K-weighting + jendela 400 ms, blok 100 ms) ----------
export class Biquad {
  private z1 = 0; private z2 = 0;
  readonly b0: number; readonly b1: number; readonly b2: number; readonly a1: number; readonly a2: number;
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; }
  process(x: number): number { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  reset(): void { this.z1 = 0; this.z2 = 0; }
}
// Koefisien untuk sample rate apa pun (rumus analog dasar BS.1770): high-shelf ~ +4 dB di 1,68 kHz, lalu high-pass 38 Hz
export function kWeighting(sr: number): [Biquad, Biquad] {
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  const K1 = Math.tan(Math.PI * f1 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K1 / Q1 + K1 * K1;
  const shelf = new Biquad((Vh + Vb * K1 / Q1 + K1 * K1) / a0, 2 * (K1 * K1 - Vh) / a0, (Vh - Vb * K1 / Q1 + K1 * K1) / a0, 2 * (K1 * K1 - 1) / a0, (1 - K1 / Q1 + K1 * K1) / a0);
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773, K2 = Math.tan(Math.PI * f2 / sr), c0 = 1 + K2 / Q2 + K2 * K2;
  const hp = new Biquad(1, -2, 1, 2 * (K2 * K2 - 1) / c0, (1 - K2 / Q2 + K2 * K2) / c0);
  return [shelf, hp];
}
// Memproses aliran sampel stereo (dipanggil tiap frame dengan sampel baru saja); momentary = rata-rata energi 4 blok terakhir (400 ms)
export class LoudnessMeter {
  private fl: [Biquad, Biquad]; private fr: [Biquad, Biquad];
  private blockN: number; private n = 0; private sumL = 0; private sumR = 0;
  private blocks = new Float64Array(4); private nb = 0; private head = 0;
  constructor(sr: number) { this.fl = kWeighting(sr); this.fr = kWeighting(sr); this.blockN = Math.max(1, Math.round(sr * 0.1)); }
  reset(): void { this.fl[0].reset(); this.fl[1].reset(); this.fr[0].reset(); this.fr[1].reset(); this.n = 0; this.sumL = 0; this.sumR = 0; this.blocks.fill(0); this.nb = 0; this.head = 0; }
  // memakai `count` sampel terakhir dari l dan r
  push(l: Float32Array, r: Float32Array, count: number): void {
    const len = Math.min(l.length, r.length), c = Math.min(count, len);
    for (let i = len - c; i < len; i++) {
      const a = this.fl[1].process(this.fl[0].process(l[i])), b = this.fr[1].process(this.fr[0].process(r[i]));
      this.sumL += a * a; this.sumR += b * b;
      if (++this.n >= this.blockN) {
        this.blocks[this.head] = (this.sumL + this.sumR) / this.n; this.head = (this.head + 1) & 3; if (this.nb < 4) this.nb++;
        this.n = 0; this.sumL = 0; this.sumR = 0;
      }
    }
  }
  get momentary(): number {   // LUFS; -Infinity bila belum ada blok / senyap (di bawah -70)
    if (this.nb === 0) return -Infinity;
    let s = 0; for (let i = 0; i < this.nb; i++) s += this.blocks[i];
    const z = s / this.nb, v = z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity;
    return v < -70 ? -Infinity : v;
  }
}

// ---------- Stereometer ----------
// korelasi fase: +1 = mono sempurna, 0 = tak berkorelasi (lebar), -1 = berlawanan fase
export function correlation(l: Float32Array, r: Float32Array, n: number): number {
  let ll = 0, rr = 0, lr = 0; const len = Math.min(l.length, r.length);
  for (let i = Math.max(0, len - n); i < len; i++) { ll += l[i] * l[i]; rr += r[i] * r[i]; lr += l[i] * r[i]; }
  const d = Math.sqrt(ll * rr); return d > 1e-12 ? clamp(lr / d, -1, 1) : 0;
}
// Titik lissajous (diputar 45°): x = samping (L-R)/√2, y = tengah (L+R)/√2. Mengambil sampel terakhir dengan langkah tetap; mengembalikan jumlah titik.
export function goniometer(l: Float32Array, r: Float32Array, n: number, outX: Float32Array, outY: Float32Array): number {
  const len = Math.min(l.length, r.length), cnt = Math.min(outX.length, n, len), stride = Math.max(1, Math.floor(Math.min(n, len) / cnt)), q = Math.SQRT1_2;
  let k = 0;
  for (let i = len - 1; i >= 0 && k < cnt; i -= stride) { outX[k] = (l[i] - r[i]) * q; outY[k] = (l[i] + r[i]) * q; k++; }
  return k;
}
