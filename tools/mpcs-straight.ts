// Tes "kelurusan" MPCS (Node, tanpa DOM): seberapa datar pitch HASIL render pada vokal sintetis yang realistis
// (scoop naik di awal nada, luncuran lebar antar nada bersambung, jatuhan di ujung nada, vibrato + drift), dengan pengaturan paling lurus:
// Center 100%, Variation 0%, Transition 0%. Pitch hasil diukur dengan estimator autokorelasi TERPISAH dari tracker MPCS.
// Pakai:  node tools/mpcs-straight.ts [path-ke-mpcs-dsp.ts]      (DBG=1 untuk cetak galat tiap 5 ms)
// Metrik per skenario (semua dalam sen, terhadap target semiton yang ideal):
//   rms / p95 / max : galat pitch di seluruh bagian bernada (kecuali 12 ms pertama / terakhir tiap rangkaian = ramp amplitudo)
//   slide           : bagian terburuk: simpangan terbesar dalam jendela 40 ms yang berjalan (apa yang terdengar sebagai "slide" / luncuran)
//   edge            : galat maks pada 60 ms pertama dan 60 ms terakhir tiap nada (zona scoop / jatuhan)
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modPath = process.argv[2] ?? new URL('../src/mpcs-dsp.ts', import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dsp: any = await import(pathToFileURL(resolve(modPath)).href);
const SR = 44100;
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface N { t0: number; t1: number; midi: number }
interface Sc { name: string; notes: N[]; glide: number; scoop: number; scoopMs: number; fall: number; fallMs: number; vibHz: number; vibC: number; drift: number; breath?: number }

// kontur pitch asli (MIDI): pusat nada + luncuran antar nada bersambung + scoop + jatuhan + vibrato + drift
function synth(sc: Sc): { x: Float32Array; ideal: Float64Array; voiced: Uint8Array } {
  const N0 = Math.round((sc.notes[sc.notes.length - 1].t1 + 0.3) * SR), midi = new Float64Array(N0), ideal = new Float64Array(N0), voiced = new Uint8Array(N0), amp = new Float64Array(N0), x = new Float32Array(N0);
  const ns = sc.notes, cont = (a: N, b: N): boolean => Math.abs(a.t1 - b.t0) < 1e-6;
  for (const n of ns) { const s = Math.round(n.t0 * SR), e = Math.round(n.t1 * SR); for (let t = s; t < e; t++) { midi[t] = n.midi; ideal[t] = Math.round(n.midi); voiced[t] = 1; } }
  for (let i = 0; i + 1 < ns.length; i++) if (cont(ns[i], ns[i + 1])) {
    const c = Math.round(ns[i].t1 * SR), h = Math.round(sc.glide / 2 * SR);
    for (let k = -h; k < h; k++) { const u = (k + h) / (2 * h), s = u * u * (3 - 2 * u); midi[c + k] = ns[i].midi + (ns[i + 1].midi - ns[i].midi) * s; }
  }
  let chain = 0;
  for (let i = 0; i < ns.length; i++) {
    if (i > 0 && !cont(ns[i - 1], ns[i])) chain = i;
    const startsNew = i === 0 || !cont(ns[i - 1], ns[i]), endsHere = i === ns.length - 1 || !cont(ns[i], ns[i + 1]);
    const s = Math.round(ns[i].t0 * SR), e = Math.round(ns[i].t1 * SR), c0 = ns[chain].t0;
    for (let t = s; t < e; t++) {
      const tt = t / SR - c0, ts = (t - s) / SR, te = (e - t) / SR;
      midi[t] += (sc.vibC / 100) * Math.sin(2 * Math.PI * sc.vibHz * tt) * Math.min(1, tt / 0.25) + (sc.drift / 100) * Math.sin(2 * Math.PI * 0.9 * tt + 1);
      if (startsNew && sc.scoop && ts < sc.scoopMs / 1000) { const u = ts / (sc.scoopMs / 1000); midi[t] += -sc.scoop * (1 - u * u * (3 - 2 * u)); }
      if (endsHere && sc.fall && te < sc.fallMs / 1000) { const u = te / (sc.fallMs / 1000); midi[t] += -sc.fall * (1 - u * u * (3 - 2 * u)); }
      let v = 1; if (startsNew && ts < 0.015) v = ts / 0.015; if (endsHere && te < 0.03) v = Math.min(v, te / 0.03); amp[t] = v;
    }
  }
  const r = rng(5), g = (): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  let ph = 0, jt = 0, pk = 0;
  for (let t = 0; t < N0; t++) {
    if (!voiced[t]) { x[t] = 0.003 * g(); continue; }
    jt = 0.99 * jt + 0.0003 * g(); const f = hz(midi[t]) * (1 + jt); ph += 2 * Math.PI * f / SR;
    let v = 0; const K = Math.floor(0.45 * SR / f);
    for (let k = 1; k <= K; k++) v += Math.sin(k * ph) * k ** -1.1 * (1 + 2 * Math.exp(-(((k * f - 800) / 350) ** 2)));
    x[t] = (v + (sc.breath ?? 0.03) * g()) * amp[t]; pk = Math.max(pk, Math.abs(x[t]));
  }
  for (let t = 0; t < N0; t++) x[t] *= 0.5 / pk;
  return { x, ideal, voiced };
}

// estimator pitch terpisah: autokorelasi ternormalisasi, rentang +-4 semiton di sekitar pitch ideal (supaya scoop 2-3 st yang tersisa tetap terukur)
function measure(y: Float32Array, t: number, hzExp: number): number | null {
  const T = SR / hzExp, W = Math.max(Math.round(3 * T), Math.round(0.025 * SR)), lo = Math.floor(T * 2 ** (-4 / 12)), hi = Math.ceil(T * 2 ** (4 / 12));
  const s = t - (W >> 1); if (s < 0 || s + W + hi + 2 >= y.length) return null;
  const rr = new Float64Array(hi + 2); let e0 = 0; for (let j = 0; j < W; j++) e0 += y[s + j] * y[s + j];
  for (let l = lo - 1; l <= hi + 1; l++) { let c = 0, e1 = 0; for (let j = 0; j < W; j++) { c += y[s + j] * y[s + j + l]; e1 += y[s + j + l] * y[s + j + l]; } rr[l] = c / Math.sqrt(e0 * e1 + 1e-12); }
  let mx = 0; for (let l = lo; l <= hi; l++) mx = Math.max(mx, rr[l]);
  let b = -1; for (let l = lo; l <= hi; l++) if (rr[l] > 0.92 * mx && rr[l] >= rr[l - 1] && rr[l] >= rr[l + 1]) { b = l; break; }
  if (b < 0 || mx < 0.5) return null;
  const a = rr[b - 1], m = rr[b], c = rr[b + 1], den = a - 2 * m + c, lag = den < 0 ? b + 0.5 * (a - c) / den : b;
  return 1200 * Math.log2(T / lag);
}

const sc1: N[] = [{ t0: 0.2, t1: 0.9, midi: 60.3 }, { t0: 1.1, t1: 1.8, midi: 63.7 }, { t0: 2.0, t1: 2.7, midi: 65.25 }];
const sc2: N[] = [{ t0: 0.2, t1: 0.7, midi: 57.4 }, { t0: 0.7, t1: 1.2, midi: 61.8 }, { t0: 1.2, t1: 1.7, midi: 64.25 }, { t0: 1.7, t1: 2.3, midi: 60.3 }, { t0: 2.3, t1: 2.8, midi: 58.75 }];
const sc3: N[] = [{ t0: 0.2, t1: 0.65, midi: 62.25 }, { t0: 0.65, t1: 1.1, midi: 65.2 }, { t0: 1.3, t1: 2.3, midi: 67.3 }, { t0: 2.5, t1: 2.9, midi: 64.2 }];
const scenarios: Sc[] = [
  { name: 'scoop+jatuh', notes: sc1, glide: 0.06, scoop: 1.8, scoopMs: 130, fall: 1.2, fallMs: 140, vibHz: 5.5, vibC: 35, drift: 12 },
  { name: 'scoop lebar 3st', notes: sc1, glide: 0.06, scoop: 3.0, scoopMs: 180, fall: 2.0, fallMs: 200, vibHz: 5.2, vibC: 30, drift: 15 },
  { name: 'legato 150ms', notes: sc2, glide: 0.15, scoop: 0, scoopMs: 0, fall: 0, fallMs: 0, vibHz: 5.5, vibC: 30, drift: 10 },
  { name: 'legato+scoop+jatuh', notes: sc2, glide: 0.12, scoop: 1.5, scoopMs: 120, fall: 1.5, fallMs: 150, vibHz: 5, vibC: 40, drift: 12 },
  { name: 'campur', notes: sc3, glide: 0.1, scoop: 2.0, scoopMs: 150, fall: 1.0, fallMs: 120, vibHz: 6, vibC: 45, drift: 15, breath: 0.08 }
];

const CTL = { center: 1, variation: 0, transition: 0 };
const pct = (a: number[], p: number): number => { if (!a.length) return 0; const b = a.slice().sort((q, w) => q - w); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
let worstSlide = 0, worstRms = 0;
console.log('MPCS kelurusan (Center 100 / Variation 0 / Transition 0): ' + modPath);
console.log('skenario'.padEnd(20) + 'nada'.padEnd(7) + 'rms'.padStart(7) + 'p95'.padStart(7) + 'max'.padStart(7) + 'slide40ms'.padStart(11) + 'edge'.padStart(7) + '  (sen)');
for (const sc of scenarios) {
  const { x, ideal, voiced } = synth(sc), r = dsp.analyze(x, SR); dsp.snapTargets(r.notes);
  if (process.env.DBG === '2') console.log('  ' + sc.name + ' nada: ' + r.notes.map((n: any) => (n.s * r.pt.hop / SR).toFixed(2) + '-' + (n.e * r.pt.hop / SR).toFixed(2) + ' m' + n.midi.toFixed(2) + '>' + n.target).join(' | '));
  const y: Float32Array = dsp.render(x, r.pt, r.notes, 12, 45, CTL), N0 = x.length, step = Math.round(0.005 * SR);
  // awal / akhir rangkaian bernada + awal / akhir tiap nada (untuk metrik edge)
  const edges: Array<[number, number]> = []; const ns = sc.notes;
  for (const n of ns) edges.push([Math.round(n.t0 * SR), Math.round((n.t0 + 0.06) * SR)], [Math.round((n.t1 - 0.06) * SR), Math.round(n.t1 * SR)]);
  const conts0: number[] = []; for (let i = 0; i + 1 < ns.length; i++) if (Math.abs(ns[i].t1 - ns[i + 1].t0) < 1e-6) conts0.push(ns[i].t1);
  const errs: number[] = [], seq: Array<number | null> = [], edgeE: number[] = [];
  for (let t = Math.round(0.05 * SR); t < N0 - Math.round(0.05 * SR); t += step) {
    let inVoice = true; for (let k = -Math.round(0.012 * SR); k <= Math.round(0.012 * SR); k += Math.round(0.006 * SR)) if (!voiced[t + k]) inVoice = false;
    if (!inVoice) { seq.push(null); continue; }
    const m = measure(y, t, hz(ideal[t])); if (m === null) { seq.push(null); continue; }
    // galat terhadap ideal: estimator mengukur terhadap pitch ideal di t, jadi m = (pitch ideal - pitch hasil) dalam sen -> tanda dibalik
    const nearJ = conts0.some(c => Math.abs(t / SR - c) < 0.04);   // di sekitar sambungan, ideal melompat tepat di batas sedangkan hasil melompat di tengah luncuran: bukan galat kelurusan
    const e = -m; seq.push(e); if (!nearJ) errs.push(e); else continue;
    if (edges.some(([a, b]) => t >= a && t < b)) edgeE.push(Math.abs(e));
  }
  // slide: simpangan (maks - min) pada jendela 8 titik (40 ms) di dalam satu nada, bukan di perbatasan nada bersambung
  let slide = 0; const conts: number[] = []; for (let i = 0; i + 1 < ns.length; i++) if (Math.abs(ns[i].t1 - ns[i + 1].t0) < 1e-6) conts.push(ns[i].t1);
  for (let i = 0; i + 8 <= seq.length; i++) {
    const w = seq.slice(i, i + 8); if (w.some(v => v === null)) continue;
    const tc = (Math.round(0.05 * SR) + (i + 4) * step) / SR; if (conts.some(c => Math.abs(tc - c) < 0.05)) continue;
    const v = w as number[]; slide = Math.max(slide, Math.max(...v) - Math.min(...v));
  }
  const a = errs.map(Math.abs), rms = Math.sqrt(errs.reduce((s, q) => s + q * q, 0) / Math.max(1, errs.length));
  worstSlide = Math.max(worstSlide, slide); worstRms = Math.max(worstRms, rms);
  console.log(sc.name.padEnd(20) + (r.notes.length + '/' + sc.notes.length).padEnd(7) + rms.toFixed(1).padStart(7) + pct(a, 0.95).toFixed(1).padStart(7) + Math.max(0, ...a).toFixed(1).padStart(7) + slide.toFixed(1).padStart(11) + Math.max(0, ...edgeE).toFixed(1).padStart(7));
  if (process.env.DBG) console.log('  ' + sc.name + ' galat(c)/5ms: ' + seq.map(v => (v === null ? '.' : String(Math.round(v)))).join(' ').slice(0, 1600));
}
console.log('terburuk: rms ' + worstRms.toFixed(1) + ' sen, slide40ms ' + worstSlide.toFixed(1) + ' sen');
