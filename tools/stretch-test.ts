// Tes time-stretch (Node, tanpa DOM): durasi hasil = durasi asli x factor, PITCH TIDAK BERUBAH, tidak ada klik / lonjakan.
// Vokal sintetis: nada 220 Hz + harmonik + vibrato halus + amplop kata. Pakai:  node tools/stretch-test.ts
import { timeStretch } from '../src/time-stretch.ts';

const sr = 44100, dur = 6, n = sr * dur;
const mk = (f0: number): Float32Array => {
  const x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = f0 * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f / sr;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 1.7 * t) ** 2;
    let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin(h * ph) / h;
    x[i] = 0.35 * env * s;
  }
  return x;
};
// pitch rata-rata lewat zero-crossing pada versi yang dilewatkan low-pass sederhana
const f0Of = (y: Float32Array): number => {
  let z = 0, lp = 0; const a = 0.08, s0 = Math.floor(y.length * 0.1), s1 = Math.floor(y.length * 0.9);
  let prev = 0;
  for (let i = s0; i < s1; i++) { lp += a * (y[i] - lp); if (prev < 0 && lp >= 0) z++; prev = lp; }
  return z / ((s1 - s0) / sr);
};
let bad = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? 'OK   ' : 'GAGAL') + ' ' + m); if (!c) bad++; };

const L = mk(220), R = mk(220).map(v => v * 0.8);
const base = f0Of(L);
for (const [from, to] of [[126, 130], [130, 126], [100, 140], [140, 100]] as const) {
  const k = from / to, t0 = Date.now();
  const [yl, yr] = timeStretch([L, R], sr, k);
  const ms = Date.now() - t0;
  const durOk = Math.abs(yl.length - Math.round(n * k)) <= 1 && yr.length === yl.length;
  const pitch = f0Of(yl), cents = 1200 * Math.log2(pitch / base);
  let jump = 0, peak = 0; for (let i = 1; i < yl.length; i++) { jump = Math.max(jump, Math.abs(yl[i] - yl[i - 1])); peak = Math.max(peak, Math.abs(yl[i])); }
  let jumpIn = 0; for (let i = 1; i < n; i++) jumpIn = Math.max(jumpIn, Math.abs(L[i] - L[i - 1]));
  ok(durOk, from + '->' + to + ' BPM: durasi ' + (yl.length / sr).toFixed(3) + ' s (harus ' + (dur * k).toFixed(3) + ' s)');
  ok(Math.abs(cents) < 15, from + '->' + to + ' BPM: pitch geser ' + cents.toFixed(1) + ' sen (batas 15 sen)');
  ok(jump < jumpIn * 1.5 && peak < 1.2, from + '->' + to + ' BPM: tanpa klik (lonjakan terbesar ' + jump.toFixed(3) + ' vs asli ' + jumpIn.toFixed(3) + ', puncak ' + peak.toFixed(2) + ')');
  console.log('     waktu proses ' + ms + ' ms untuk ' + dur + ' s stereo');
}
const same = timeStretch([L], sr, 1)[0];
ok(same.length === n && same[1000] === L[1000], 'factor 1 = tidak berubah');
process.exit(bad ? 1 : 0);
