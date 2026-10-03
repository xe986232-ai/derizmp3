// Tes knob MPCS (Node, tanpa DOM): Center / Variation / Transition harus benar-benar mengubah hasil render, bukan sekadar tampilan.
// Pakai:  node tools/mpcs-knobs.ts [path-ke-mpcs-dsp.ts]
// Pitch hasil render diukur dengan estimator autokorelasi TERPISAH dari tracker MPCS, pada sinyal sintetis yang kebenarannya diketahui.
//   Center     : pergeseran pusat nada terukur harus = center * (target - pitch asli)
//   Variation  : simpangan baku pitch dalam nada (vibrato + drift) harus menyusut sebanding dengan knob (1 -> 0 = datar)
//   Transition : waktu naik 10-90% di sambungan nada: 0 = lompat tajam, 0.5 = luncuran asli, 1 = legato lebar (makin besar knob makin lambat)
//   Manual     : nada yang diseret tangan dikoreksi penuh walau Center = 0; kondisi awal UI (Center 0) = audio tidak berubah sama sekali
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modPath = process.argv[2] ?? new URL('../src/mpcs-dsp.ts', import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dsp: any = await import(pathToFileURL(resolve(modPath)).href);
const SR = 44100;
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

interface TN { t0: number; t1: number; midi: number }
function synth(notes: TN[], glide: number, vibHz: number, vibCents: number, driftCents = 0): Float32Array {
  const N = Math.round((notes[notes.length - 1].t1 + 0.25) * SR), midi = new Float64Array(N), amp = new Float64Array(N), x = new Float32Array(N);
  for (const n of notes) { const s = Math.round(n.t0 * SR), e = Math.round(n.t1 * SR); for (let t = s; t < e; t++) { midi[t] = n.midi; amp[t] = 1; } }
  for (let i = 0; i + 1 < notes.length; i++) {
    const c = Math.round(notes[i].t1 * SR), h = Math.round(glide / 2 * SR);
    for (let k = -h; k < h; k++) { const u = (k + h) / (2 * h), s = u * u * (3 - 2 * u); midi[c + k] = notes[i].midi + (notes[i + 1].midi - notes[i].midi) * s; }
  }
  const t0 = notes[0].t0;
  for (let t = Math.round(t0 * SR); t < N; t++) {
    if (!amp[t]) continue; const tt = t / SR - t0;
    midi[t] += (vibCents / 100) * Math.sin(2 * Math.PI * vibHz * tt) * Math.min(1, tt / 0.25) + (driftCents / 100) * Math.sin(2 * Math.PI * 0.9 * tt + 1);
  }
  const a0 = Math.round(0.015 * SR), r0 = Math.round(0.03 * SR), s0 = Math.round(t0 * SR), e0 = Math.round(notes[notes.length - 1].t1 * SR);
  let ph = 0, pk = 0;
  for (let t = 0; t < N; t++) {
    if (!amp[t]) continue;
    const f = hz(midi[t]); ph += 2 * Math.PI * f / SR;
    let v = 0; const K = Math.floor(0.45 * SR / f);
    for (let k = 1; k <= K; k++) v += Math.sin(k * ph) * k ** -1.1 * (1 + 2 * Math.exp(-(((k * f - 800) / 350) ** 2)));
    const env = Math.min(1, (t - s0) / a0, (e0 - t) / r0); x[t] = v * Math.max(0, env); pk = Math.max(pk, Math.abs(x[t]));
  }
  for (let t = 0; t < N; t++) x[t] *= 0.5 / pk;
  return x;
}

// estimator pitch (MIDI) per 5 ms: autokorelasi ternormalisasi, puncak pertama yang mendekati maksimum (hindari galat oktaf), interpolasi parabola
function pitchTrack(y: Float32Array): { t: number[]; m: number[] } {
  const W = 1280, lo = Math.floor(SR / 700), hi = Math.ceil(SR / 120), hop = Math.round(0.005 * SR), t: number[] = [], m: number[] = [];
  for (let c = W; c + W < y.length; c += hop) {
    const a = c - (W >> 1), r = new Float64Array(hi + 2);
    let e0 = 0; for (let i = 0; i < W; i++) e0 += y[a + i] * y[a + i];
    if (e0 < 1e-3) continue;
    for (let l = lo - 1; l <= hi + 1; l++) { let sc = 0, el = 0; for (let i = 0; i < W; i++) { sc += y[a + i] * y[a + i + l]; el += y[a + i + l] * y[a + i + l]; } r[l] = sc / Math.sqrt(e0 * el + 1e-12); }
    let mx = 0; for (let l = lo; l <= hi; l++) mx = Math.max(mx, r[l]);
    let b = -1; for (let l = lo; l <= hi; l++) if (r[l] > 0.9 * mx && r[l] >= r[l - 1] && r[l] >= r[l + 1]) { b = l; break; }
    if (b < 0) continue;
    const den = r[b - 1] - 2 * r[b] + r[b + 1], d = den < 0 ? 0.5 * (r[b - 1] - r[b + 1]) / den : 0;
    t.push(c / SR); m.push(69 + 12 * Math.log2(SR / (b + d) / 440));
  }
  return { t, m };
}
const win = (p: { t: number[]; m: number[] }, a: number, b: number): number[] => p.m.filter((_, i) => p.t[i] >= a && p.t[i] <= b);
const mean = (v: number[]): number => v.reduce((s, q) => s + q, 0) / Math.max(1, v.length);
const sd = (v: number[]): number => { const mu = mean(v); return Math.sqrt(mean(v.map(q => (q - mu) ** 2))); };

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) fails++; console.log((ok ? '  OK    ' : '  GAGAL ') + msg); };
type Ctl = { center: number; variation: number; transition: number };
const prep = (x: Float32Array): { pt: unknown; notes: Array<{ s: number; e: number; midi: number; target: number; man?: boolean }> } => {
  const r = dsp.analyze(x, SR); dsp.snapTargets(r.notes); return { pt: r.pt, notes: r.notes };
};

