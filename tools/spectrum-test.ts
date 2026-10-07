// Tes SPECTRUM (src/spectrum-dsp.ts): deteksi pitch, kestabilan gambar scope, envelope riwayat, penguat otomatis, kecepatan.
//   node tools/spectrum-test.ts
import { PitchDetector, PitchTracker, TraceBuilder, Envelope, AutoGain, shape, noteName } from '../src/spectrum-dsp.ts';

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };
const N = 4096, M = 160;

// ---------- pembangkit sinyal ----------
type Gen = (t: number) => number;
const TAU = Math.PI * 2;
const sine = (f: number, a = 0.6): Gen => t => a * Math.sin(TAU * f * t);
const saw = (f: number, a = 0.5): Gen => t => { let s = 0; for (let h = 1; h <= 12; h++) s += Math.sin(TAU * f * h * t) / h; return a * s * 0.6; };
const square = (f: number, a = 0.5): Gen => t => a * (Math.sin(TAU * f * t) >= 0 ? 1 : -1);
const missingFund = (f: number): Gen => t => 0.3 * (Math.sin(TAU * 2 * f * t) + Math.sin(TAU * 3 * f * t) + Math.sin(TAU * 4 * f * t) + Math.sin(TAU * 5 * f * t));
function noiseGen(): Gen { let s = 12345; return () => { s = (s * 1664525 + 1013904223) >>> 0; return ((s / 4294967296) * 2 - 1) * 0.5; }; }
const vib = (f: number, depth: number, rate: number): Gen => { let ph = 0, last = 0; return t => { const dt = t - last; last = t; ph += TAU * f * (1 + depth * Math.sin(TAU * rate * t)) * Math.max(0, dt); return 0.5 * Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph); }; };
const mix = (...g: Gen[]): Gen => t => g.reduce((a, f) => a + f(t), 0);

function render(g: Gen, sr: number, t0: number): Float32Array {   // N sampel yang berakhir di waktu t0 (detik)
  const x = new Float32Array(N), s0 = Math.round(t0 * sr) - N;
  for (let i = 0; i < N; i++) x[i] = g((s0 + i) / sr);
  return x;
}

// ---------- 1. akurasi pitch ----------
for (const sr of [44100, 48000]) {
  const det = new PitchDetector(N);
  const cases: [string, Gen, number][] = [
    ['sinus 110 Hz', sine(110), 110], ['saw 220 Hz', saw(220), 220], ['kotak 440 Hz', square(440), 440], ['sinus 1760 Hz', sine(1760), 1760],
    ['bass 55 Hz + harmonik', saw(55), 55], ['fundamental hilang (100 Hz)', missingFund(100), 100], ['sinus 30 Hz', sine(30), 30]
  ];
  for (const [name, g, f] of cases) {
    const e = det.detect(render(g, sr, 1), sr), got = e.period > 0 ? sr / e.period : 0;
    ok(Math.abs(got - f) / f < 0.006 && e.clarity > 0.8, `${sr} Hz: ${name} -> ${got.toFixed(2)} Hz (clarity ${e.clarity.toFixed(2)})`);
  }
  const nz = det.detect(render(noiseGen(), sr, 1), sr);
  ok(nz.period === 0 || nz.clarity < 0.55, `${sr} Hz: noise tidak dianggap nada (clarity ${nz.clarity.toFixed(2)})`);
  ok(det.detect(new Float32Array(N), sr).period === 0, `${sr} Hz: senyap -> tanpa periode`);
}
{ const n = noteName(440); ok(n.name === 'A4' && n.cents === 0, 'noteName 440 = A4'); const m = noteName(261.63); ok(m.name === 'C4', 'noteName 261.63 = C4'); }

