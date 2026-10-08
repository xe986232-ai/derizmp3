// Tes asap SPECTRUM GAYA 2 (src/spectrum2.ts) tanpa browser: kanvas palsu mencatat panggilan, lalu layout / update / draw dijalankan di berbagai lebar layar.
//   node tools/spectrum2-layout-test.ts
import { register } from 'node:module';
// spectrum2.ts mengimpor './spectrum2-dsp' tanpa ekstensi (gaya Vite); hook kecil ini menambah ".ts" supaya Node bisa memuatnya
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.'))return n(s+'.ts',c);throw e}}`));

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };

// ---------- kanvas palsu ----------
const calls: Record<string, number> = {};
const mkCtx = (): unknown => new Proxy({}, {
  get(t: Record<string, unknown>, k: string) {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (k === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    if (k in t) return t[k];
    return (..._a: unknown[]) => { calls[k] = (calls[k] || 0) + 1; };
  },
  set(t: Record<string, unknown>, k: string, v: unknown) { t[k] = v; return true; },
});
(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkCtx() }) };

const { SpectrumStyle2, FFT2 } = await import('../src/spectrum2.ts') as typeof import('../src/spectrum2');

const SR = 48000, BINS = FFT2 / 2;
const db = new Float32Array(BINS).fill(-100);
for (let k = 0; k < BINS; k++) { const hz = (k * SR) / FFT2; db[k] = -30 - 20 * Math.log10(1 + hz / 200); }   // spektrum miring seperti musik
db[Math.round(440 / (SR / FFT2))] = -12;
const N = 4096, mono = new Float32Array(N), l = new Float32Array(2048), r = new Float32Array(2048), trace = new Float32Array(160);
for (let i = 0; i < N; i++) mono[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
for (let i = 0; i < 2048; i++) { l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR); r[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR + 0.5); }
for (let i = 0; i < trace.length; i++) trace[i] = 0.5 * Math.sin((i / trace.length) * 2 * Math.PI * 3);

const mins: Record<string, number> = { sgram: 110, wave: 96, level: 50, stereo: 72, scope: 90, bars: 130 };
for (const [W, H] of [[260, 64], [320, 64], [420, 64], [568, 64], [700, 64], [844, 64], [888, 64], [1000, 100], [1400, 100], [700, 120]] as [number, number][]) {
  const s = new SpectrumStyle2();
  let err = '';
  try {
    s.layout(W, H, SR, BINS);
    const rects = (s as unknown as { rects: { k: string; x: number; w: number }[] }).rects;
    ok(rects.length >= 1, `W=${W} H=${H}: ada modul (${rects.map(r => r.k).join(', ')})`);
    ok(rects.some(r => r.k === 'bars') || W < 130, `  analyzer selalu dipertahankan saat muat`);
    let prevEnd = -Infinity, good = true;
    for (const r of rects) { if (r.x < prevEnd || r.x < 0 || r.x + r.w > W + 1 || r.w < mins[r.k] - 1) good = false; prevEnd = r.x + r.w; }
    ok(good, `  tanpa tumpang tindih, di dalam layar, lebar >= minimum`);
    const st = rects.find(r => r.k === 'stereo'); if (st) ok(st.w <= Math.max(72, H * 1.15) + 1, `  stereometer tidak terlalu lebar (${st.w}px)`);
    if (W >= 888) ok(rects.length === 6, `  layar lebar: keenam modul tampil`);
    // jalankan 90 frame (1,5 detik) + gambar
    const g = mkCtx() as CanvasRenderingContext2D;
    for (let f = 0; f < 90; f++) { s.update({ db, mono, l, r, sr: SR, newSamples: 800, trace, traceOk: true, traceScale: 1 }, 1 / 60, 170); s.draw(g); }
    const sx = s as unknown as { lufs: number; corr: number; bars: { level: Float32Array; peak: Float32Array }; wAmp: Float32Array; holdL: number };
    if (rects.some(r => r.k === 'level')) ok(Number.isFinite(sx.lufs) && sx.lufs > -20 && sx.lufs < 0, `  LUFS terukur masuk akal (${sx.lufs.toFixed(1)})`);
    if (st) ok(sx.corr > 0.5 && sx.corr <= 1, `  korelasi kanal yang mirip positif (${sx.corr.toFixed(2)})`);
    ok(sx.bars.level.every(Number.isFinite) && Math.max(...sx.bars.level) > 0.3, `  bar analyzer bergerak (maks ${Math.max(...sx.bars.level).toFixed(2)})`);
    if (rects.some(r => r.k === 'wave')) ok(Math.max(...sx.wAmp) > 0.4, `  waveform terisi (maks ${Math.max(...sx.wAmp).toFixed(2)})`);
    s.reset(); s.draw(g);
  } catch (e) { err = String((e as Error).stack || e); }
  ok(err === '', `W=${W} H=${H}: layout/update/draw/reset tanpa error${err ? '\n' + err : ''}`);
}

// ubah ukuran berulang kali + sample rate lain tidak boleh error
{
  const s = new SpectrumStyle2(); let err = '';
  try {
    const g = mkCtx() as CanvasRenderingContext2D;
    for (const [W, sr] of [[900, 48000], [300, 44100], [1200, 96000], [640, 48000]] as [number, number][]) {
      const H = 64;
      s.layout(W, H, sr, BINS); for (let f = 0; f < 10; f++) { s.update({ db, mono, l, r, sr, newSamples: 700, trace, traceOk: false, traceScale: 1 }, 1 / 60, 90); s.draw(g); }
    }
  } catch (e) { err = String((e as Error).stack || e); }
  ok(err === '', `ganti ukuran + sample rate berulang tanpa error${err ? '\n' + err : ''}`);
}
console.log('panggilan gambar terbanyak:', Object.entries(calls).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + '×' + v).join(', '));
console.log(fail ? `\n${fail} tes GAGAL` : '\nSemua tes lulus');
process.exit(fail ? 1 : 0);
