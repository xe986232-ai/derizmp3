// Tes Stem Splitter (src/stem-split.ts) dengan lagu sintetis yang stem aslinya diketahui.
//   node tools/stem-test.ts
// Lagu: vokal (di tengah, nada meluncur + vibrato + suku kata), gitar (ber-pan kiri), pad (ber-pan kanan),
//       kick + snare + hi-hat (tengah / hampir tengah), bass (tengah).
import { separate } from '../src/stem-split.ts';

const SR = 44100, DUR = 6, N = SR * DUR;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const vocal = new Float32Array(N), inst = [new Float32Array(N), new Float32Array(N)];
{
  // vokal: not 220 -> 262 -> 330 -> 247 Hz, tiap not 0,75 dtk, suku kata 0,5 dtk menyala + 0,25 dtk jeda; 14 harmonik dengan puncak formant ~800 Hz
  const notes = [220, 262, 330, 247, 220, 294, 262, 196];
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, ni = Math.min(notes.length - 1, Math.floor(t / 0.75)), tn = t - ni * 0.75;
    const gate = tn < 0.5 ? Math.min(1, tn / 0.03, (0.5 - tn) / 0.04) : 0;
    const f0 = notes[ni] * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f0 / SR;
    let v = 0; for (let h = 1; h <= 14; h++) v += Math.sin(h * ph) * Math.exp(-((h * f0 - 800) ** 2) / (2 * 600 ** 2)) + 0.05 * Math.sin(h * ph) / h;
    vocal[i] = 0.22 * gate * v;
  }
  // gitar (kiri): kord dipetik tiap 1,5 dtk, harmonik meluruh
  for (let c = 0; c < 4; c++) for (const f of [110, 138.6, 164.8, 220]) for (let i = Math.floor(c * 1.5 * SR); i < Math.min(N, Math.floor((c + 1) * 1.5 * SR)); i++) {
    const tt = i / SR - c * 1.5; let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h * Math.exp(-tt * (1 + h * 0.6));
    inst[0][i] += 0.10 * v; inst[1][i] += 0.03 * v;
  }
  // pad (kanan): sustain, 4 nada, sedikit detune
  for (const f of [196, 247, 294]) for (let i = 0; i < N; i++) { const v = Math.sin(2 * Math.PI * f * i / SR) + 0.5 * Math.sin(2 * Math.PI * f * 2.003 * i / SR); inst[0][i] += 0.025 * v; inst[1][i] += 0.09 * v; }
  // drum + bass (tengah)
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, b = t % 0.5, s = (t + 0.5) % 1.0, h = t % 0.25;
    const kick = b < 0.18 ? Math.sin(2 * Math.PI * (50 * b + (100 / 30) * (1 - Math.exp(-30 * b)))) * Math.exp(-b * 22) : 0;   // sapuan 150 -> 50 Hz
    const n = rnd(); lp += 0.3 * (n - lp);
    const snare = s < 0.15 ? (0.7 * n + 0.3 * Math.sin(2 * Math.PI * 190 * s)) * Math.exp(-s * 26) : 0;
    const hat = h < 0.04 ? (n - lp) * Math.exp(-h * 90) : 0;
    const bass = 0.35 * Math.sin(2 * Math.PI * 55 * t) * (b < 0.4 ? 1 : 0.3);
    const d = 0.6 * kick + 0.35 * snare + 0.25 * hat + bass;
    inst[0][i] += d; inst[1][i] += d * 0.98;
  }
}
const mix = [new Float32Array(N), new Float32Array(N)], vref = [vocal, vocal], iref = [new Float32Array(N), new Float32Array(N)];
for (let i = 0; i < N; i++) for (let c = 0; c < 2; c++) { mix[c][i] = vocal[i] + inst[c][i]; iref[c][i] = inst[c][i]; }

const energy = (x: Float32Array[]) => { let s = 0; for (const c of x) for (let i = 0; i < c.length; i++) s += c[i] * c[i]; return s; };
const sdr = (est: Float32Array[], ref: Float32Array[]) => {
  let num = 0, den = 0;
  for (let c = 0; c < ref.length; c++) for (let i = 0; i < N; i++) { num += ref[c][i] ** 2; den += (est[c][i] - ref[c][i]) ** 2; }
  return 10 * Math.log10(num / (den + 1e-18));
};
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { console.log((ok ? 'OK    ' : 'GAGAL ') + name + ': ' + info); if (!ok) fails++; };

