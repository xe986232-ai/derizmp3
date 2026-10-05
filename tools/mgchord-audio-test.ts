// Tes suara + mixing MGCHORD: render progression offline, ukur level.  Jalankan: npm i --no-save node-web-audio-api && node tools/mgchord-audio-test.ts [hasil.wav]
// Cek: tidak ada NaN, puncak tidak pernah pecah (< 0.99), tidak terlalu pelan / terlalu keras, akor 5 suara velocity penuh tetap terkendali.
import { writeFileSync } from 'node:fs';
import { buildNotes, defaultVoicing, type Settings, type Slot } from '../src/mgchord-theory.ts';
import { createMaster, pianoTone } from '../src/mgchord-audio.ts';

let wa: typeof import('node-web-audio-api');
try { wa = await import('node-web-audio-api'); } catch { console.log('SKIP node-web-audio-api belum terpasang: npm i --no-save node-web-audio-api'); process.exit(0); }

let fail = 0;
const check = (name: string, ok: boolean, info = ''): void => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); };
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
const SR = 44100;

async function render(notes: { p: number; s: number; l: number; v: number }[], bpm: number, secs: number): Promise<Float32Array[]> {
  const c = new wa.OfflineAudioContext(2, Math.ceil(SR * secs), SR) as unknown as OfflineAudioContext;
  const m = createMaster(c), spb = 60 / bpm;
  for (const n of notes) pianoTone(c, m.input, n.p, 0.05 + n.s * spb, n.l * spb, n.v);
  const buf = await c.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)];
}
function stats(ch: Float32Array[]): { peak: number; rms: number; nan: boolean } {
  let peak = 0, sum = 0, n = 0, nan = false;
  for (const d of ch) for (let i = 0; i < d.length; i++) { const x = d[i]; if (!Number.isFinite(x)) { nan = true; continue; } peak = Math.max(peak, Math.abs(x)); sum += x * x; n++; }
  return { peak, rms: Math.sqrt(sum / n), nan };
}

const st: Settings = { root: 0, scale: 'Minor', octave: 0, chordType: 'Diatonic 9th' };
const slots: Slot[] = [{ deg: 0, beats: 4, root: 0, q: 'Minor' }, { deg: 0, beats: 4, root: 8, q: 'Major' }, { deg: 0, beats: 4, root: 3, q: 'Major' }, { deg: 0, beats: 4, root: 10, q: 'Major' }];
const prog = buildNotes(st, slots, defaultVoicing(), { style: 'Block', rate: 0.5, strum: 0.12 });
const a = await render(prog, 100, 11.5), sa = stats(a);
console.log(`progression Cm-Ab-Eb-Bb: peak ${db(sa.peak).toFixed(1)} dBFS, rms ${db(sa.rms).toFixed(1)} dBFS`);
check('progression: tidak ada NaN', !sa.nan);
check('progression: tidak pecah (peak < 0.99)', sa.peak < 0.99);
check('progression: tidak terlalu pelan (rms > -25 dBFS)', db(sa.rms) > -25);
check('progression: tidak terlalu keras (rms < -16 dBFS)', db(sa.rms) < -16);

const full = [48, 52, 55, 60, 64, 67, 72].map(p => ({ p, s: 0, l: 4, v: 1 }));   // 7 nada sekaligus, velocity penuh = kasus terburuk
const b = await render(full, 100, 6), sb = stats(b);
console.log(`7 nada velocity penuh: peak ${db(sb.peak).toFixed(1)} dBFS, rms ${db(sb.rms).toFixed(1)} dBFS`);
check('kasus terburuk: tidak ada NaN', !sb.nan);
check('kasus terburuk: tidak pecah (peak < 0.99)', sb.peak < 0.99);

const l = a[0], r = a[1]; let diff = 0; for (let i = 0; i < l.length; i++) diff += Math.abs(l[i] - r[i]);
check('stereo: kiri dan kanan tidak identik (panning + reverb)', diff > 1e-3);

const tail = a[0].slice(Math.floor(SR * 11)), st2 = stats([tail]);
check('ekor menghilang (tidak ada bunyi menggantung / dengung)', db(st2.rms) < -55, `rms ekor ${db(st2.rms).toFixed(1)} dBFS`);

if (process.argv[2]) {   // simpan WAV 16-bit stereo untuk didengar
  const n = a[0].length, bytes = Buffer.alloc(44 + n * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + n * 4, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(SR, 24); bytes.writeUInt32LE(SR * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, a[0][i])) * 32767), 44 + i * 4); bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, a[1][i])) * 32767), 46 + i * 4); }
  writeFileSync(process.argv[2], bytes); console.log('WAV ditulis: ' + process.argv[2]);
}
console.log(fail ? `${fail} GAGAL` : 'semua lolos');
process.exit(fail ? 1 : 0);
