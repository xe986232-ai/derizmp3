// Tes jadwal lengkap DERIZ (pesan 'sched'): node --experimental-transform-types tools/deriz-sched-test.ts
// (1) Pesan 'sched' yang tiba tepat waktu menghasilkan suara BIT-PER-BIT sama dengan jalur lama (pesan on / off per nada).
// (2) Pesan 'sched' yang tiba telat: nada telat tetap dimainkan dengan panjang aslinya (off ikut bergeser), tidak menumpuk, yang telat > panjangnya dilewati.
import { WORKLET_SRC } from '../src/deriz-synth.ts';
const SR = 48000, BLK = 128;
let T = 0;
Object.defineProperty(globalThis, 'currentTime', { get: () => T, configurable: true });
(globalThis as any).sampleRate = SR;
let Proc: any;
(globalThis as any).AudioWorkletProcessor = class { port = { postMessage: () => {}, onmessage: null as any }; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function('performance', 'Date', WORKLET_SRC)(performance, Date);

const n0 = SR * 3, l = new Float32Array(n0), r = new Float32Array(n0);
for (let i = 0; i < n0; i++) { const t = i / SR, v = Math.exp(-(t % 1.5) * 2) * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1310 * t)); l[i] = v; r[i] = v * 0.9; }
const mono = l.map((x, i) => (x + r[i]) / 2);
const mk = () => { const n = new Proc(); n.msg({ t: 'buf', ch: [l.slice(), r.slice()], mono: mono.slice(), ons: [0, 72000], rate: SR }); return n; };

const notes = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, semis: [0, 4, 7, 12, 5, 9][i % 6], at: 0.2 + i * 0.125, dur: 0.3 }));
function run(mode: 'old' | 'sched', deliverAt = 0): { out: Float32Array; log: Array<[string, number, number]> } {
  const node = mk(); T = 0;
  const log: Array<[string, number, number]> = [], ap = node.apply.bind(node);
  node.apply = (m: any) => { log.push([m.t, m.id, T]); ap(m); };
  const send = () => {
    if (mode === 'old') for (const n of notes) { node.msg({ t: 'on', id: n.id, semis: n.semis, start: 0, speed: 1, pitch: 0, vol: 0.9, at: n.at, vel: 1 }); node.msg({ t: 'off', id: n.id, at: n.at + n.dur }); }
    else {
      const ev: any[] = [];
      for (const n of notes) { ev.push({ t: 'on', id: n.id, semis: n.semis, start: 0, speed: 1, pitch: 0, vol: 0.9, at: n.at, vel: 1, dur: n.dur }); ev.push({ t: 'off', id: n.id, at: n.at + n.dur }); }
      ev.sort((a, b) => a.at - b.at || (a.t === 'on' ? -1 : 1));
      node.msg({ t: 'sched', ev, sent: 0 });
    }
  };
  const total = Math.ceil(4 * SR / BLK), out = new Float32Array(total * BLK); let sent = false;
  for (let b = 0; b < total; b++) {
    T = b * BLK / SR;
    if (!sent && T >= deliverAt) { send(); sent = true; }
    const o = [new Float32Array(BLK), new Float32Array(BLK)];
    node.process([], [o]); out.set(o[0], b * BLK);
  }
  return { out, log };
}

let fail = 0; const ok = (c: boolean, msg: string) => { console.log((c ? 'OK   ' : 'GAGAL ') + msg); if (!c) fail++; };
const a = run('old'), b = run('sched');
let same = a.out.length === b.out.length; for (let i = 0; same && i < a.out.length; i++) if (a.out[i] !== b.out[i]) same = false;
ok(same, 'tepat waktu: suara sched = suara jalur lama (bit-per-bit)');

const late = run('sched', 1.0);   // jadwal baru tiba di detik 1,0: nada di 0,2..0,95 sudah lewat
const ons = late.log.filter(e => e[0] === 'on'), offs = new Map(late.log.filter(e => e[0] === 'off').map(e => [e[1], e[2]]));
const skipped = notes.filter(n => !ons.some(e => e[1] === n.id));
ok(skipped.length === notes.filter(n => 1.0 - n.at >= n.dur).length, 'telat >= panjang nada: dilewati (' + skipped.length + ' nada)');
let lenOk = true, pile = 0;
for (const e of ons) { const n = notes[e[1] - 1], dur = (offs.get(e[1]) ?? 99) - e[2]; if (Math.abs(dur - n.dur) > 0.006) lenOk = false; if (e[2] - n.at > 0.006 && e[2] - n.at < n.dur) pile++; }
ok(lenOk, 'nada telat tetap berbunyi selama panjang aslinya (off ikut bergeser)');
ok(ons.every(e => e[2] >= notes[e[1] - 1].at - 0.003), 'tidak ada nada mulai sebelum waktunya');
console.log('nada telat yang tetap dimainkan:', pile, '| nada tepat waktu setelah itu:', ons.length - pile);
const cut = run('sched', 0.0); let peak = 0; for (const x of cut.out) peak = Math.max(peak, Math.abs(x));
ok(peak > 0.05, 'ada suara (puncak ' + peak.toFixed(2) + ')');
process.exit(fail ? 1 : 0);
