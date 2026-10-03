// Tes De-esser (src/deesser.ts): jalankan prosesor worklet di Node dengan sinyal sintetis.
//   node tools/deesser-test.ts
import { DEESSER_SRC } from '../src/deesser.ts';

const SR = 44100;
let Proc: any;
(globalThis as any).sampleRate = SR;
(globalThis as any).AudioWorkletProcessor = class { port: any = {}; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function(DEESSER_SRC)();

function run(x: Float32Array, p: { fc: number; thr: number; max: number; on: boolean }): Float32Array {
  const node = new Proc(); node.port.onmessage({ data: { t: 'p', ...p } }); node.fc = p.fc;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i), a = x.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)];
    node.process([[a, a]], [o]); out.set(o[0], i);
  }
  return out;
}
// band di atas 6 kHz (HP Butterworth 2 kutub), supaya reduksi desis terukur terpisah dari vokal rendah yang tetap bunyi
function hp(x: Float32Array): Float32Array {
  const w = 2 * Math.PI * 6000 / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, a1 = -2 * cs / a0, a2 = (1 - al) / a0, o = new Float32Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + z1; z1 = b1 * x[i] - a1 * y + z2; z2 = b0 * x[i] - a2 * y; o[i] = y; }
  return o;
}
const rms = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const db = (v: number) => 20 * Math.log10(v + 1e-12);

// 1) magnitudo datar saat tidak ada reduksi (derau putih, Amount 0)
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const N = SR * 2, noise = new Float32Array(N).map(() => rnd() * 0.3);
const flat = run(noise, { fc: 6500, thr: -32, max: 0, on: true });
console.log('flat (Amount 0): selisih RMS', (db(rms(flat, 4000, N)) - db(rms(noise, 4000, N))).toFixed(3), 'dB (harus ~0)');

// 2) vokal sintetis: vokal 220 Hz + 5 harmonik (tanpa desis) 0,6 dtk, lalu "S" = derau di atas 6 kHz selama 0,3 dtk, lalu vokal lagi
const T = SR * 1.2, x = new Float32Array(T), s0 = Math.floor(SR * 0.6), s1 = Math.floor(SR * 0.9);
let lp = 0;
for (let i = 0; i < T; i++) {
  let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 220 * h * i / SR) / h;
  x[i] = 0.25 * v;
  if (i >= s0 && i < s1) { const n = rnd(); lp += 0.35 * (n - lp); x[i] += 0.5 * (n - lp); }   // high-pass kasar ~ desis
}
const y = run(x, { fc: 6000, thr: -32, max: 12, on: true });
const hx = hp(x), hy = hp(y);
const vowel = [rms(x, 4000, s0 - 2000), rms(y, 4000, s0 - 2000)], ess = [rms(hx, s0 + 6000, s1 - 2000), rms(hy, s0 + 6000, s1 - 2000)];
console.log('vokal  :', db(vowel[0]).toFixed(1), '->', db(vowel[1]).toFixed(1), 'dB (selisih', (db(vowel[1]) - db(vowel[0])).toFixed(2), ', harus ~0)');
console.log('desis (band >6 kHz):', db(ess[0]).toFixed(1), '->', db(ess[1]).toFixed(1), 'dB (selisih', (db(ess[1]) - db(ess[0])).toFixed(1), ', harus negatif, <= 12)');

// 3) tombol mati: tidak ada reduksi
const off = run(x, { fc: 6000, thr: -32, max: 12, on: false });
console.log('off    : desis selisih', (db(rms(hp(off), s0 + 6000, s1 - 2000)) - db(ess[0])).toFixed(2), 'dB (harus ~0)');

// 4) Amount menentukan batas reduksi
for (const m of [6, 12, 20]) { const z = run(x, { fc: 6000, thr: -50, max: m, on: true }); console.log('max', m, 'dB: reduksi desis', (db(ess[0]) - db(rms(hp(z), s0 + 6000, s1 - 2000))).toFixed(1), 'dB'); }
