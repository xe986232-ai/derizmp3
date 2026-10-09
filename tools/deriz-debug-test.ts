// Tes statistik Debug Audio di worklet DERIZ (src/deriz-synth.ts): jalankan prosesor worklet di Node dengan sample sintetis.
//   node --experimental-transform-types tools/deriz-debug-test.ts   (flag perlu karena deriz-synth.ts memakai parameter property TypeScript)
// Yang dicek: (1) suara BIT-PER-BIT sama antara debug mati dan debug nyala, (2) hitungan blok / nada telat / dipotong / hilang benar,
// (3) deteksi blok telat dengan timer presisi dan dengan timer kasar 1 ms (Date.now), (4) tambahan beban kecil.
import { WORKLET_SRC } from '../src/deriz-synth.ts';

const SR = 48000, BLK = 128;
let T = 0;
Object.defineProperty(globalThis, 'currentTime', { get: () => T, configurable: true });
(globalThis as any).sampleRate = SR;

interface Posted { t: string; [k: string]: any }
function load(perf: any, date: any): { make: () => any; posted: Posted[] } {
  const posted: Posted[] = [];
  let Proc: any;
  (globalThis as any).AudioWorkletProcessor = class { port = { postMessage: (m: Posted) => { posted.push(m); }, onmessage: null as any }; };
  (globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
  new Function('performance', 'Date', WORKLET_SRC)(perf, date);
  return { make: () => new Proc(), posted };
}

// sample: 3 detik, dua letupan nada supaya ada onset, stereo sedikit berbeda
function makeSample(): { ch: Float32Array[]; mono: Float32Array; ons: number[]; rate: number } {
  const n = SR * 3, l = new Float32Array(n), r = new Float32Array(n), ons = [0, Math.round(1.5 * SR)];
  for (let i = 0; i < n; i++) {
    const t = i / SR, seg = t < 1.5 ? t : t - 1.5, env = Math.exp(-seg * 2);
    const v = env * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 440.7 * t) + 0.1 * Math.sin(2 * Math.PI * 1310 * t));
    l[i] = v; r[i] = v * 0.9 + 0.02 * Math.sin(2 * Math.PI * 97 * t);
  }
  const mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = (l[i] + r[i]) / 2;
  return { ch: [l, r], mono, ons, rate: SR };
}
const give = (node: any, s: ReturnType<typeof makeSample>) => node.msg({ t: 'buf', ch: s.ch.map(x => x.slice()), mono: s.mono.slice(), ons: s.ons, rate: s.rate });

