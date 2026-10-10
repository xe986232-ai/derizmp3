// Tes BPMTUNE (src/bpmtune-dsp.ts): tempo pada pola drum sintetis (sapuan 70-180 BPM), offset ketukan, YIN, nama nada, tap tempo.
//   node tools/bpmtune-test.ts
import { detectTempo, yin, hzToNote, tapBpm } from '../src/bpmtune-dsp.ts';

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };
const SR = 44100, TAU = Math.PI * 2;
let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

// drum sintetis: kick di ketukan 1 & 3, snare 2 & 4, hat tiap 8th. lead = detik sebelum ketukan pertama.
function drums(bpm: number, secs: number, lead = 0, style: 'rock' | 'four' | 'sparse' = 'rock'): Float32Array {
  const x = new Float32Array(Math.floor(secs * SR)), beat = 60 / bpm;
  const kick = (t0: number) => { const s = Math.floor(t0 * SR); for (let i = 0; i < 0.22 * SR && s + i < x.length; i++) { const t = i / SR; x[s + i] += 0.9 * Math.sin(TAU * (50 * t + 70 * (1 - Math.exp(-t * 25)) / 25 * 0 + 110 * (1 - Math.exp(-30 * t)) / 30)) * Math.exp(-t * 18); } };
  const snare = (t0: number) => { const s = Math.floor(t0 * SR); for (let i = 0; i < 0.16 * SR && s + i < x.length; i++) { const t = i / SR; x[s + i] += 0.5 * rnd() * Math.exp(-t * 28) + 0.25 * Math.sin(TAU * 190 * t) * Math.exp(-t * 30); } };
  const hat = (t0: number, a: number) => { const s = Math.floor(t0 * SR); let p = 0; for (let i = 0; i < 0.04 * SR && s + i < x.length; i++) { const t = i / SR, n = rnd(); const h = n - p; p = n; x[s + i] += a * h * Math.exp(-t * 90); } };
  for (let k = 0; lead + k * beat / 2 < secs - 0.3; k++) {
    const t = lead + k * beat / 2, b = k / 2;
    if (k % 2 === 0) {
      if (style === 'four') kick(t);
      else if (style === 'sparse') { if (b % 4 === 0) kick(t); else if (b % 4 === 2) snare(t); }
      else { if (b % 2 === 0) kick(t); else snare(t); }
    }
    if (style !== 'sparse') hat(t, k % 2 ? 0.25 : 0.15);
  }
  return x;
}

// ---------- tempo: sapuan ----------
let exact = 0, oct = 0, bad = 0; const badList: string[] = [];
for (let bpm = 70; bpm <= 180; bpm += 5) {
  const r = detectTempo(drums(bpm + 0.3, 24), SR);
  const want = bpm + 0.3;
  if (!r) { bad++; badList.push(bpm + ':null'); continue; }
  const e = Math.abs(r.bpm - want);
  if (e <= 0.5) exact++;
  else if (Math.abs(r.bpm * 2 - want) < 1 || Math.abs(r.bpm / 2 - want) < 1) { oct++; badList.push(bpm + '->' + r.bpm.toFixed(1) + ' (oktaf)'); }
  else { bad++; badList.push(bpm + '->' + r.bpm.toFixed(1)); }
}
console.log(`sapuan 70-180 (23 titik): tepat=${exact} oktaf=${oct} salah=${bad}`); if (badList.length) console.log('  ' + badList.join(', '));
ok(exact >= 17, 'sapuan: minimal 17 dari 23 tepat (+-0,5 BPM)');
ok(bad <= 2, 'sapuan: salah (bukan oktaf) paling banyak 2');

