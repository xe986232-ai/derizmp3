// Tes pitch shift audio clip (Node, tanpa DOM): durasi hasil = durasi asli x factor, frekuensi bergeser sesuai semitone.  Pakai:  node tools/pitch-test.ts
import { timeStretchPitch } from '../src/time-stretch.ts';

const sr = 44100, n = sr * 3;
const sine = (f: number): Float32Array => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr); return x; };
const freqOf = (y: Float32Array): number => {   // zero-crossing naik pada bagian tengah
  let z = 0, prev = 0; const s0 = Math.floor(y.length * 0.2), s1 = Math.floor(y.length * 0.8);
  for (let i = s0; i < s1; i++) { if (prev < 0 && y[i] >= 0) z++; prev = y[i]; }
  return z / ((s1 - s0) / sr);
};
let bad = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? 'OK   ' : 'GAGAL') + ' ' + m); if (!c) bad++; };

for (const [st, k] of [[12, 1], [-12, 1], [3, 1], [-5, 1], [7, 0.969], [-7, 1.03], [0, 1]] as const) {
  const t0 = Date.now(), y = timeStretchPitch([sine(440), sine(440)], sr, k, st)[0];
  const want = 440 * 2 ** (st / 12), got = freqOf(y), cents = 1200 * Math.log2(got / want);
  ok(Math.abs(y.length - Math.round(n * k)) <= 1, `${st >= 0 ? '+' : ''}${st} st, factor ${k}: durasi ${y.length} (harus ${Math.round(n * k)})`);
  ok(Math.abs(cents) < 15, `${st >= 0 ? '+' : ''}${st} st: ${got.toFixed(1)} Hz (harus ${want.toFixed(1)} Hz, selisih ${cents.toFixed(1)} cent) ${Date.now() - t0} ms`);
  ok(y.every(v => Math.abs(v) <= 0.75), `${st} st: tidak ada lonjakan / clipping`);
}
if (bad) { console.log(bad + ' tes gagal'); process.exit(1); } console.log('Semua tes lulus');