interface Run { out: Float32Array; stats: Posted[]; active: number }
// skenario: 3 DERIZ, melodi cepat + akor + duplikat; tiap nada 'on' dijadwalkan lebih dulu (at), 'off' juga
function scenario(dbg: boolean, perf: any, date: any, heavyMs: (blk: number) => number = () => 0, fake?: { t: number }): Run {
  const { make, posted } = load(perf, date), s = makeSample();
  const nodes = [make(), make(), make()];
  T = 0;
  nodes.forEach(n => give(n, s));
  nodes.forEach(n => n.msg({ t: 'gov', on: false }));   // tes ini menguji instrumentasi: governor beban bergantung pada waktu nyata (JIT dingin vs hangat), jadi dimatikan agar keluaran deterministik (governor diuji di deriz-load-test.ts)
  if (dbg) nodes.forEach(n => n.msg({ t: 'dbg', on: true }));
  let id = 0;
  nodes.forEach((n, k) => {
    for (let i = 0; i < 24; i++) {   // 8 nada/detik, tiap DERIZ bergeser sedikit; tiap 4 nada ada akor 3 nada (duplikat nada yang sama di DERIZ lain)
      const at = 0.2 + i * 0.125 + k * 0.01, semis = [0, 4, 7, 12, 5, 9][(i + k) % 6], chord = i % 4 === 0 ? 3 : 1;
      for (let c = 0; c < chord; c++) {
        const nid = ++id;
        n.msg({ t: 'on', id: nid, semis: semis + c * 4, start: Math.round((i % 2 ? 1.5 : 0) * SR), speed: 1, pitch: 0, vol: 0.9, at, vel: 1 });
        n.msg({ t: 'off', id: nid, at: at + 0.3 });
      }
    }
  });
  const total = Math.ceil(5.0 * SR / BLK), out = new Float32Array(total * BLK * 2);
  let active = 0;
  for (let b = 0; b < total; b++) {
    T = b * BLK / SR;
    const before = nodes.some(n => n.voices.length > 0);
    const o = [new Float32Array(BLK), new Float32Array(BLK)];
    nodes.forEach(n => {
      if (fake) { const run = n.run; n.run = function (i: any, p: any) { fake.t += heavyMs(b); return run.call(this, i, p); }; }
      n.process([], [o]);
      if (fake) delete n.run;
    });
    if (before || nodes.some(n => n.voices.length > 0)) active++;
    out.set(o[0], (b * 2) * BLK); out.set(o[1], (b * 2 + 1) * BLK);
  }
  return { out, stats: posted.filter(m => m.t === 'st'), active };
}
const same = (x: Float32Array, y: Float32Array): boolean => { if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
let fails = 0;
const ok = (c: boolean, msg: string) => { if (!c) fails++; console.log((c ? 'OK   ' : 'GAGAL') + ' ' + msg); };

// ---- 1. suara identik, debug mati vs nyala ----
const off = scenario(false, performance, Date), onn = scenario(true, performance, Date);
ok(same(off.out, onn.out), 'keluaran audio identik bit-per-bit (debug mati vs nyala), ' + off.out.length + ' sampel');
ok(off.stats.length === 0, 'debug mati: tidak ada pesan statistik');
let peak = 0; for (const v of off.out) peak = Math.max(peak, Math.abs(v));
ok(peak > 0.05, 'skenario menghasilkan suara (puncak ' + peak.toFixed(3) + ')');

// ---- 2. hitungan ----
const sum = (k: string) => onn.stats.reduce((s, m) => s + m[k], 0);
ok(onn.stats.length >= 5, 'laporan terkirim tiap 0,5 detik (' + onn.stats.length + ' pesan dalam 5 detik)');
ok(sum('n') === onn.active, 'jumlah blok aktif cocok: ' + sum('n') + ' vs hitungan tes ' + onn.active);
ok(sum('nOn') === 3 * 24 + 3 * 6 * 2, 'jumlah nada terjadwal cocok: ' + sum('nOn'));   // 24 nada tiap DERIZ + 6 akor x 2 nada ekstra
ok(sum('nLate') === 0, 'semua nada tepat waktu (telat: ' + sum('nLate') + ')');
ok(sum('full') + sum('light') + sum('hit') > 100, 'frame WSOLA terhitung: penuh ' + sum('full') + ', ringan ' + sum('light') + ', cache ' + sum('hit'));
ok(Math.max(...onn.stats.map(m => m.vmax)) >= 6 && Math.max(...onn.stats.map(m => m.iamax)) === 3, 'voice puncak ' + Math.max(...onn.stats.map(m => m.vmax)) + ' di ' + Math.max(...onn.stats.map(m => m.iamax)) + ' DERIZ');

// ---- 3. nada telat, dipotong, tanpa sample, jadwal terhapus ----
{
  const { make, posted } = load(performance, Date), s = makeSample(), n = make(), n2 = make();
  T = 0; give(n, s); n.msg({ t: 'dbg', on: true });
  T = 0.5;
  n.msg({ t: 'on', id: 1, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.42, vel: 1 });   // jadwal sudah lewat 80 ms
  n.msg({ t: 'on', id: 2, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.5005, vel: 1 });   // masih tertunda (belum jatuh tempo) ketika sample baru masuk: ikut terhapus
  for (let i = 0; i < 14; i++) n.msg({ t: 'on', id: 10 + i, semis: i, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.5, vel: 1 });   // + id 1 = 15 nada ditahan sekaligus, batas 12 => 3 terpotong
  n2.msg({ t: 'on', id: 99, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.5, vel: 1 });   // n2 tidak punya sample
  for (let i = 0; i < 3; i++) n.msg({ t: 'on', id: 200 + i, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.9, vel: 1 });   // tertunda...
  give(n, s);   // ...lalu sample baru masuk: 3 + id 2 = 4 jadwal terhapus
  for (let b = 0; b < 400; b++) { T = 0.5 + b * BLK / SR; n.process([], [[new Float32Array(BLK), new Float32Array(BLK)]]); n2.process([], [[new Float32Array(BLK), new Float32Array(BLK)]]); }
  const st = posted.filter(m => m.t === 'st'), S = (k: string) => st.reduce((x, m) => x + m[k], 0);
  ok(S('nLate') >= 1 && Math.abs(Math.max(...st.map(m => m.ltMax)) - 80) < 0.5, 'nada telat 80 ms terdeteksi (terlama ' + Math.max(...st.map(m => m.ltMax)).toFixed(1) + ' ms, jumlah ' + S('nLate') + ')');
  ok(S('stealH') === 3 && S('stealT') === 0, 'nada ditahan terpotong: ' + S('stealH') + ' (diharapkan 3: 15 nada ditahan - batas 12)');
  ok(S('noBuf') === 1, 'nada tanpa sample: ' + S('noBuf'));
  ok(S('penDrop') === 4, 'jadwal terhapus saat sample baru: ' + S('penDrop') + ' (diharapkan 4)');
}

// ---- 3b. pesan nada tertunda di jalan: dikirim di jam 1,0 s, diterima worklet di jam 1,6 s ----
{
  const { make, posted } = load(performance, Date), s = makeSample(), n = make();
  T = 0; give(n, s); n.msg({ t: 'dbg', on: true });
  T = 1.6;
  n.msg({ t: 'on', id: 1, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 1.0, vel: 1, sent: 1.0 });    // tertunda 600 ms di jalan
  n.msg({ t: 'on', id: 2, semis: 0, start: 0, speed: 1, pitch: 0, vol: 0.9, at: 1.7, vel: 1, sent: 1.599 });  // normal (1 ms)
  for (let b = 0; b < 400; b++) { T = 1.6 + b * BLK / SR; n.process([], [[new Float32Array(BLK), new Float32Array(BLK)]]); }
  const st = posted.filter(m => m.t === 'st'), S = (k: string) => st.reduce((x, m) => x + m[k], 0);
  ok(S('trN') === 2 && S('trSlow') === 1 && Math.abs(Math.max(...st.map(m => m.trMax)) - 600) < 0.5, 'pesan tertunda di jalan: ' + S('trSlow') + ' dari ' + S('trN') + ', terlama ' + Math.max(...st.map(m => m.trMax)).toFixed(0) + ' ms (diharapkan 1 dari 2, 600 ms)');
}

// ---- 4. blok telat: timer presisi, lalu timer kasar 1 ms (Date.now) ----
// Beban buatan hanya di blok 400..409 (sekitar detik 1,07; ketiga DERIZ sedang bunyi): tiap DERIZ menambah X ms ke jam palsu.
{
  const bud = BLK / SR * 1000, burst = (x: number) => (b: number) => (b >= 400 && b < 410 ? x : 0);
  const stats = (r: Run) => ({ late: r.stats.reduce((x, m) => x + m.late, 0), max: Math.max(...r.stats.map(m => m.max)), tr: r.stats[0]?.tr });
  const fa = { t: 0 }, pa = { now: () => fa.t };
  let r = stats(scenario(true, pa, Date, burst(3), fa));   // 3 DERIZ x 3 ms = 9 ms per blok, jatah 2,67 ms
  ok(r.late === 10 && Math.abs(r.max - 9) < 1e-6 && r.tr === 0, 'timer presisi, 9 ms x 10 blok: telat ' + r.late + ' (diharapkan 10), puncak ' + r.max.toFixed(1) + ' ms');
  r = stats(scenario(true, pa, Date, burst(0.5), fa));      // 1,5 ms per blok: di bawah jatah
  ok(r.late === 0, 'timer presisi, 1,5 ms per blok (< ' + bud.toFixed(2) + '): telat ' + r.late + ' (diharapkan 0)');
  r = stats(scenario(true, pa, Date, burst(1), fa));        // 3 ms per blok: sedikit di atas jatah
  ok(r.late === 10, 'timer presisi, 3 ms x 10 blok: telat ' + r.late + ' (diharapkan 10)');
  const fb = { t: 1000 }, pb = { now: () => fb.t };          // timer kasar: jam palsu hanya bergerak dalam kelipatan 1 ms
  r = stats(scenario(true, undefined, pb, burst(2), fb));   // 6 ms per blok terukur: PASTI lewat jatah
  ok(r.tr === 1 && r.late === 10, 'tanpa performance di worklet (Date.now): resolusi dilaporkan ' + r.tr + ' ms, telat ' + r.late + ' (diharapkan 10)');
  r = stats(scenario(true, undefined, pb, burst(1), fb));   // 3 ms terukur: bisa saja 2,01-3,99 ms sebenarnya, jadi tidak dihitung telat (sengaja konservatif)
  ok(r.late === 0, 'timer kasar, 3 ms terukur: tidak dihitung telat (konservatif), telat ' + r.late);
}

// ---- 5. tambahan beban ----
{
  const t = (dbg: boolean): number => { const t0 = performance.now(); for (let i = 0; i < 3; i++) scenario(dbg, performance, Date); return performance.now() - t0; };
  t(false); t(true);
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < 5; i++) { a.push(t(false)); b.push(t(true)); }
  const ma = Math.min(...a), mb = Math.min(...b);
  console.log('INFO tambahan beban saat debug nyala: ' + ((mb / ma - 1) * 100).toFixed(1) + '% (' + ma.toFixed(0) + ' ms -> ' + mb.toFixed(0) + ' ms untuk 3 skenario)');
  ok(mb / ma < 1.25, 'tambahan beban debug nyala < 25% (termasuk biaya menyiapkan skenario)');
}
console.log(fails ? '\n' + fails + ' GAGAL' : '\nsemua lulus');
process.exit(fails ? 1 : 0);
