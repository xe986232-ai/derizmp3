// Tes mesin MIDI Printer (Node, tanpa DOM). Pakai:  node tools/printer-midi.ts
// 1) Vokal sintetis (nada diketahui, dengan vibrato + drift + sedikit meleset) -> analyze() -> notesToPrint(): nada, urutan, dan durasi harus cocok.
// 2) writeMidiFile() -> readMidiFile(): isi file harus sama persis dengan nada masukan (tempo, ppq, nada, velocity).
// 3) Kasus tepi: nada pendek dibuang, nada sama berdempetan digabung, kuantisasi grid, kunci tangga nada.
import { analyze, snapTargets } from '../src/mpcs-dsp.ts';
import { notesToPrint, writeMidiFile, readMidiFile, snapToScale, PPQ } from '../src/printer-midi.ts';

const SR = 44100, hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
let fails = 0;
const ok = (c: boolean, msg: string): void => { console.log((c ? 'OK   ' : 'GAGAL') + ' ' + msg); if (!c) fails++; };

interface TN { t0: number; t1: number; midi: number }
function synth(notes: TN[], vibHz = 5.5, vibCents = 25, driftCents = 12): Float32Array {
  const N = Math.round((notes[notes.length - 1].t1 + 0.25) * SR), midi = new Float64Array(N), amp = new Float64Array(N), x = new Float32Array(N);
  for (const n of notes) { const s = Math.round(n.t0 * SR), e = Math.round(n.t1 * SR); for (let t = s; t < e; t++) { midi[t] = n.midi; amp[t] = 1; } }
  for (let i = 0; i + 1 < notes.length; i++) {   // luncuran 60 ms antar nada yang bersambung
    if (notes[i + 1].t0 - notes[i].t1 > 0.001) continue;
    const c = Math.round(notes[i].t1 * SR), h = Math.round(0.03 * SR);
    for (let k = -h; k < h; k++) { const u = (k + h) / (2 * h), s = u * u * (3 - 2 * u); midi[c + k] = notes[i].midi + (notes[i + 1].midi - notes[i].midi) * s; }
  }
  const t0 = notes[0].t0;
  for (let t = Math.round(t0 * SR); t < N; t++) { if (!amp[t]) continue; const tt = t / SR - t0; midi[t] += (vibCents / 100) * Math.sin(2 * Math.PI * vibHz * tt) * Math.min(1, tt / 0.25) + (driftCents / 100) * Math.sin(2 * Math.PI * 0.9 * tt + 1); }
  const a0 = Math.round(0.015 * SR), r0 = Math.round(0.03 * SR);
  let ph = 0, pk = 0;
  for (let t = 0; t < N; t++) {
    if (!amp[t]) continue;
    const f = hz(midi[t]); ph += 2 * Math.PI * f / SR;
    let v = 0; const K = Math.floor(0.45 * SR / f);
    for (let k = 1; k <= K; k++) v += Math.sin(k * ph) * k ** -1.1 * (1 + 2 * Math.exp(-(((k * f - 800) / 350) ** 2)));
    // envelope per nada: atak / lepas di setiap tepi nada yang terpisah (jeda) supaya jeda terdengar sebagai diam
    let env = 1; for (const n of notes) { const s = n.t0 * SR, e = n.t1 * SR; if (t >= s && t < e) env = Math.min(1, (t - s) / a0, (e - t) / r0); }
    x[t] = v * Math.max(0, env); pk = Math.max(pk, Math.abs(x[t]));
  }
  for (let t = 0; t < N; t++) x[t] *= 0.5 / pk;
  return x;
}

// ---- 1) vokal -> nada ----
const BPM = 120, spb = 60 / BPM;
const truth: TN[] = [
  { t0: 0.30, t1: 0.90, midi: 60.2 }, { t0: 0.90, t1: 1.50, midi: 64 }, { t0: 1.70, t1: 2.30, midi: 67.3 },
  { t0: 2.30, t1: 3.00, midi: 65 }, { t0: 3.30, t1: 4.10, midi: 62 }
];
const x = synth(truth);
const { pt, notes } = analyze(x, SR); snapTargets(notes);
const got = notesToPrint(notes, pt, { bpm: BPM });
console.log('nada terdeteksi:', got.map(n => `${n.p}@${n.s.toFixed(2)}+${n.l.toFixed(2)}v${n.v}`).join('  '));
ok(got.length === truth.length, `jumlah nada ${got.length} = ${truth.length}`);
let pitchOk = 0, timeOk = 0;
truth.forEach((t, i) => {
  const g = got[i]; if (!g) return;
  if (g.p === Math.round(t.midi)) pitchOk++;
  if (Math.abs(g.s * spb - t.t0) < 0.08 && Math.abs((g.s + g.l) * spb - t.t1) < 0.12) timeOk++;
});
ok(pitchOk === truth.length, `pitch semua nada = semiton terdekat (${pitchOk}/${truth.length})`);
ok(timeOk === truth.length, `awal & akhir nada dalam toleransi 80/120 ms (${timeOk}/${truth.length})`);
ok(got.every(n => Number.isInteger(n.p) && n.v >= 1 && n.v <= 127), 'pitch bulat, velocity 1..127');
ok(got.every((n, i) => i === 0 || n.s >= got[i - 1].s + got[i - 1].l - 1e-9), 'monofonik: tidak ada nada saling menimpa');

