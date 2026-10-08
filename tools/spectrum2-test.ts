// Tes SPECTRUM GAYA 2 (src/spectrum2-dsp.ts): pemetaan pita log, dinamika bar + penanda puncak, frekuensi terkeras, palet.
//   node tools/spectrum2-test.ts
import { BandMap, BarDynamics, loudestPeak, buildPalette, paletteAt, hzToPos, posToHz, dbToLevel, fmtHz, FMIN, FMAX,
  bandEnergies, waveRGB, peakAbs, ampToDb, dbToMeter, LoudnessMeter, correlation, goniometer } from '../src/spectrum2-dsp.ts';

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };

// ---------- FFT radix-2 sederhana: meniru keluaran AnalyserNode.getFloatFrequencyData (jendela Blackman, dB, bin 0..N/2-1) ----------
function spectrumDb(x: Float32Array): Float32Array {
  const N = x.length, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const a = (2 * Math.PI * i) / N; re[i] = x[i] * (0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)); }
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const out = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / N + 1e-12);
  return out;
}
const N = 8192, SR = 48000, BINS = N / 2;
const tone = (hz: number, a = 0.5): Float32Array => { const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / SR); return x; };
const mixT = (...xs: Float32Array[]): Float32Array => { const o = new Float32Array(N); for (const x of xs) for (let i = 0; i < N; i++) o[i] += x[i]; return o; };

// ---------- sumbu log ----------
ok(Math.abs(hzToPos(FMIN)) < 1e-9 && Math.abs(hzToPos(FMAX) - 1) < 1e-9, 'hzToPos: FMIN = 0, FMAX = 1');
ok(Math.abs(posToHz(hzToPos(1234)) - 1234) < 1e-6, 'posToHz kebalikan hzToPos');
ok(hzToPos(1000) > hzToPos(100) && Math.abs((hzToPos(1000) - hzToPos(100)) - (hzToPos(10000) - hzToPos(1000))) < 1e-9, 'skala log: tiap dekade sama lebar');
ok(dbToLevel(-Infinity) === 0 && dbToLevel(NaN) === 0 && dbToLevel(0) === 1 && dbToLevel(-200) === 0, 'dbToLevel: senyap = 0, keras = 1, nilai tak hingga aman');

// ---------- BandMap: nada murni jatuh di pita yang benar ----------
{
  const nb = 48, bm = new BandMap(nb, BINS, SR, 0), out = new Float32Array(nb);
  for (const f of [60, 440, 1000, 5000, 12000]) {
    bm.map(spectrumDb(tone(f)), out);
    let k = 0; for (let i = 1; i < nb; i++) if (out[i] > out[k]) k = i;
    const c = bm.centers[k], lo = posToHz(k / nb), hi = posToHz((k + 1) / nb);
    ok(f >= lo * 0.98 && f <= hi * 1.02, `sinus ${f} Hz -> pita ${k} (${lo.toFixed(0)}..${hi.toFixed(0)} Hz, tengah ${c.toFixed(0)})`);
    ok(out[k] > 0.7, `  tingginya cukup (${out[k].toFixed(2)})`);
  }
  // senyap
  bm.map(new Float32Array(BINS).fill(-Infinity), out);
  ok(out.every(v => v === 0), 'senyap (-Infinity) -> semua pita 0');
  // bass sangat sempit (pita < 1 bin) tetap tidak NaN dan tidak bolong untuk sinus rendah
  const bm2 = new BandMap(200, BINS, SR, 0), o2 = new Float32Array(200);
  bm2.map(spectrumDb(tone(50)), o2);
  ok(o2.every(Number.isFinite) && Math.max(...o2) > 0.7, 'pita bass sangat rapat: tanpa NaN, puncak tetap terlihat');
  // tilt: sisi tinggi diangkat
  const flat = new BandMap(nb, BINS, SR, 0), tilted = new BandMap(nb, BINS, SR, 4), a = new Float32Array(nb), b = new Float32Array(nb);
  const noiseDb = new Float32Array(BINS).fill(-60);
  flat.map(noiseDb, a); tilted.map(noiseDb, b);
  ok(b[nb - 1] > a[nb - 1] && b[0] < a[0], 'tilt +4 dB/oktaf: pita tinggi naik, pita rendah turun');
}

