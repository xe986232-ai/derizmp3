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

// ---- 4) snap ke grid: awal DAN akhir tiap nada harus tepat di garis grid terdekat ----
const onGrid = (x: number, g: number): boolean => Math.abs(x / g - Math.round(x / g)) < 1e-6;
for (const g of [1, 0.5, 0.25, 0.125]) {
  const q = notesToPrint(notes, pt, { bpm: BPM, grid: g });
  ok(q.length > 0 && q.every(n => onGrid(n.s, g) && onGrid(n.l, g) && n.l >= g - 1e-9), `vokal sintetis @grid ${g}: semua awal & panjang kelipatan grid, panjang >= 1 langkah (${q.length} nada)`);
  ok(q.every((n, i) => i === 0 || n.s >= q[i - 1].s + q[i - 1].l - 1e-9) && q.every((n, i) => i === 0 || n.s > q[i - 1].s), `vokal sintetis @grid ${g}: urut, tidak ada nada menimpa / bertumpuk`);
}
const q16 = notesToPrint(notes, pt, { bpm: BPM, grid: 0.25 });
ok(truth.every((t, i) => q16[i] && Math.abs(q16[i].s - Math.round(t.t0 / spb / 0.25) * 0.25) <= 0.25 + 1e-9), 'awal tiap nada paling jauh satu langkah (1/16) dari posisi aslinya, tidak melenceng lebih');
// jitter manusia: 0.49 s / 1.51 s / 2.48 s @120 BPM = 0.98 / 3.02 / 4.96 ketukan -> harus 1.0 / 3.0 / 5.0
r = notesToPrint([N(49, 99, 60), N(151, 199, 62), N(248, 298, 64)], P, { bpm: 120, grid: 0.25 });
ok(r.map(n => n.s).join() === '1,3,5' && r.every(n => onGrid(n.l, 0.25)), `onset yang sedikit meleset menempel ke grid terdekat: ${r.map(n => n.s).join(', ')}`);
// dua nada beda pitch jatuh di langkah yang sama (suara tunggal): yang aslinya lebih panjang menang, tidak ada nada 0.001 ketukan
r = notesToPrint([N(100, 120, 60), N(105, 150, 64)], P, { bpm: 120, grid: 0.25 });
ok(r.length === 1 && r[0].p === 64 && r[0].s === 2 && onGrid(r[0].l, 0.25), `tabrakan di langkah grid yang sama: satu nada tersisa (p=${r[0]?.p}, s=${r[0]?.s})`);
r = notesToPrint([N(100, 150, 64), N(105, 120, 60)], P, { bpm: 120, grid: 0.25 });
ok(r.length === 1 && r[0].p === 64, 'tabrakan: urutan masuk tidak mempengaruhi pemenang (yang lebih panjang)');
// nada pendek tetap minimal satu langkah dan panjang dipotong ke awal nada berikutnya (keduanya di grid)
r = notesToPrint([N(0, 8, 60), N(8, 50, 62)], P, { bpm: 120, grid: 0.5 });
ok(r.length >= 1 && r.every(n => onGrid(n.s, 0.5) && onGrid(n.l, 0.5) && n.l >= 0.5 - 1e-9), 'nada sangat pendek diperpanjang ke minimal 1 langkah dan tetap di grid');
const free = notesToPrint(notes, pt, { bpm: BPM, grid: 0 });
ok(free.some(n => !onGrid(n.s, 0.25)), 'grid Off: waktu asli tidak diubah (tidak dipaksa ke grid)');