// ---------- 2. kestabilan gambar: korelasi antar frame berurutan (60 fps, deteksi 20 Hz) ----------
function stability(g: Gen, sr: number, lock: boolean, secs = 3): { corr: number; worst: number; periodJumps: number } {
  const det = new PitchDetector(N), trk = new PitchTracker(), tb = new TraceBuilder(N, M);
  let prev: Float32Array | null = null, cur = new Float32Array(M), sum = 0, cnt = 0, worst = 1, jumps = 0, lastP = 0;
  const frames = Math.round(secs * 60);
  for (let f = 0; f < frames; f++) {
    const x = render(g, sr, 0.5 + f / 60);
    if (f % 3 === 0) { trk.update(det.detect(x, sr)); if (lastP && trk.period && Math.abs(trk.period / lastP - 1) > 0.1) jumps++; if (trk.period) lastP = trk.period; }
    const info = tb.build(x, trk.period, sr, cur, lock ? prev : null);
    if (prev && !info.silent && f > 30) {
      let dot = 0, a = 0, b = 0;
      for (let k = 0; k < M; k++) { dot += cur[k] * prev[k]; a += cur[k] * cur[k]; b += prev[k] * prev[k]; }
      const c = dot / Math.sqrt(a * b + 1e-18); sum += c; cnt++; if (c < worst) worst = c;
    }
    if (!prev) prev = new Float32Array(M);
    prev.set(cur);
  }
  return { corr: sum / Math.max(1, cnt), worst, periodJumps: jumps };
}
for (const sr of [44100, 48000]) {
  const sigs: [string, Gen, number, number][] = [
    ['saw 220 Hz + vibrato 1.5%', vib(220, 0.015, 5), 0.96, 0.85],
    ['bass 55 Hz + lead 440 Hz', mix(sine(55, 0.5), saw(440, 0.3)), 0.95, 0.8],
    ['kotak 330 Hz', square(330), 0.995, 0.99],
    ['gelombang kompleks 130 Hz (banyak zero-crossing per siklus)', t => 0.5 * Math.sin(TAU * 130 * t) + 0.45 * Math.sin(TAU * 260 * t + 1.9) + 0.35 * Math.sin(TAU * 390 * t + 0.4) + 0.2 * Math.sin(TAU * 910 * t), 0.97, 0.9]
  ];
  for (const [name, g, minMean, minWorst] of sigs) {
    const L = stability(g, sr, true), U = stability(g, sr, false);
    ok(L.corr >= minMean && L.worst >= minWorst, `${sr} Hz: ${name}: korelasi rata-rata ${L.corr.toFixed(4)} terburuk ${L.worst.toFixed(3)} (tanpa kunci fase ${U.corr.toFixed(4)} / ${U.worst.toFixed(3)}), lompatan periode ${L.periodJumps}`);
    ok(L.corr >= U.corr - 1e-6, `${sr} Hz: ${name}: kunci fase tidak lebih buruk dari trigger biasa`);
  }
}

