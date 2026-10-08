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