console.log('MPCS knobs: ' + modPath);

// ---------- A. Center + Variation: tiga nada sumbang, vibrato 45 sen @ 5.5 Hz + drift 12 sen ----------
{
  const TNs: TN[] = [{ t0: 0.2, t1: 1.0, midi: 60.35 }, { t0: 1.0, t1: 1.8, midi: 62.4 }, { t0: 1.8, t1: 2.6, midi: 64.3 }];
  const x = synth(TNs, 0.08, 5.5, 45, 12), { pt, notes } = prep(x);
  console.log('\n[A] Center / Variation  (nada terdeteksi: ' + notes.length + ')');
  check(notes.length === 3, 'analisis menemukan 3 nada');
  const rnd = (c: Partial<Ctl>): Float32Array => dsp.render(x, pt, notes, 12, 45, { center: 1, variation: 1, transition: 0.5, ...c });
  const spans = TNs.map(n => [n.t0 + 0.22, n.t1 - 0.12] as const);
  const base = pitchTrack(x), baseMean = spans.map(([a, b]) => mean(win(base, a, b)));

  console.log('  Center (variation 1):    geser terukur (sen) vs yang diharapkan = center * (target - pitch asli)');
  for (const c of [0, 0.5, 1]) {
    const p = pitchTrack(rnd({ center: c })); let worst = 0; const cells: string[] = [];
    notes.forEach((n, i) => { const got = (mean(win(p, spans[i][0], spans[i][1])) - baseMean[i]) * 100, want = c * (n.target - n.midi) * 100; worst = Math.max(worst, Math.abs(got - want)); cells.push(got.toFixed(0) + '/' + want.toFixed(0)); });
    console.log('    center ' + (c * 100 + '%').padEnd(5) + ' nada1..3 terukur/harap: ' + cells.join('  ') + '   galat maks ' + worst.toFixed(1) + ' sen');
    check(worst < 12, 'Center ' + c * 100 + '% menggeser pusat nada sebesar ' + (c * 100) + '% dari koreksi penuh');
  }

  console.log('  Variation (center 1):    simpangan baku pitch di dalam nada (sen); asli = ' + mean(spans.map(([a, b]) => sd(win(base, a, b)) * 100)).toFixed(1));
  const sds: number[] = [];
  for (const v of [1, 0.5, 0]) { const p = pitchTrack(rnd({ variation: v })), s = mean(spans.map(([a, b]) => sd(win(p, a, b)) * 100)); sds.push(s); console.log('    variation ' + (v * 100 + '%').padEnd(5) + ' simpangan baku ' + s.toFixed(1) + ' sen'); }
  check(sds[1] < sds[0] * 0.75 && sds[1] > sds[2], 'Variation 50% = variasi menyusut sekitar setengah');
  check(sds[2] < 6, 'Variation 0% = pitch datar (< 6 sen) walau aslinya bervibrato');
}