// ---------- 3. envelope riwayat: pluck 4x per detik, setiap pluck meluruh ----------
{
  const sr = 48000, env = new Envelope(sr), buf = new Float32Array(N);
  const g: Gen = t => { const ph = (t * 4) % 1; return 0.8 * Math.exp(-ph * 10) * Math.sin(TAU * 220 * t); };
  let t = 0, cols = 0;
  for (let f = 0; f < 60 * 3; f++) {   // 3 detik, frame 60 fps
    const n = Math.round(sr / 60); for (let i = 0; i < N; i++) buf[i] = g(t + (i - N + n) / sr);
    cols += env.push(buf, n); t += n / sr;
  }
  const expect = 3 / env.binSec;
  ok(Math.abs(cols - expect) < 4, `envelope: ${cols} kolom dalam 3 s (harapan ~${expect.toFixed(0)})`);
  const per = Math.round(0.25 / env.binSec);
  const peaks: number[] = [];
  for (let b = 0; b < per * 8; b++) { if (env.at(b) > env.at(b + 1) && env.at(b) >= env.at(b - 1) && env.at(b) > 0.4) peaks.push(b); }
  ok(peaks.length >= 7 && peaks.length <= 9, `envelope: ${peaks.length} puncak pluck terlihat di 2 detik terakhir (harapan 8)`);
  let minGap = 1e9; for (let i = 1; i < peaks.length; i++) minGap = Math.min(minGap, peaks[i] - peaks[i - 1]);
  ok(peaks.length < 2 || Math.abs(minGap - per) <= 3, `envelope: jarak antar pluck ${minGap} kolom (harapan ${per})`);
  const deep = env.at(2);   // simulasi berhenti tepat sebelum pluck berikutnya (fase 0): ekor sudah meluruh jauh
  const mid = env.at(Math.round(per / 2));   // pertengahan siklus: pluck sudah turun jauh dari puncak 0.8
  ok(deep < 0.05 && mid < 0.2 && env.at(peaks[0] ?? 0) > 0.6, `envelope: ekor meluruh (ujung ${deep.toFixed(3)}, tengah ${mid.toFixed(3)}, puncak ${env.at(peaks[0] ?? 0).toFixed(2)})`);
  ok(env.frac >= 0 && env.frac < 1, `envelope: frac ${env.frac.toFixed(2)} di dalam 0..1`);
  const c1 = env.cubic(10.5), lo = Math.min(env.at(10), env.at(11)) * 0.7, hi = Math.max(env.at(10), env.at(11)) * 1.3 + 1e-6;
  ok(c1 >= lo && c1 <= hi, 'envelope: interpolasi kubik masuk akal');
}
// release: sesudah sumber dimatikan, ~50 ms kemudian nilai tinggal ~37%
{
  const sr = 48000, env = new Envelope(sr, 0.006, 12, 0.05), loud = new Float32Array(N).fill(0.5), quiet = new Float32Array(N);
  env.push(loud, 4096); for (let i = 0; i < 20; i++) env.push(loud, 288);
  const v0 = env.at(0); let steps = 0; env.push(quiet, 288);
  while (env.at(0) > v0 * 0.368 && steps < 50) { env.push(quiet, 288); steps++; }
  ok(Math.abs(steps * 0.006 - 0.05) < 0.012, `envelope: waktu turun ke 37% = ${(steps * 6)} ms (harapan ~50 ms)`);
}

// ---------- 4. penguat otomatis ----------
{
  const ag = new AutoGain(6);
  for (let i = 0; i < 120; i++) ag.update(0.1, 1 / 60);
  ok(Math.abs(ag.scale * 0.1 - 0.92) < 0.05, `AutoGain: sinyal 0.1 diskalakan ke ~0.92 (${(ag.scale * 0.1).toFixed(2)})`);
  ag.update(1, 1 / 60); for (let i = 0; i < 10; i++) ag.update(1, 1 / 60);
  ok(ag.scale <= 0.92 / 0.6, 'AutoGain: puncak keras langsung menurunkan penguatan');
  const ag2 = new AutoGain(6); for (let i = 0; i < 600; i++) ag2.update(0.0001, 1 / 60);
  ok(ag2.scale <= 0.92 / 0.03 + 1e-6, `AutoGain: senyap tidak memperbesar tanpa batas (maks x${ag2.scale.toFixed(1)})`);
  ok(shape(0) === 0 && shape(1) === 1 && shape(2) === 1 && shape(0.1) > 0.1 && shape(0.1) < 0.2, 'shape: 0->0, 1->1, bagian pelan sedikit diangkat');
}

// ---------- 5. kecepatan ----------
{
  const sr = 48000, det = new PitchDetector(N), tb = new TraceBuilder(N, M), x = render(mix(saw(110), sine(440, 0.2)), sr, 1), out = new Float32Array(M), prev = new Float32Array(M);
  let t0 = performance.now(); const R = 200;
  for (let i = 0; i < R; i++) det.detect(x, sr);
  const dMs = (performance.now() - t0) / R;
  t0 = performance.now();
  for (let i = 0; i < R * 5; i++) tb.build(x, sr / 110, sr, out, prev);
  const bMs = (performance.now() - t0) / (R * 5);
  ok(dMs < 8, `kecepatan: detect ${dMs.toFixed(2)} ms/panggilan (jalan ~20x per detik)`);
  ok(bMs < 3, `kecepatan: build trace ${bMs.toFixed(2)} ms/frame (jalan 60x per detik)`);
}

console.log(fail ? `\n${fail} tes GAGAL` : '\nsemua tes lolos');
process.exit(fail ? 1 : 0);