// ---------- BarDynamics ----------
{
  const bd = new BarDynamics(2), t = new Float32Array([1, 0]);
  const dt = 1 / 60;
  for (let i = 0; i < 12; i++) bd.update(t, dt);
  ok(bd.level[0] > 0.85, `naik cepat: 12 frame (200 ms) -> ${bd.level[0].toFixed(2)}`);
  ok(bd.peak[0] >= bd.level[0] - 1e-6, 'penanda puncak >= level');
  t[0] = 0;
  for (let i = 0; i < 20; i++) bd.update(t, dt);   // 330 ms: masih dalam masa tahan (0,5 s) setelah puncak terakhir
  ok(bd.peak[0] > 0.9, `puncak tertahan sesaat setelah level turun (${bd.peak[0].toFixed(2)})`);
  const lvl = bd.level[0];
  ok(lvl < 0.5, `level turun lebih pelan dari naik tapi pasti turun (${lvl.toFixed(2)})`);
  for (let i = 0; i < 180; i++) bd.update(t, dt);   // 3 detik: puncak sudah jatuh
  ok(bd.peak[0] < 0.1, `puncak akhirnya jatuh (${bd.peak[0].toFixed(3)})`);
  ok(bd.peak[0] >= bd.level[0], 'puncak tidak pernah di bawah level');
  const v1 = bd.peak[1]; ok(v1 === 0, 'bar yang tidak pernah naik tetap 0');
  bd.reset(); ok(bd.level[0] === 0 && bd.peak[0] === 0, 'reset membersihkan');
  bd.resize(5); ok(bd.n === 5 && bd.level.length === 5, 'resize mengubah jumlah bar');
}

// ---------- frekuensi terkeras ----------
{
  for (const f of [82.4, 440, 1234.5, 3000]) {
    const pk = loudestPeak(spectrumDb(tone(f)), SR);
    ok(!!pk && Math.abs(pk.hz - f) < Math.max(1.5, f * 0.004), `loudestPeak sinus ${f} Hz -> ${pk ? pk.hz.toFixed(2) : 'null'}`);
  }
  const two = loudestPeak(spectrumDb(mixT(tone(300, 0.2), tone(2000, 0.5))), SR);
  ok(!!two && Math.abs(two.hz - 2000) < 8, `dua nada: yang lebih keras menang (${two ? two.hz.toFixed(1) : 'null'})`);
  ok(loudestPeak(new Float32Array(BINS).fill(-Infinity), SR) === null, 'senyap -> null');
  ok(loudestPeak(spectrumDb(tone(440, 0.0001)), SR) === null, 'sangat pelan (di bawah ambang) -> null');
}

// ---------- palet ----------
{
  const pal = buildPalette();
  ok(pal.length === 256 * 4, 'palet 256 warna RGBA');
  let mono = true, prev = -1;
  for (let i = 0; i < 256; i++) { const lum = 0.2126 * pal[i * 4] + 0.7152 * pal[i * 4 + 1] + 0.0722 * pal[i * 4 + 2]; if (lum < prev - 1.5) mono = false; prev = lum; }
  ok(mono, 'kecerahan palet naik (nilai keras = terang)');
  ok(pal[0] === 14 && pal[1] === 14 && pal[2] === 20, 'warna 0 = latar panel (#0e0e14), spectrogram menyatu dengan strip');
  ok(pal[255 * 4 + 3] === 255 && pal[3] === 255, 'semua warna opak');
  const mid = paletteAt(0.64);
  ok(Math.abs(mid[0] - 179) < 1 && Math.abs(mid[1] - 161) < 1 && Math.abs(mid[2] - 247) < 1, 'titik 0,64 = lavender aksen aplikasi (#b3a1f7)');
}

// ---------- Waveform multi-band: warna mengikuti isi frekuensi ----------
{
  const e = { low: 0, mid: 0, high: 0 };
  bandEnergies(spectrumDb(tone(100)), SR, e);
  ok(e.low > e.mid && e.low > e.high, `sinus 100 Hz -> rentang rendah dominan (${e.low.toFixed(2)} / ${e.mid.toFixed(2)} / ${e.high.toFixed(2)})`);
  bandEnergies(spectrumDb(tone(1000)), SR, e);
  ok(e.mid > e.low && e.mid > e.high, 'sinus 1 kHz -> menengah dominan');
  bandEnergies(spectrumDb(tone(9000)), SR, e);
  ok(e.high > e.low && e.high > e.mid, 'sinus 9 kHz -> tinggi dominan');
  const lo = waveRGB({ low: 1, mid: 0.05, high: 0.05 }), hi = waveRGB({ low: 0.05, mid: 0.05, high: 1 });
  ok(lo[0] > 220 && hi[2] > 200 && hi[0] < 150, 'warna: rendah condong koral, tinggi condong cyan');
  const sil = waveRGB({ low: 0, mid: 0, high: 0 });
  ok(sil[0] === 179 && sil[1] === 161, 'senyap -> warna lavender (tidak NaN)');
  bandEnergies(new Float32Array(BINS).fill(-Infinity), SR, e);
  ok(e.low === 0 && e.mid === 0 && e.high === 0, 'senyap -> energi 0');
}