// ---- 2) tulis -> baca file .mid ----
const bytes = writeMidiFile(got, BPM);
ok(String.fromCharCode(...bytes.slice(0, 4)) === 'MThd' && String.fromCharCode(...bytes.slice(14, 18)) === 'MTrk', 'header SMF (MThd + MTrk) benar');
const back = readMidiFile(bytes);
ok(back.ppq === PPQ && Math.abs(back.bpm - BPM) < 0.01, `ppq ${back.ppq}, tempo ${back.bpm.toFixed(2)}`);
ok(back.notes.length === got.length, `file berisi ${back.notes.length} nada`);
let same = true;
got.forEach((n, i) => { const b = back.notes[i]; if (!b || b.p !== n.p || b.v !== n.v || b.on !== Math.round(n.s * PPQ) || Math.abs((b.off - b.on) - Math.round(n.l * PPQ)) > 1) same = false; });
ok(same, 'isi file sama persis dengan nada masukan (pitch, velocity, waktu)');
const bytes2 = writeMidiFile(got, 93.5); ok(Math.abs(readMidiFile(bytes2).bpm - 93.5) < 0.01, 'tempo non-bulat 93.5 BPM terbaca balik');

// ---- 3) kasus tepi ----
const mkPt = (frames: number) => ({ sr: 44100, hop: 441, f0: new Float32Array(frames).fill(220), rms: new Float32Array(frames).fill(0.3) });   // 1 frame = 10 ms
const P = mkPt(400);
const N = (s: number, e: number, midi: number) => ({ s, e, midi, target: midi });
let r = notesToPrint([N(0, 4, 60), N(10, 60, 62)], P, { bpm: 120 });   // 40 ms dibuang, 500 ms tetap
ok(r.length === 1 && r[0].p === 62, 'nada < 60 ms dibuang');
r = notesToPrint([N(0, 50, 60), N(52, 100, 60)], P, { bpm: 120 });      // jeda 20 ms, pitch sama -> satu nada
ok(r.length === 1 && Math.abs(r[0].l - 2) < 1e-6, 'dua nada sama berdempetan digabung jadi satu (1.0 s = 2 ketukan @120)');
r = notesToPrint([N(0, 50, 60), N(60, 110, 60)], P, { bpm: 120 });      // jeda 100 ms -> tetap dua (not berulang)
ok(r.length === 2, 'nada sama dengan jeda panjang tetap dua nada (nada berulang)');
r = notesToPrint([{ s: 0, e: 50, midi: 60.4, target: 61 }], P, { bpm: 120 });
ok(r[0].p === 61, 'memakai target (hasil snap MPCS) kalau ada');
r = notesToPrint([{ s: 0, e: 50, midi: 60.4, target: NaN }], P, { bpm: 120 });
ok(r[0].p === 60, 'target tidak valid -> jatuh ke midi dibulatkan');
r = notesToPrint([N(7, 43, 60)], P, { bpm: 120, grid: 0.25 });          // 0.07 s = 0.14 beat -> 0.25 ; 0.43 s = 0.86 beat -> 0.75 ; panjang = 0.5
ok(Math.abs(r[0].s - 0.25) < 1e-9 && Math.abs(r[0].l - 0.5) < 1e-9, `grid 1/16: mulai ${r[0].s}, panjang ${r[0].l}`);
ok(snapToScale(61, 0, 'major') === 60 && snapToScale(63, 0, 'major') === 62 && snapToScale(66, 0, 'major') === 65, 'C mayor: C#→C, D#→D, F#→F (seri turun)');
ok(snapToScale(64, 9, 'minor') === 64 && snapToScale(61, 9, 'minor') === 60, 'A minor: E tetap; C# (di luar skala, C dan D sama dekat) -> C (seri turun)');
r = notesToPrint([N(0, 50, 61)], P, { bpm: 120, scale: { root: 0, mode: 'major' } });
ok(r[0].p === 60, 'opsi scale dipakai di notesToPrint');
ok(notesToPrint([], P, { bpm: 120 }).length === 0 && readMidiFile(writeMidiFile([], 120)).notes.length === 0, 'tanpa nada: daftar kosong, file tetap valid');
ok(notesToPrint([N(0, 50, 200)], P, { bpm: 120 })[0].p === 127, 'pitch di luar jangkauan dijepit ke 0..127');

console.log(fails ? `\n${fails} tes GAGAL` : '\nSemua tes lulus');
process.exit(fails ? 1 : 0);