// ---------- B. Transition: dua nada, luncuran asli 80 ms, tanpa vibrato ----------
{
  const TNs: TN[] = [{ t0: 0.2, t1: 1.0, midi: 60.3 }, { t0: 1.0, t1: 1.8, midi: 63.4 }];
  const x = synth(TNs, 0.08, 0, 0), { pt, notes } = prep(x);
  console.log('\n[B] Transition  (nada: ' + notes.length + ', luncuran asli 80 ms, lompatan 3.1 st; waktu naik 10-90% di sambungan)');
  check(notes.length === 2, 'analisis menemukan 2 nada');
  const rise = (p: { t: number[]; m: number[] }): { ms: number; step: number } => {
    const pa = mean(win(p, 0.75, 0.88)), pb = mean(win(p, 1.12, 1.25)), d = pb - pa; let t10 = NaN, t90 = NaN, big = 0;
    for (let i = 0; i < p.t.length; i++) { if (p.t[i] < 0.85 || p.t[i] > 1.15) continue; const u = (p.m[i] - pa) / d; if (isNaN(t10) && u >= 0.1) t10 = p.t[i]; if (isNaN(t90) && u >= 0.9) t90 = p.t[i]; if (i && p.t[i - 1] >= 0.85) big = Math.max(big, Math.abs(p.m[i] - p.m[i - 1])); }
    return { ms: (t90 - t10) * 1000, step: big * 100 };
  };
  const floor = rise(pitchTrack(synth(TNs, 0.002, 0, 0))).ms;   // batas resolusi estimator: waktu naik terukur untuk lompatan yang BENAR-BENAR instan
  const natural = rise(pitchTrack(x)).ms;
  // kurva f0 yang DILIHAT tracker MPCS (acuan koreksi): kalau luncuran di sini lebih landai dari aslinya, itu batas bawah kecuraman koreksi
  const seen = ((): number => {
    const tt: number[] = [], mm: number[] = []; (pt as { f0: Float32Array; hop: number }).f0.forEach((f, i) => { if (f) { tt.push(i * (pt as { hop: number }).hop / SR); mm.push(69 + 12 * Math.log2(f / 440)); } });
    return rise({ t: tt, m: mm }).ms;
  })();
  console.log('    tracker MPCS melihat luncuran asli selama ' + seen.toFixed(0) + ' ms (kurva ini yang dipakai sebagai acuan koreksi)');
  console.log('    pembanding: lompatan instan terukur ' + floor.toFixed(0) + ' ms (batas estimator), luncuran asli terukur ' + natural.toFixed(0) + ' ms');
  const res: number[] = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = dsp.render(x, pt, notes, 12, 45, { center: 1, variation: 1, transition: t }), r = rise(pitchTrack(y)); res.push(r.ms);
    console.log('    transition ' + (t * 100 + '%').padEnd(5) + ' zona halus ' + String(Math.round(dsp.transitionMs(t))).padStart(3) + ' ms   waktu naik terukur ' + r.ms.toFixed(0).padStart(3) + ' ms   lompat maks/5ms ' + r.step.toFixed(0) + ' sen');
  }
  check(res[0] <= 0.5 * natural, 'Transition 0% = lompat tajam: waktu naik ' + res[0].toFixed(0) + ' ms, kurang dari separuh luncuran asli (' + natural.toFixed(0) + ' ms)');
  check(res[0] < res[1] && res[1] < res[2], 'sisi kiri: makin kecil knob makin tajam (0% < 25% < 50%)');
  check(Math.abs(res[2] - natural) <= 8, 'Transition 50% = luncuran natural dipertahankan (' + res[2].toFixed(0) + ' ms vs asli ' + natural.toFixed(0) + ' ms)');
  check(res[2] < res[3] && res[3] < res[4], 'sisi kanan: makin besar knob makin legato (50% < 75% < 100%)');
  check(res[4] > natural + 25, 'Transition 100% = luncuran jauh lebih lebar dari aslinya (legato), bukan sekadar sama dengan 50%');
}

// ---------- C. Nada atur-tangan + kondisi awal UI ----------
{
  const TNs: TN[] = [{ t0: 0.2, t1: 1.0, midi: 60.35 }, { t0: 1.0, t1: 1.8, midi: 62.4 }, { t0: 1.8, t1: 2.6, midi: 64.3 }];
  const x = synth(TNs, 0.08, 5.5, 45, 12), { pt, notes } = prep(x);
  console.log('\n[C] Nada atur-tangan & kondisi awal');
  const init = dsp.render(x, pt, notes, 12, 45, { center: 0, variation: 1, transition: 0.5 });
  let md = 0; for (let i = 0; i < x.length; i++) md = Math.max(md, Math.abs(init[i] - x[i]));
  check(md === 0, 'kondisi awal UI (Center 0, Variation 100, Transition 50) = audio identik dengan asli (selisih maks ' + md + ')');
  notes[1].man = true; notes[1].target = Math.round(notes[1].midi) + 1;
  const spans = TNs.map(n => [n.t0 + 0.22, n.t1 - 0.12] as const), base = pitchTrack(x), p = pitchTrack(dsp.render(x, pt, notes, 12, 45, { center: 0, variation: 1, transition: 0.5 }));
  const sh = spans.map(([a, b]) => (mean(win(p, a, b)) - mean(win(base, a, b))) * 100);
  console.log('    geser terukur (sen) saat Center 0 dan nada 2 diseret +1 semiton dari snap: ' + sh.map(v => v.toFixed(0)).join('  '));
  check(Math.abs(sh[0]) < 10 && Math.abs(sh[2]) < 10, 'nada otomatis tidak berubah saat Center 0');
  check(Math.abs(sh[1] - (notes[1].target - notes[1].midi) * 100) < 12, 'nada atur-tangan dikoreksi penuh walau Center 0');
}

console.log('\n' + (fails ? fails + ' pemeriksaan GAGAL' : 'Semua pemeriksaan lulus'));
process.exit(fails ? 1 : 0);