// ---------- Peak ----------
{
  const x = new Float32Array(1000); x[900] = -0.5; x[100] = 0.9;
  ok(Math.abs(peakAbs(x, 200) - 0.5) < 1e-6 && Math.abs(peakAbs(x, 1000) - 0.9) < 1e-6, 'peakAbs hanya melihat n sampel terakhir');
  ok(Math.abs(ampToDb(1)) < 1e-9 && Math.abs(ampToDb(0.5) + 6.0206) < 1e-3 && ampToDb(0) === -120, 'ampToDb');
  ok(dbToMeter(0) === 1 && dbToMeter(-60) === 0 && dbToMeter(-30) === 0.5 && dbToMeter(-200) === 0, 'dbToMeter: -60..0 dBFS -> 0..1');
}

// ---------- LUFS (BS.1770) ----------
{
  const run = (sr: number, f: number, aL: number, aR: number, sec = 1): number => {
    const m = new LoudnessMeter(sr), n = Math.floor(sr * sec), l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { const s = Math.sin((2 * Math.PI * f * i) / sr); l[i] = aL * s; r[i] = aR * s; }
    m.push(l, r, n); return m.momentary;
  };
  const full = run(48000, 997, 1, 1);
  const one = run(48000, 997, 1, 0);
  ok(Math.abs(one - -3.01) < 0.15, `acuan BS.1770: 997 Hz skala penuh di SATU kanal = -3,01 LUFS (didapat ${one.toFixed(2)})`);
  ok(Math.abs(full) < 0.15, `997 Hz skala penuh di kedua kanal = 0,0 LUFS (didapat ${full.toFixed(2)})`);
  ok(Math.abs(run(48000, 997, 0.1, 0.1) - (full - 20)) < 0.1, '-20 dB amplitudo = -20 LUFS (linear)');
  ok(Math.abs(run(44100, 997, 1, 1) - full) < 0.1, 'konsisten di 44,1 kHz');
  ok(Math.abs(one - (full - 3.01)) < 0.1, 'satu kanal saja = 3 dB lebih pelan dari dua kanal');
  ok(run(48000, 20, 1, 1) < run(48000, 997, 1, 1) - 10, 'high-pass K-weighting: 20 Hz jauh lebih pelan dari 997 Hz');
  ok(run(48000, 8000, 1, 1) > full + 2, 'high-shelf K-weighting: 8 kHz lebih keras terukur dari 997 Hz');
  ok(run(48000, 997, 0, 0) === -Infinity, 'senyap = -Infinity');
  const m = new LoudnessMeter(48000); ok(m.momentary === -Infinity, 'belum ada data = -Infinity');
}

// ---------- Stereometer ----------
{
  const n = 2048, l = new Float32Array(n), r = new Float32Array(n), r2 = new Float32Array(n), r3 = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = Math.sin(i * 0.05); r[i] = l[i]; r2[i] = -l[i]; r3[i] = Math.sin(i * 0.05 + Math.PI / 2); }
  ok(correlation(l, r, n) > 0.999, 'korelasi mono sempurna = +1');
  ok(correlation(l, r2, n) < -0.999, 'korelasi berlawanan fase = -1');
  ok(Math.abs(correlation(l, r3, n)) < 0.05, 'korelasi beda fase 90° = ~0');
  ok(correlation(new Float32Array(n), new Float32Array(n), n) === 0, 'senyap = 0');
  const xs = new Float32Array(256), ys = new Float32Array(256);
  let k = goniometer(l, r, n, xs, ys);
  let maxX = 0; for (let i = 0; i < k; i++) maxX = Math.max(maxX, Math.abs(xs[i]));
  ok(k === 256 && maxX < 1e-6, 'sinyal mono: semua titik di sumbu tengah (x = 0)');
  k = goniometer(l, r2, n, xs, ys);
  let maxY = 0; for (let i = 0; i < k; i++) maxY = Math.max(maxY, Math.abs(ys[i]));
  ok(maxY < 1e-6, 'sinyal berlawanan fase: semua titik di sumbu samping (y = 0)');
  ok(goniometer(l, r, 100, xs, ys) === 100, 'jumlah titik dibatasi n bila n < kapasitas');
}

ok(fmtHz(440) === '440 Hz' && fmtHz(1234) === '1.23 kHz' && fmtHz(12500) === '12.5 kHz', 'fmtHz');

console.log(fail ? `\n${fail} tes GAGAL` : '\nSemua tes lulus');
process.exit(fail ? 1 : 0);
