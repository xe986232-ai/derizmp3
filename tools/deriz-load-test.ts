// Tes pengaman beban (governor) worklet DERIZ: node --experimental-transform-types tools/deriz-load-test.ts
// Dulu jumlah nada hidup dibatasi per plugin saja (12), jadi banyak plugin DERIZ bisa menumpuk puluhan nada (termasuk ekor lepas ~370 ms) dan satu blok audio
// melewati jatah 2,67 ms: SELURUH graf (audio clip juga) patah-patah, jam audio tersendat (playhead loncat), suara tertinggal baru keluar setelah Pause.
// Waktu di tes ini PALSU (performance.now = jam buatan yang hanya maju sebesar biaya yang kita modelkan), jadi hasilnya deterministik di mesin apa pun.
//   (1) beban ringan: governor tidak mengubah suara sedikit pun (bit-per-bit sama dengan governor mati)
//   (2) beban berat: jumlah nada hidup dibatasi sampai beban kembali di bawah jatah; tanpa governor nada menumpuk
//   (3) yang dibuang = ekor pelan lebih dulu; nada yang masih ditahan tetap hidup
//   (4) beban turun lagi: batas dilonggarkan kembali
//   (5) ekor lepas habis lebih cepat dari sebelumnya dan tanpa klik
import { WORKLET_SRC } from '../src/deriz-synth.ts';
const SR = 48000, BLK = 128, BUD = BLK / SR * 1000;
let T = 0;
Object.defineProperty(globalThis, 'currentTime', { get: () => T, configurable: true });
(globalThis as any).sampleRate = SR;
const fake = { t: 0 };
const perf = { now: () => fake.t };
let Proc: any;
(globalThis as any).AudioWorkletProcessor = class { port = { postMessage: () => {}, onmessage: null as any }; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };

const n0 = SR * 12, l = new Float32Array(n0), r = new Float32Array(n0);
for (let i = 0; i < n0; i++) { const t = i / SR, v = Math.exp(-(t % 1.5) * 2) * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1310 * t)); l[i] = v; r[i] = v * 0.9; }
const mono = l.map((x, i) => (x + r[i]) / 2);

interface Note { id: number; semis: number; at: number; dur: number }
interface Opts { plugins: number; secs: number; gov: boolean; costPerVoice: number; notes: (k: number) => Note[]; costAfter?: { at: number; cost: number } }
function run(o: Opts) {
  new Function('performance', 'Date', WORKLET_SRC)(perf, Date);   // scope baru per skenario (GOV / kolam / daftar plugin bersih)
  const nodes = Array.from({ length: o.plugins }, () => { const n = new Proc(); n.msg({ t: 'buf', ch: [l.slice(), r.slice()], mono: mono.slice(), ons: [0, 72000], rate: SR }); n.msg({ t: 'gov', on: o.gov }); return n; });
  nodes.forEach((n, k) => {
    const ev: any[] = [];
    for (const x of o.notes(k)) { ev.push({ t: 'on', id: x.id, semis: x.semis, start: 0, speed: 1, pitch: 0, vol: 0.9, at: x.at, vel: 1, dur: x.dur }); ev.push({ t: 'off', id: x.id, at: x.at + x.dur }); }
    ev.sort((a, b) => a.at - b.at || (a.t === 'on' ? -1 : 1));
    n.msg({ t: 'sched', ev, sent: 0 });
  });
  T = 0; fake.t = 0;
  const total = Math.ceil(o.secs * SR / BLK), out = new Float32Array(total * BLK), live: number[] = [], cap: number[] = [];
  const blk = [new Float32Array(BLK), new Float32Array(BLK)];
  for (let b = 0; b < total; b++) {
    T = b * BLK / SR;
    const cost = o.costAfter && T >= o.costAfter.at ? o.costAfter.cost : o.costPerVoice;
    blk[0].fill(0); blk[1].fill(0);
    for (const n of nodes) { const orig = n.run; n.run = function (i: any, p: any) { fake.t += this.voices.length * cost; return orig.call(this, i, p); }; n.process([], [blk]); delete n.run; }
    out[b * BLK] = 0; out.set(blk[0], b * BLK);
    live.push(nodes.reduce((s: number, n: any) => s + n.voices.filter((v: any) => !v.fast).length, 0));
    cap.push(nodes[0].gov.cap);
    fake.t += 0.0001;
  }
  return { out, live, cap, nodes };
}
let fail = 0; const ok = (c: boolean, msg: string) => { console.log((c ? 'OK   ' : 'GAGAL ') + msg); if (!c) fail++; };
const maxOf = (a: number[], from = 0, to = a.length) => a.slice(from, to).reduce((m, x) => Math.max(m, x), 0);
const per = (secs: number) => Math.floor(secs * SR / BLK);

// melodi cepat: nada 0,25 s tiap 0,15 s (nada baru mulai selagi nada dan ekor sebelumnya masih bunyi) dengan tinggi berganti, tiap plugin bergeser sedikit
const melody = (k: number): Note[] => Array.from({ length: 90 }, (_, i) => ({ id: k * 1000 + i + 1, semis: [0, 4, 7, 12, 5, 9, 19][(i * 3 + k) % 7], at: 0.2 + i * 0.15 + k * 0.011, dur: 0.25 }));