// 1) stereo, bawaan
let t0 = Date.now(); const r = separate(mix, SR); const dt = (Date.now() - t0) / 1000;
console.log('waktu:', dt.toFixed(1), 'dtk untuk', DUR, 'dtk audio stereo (', (DUR / dt).toFixed(1), 'x realtime )');
const sv0 = sdr(mix, vref), si0 = sdr(mix, iref), sv = sdr(r.vocal, vref), si = sdr(r.instrumental, iref);
console.log('SDR vokal    : tanpa pemisahan', sv0.toFixed(1), 'dB -> hasil', sv.toFixed(1), 'dB');
console.log('SDR instrumen: tanpa pemisahan', si0.toFixed(1), 'dB -> hasil', si.toFixed(1), 'dB');
check('perbaikan vokal >= 6 dB', sv - sv0 >= 6, (sv - sv0).toFixed(1) + ' dB');
check('perbaikan instrumen >= 3 dB', si - si0 >= 3, (si - si0).toFixed(1) + ' dB');

// 2) vokal + instrumen = aslinya, panjang dan kanal sama
let maxd = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) maxd = Math.max(maxd, Math.abs(r.vocal[c][i] + r.instrumental[c][i] - mix[c][i]));
check('vokal + instrumen = asli', maxd < 1e-5, 'selisih maks ' + maxd.toExponential(1));
check('panjang / kanal sama', r.vocal.length === 2 && r.vocal[0].length === N && r.instrumental[1].length === N, r.vocal.length + ' kanal x ' + r.vocal[0].length);

// 3) potongan kecil (chunkSec 2) hampir sama dengan potongan besar: tidak ada sambungan yang terdengar
const rc = separate(mix, SR, { chunkSec: 2 });
let dm = 0; for (let i = 0; i < N; i++) dm = Math.max(dm, Math.abs(rc.vocal[0][i] - r.vocal[0][i]));
check('hasil per-potongan konsisten', dm < 5e-3, 'selisih maks vs 12 dtk ' + dm.toExponential(1) + ' (puncak sinyal ~' + Math.max(...mix[0].slice(0, SR)).toFixed(2) + ')');

// 4) kenop strength: hanya dilaporkan (tidak ada ambang): di lagu sintetis ini pengaruhnya kecil, jadi bukan klaim kualitas
const leak = (x: { vocal: Float32Array[] }) => { const e: Float32Array[] = x.vocal.map((c, k) => c.map((v, i) => v - vref[k][i])); return 10 * Math.log10(energy(e) / energy(vref)); };
const ls = [0, 0.5, 1].map(s => ({ s, l: leak(separate(mix, SR, { strength: s })) }));
console.log('galat vokal relatif (dB, makin kecil makin baik):', ls.map(o => 'strength ' + o.s + ' = ' + o.l.toFixed(1)).join(', '));

// 5) mono: tetap jalan dan menjumlah ke asli (kualitas lebih rendah, hanya HPSS + pita)
const mono = [new Float32Array(N)]; for (let i = 0; i < N; i++) mono[0][i] = (mix[0][i] + mix[1][i]) / 2;
const rm = separate(mono, SR); let md = 0; for (let i = 0; i < N; i++) md = Math.max(md, Math.abs(rm.vocal[0][i] + rm.instrumental[0][i] - mono[0][i]));
check('mono: 1 kanal & jumlah = asli', rm.vocal.length === 1 && md < 1e-5, 'selisih maks ' + md.toExponential(1));
const mref = [vocal]; console.log('SDR vokal mono: tanpa pemisahan', sdr(mono, mref).toFixed(1), 'dB -> hasil', sdr(rm.vocal, mref).toFixed(1), 'dB');

// 6) kasus tepi: audio sangat pendek, diam, kanal salah
const tiny = separate([new Float32Array(1000).map(() => rnd() * 0.1), new Float32Array(1000)], SR);
check('audio pendek (1000 sample)', tiny.vocal[0].length === 1000 && tiny.vocal[0].every(Number.isFinite), 'ok');
const sil = separate([new Float32Array(SR), new Float32Array(SR)], SR);
check('diam -> diam, tanpa NaN', sil.vocal[0].every(v => v === 0) && sil.instrumental[0].every(v => v === 0), 'ok');
check('kosong (0 sample)', separate([new Float32Array(0)], SR).vocal[0].length === 0, 'ok');
let threw = false; try { separate([new Float32Array(10), new Float32Array(10), new Float32Array(10)], SR); } catch { threw = true; }
check('3 kanal ditolak dengan pesan jelas', threw, 'ok');

console.log(fails ? '\n' + fails + ' pemeriksaan GAGAL' : '\nsemua pemeriksaan lolos');
process.exit(fails ? 1 : 0);