// ---------- tempo spesifik ----------
for (const [bpm, style] of [[120, 'rock'], [128, 'four'], [95, 'sparse'], [140, 'four']] as const) {
  const r = detectTempo(drums(bpm, 30, 0.37, style), SR);
  ok(!!r && Math.abs(r.bpm - bpm) <= 0.5, `${style} ${bpm} BPM -> ${r?.bpm}`);
}
{ // fase: ketukan pertama pada 0.37 s; grid bisa jatuh di ketukan manapun, jadi cek terhadap kelipatan periode
  const bpm = 120, lead = 0.37, r = detectTempo(drums(bpm, 20, lead, 'four'), SR)!, per = 60 / r.bpm;
  const d = ((r.offset - lead) % per + per) % per, err = Math.min(d, per - d);
  ok(err < 0.03, `offset grid cocok dengan ketukan (selisih ${(err * 1000).toFixed(1)} ms)`);
}
{ const r = detectTempo(new Float32Array(SR * 10), SR); ok(r === null || r.conf < 0.2, 'hening: tidak percaya diri'); }
{ const r = detectTempo(new Float32Array(SR), SR); ok(r === null, 'terlalu pendek: null'); }
{ const t0 = performance.now(); detectTempo(drums(120, 240), SR); const ms = performance.now() - t0; ok(ms < 8000, `4 menit audio dianalisis dalam ${ms.toFixed(0)} ms`); }

// ---------- YIN ----------
const tone = (f: number, kind: 'sin' | 'saw' | 'harm', n = 4096, sr = SR) => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = kind === 'sin' ? 0.5 * Math.sin(TAU * f * t) : kind === 'saw' ? 0.4 * (2 * ((f * t) % 1) - 1) : 0.3 * Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t) + 0.2 * Math.sin(TAU * 3 * f * t); }
  return x;
};
let worst = 0;
for (const f of [82.41, 110, 196, 261.63, 329.63, 440, 445, 659.26, 880, 1046.5])
  for (const k of ['sin', 'saw', 'harm'] as const) {
    const r = yin(tone(f, k), SR);
    const cents = r ? Math.abs(1200 * Math.log2(r.hz / f)) : 999; worst = Math.max(worst, cents);
    if (cents > 3) console.log(`  ${k} ${f} -> ${r?.hz.toFixed(2)} (${cents.toFixed(1)} cent)`);
  }
ok(worst < 3, `YIN sin/saw/harmonik 82-1046 Hz: selisih terburuk ${worst.toFixed(2)} cent`);
{ const r = yin(tone(440, 'sin', 4096, 48000), 48000); ok(!!r && Math.abs(1200 * Math.log2(r.hz / 440)) < 2, 'YIN di 48 kHz'); }
{ const x = tone(440, 'sin'); for (let i = 0; i < x.length; i++) x[i] += 0.03 * rnd(); const r = yin(x, SR); ok(!!r && Math.abs(1200 * Math.log2(r.hz / 440)) < 5, 'YIN tahan derau ringan'); }
ok(yin(new Float32Array(4096), SR) === null, 'YIN: hening = null');
{ const x = new Float32Array(4096); for (let i = 0; i < x.length; i++) x[i] = 0.3 * rnd(); const r = yin(x, SR); ok(r === null || r.prob < 0.8, 'YIN: derau putih tidak jadi nada yakin'); }

// ---------- nama nada ----------
{ const n = hzToNote(440); ok(n.name === 'A' && n.octave === 4 && Math.abs(n.cents) < 1e-6, 'A4 = 440'); }
{ const n = hzToNote(261.63); ok(n.name === 'C' && n.octave === 4 && Math.abs(n.cents) < 1, 'C4'); }
{ const n = hzToNote(445); ok(n.name === 'A' && n.cents > 15 && n.cents < 25, `445 Hz = A +${n.cents.toFixed(1)} cent`); }
{ const n = hzToNote(445, 445); ok(n.name === 'A' && Math.abs(n.cents) < 1e-6, 'A4 acuan 445'); }
{ const n = hzToNote(415.3, 415); ok(n.name === 'A' && n.octave === 4, 'A4 acuan 415 (barok)'); }
{ const n = hzToNote(27.5); ok(n.name === 'A' && n.octave === 0, 'A0'); }

// ---------- tap ----------
{ const b = tapBpm([0, 500, 1000, 1500, 2000]); ok(!!b && Math.abs(b - 120) < 0.01, 'tap 500 ms = 120 BPM'); }
ok(tapBpm([0]) === null, 'tap: satu ketukan = null');

console.log(fail ? `\n${fail} GAGAL` : '\nsemua lolos');
process.exit(fail ? 1 : 0);