// ---- 5) nada berulang vs nada yang dipotong tracker; salah oktaf ----
// rms 0.3 di mana-mana, kecuali lembah (0.0) di frame [a, b): penyanyi berhenti sebentar = nada diulang
const dipPt = (frames: number, a: number, b: number) => { const p = mkPt(frames); for (let f = a; f < b; f++) p.rms[f] = 0; return p; };
r = notesToPrint([N(0, 50, 64), N(53, 100, 64)], dipPt(400, 48, 54), { bpm: 120 });   // jeda 30 ms, energi jatuh ke 0 -> dua nada
ok(r.length === 2, 'nada sama + lembah energi di celah: tetap dua nada (nada berulang, bukan dipotong tracker)');
r = notesToPrint([N(0, 50, 64), N(53, 100, 64)], P, { bpm: 120 });                     // jeda yang sama, energi rata -> satu nada
ok(r.length === 1, 'nada sama + celah tanpa lembah energi: tetap digabung jadi satu');
r = notesToPrint([N(0, 20, 64), N(20, 40, 64), N(40, 60, 64), N(60, 80, 64)], dipPt(400, 19, 21), { bpm: 120 });
ok(r.length === 2 && r[0].l > 0.3, 'hanya celah yang punya lembah energi yang memisahkan nada');
r = notesToPrint([N(0, 50, 60), N(55, 70, 72), N(75, 130, 61)], P, { bpm: 120 });      // nada pendek (150 ms) tepat satu oktaf di atas dua tetangga yang berdekatan
ok(r.length === 3 && r[1].p === 60, `lompatan oktaf palsu pada nada pendek dilipat ke oktaf tetangga (p=${r[1]?.p})`);
r = notesToPrint([N(0, 50, 60), N(55, 120, 72), N(125, 180, 61)], P, { bpm: 120 });    // nada 650 ms: lompatan oktaf sungguhan, dibiarkan
ok(r[1].p === 72, 'nada panjang di oktaf lain dibiarkan (lompatan melodi sungguhan)');
r = notesToPrint([N(0, 50, 60), N(55, 70, 72), N(75, 130, 67)], P, { bpm: 120 });      // tetangga berjauhan (60 vs 67): bukan pola salah oktaf
ok(r[1].p === 72, 'lompatan oktaf dengan tetangga berjauhan dibiarkan');

// ---- 6) pencilan konteks: nada pendek yang jauh dari sekitarnya (salah harmonik / noise) ----
const melody = [N(0, 40, 64), N(50, 90, 66), N(100, 140, 68), N(150, 190, 66), N(200, 240, 64)];   // 400 ms tiap nada, sekitar E4-G#4
r = notesToPrint([...melody.slice(0, 2), N(92, 98, 64 + 19), ...melody.slice(2)], P, { bpm: 120 });   // 60 ms, tepat 19 semiton (harmonik ke-3) di atas konteks
ok(r.length === 5 && r.every(n => n.p >= 64 && n.p <= 68), `salah harmonik ke-3 (+19) dilipat ke konteks (${r.map(n => n.p).join(',')})`);
r = notesToPrint([...melody.slice(0, 2), N(92, 98, 64 - 19), ...melody.slice(2)], P, { bpm: 120 });   // sub-harmonik (-19)
ok(r.length === 5 && r.every(n => n.p >= 64 && n.p <= 68), `salah sub-harmonik (-19) dilipat ke konteks (${r.map(n => n.p).join(',')})`);
r = notesToPrint([...melody.slice(0, 2), N(92, 98, 64 + 15), ...melody.slice(2)], P, { bpm: 120 });   // 15 semiton: bukan kelipatan harmonik, tak didukung -> noise, dibuang
ok(r.length === 5 && r.every(n => n.p >= 64 && n.p <= 68), `nada pencilan pendek tanpa pendukung (bukan harmonik) dibuang (${r.map(n => n.p).join(',')})`);
r = notesToPrint([N(0, 50, 60), N(60, 110, 60), N(120, 170, 60), N(180, 230, 60), N(240, 290, 60), N(300, 350, 72)], P, { bpm: 120 });   // 72: 500 ms, panjang -> tak disentuh
ok(r[r.length - 1].p === 72, 'nada panjang (>= 350 ms) tidak pernah dibuang atau dilipat');
const low = [N(0, 20, 52), N(25, 45, 52), N(50, 70, 52), N(75, 95, 52), N(100, 120, 52), N(125, 145, 52), N(150, 170, 52)];   // bagian rendah yang sah: banyak nada pendek sepitch saling mendukung
r = notesToPrint([...low, N(172, 220, 71)], P, { bpm: 120 });
ok(r.filter(n => n.p === 52).length >= 6, `bagian rendah yang sah (banyak nada pendek sepitch) tidak dibuang (${r.filter(n => n.p === 52).length} nada)`);

console.log(fails ? `\n${fails} tes GAGAL` : '\nSemua tes lulus');
process.exit(fails ? 1 : 0);
