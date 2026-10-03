// Tes encoder WAV (Node, tanpa DOM): header benar, sample kembali persis, nilai di atas 1.0 tidak terpotong.
// Pakai:  node tools/wav-test.ts
import { encodeWavFloat } from '../src/wav.ts';

const sr = 44100, n = 1000, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = 1.6 * Math.sin(2 * Math.PI * 440 * i / sr);   // sengaja > 1.0
x[0] = -0.25; x[n - 1] = 0.125;
const ab = encodeWavFloat(x, sr), dv = new DataView(ab);
const tag = (o: number): string => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
let bad = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? 'OK   ' : 'GAGAL') + ' ' + m); if (!c) bad++; };

ok(tag(0) === 'RIFF' && tag(8) === 'WAVE', 'RIFF/WAVE');
ok(dv.getUint32(4, true) === ab.byteLength - 8, 'ukuran RIFF = total - 8');
ok(tag(12) === 'fmt ' && dv.getUint32(16, true) === 18, 'chunk fmt 18 byte');
ok(dv.getUint16(20, true) === 3, 'format 3 (float)');
ok(dv.getUint16(22, true) === 1, 'mono');
ok(dv.getUint32(24, true) === sr && dv.getUint32(28, true) === sr * 4 && dv.getUint16(32, true) === 4 && dv.getUint16(34, true) === 32, 'sample rate / byte rate / block align / 32 bit');
ok(tag(38) === 'fact' && dv.getUint32(46, true) === n, 'chunk fact = jumlah sample');
ok(tag(50) === 'data' && dv.getUint32(54, true) === n * 4, 'chunk data = n * 4 byte');
let maxErr = 0, peak = 0;
for (let i = 0; i < n; i++) { const v = dv.getFloat32(58 + i * 4, true); maxErr = Math.max(maxErr, Math.abs(v - x[i])); peak = Math.max(peak, Math.abs(v)); }
ok(maxErr === 0, 'sample kembali persis (galat ' + maxErr + ')');
ok(peak > 1.5, 'puncak > 1.0 tidak terpotong (puncak ' + peak.toFixed(3) + ')');
ok(ab.byteLength === 58 + n * 4, 'total byte ' + ab.byteLength);
process.exit(bad ? 1 : 0);
