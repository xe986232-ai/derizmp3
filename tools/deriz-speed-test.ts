// Tes rentang Speed DERIZ (0.25× - 4×): node --experimental-transform-types tools/deriz-speed-test.ts
// (1) Skala knob <-> kecepatan: tengah 1×, ujung 0.25× / 4×, bolak-balik konsisten.
// (2) Worklet menghasilkan suara bersih (tanpa NaN, tidak senyap) di 0.25×, 1×, 4×, dan sample yang dimainkan makin lama makin pendek / panjang sesuai Speed.
import { WORKLET_SRC } from '../src/deriz-synth.ts';
import { derizSpeed, derizSpeedKnob, derizSpeedFromV1, SPEED_MIN, SPEED_MAX } from '../src/deriz-speed.ts';
let bad = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'GAGAL ') + m); if (!c) bad++; };

ok(Math.abs(derizSpeed(0.5) - 1) < 1e-9 && Math.abs(derizSpeed(0) - SPEED_MIN) < 1e-9 && Math.abs(derizSpeed(1) - SPEED_MAX) < 1e-9, 'knob: tengah 1x, kiri ' + SPEED_MIN + 'x, kanan ' + SPEED_MAX + 'x');
ok([0, 0.1, 0.37, 0.5, 0.8, 1].every(v => Math.abs(derizSpeedKnob(derizSpeed(v)) - v) < 1e-9), 'knob <-> kecepatan bolak-balik konsisten');
ok(derizSpeedKnob(100) === 1 && derizSpeedKnob(0.001) === 0, 'di luar rentang berhenti di batas');
// project lama (rentang 0.5x - 2x): kecepatan yang sama setelah dikonversi
ok([0, 0.25, 0.5, 0.75, 1].every(o => Math.abs(derizSpeed(derizSpeedFromV1(o)) - 2 ** ((o - 0.5) * 2)) < 1e-9), 'konversi project lama mempertahankan kecepatan');

const SR = 48000, BLK = 128;
let T = 0;
Object.defineProperty(globalThis, 'currentTime', { get: () => T, configurable: true });
(globalThis as any).sampleRate = SR;
let Proc: any;
(globalThis as any).AudioWorkletProcessor = class { port = { postMessage: () => {}, onmessage: null as any }; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function('performance', 'Date', WORKLET_SRC)(performance, Date);

const n0 = SR * 4, l = new Float32Array(n0);
for (let i = 0; i < n0; i++) { const t = i / SR; l[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) * (t < 3 ? 1 : 0); }   // nada 220 Hz selama 3 detik, lalu senyap
function render(speed: number): { peak: number; nan: boolean; lastSound: number } {
  const n = new Proc(); T = 0;
  n.msg({ t: 'buf', ch: [l.slice(), l.slice()], mono: l.slice(), ons: [0], rate: SR });
  n.msg({ t: 'on', id: 1, semis: 0, start: 0, speed, pitch: 0, vol: 0.9, at: 0.05, vel: 1 });
  const out = [new Float32Array(BLK), new Float32Array(BLK)];
  let peak = 0, nan = false, last = 0;
  for (let b = 0; b < Math.ceil(SR * 14 / BLK); b++) {
    out[0].fill(0); out[1].fill(0);
    n.process([], [out], {});
    for (let i = 0; i < BLK; i++) { const v = out[0][i]; if (!Number.isFinite(v)) nan = true; const a = Math.abs(v); if (a > peak) peak = a; if (a > 0.02) last = T + i / SR; }
    T += BLK / SR;
  }
  return { peak, nan, lastSound: last };
}
const r1 = render(1), rs = render(SPEED_MIN), rf = render(SPEED_MAX);
for (const [nm, r] of [['1x', r1], [SPEED_MIN + 'x', rs], [SPEED_MAX + 'x', rf]] as const) ok(!r.nan && r.peak > 0.1 && r.peak < 2, nm + ': ada suara, tanpa NaN (puncak ' + r.peak.toFixed(2) + ', suara terakhir ' + r.lastSound.toFixed(2) + ' s)');
ok(rf.lastSound < r1.lastSound * 0.5, SPEED_MAX + 'x selesai jauh lebih cepat dari 1x');
ok(rs.lastSound > r1.lastSound * 2, SPEED_MIN + 'x berlangsung jauh lebih lama dari 1x');
console.log(bad ? bad + ' tes gagal' : 'semua lulus'); process.exit(bad ? 1 : 0);