// (1) beban ringan: governor tidak boleh mengubah apa pun
{
  const a = run({ plugins: 3, secs: 4, gov: true, costPerVoice: 0.01, notes: melody }), b = run({ plugins: 3, secs: 4, gov: false, costPerVoice: 0.01, notes: melody });
  let same = a.out.length === b.out.length; for (let i = 0; same && i < a.out.length; i++) if (a.out[i] !== b.out[i]) same = false;
  ok(same, 'beban ringan: suara dengan governor = tanpa governor (bit-per-bit)');
  ok(maxOf(a.cap) === maxOf(b.cap) && a.cap.every(c => c === a.cap[0]), 'beban ringan: batas nada tidak pernah turun (' + a.cap[0] + ')');
}

// (2) beban berat: 8 plugin, tiap voice memakan 0,12 ms per blok -> 20 voice sudah 90% jatah
const heavy = { plugins: 8, secs: 8, costPerVoice: 0.12, notes: melody };
const on = run({ ...heavy, gov: true }), off = run({ ...heavy, gov: false });
const settle = per(3);
const peakOff = maxOf(off.live, settle), peakOn = maxOf(on.live, settle);
ok(peakOff > 22, 'tanpa governor nada menumpuk (puncak ' + peakOff + ' voice)');
ok(peakOn <= 0.7 * BUD / 0.12 + 6, 'dengan governor jumlah nada dibatasi (puncak ' + peakOn + ', ambang ' + Math.round(0.7 * BUD / 0.12 + 6) + ')');
ok(peakOn < peakOff * 0.7, 'dengan governor puncak jauh lebih rendah (' + peakOn + ' vs ' + peakOff + ')');
let peakMs = 0; { const avg = (live: number[]) => { let s = 0, c = 0; for (let i = settle; i < live.length; i++) { s += live[i] * 0.12 / BUD; c++; } return s / c; }; peakMs = avg(on.live); ok(peakMs < 0.75, 'beban rata-rata setelah governor menyesuaikan: ' + (100 * peakMs).toFixed(0) + '% jatah (tanpa governor ' + (100 * avg(off.live)).toFixed(0) + '%)'); }
const sig = (o: Float32Array) => { let s = 0; for (const x of o) s += x * x; return Math.sqrt(s / o.length); };
ok(sig(on.out) > 0.5 * sig(off.out), 'suara tetap penuh setelah nada dibatasi (RMS ' + sig(on.out).toFixed(3) + ' vs ' + sig(off.out).toFixed(3) + ')');

// (3) nada yang masih ditahan tidak dikorbankan selama batas masih cukup untuk mereka: 2 plugin menahan 2 nada sepanjang tes (4 nada), 6 plugin lain bermelodi
{
  const held = new Set<number>(), notes = (k: number): Note[] => {
    if (k < 2) { const h = [{ id: 9000 + k * 2, semis: 0, at: 0.1, dur: 30 }, { id: 9001 + k * 2, semis: 7, at: 0.1, dur: 30 }]; h.forEach(x => held.add(x.id)); return h; }
    return melody(k).map(x => ({ ...x, dur: 0.12 }));   // nada pendek (tidak tumpang tindih): yang menumpuk hanya EKOR lepasnya (~250 ms), itulah yang harus dibuang lebih dulu
  };
  const res = run({ plugins: 8, secs: 8, gov: true, costPerVoice: 0.09, notes });
  const alive = new Set<number>(); res.nodes.forEach((n: any) => n.voices.forEach((v: any) => { if (!v.rel && !v.fast) alive.add(v.id); }));
  const lost = [...held].filter(id => !alive.has(id));
  ok(lost.length === 0, 'nada ditahan tetap hidup walau governor membuang nada (hilang: ' + lost.length + ' dari ' + held.size + ')');
  ok(res.nodes[0].gov.cap < 48 && res.cap.some(c => c < 48), 'governor memang menurunkan batas di skenario ini (terendah ' + Math.min(...res.cap) + ', akhir ' + res.nodes[0].gov.cap + ')');
}

// (4) beban turun: batas naik lagi
{
  const res = run({ plugins: 8, secs: 14, gov: true, costPerVoice: 0.12, costAfter: { at: 6, cost: 0.002 }, notes: melody });
  const low = Math.min(...res.cap.slice(0, per(6))), end = res.cap[res.cap.length - 1];
  ok(low < 30 && end > low + 10, 'batas turun saat berat (' + low + ') lalu naik lagi saat longgar (' + end + ')');
}

// (5) ekor lepas: habis lebih cepat dari 0,37 s, tanpa klik
{
  const res = run({ plugins: 1, secs: 2, gov: false, costPerVoice: 0.001, notes: () => [{ id: 1, semis: 12, at: 0.2, dur: 0.3 }] });
  const offAt = 0.5; let gone = -1;
  for (let b = per(offAt); b < res.live.length; b++) if (res.nodes[0].voices.length === 0 && res.live[b] === 0) { gone = b * BLK / SR - offAt; break; }
  // ekor diputus saat levelnya < -54 dB (envelope 0,002) lalu dihabiskan 4 ms: seluruh sisa suara setelah titik itu di bawah ~ -54 dBFS, jadi langkah / klik pemutusan tidak mungkin terdengar
  let tailPk = 0; for (let i = Math.floor((offAt + 0.26) * SR); i < res.out.length; i++) tailPk = Math.max(tailPk, Math.abs(res.out[i]));
  ok(gone > 0 && gone < 0.36, 'ekor habis ' + (gone * 1000).toFixed(0) + ' ms setelah nada dilepas (dulu ~370 ms)');
  ok(tailPk < 2e-3, 'setelah ekor diputus sisa suara di bawah -54 dBFS (puncak ' + tailPk.toExponential(1) + ')');
}
process.exit(fail ? 1 : 0);
