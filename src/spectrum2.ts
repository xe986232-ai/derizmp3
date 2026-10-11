// SPECTRUM GAYA 2: deretan modul berdampingan, dipakai spectrum.ts saat Pengaturan > Spectrum > Gaya 2.
// Modul (kiri ke kanan; yang tidak muat di layar sempit dibuang menurut prioritas):
//   Spectrogram | Waveform multi-band | Peak/LUFS | Stereometer | Oscilloscope | Spectrum Analyzer
//   - Spectrogram    : frekuensi (skala log) terhadap waktu, bergulir; warna = kekerasan
//   - Waveform       : riwayat amplitudo bergulir, tiap kolom diwarnai isi frekuensinya (rendah = koral, menengah = lavender, tinggi = cyan)
//   - Peak/LUFS      : puncak L/R dengan penahan + LUFS momentari (K-weighting, BS.1770)
//   - Stereometer    : lissajous (diputar 45°) berjejak halus + batang korelasi fase
//   - Oscilloscope   : bentuk gelombang nyata beberapa siklus terakhir, terkunci fase (hasil TraceBuilder milik spectrum.ts)
//   - Analyzer       : bar bulat berpenanda puncak jatuh + pembacaan frekuensi/nada terkeras
// Hitungan ada di spectrum2-dsp.ts (murni, ada tesnya). Kelas ini tidak menyentuh Web Audio: spectrum.ts membaca analyser lalu memanggil update().

import {
  BandMap, BarDynamics, buildPalette, contrast, loudestPeak, hzToPos, fmtHz, clamp,
  bandEnergies, waveRGB, peakAbs, ampToDb, dbToMeter, LoudnessMeter, correlation, goniometer,
  type BandEnergy,
} from './spectrum2-dsp';
import { noteName, AutoGain, shape } from './spectrum-dsp';
import { isFlat, isFlatDark } from './ui-theme';

// Warna strip Spectrum per tema. Tema default = indigo/lavender neon di latar gelap (nilai lama, tidak diubah); tema Flat = palet gambar referensi di latar krem (lavender, oranye, teal, hijau/kuning meter, magenta, teks #343536).
export interface SpecColors {
  flat: boolean; ink: (a: number) => string; fill: string; outline: string; hot: string; cool: string; hold: string; dot: string; peakLine: string; scope: string;
  meter: [number, string][]; areaFill: [number, string][]; areaLine: [number, string][];
}
const DEF_COLORS: SpecColors = {
  flat: false, ink: a => `rgba(255,255,255,${a})`, fill: '#b3a1f7', outline: '#f4f0ff', hot: '#ff6b81', cool: '#7ee2f0', hold: 'rgba(255,250,234,.95)', dot: 'rgba(179,161,247,.55)', peakLine: 'rgba(255,250,234,.32)', scope: '#f4f0ff',
  meter: [[0, '#3a2a8a'], [0.62, '#9d86ee'], [0.86, '#7ee2f0'], [1, '#ff6b81']],
  areaFill: [[0, 'rgba(58,42,138,.10)'], [0.5, 'rgba(157,134,238,.45)'], [0.85, 'rgba(126,226,240,.70)'], [1, 'rgba(255,250,234,.85)']],
  areaLine: [[0, '#6a55d0'], [0.5, '#b3a1f7'], [0.85, '#7ee2f0'], [1, '#fffaea']],
};
const FLAT_COLORS: SpecColors = {
  flat: true, ink: a => `rgba(52,53,54,${Math.min(1, a * 1.6).toFixed(3)})`, fill: '#B98AD0', outline: '#8F8F8F', hot: '#D85A94', cool: '#5B9F9A', hold: '#343536', dot: 'rgba(141,112,168,.6)', peakLine: 'rgba(52,53,54,.35)', scope: '#8F8F8F',
  meter: [[0, '#79B86A'], [0.7, '#79B86A'], [0.88, '#E5C65A'], [1, '#F5A044']],
  areaFill: [[0, 'rgba(141,112,168,.12)'], [0.5, 'rgba(185,138,208,.55)'], [0.85, 'rgba(245,160,68,.70)'], [1, 'rgba(217,130,50,.85)']],
  areaLine: [[0, '#8D70A8'], [0.5, '#B98AD0'], [0.85, '#F5A044'], [1, '#D98232']],
};
// Flat Style 2 (UI gelap): tinta terang (#E7E9EE), meter hijau -> kuning -> oranye, area lavender -> oranye. Sama dengan palet FLAT_COLS['2'] di ui-theme.ts.
const FLAT_DARK_COLORS: SpecColors = {
  flat: true, ink: a => `rgba(231,233,238,${Math.min(1, a).toFixed(3)})`, fill: '#B98AD0', outline: '#98A0AE', hot: '#FF6B9D', cool: '#3DBDB4', hold: '#E7E9EE', dot: 'rgba(185,138,208,.55)', peakLine: 'rgba(231,233,238,.32)', scope: '#B98AD0',
  meter: [[0, '#5FCF80'], [0.7, '#5FCF80'], [0.88, '#F0C64E'], [1, '#F5A044']],
  areaFill: [[0, 'rgba(141,112,168,.10)'], [0.5, 'rgba(185,138,208,.45)'], [0.85, 'rgba(245,160,68,.65)'], [1, 'rgba(255,196,122,.85)']],
  areaLine: [[0, '#8D70A8'], [0.5, '#B98AD0'], [0.85, '#F5A044'], [1, '#FFC47A']],
};
const flatNow = (): boolean => { try { return isFlat(); } catch { return false; } };   // aman di lingkungan tanpa document.documentElement (tes Node)
const flatDarkNow = (): boolean => { try { return isFlatDark(); } catch { return false; } };
export const specColors = (): SpecColors => flatDarkNow() ? FLAT_DARK_COLORS : flatNow() ? FLAT_COLORS : DEF_COLORS;
let C: SpecColors = DEF_COLORS;   // diperbarui di awal draw()

export const FFT2 = 8192;           // analyser frekuensi: jendela ~170 ms @48 kHz, bass rapat (5,9 Hz per bin)
const GAP = 10;                     // jarak antar modul (px CSS); garis pemisah di tengahnya
const PAD_B = 6;
const FONT = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
const FONT_BIG = '700 12px "Plus Jakarta Sans", system-ui, sans-serif';
const TICKS: [number, string][] = [[100, '100'], [1000, '1k'], [10000, '10k']];
const PTS = 640;                    // titik lissajous per frame

type Kind = 'sgram' | 'wave' | 'level' | 'stereo' | 'scope' | 'bars';
interface Def { k: Kind; w: number; min: number }
// urutan tampil; w = bobot lebar, min = lebar minimum (px CSS)
const DEFS: Def[] = [
  { k: 'sgram', w: 3.0, min: 110 }, { k: 'wave', w: 2.4, min: 96 }, { k: 'level', w: 0.9, min: 50 },
  { k: 'stereo', w: 1.3, min: 72 }, { k: 'scope', w: 1.9, min: 90 }, { k: 'bars', w: 3.2, min: 130 },
];
const PRIORITY: Kind[] = ['bars', 'sgram', 'wave', 'level', 'scope', 'stereo'];   // urutan dipertahankan saat layar sempit
interface Rect { k: Kind; x: number; w: number }

export interface S2Input {
  db: Float32Array;                 // dB per bin (analyser frekuensi, FFT2 / 2 bin)
  mono: Float32Array;               // domain waktu (campuran mono), sampel terbaru di ujung
  l: Float32Array; r: Float32Array; // domain waktu per kanal
  sr: number;
  newSamples: number;               // perkiraan sampel baru sejak frame lalu (dt * sr)
  trace: Float32Array; traceOk: boolean; traceScale: number;   // scope terkunci fase dari spectrum.ts
}

export class SpectrumStyle2 {
  private pal = buildPalette();
  private flatPal = false;      // true = palet spectrogram Flat terang (Style 1); Style 2 (gelap) memakai palet gelap bawaan
  private flatBands = false;    // warna waveform multi-band versi Flat (oranye / lavender / teal), berlaku untuk semua style Flat
  private themeKey = 'd';
  private rects: Rect[] = [];
  private W = 0; private H = 0; private sr = 48000; private bins = FFT2 / 2;
  // spectrogram
  private sg = document.createElement('canvas'); private sgx = this.sg.getContext('2d')!;
  private col: ImageData | null = null; private rows = new Float32Array(0); private prevRows = new Float32Array(0); private haveRows = false;
  private rowMap: BandMap | null = null; private sgAcc = 0;
  // waveform
  private wAmp = new Float32Array(0); private wRms = new Float32Array(0); private wRgb = new Uint8Array(0); private wHead = 0; private wAcc = 0; private wLast = 0; private wLastR = 0;
  private wGain = new AutoGain(6); private wEnergy: BandEnergy = { low: 0, mid: 0, high: 0 }; private wCol: [number, number, number] = [179, 161, 247];
  private wColS: [number, number, number] = [179, 161, 247];
  // peak / LUFS
  private lm: LoudnessMeter | null = null;
  private pkL = 0; private pkR = 0; private holdL = 0; private holdR = 0; private holdTL = 0; private holdTR = 0; private lufs = -Infinity; private lufsT = 0;
  // stereometer
  private st = document.createElement('canvas'); private stx = this.st.getContext('2d')!;
  private gx = new Float32Array(PTS); private gy = new Float32Array(PTS); private gn = 0; private corr = 0; private corrS = 0; private gGain = new AutoGain(1.5, 0.05);
  // scope
  private scope: { trace: Float32Array; ok: boolean; scale: number } = { trace: new Float32Array(0), ok: false, scale: 1 };
  // analyzer
  private barMap: BandMap | null = null; private bars = new BarDynamics(0); private target = new Float32Array(0);
  private readout = ''; private readAge = 99; private readT = 0;

  // ---------- tata letak ----------
  layout(W: number, H: number, sr: number, bins = this.bins): void {
    this.W = W; this.H = H; this.sr = sr; this.bins = bins;
    // pilih modul yang muat menurut prioritas, lalu bagi lebar menurut bobot (stereometer dibatasi mendekati persegi)
    const chosen = new Set<Kind>(); let used = 0;
    for (const k of PRIORITY) { const d = DEFS.find(x => x.k === k)!; const need = d.min + (chosen.size ? GAP : 0); if (used + need <= W) { chosen.add(k); used += need; } }
    const list = DEFS.filter(d => chosen.has(d.k)), free = W - GAP * Math.max(0, list.length - 1);
    // tiap modul mulai dari lebar minimum; sisa ruang dibagi menurut bobot (stereometer dibatasi mendekati persegi, kelebihannya dibagi ke yang lain)
    const alloc = new Map<Kind, number>(); for (const d of list) alloc.set(d.k, d.min);
    let rem = free - list.reduce((a, d) => a + d.min, 0), active = list.slice();
    for (let it = 0; it < 3 && rem > 0.5 && active.length; it++) {
      const ws = active.reduce((a, d) => a + d.w, 0), next: Def[] = []; let used = 0;
      for (const d of active) {
        const cur = alloc.get(d.k)!, cap = d.k === 'stereo' ? Math.max(d.min, H * 1.15) : Infinity;
        let add = rem * d.w / ws;
        if (cur + add > cap) add = Math.max(0, cap - cur); else next.push(d);
        alloc.set(d.k, cur + add); used += add;
      }
      rem -= used; active = next;
    }
    let x = 0; this.rects = [];
    list.forEach((d, i) => {
      const last = i === list.length - 1, w = last ? Math.max(d.min, Math.round(W - x)) : Math.floor(alloc.get(d.k)!);   // bulatkan ke bawah; modul terakhir menyerap sisa sampai tepi kanan
      this.rects.push({ k: d.k, x, w }); x += w + GAP;
    });
    this.prepare();
  }
  private rect(k: Kind): Rect | undefined { return this.rects.find(r => r.k === k); }
  private prepare(): void {
    const H = Math.max(8, Math.round(this.H));
    const sg = this.rect('sgram');
    if (sg) {
      const w = Math.max(8, sg.w);
      if (this.sg.width !== w || this.sg.height !== H) { this.sg.width = w; this.sg.height = H; this.col = this.sgx.createImageData(1, H); this.clearSg(); }
      if (this.rows.length !== H) { this.rows = new Float32Array(H); this.prevRows = new Float32Array(H); this.haveRows = false; }
      if (!this.rowMap || this.rowMap.n !== H || this.rowMap.sr !== this.sr || this.rowMap.bins !== this.bins) this.rowMap = new BandMap(H, this.bins, this.sr, 3);
    }
    const wv = this.rect('wave');
    if (wv) { const w = Math.max(8, wv.w); if (this.wAmp.length !== w) { this.wAmp = new Float32Array(w); this.wRms = new Float32Array(w); this.wRgb = new Uint8Array(w * 3); this.wHead = 0; } }
    const sm = this.rect('stereo');
    if (sm) { if (this.st.width !== sm.w || this.st.height !== H) { this.st.width = sm.w; this.st.height = H; } }
    const br = this.rect('bars');
    if (br) {
      const nb = clamp(Math.round(br.w / 3), 40, 140);
      if (!this.barMap || this.barMap.n !== nb || this.barMap.sr !== this.sr || this.barMap.bins !== this.bins) this.barMap = new BandMap(nb, this.bins, this.sr, 4);
      if (this.target.length !== nb) { this.target = new Float32Array(nb); this.bars.resize(nb); }
    }
    if (!this.lm || this.lmSr !== this.sr) { this.lm = new LoudnessMeter(this.sr); this.lmSr = this.sr; }
  }
  private lmSr = 0;
  // ganti tema (default <-> Flat): bangun ulang palet spectrogram, warna waveform multi-band kembali ke lavender tema itu, dan spectrogram dibersihkan
  applyTheme(): void {
    const f = flatNow(), dark = flatDarkNow(), key = f ? (dark ? 'fd' : 'f') : 'd'; if (key === this.themeKey) return;
    this.themeKey = key; this.flatBands = f; this.flatPal = f && !dark; this.pal = buildPalette(this.flatPal);
    const m: [number, number, number] = f ? [185, 138, 208] : [179, 161, 247]; this.wCol = [m[0], m[1], m[2]]; this.wColS = [m[0], m[1], m[2]];
    if (this.sg.width) this.clearSg();
  }
  private clearSg(): void { this.sgx.fillStyle = `rgb(${this.pal[0]},${this.pal[1]},${this.pal[2]})`; this.sgx.fillRect(0, 0, this.sg.width, this.sg.height); }

  reset(): void {
    this.applyTheme();
    this.bars.reset(); this.target.fill(0); this.haveRows = false; this.sgAcc = 0; this.readout = ''; this.readAge = 99;
    if (this.sg.width) this.clearSg();
    this.wAmp.fill(0); this.wRms.fill(0); this.wHead = 0; this.wAcc = 0; this.wLast = 0; this.wLastR = 0; this.wGain.reset();
    this.lm?.reset(); this.pkL = this.pkR = this.holdL = this.holdR = 0; this.lufs = -Infinity;
    this.gn = 0; this.corr = this.corrS = 0; this.gGain.reset(); if (this.st.width) this.stx.clearRect(0, 0, this.st.width, this.st.height);
  }

  // ---------- satu langkah (dipanggil tiap frame) ----------
  update(inp: S2Input, dt: number, pps: number): void {
    this.scope.trace = inp.trace; this.scope.ok = inp.traceOk; this.scope.scale = inp.traceScale;
    const n = clamp(Math.round(inp.newSamples), 1, inp.mono.length);

    // analyzer
    if (this.barMap) { this.barMap.map(inp.db, this.target); this.bars.update(this.target, dt); }
    const rd = this.rect('bars');
    this.readT += dt; this.readAge += dt;
    if (rd && this.readT >= 0.12) {
      this.readT = 0;
      const pk = loudestPeak(inp.db, inp.sr);
      if (pk) { this.readout = fmtHz(pk.hz) + '  ·  ' + noteName(pk.hz).name; this.readAge = 0; } else if (this.readAge > 0.5) this.readout = '';
    }

    // spectrogram
    if (this.rowMap && this.col) {
      this.prevRows.set(this.rows); this.rowMap.map(inp.db, this.rows);
      if (!this.haveRows) { this.prevRows.set(this.rows); this.haveRows = true; }
      this.sgAcc += dt * pps;
      const k = Math.min(Math.floor(this.sgAcc), this.sg.width);
      if (k > 0) {
        this.sgAcc -= Math.floor(this.sgAcc);
        this.sgx.drawImage(this.sg, -k, 0);   // semua piksel opak: sama dengan menyalin; k kolom paling kanan ditimpa di bawah
        const H = this.sg.height, d = this.col.data, pal = this.pal;
        for (let c = 0; c < k; c++) {
          const t = (c + 1) / k;
          for (let y = 0; y < H; y++) {
            const i = H - 1 - y, v = contrast(this.prevRows[i] + (this.rows[i] - this.prevRows[i]) * t), p = Math.round(v * 255) * 4, o = y * 4;
            d[o] = pal[p]; d[o + 1] = pal[p + 1]; d[o + 2] = pal[p + 2]; d[o + 3] = 255;
          }
          this.sgx.putImageData(this.col, this.sg.width - k + c, 0);
        }
      }
    }

    // waveform multi-band: satu kolom per px. Tiap kolom = puncak (selubung) + RMS (badan); nilai diinterpolasi dari frame lalu ke frame ini
    // supaya tidak bertangga, dan warnanya dari energi frekuensi (dihaluskan)
    if (this.wAmp.length) {
      const pk = peakAbs(inp.mono, n);
      let sq = 0; for (let i = Math.max(0, inp.mono.length - n); i < inp.mono.length; i++) sq += inp.mono[i] * inp.mono[i];
      const rms = Math.sqrt(sq / n);
      this.wGain.update(pk, dt);
      bandEnergies(inp.db, inp.sr, this.wEnergy); waveRGB(this.wEnergy, this.wCol, this.flatBands);
      const ks = 1 - Math.exp(-dt / 0.08); for (let i = 0; i < 3; i++) this.wColS[i] += (this.wCol[i] - this.wColS[i]) * ks;
      const curPk = Math.max(pk, this.wLast * Math.exp(-dt / 0.07)), curRms = Math.max(rms, this.wLastR * Math.exp(-dt / 0.1));   // naik seketika, turun halus
      this.wAcc += dt * pps;
      const k = Math.min(Math.floor(this.wAcc), this.wAmp.length);
      if (k > 0) {
        this.wAcc -= Math.floor(this.wAcc);
        for (let c = 0; c < k; c++) {
          const t = (c + 1) / k, i = this.wHead;
          this.wAmp[i] = this.wLast + (curPk - this.wLast) * t; this.wRms[i] = this.wLastR + (curRms - this.wLastR) * t;
          this.wRgb[i * 3] = this.wColS[0]; this.wRgb[i * 3 + 1] = this.wColS[1]; this.wRgb[i * 3 + 2] = this.wColS[2];
          this.wHead = (this.wHead + 1) % this.wAmp.length;
        }
        this.wLast = curPk; this.wLastR = curRms;
      }
    }

    // peak + LUFS
    this.pkL = peakAbs(inp.l, n); this.pkR = peakAbs(inp.r, n);
    const dL = ampToDb(this.pkL), dR = ampToDb(this.pkR);
    this.holdTL -= dt; this.holdTR -= dt;
    if (dL >= this.holdL) { this.holdL = dL; this.holdTL = 1.2; } else if (this.holdTL <= 0) this.holdL = Math.max(dL, this.holdL - 20 * dt);
    if (dR >= this.holdR) { this.holdR = dR; this.holdTR = 1.2; } else if (this.holdTR <= 0) this.holdR = Math.max(dR, this.holdR - 20 * dt);
    if (this.lm) { this.lm.push(inp.l, inp.r, n); this.lufsT += dt; if (this.lufsT >= 0.1) { this.lufsT = 0; this.lufs = this.lm.momentary; } }

    // stereometer
    if (this.rect('stereo')) {
      this.gn = goniometer(inp.l, inp.r, Math.min(inp.l.length, Math.max(n, 512)), this.gx, this.gy);
      let pk2 = 0; for (let i = 0; i < this.gn; i++) { const a = Math.max(Math.abs(this.gx[i]), Math.abs(this.gy[i])); if (a > pk2) pk2 = a; }
      this.gGain.update(pk2, dt);
      const c = correlation(inp.l, inp.r, 1024); this.corrS += (c - this.corrS) * (1 - Math.exp(-dt / 0.15)); this.corr = this.corrS;
    }
  }

  // ---------- gambar (g sudah diberi setTransform(dpr) oleh pemanggil; koordinat = piksel CSS) ----------
  draw(g: CanvasRenderingContext2D): void {
    const H = this.H; if (!this.W || !H) return;
    C = specColors();
    g.save();
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      g.save(); g.beginPath(); g.rect(r.x, 0, r.w, H); g.clip(); g.translate(r.x, 0);
      switch (r.k) {
        case 'sgram': this.drawSgram(g, r.w, H); break;
        case 'wave': this.drawWave(g, r.w, H); break;
        case 'level': this.drawLevel(g, r.w, H); break;
        case 'stereo': this.drawStereo(g, r.w, H); break;
        case 'scope': this.drawScope(g, r.w, H); break;
        case 'bars': this.drawBars(g, r.w, H); break;
      }
      g.restore();
      if (i < this.rects.length - 1) { g.fillStyle = C.ink(.10); g.fillRect(r.x + r.w + GAP / 2, 6, 1, H - 12); }
    }
    g.restore();
  }

  private drawSgram(g: CanvasRenderingContext2D, w: number, H: number): void {
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(this.sg, 0, 0, w, H);
    g.font = FONT; g.textBaseline = 'middle';
    for (const [hz, label] of TICKS) {
      const y = Math.round(H - hzToPos(hz) * H) + 0.5;
      g.fillStyle = C.ink(.10); g.fillRect(0, y - 0.5, w, 1);
      g.fillStyle = C.ink(.45); g.fillText(label, w - 4 - g.measureText(label).width, Math.min(H - 6, Math.max(6, y - 6)));
    }
    g.save(); g.globalCompositeOperation = 'destination-out';   // tepi kiri memudar ("keluar" dari layar)
    const fw = Math.min(30, w * 0.2), fade = g.createLinearGradient(0, 0, fw, 0); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade; g.fillRect(0, 0, fw, H); g.restore();
  }

  private drawWave(g: CanvasRenderingContext2D, w: number, H: number): void {
    const len = this.wAmp.length; if (!len) return;
    const mid = H / 2, amp = H / 2 - 5, sc = this.wGain.scale, fw = Math.min(28, w * 0.2);
    g.fillStyle = C.ink(.07); g.fillRect(0, Math.round(mid), w, 1);
    const off = Math.max(0, len - w);   // kolom lebih lama dari lebar modul tidak digambar
    for (let x = 0; x < Math.min(w, len); x++) {
      const i = (this.wHead + off + x) % len, fade = x < fw ? x / fw : 1;
      const h1 = Math.max(0.6, shape(this.wAmp[i] * sc) * amp), h2 = Math.min(h1, Math.max(0.5, shape(this.wRms[i] * sc * 1.25) * amp));
      const rgb = `${this.wRgb[i * 3]},${this.wRgb[i * 3 + 1]},${this.wRgb[i * 3 + 2]}`;
      g.fillStyle = `rgba(${rgb},${0.30 * fade})`; g.fillRect(x, mid - h1, 1, h1 * 2);   // selubung puncak: tipis, transparan
      g.fillStyle = `rgba(${rgb},${0.95 * fade})`; g.fillRect(x, mid - h2, 1, h2 * 2);   // badan RMS: pekat
    }
  }

  private drawLevel(g: CanvasRenderingContext2D, w: number, H: number): void {
    const cx = w / 2, dL = ampToDb(this.pkL), dR = ampToDb(this.pkR), compact = H < 100;
    const val = Number.isFinite(this.lufs) ? this.lufs.toFixed(1) : '−∞';
    g.textBaseline = 'top';
    let top: number;
    if (compact) {   // strip rendah (sama tinggi dengan Gaya 1): satu baris "−8.0 LU", batang di bawahnya
      g.font = FONT_BIG; const wn = g.measureText(val).width; g.font = FONT; const wu = g.measureText('LU').width, x0 = cx - (wn + 3 + wu) / 2;
      g.textAlign = 'left'; g.font = FONT_BIG; g.fillStyle = C.ink(.92); g.fillText(val, x0, 2);
      g.font = FONT; g.fillStyle = C.ink(.45); g.fillText('LU', x0 + wn + 3, 5);
      top = 19;
    } else {
      g.textAlign = 'center';
      g.font = FONT; g.fillStyle = C.ink(.45); g.fillText('LUFS', cx, 3);
      g.font = FONT_BIG; g.fillStyle = C.ink(.92); g.fillText(val, cx, 13);
      const pkMax = Math.max(this.holdL, this.holdR);
      g.font = FONT; g.fillStyle = pkMax > -1 ? C.hot : C.ink(.55); g.fillText('pk ' + (pkMax > -100 ? pkMax.toFixed(1) : '−∞'), cx, 29);
      top = 44;
    }
    g.textAlign = 'left';
    const base = H - PAD_B, ah = base - top; if (ah < 10) return;
    const bw = clamp(Math.floor((w - 24) / 2), 6, 14), gp = 5, x0 = Math.round(cx - bw - gp / 2);
    const grad = g.createLinearGradient(0, base, 0, top);
    for (const [o, col] of C.meter) grad.addColorStop(o, col);
    for (let c = 0; c < 2; c++) {
      const x = x0 + c * (bw + gp), lv = dbToMeter(c ? dR : dL), hd = dbToMeter(c ? this.holdR : this.holdL);
      g.fillStyle = C.ink(.07); g.fillRect(x, top, bw, ah);
      g.fillStyle = grad; g.fillRect(x, base - lv * ah, bw, lv * ah);
      if (hd > 0.01) { g.fillStyle = C.hold; g.fillRect(x, base - hd * ah - 1, bw, 1.5); }
    }
    g.fillStyle = C.ink(.18); for (const db of [-6, -18, -36]) g.fillRect(x0 - 4, Math.round(base - dbToMeter(db) * ah), 2 * bw + gp + 8, 1);   // garis bantu -6 / -18 / -36 dBFS
  }

  private drawStereo(g: CanvasRenderingContext2D, w: number, H: number): void {
    const corrH = 8, areaH = H - corrH - 6, R = Math.max(10, Math.min(w / 2 - 4, areaH / 2)), cx = w / 2, cy = 4 + areaH / 2;
    // bingkai: belah ketupat (sumbu L/R diputar 45°) + sumbu tengah
    g.strokeStyle = C.ink(.12); g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx + R, cy); g.lineTo(cx, cy + R); g.lineTo(cx - R, cy); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke();
    // titik berjejak: kanvas khusus yang dipudarkan tiap frame
    const sx = this.stx, sw = this.st.width, sh = this.st.height;
    if (sw && sh) {
      sx.save(); sx.globalCompositeOperation = 'destination-out'; sx.fillStyle = 'rgba(0,0,0,.28)'; sx.fillRect(0, 0, sw, sh); sx.restore();
      const k = R * this.gGain.scale;   // gGain.scale = 0.92 / puncak: titik terjauh ~92% jari-jari
      sx.save(); sx.globalCompositeOperation = 'lighter'; sx.fillStyle = C.dot;
      for (let i = 0; i < this.gn; i++) {
        const x = cx + clamp(this.gx[i] * k, -R, R), y = cy - clamp(this.gy[i] * k, -R, R);
        sx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
      sx.restore();
      g.drawImage(this.st, 0, 0, sw, sh);
    }
    // batang korelasi fase: -1 (kiri) .. 0 .. +1 (kanan)
    const bx = 6, bw = w - 12, by = H - PAD_B - corrH / 2 - 1;
    g.fillStyle = C.ink(.10); g.fillRect(bx, by - 1.5, bw, 3);
    g.fillStyle = C.ink(.25); g.fillRect(bx + bw / 2 - 0.5, by - 4, 1, 8);
    const mx = bx + (this.corr * 0.5 + 0.5) * bw;
    g.fillStyle = this.corr < -0.1 ? C.hot : C.cool; g.fillRect(mx - 1.5, by - 4, 3, 8);
  }

  private drawScope(g: CanvasRenderingContext2D, w: number, H: number): void {
    const mid = H / 2, amp = H / 2 - 7, t = this.scope.trace, m = t.length;
    g.fillStyle = C.ink(.07); g.fillRect(0, Math.round(mid), w, 1);
    if (!this.scope.ok || m < 2) return;
    g.beginPath();
    for (let i = 0; i < m; i++) { const x = (i / (m - 1)) * (w - 2) + 1, y = mid - clamp(t[i] * this.scope.scale, -1, 1) * amp * 0.96; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.lineJoin = 'round'; g.lineWidth = 1.5; g.strokeStyle = C.scope; g.stroke();
  }

  // kurva area halus (Catmull-Rom) dengan gradasi, garis tipis di tepi atas, dan garis puncak redup; sumbu frekuensi log
  private drawBars(g: CanvasRenderingContext2D, w: number, H: number): void {
    const nb = this.bars.n; if (nb < 2) return;
    const top = 14, base = H - PAD_B, ah = base - top, dx = w / nb;
    g.fillStyle = C.ink(.06);
    for (const q of [0.33, 0.66]) g.fillRect(0, Math.round(base - q * ah), w, 1);
    g.font = FONT; g.textBaseline = 'alphabetic';
    for (const [hz, label] of TICKS) {   // garis vertikal tipis + label di tepi bawah
      const x = Math.round(hzToPos(hz) * w) + 0.5;
      g.fillStyle = C.ink(.07); g.fillRect(x - 0.5, top, 1, ah);
      g.fillStyle = C.ink(.35); g.fillText(label, x + 3, base - 2);
    }
    const curve = (arr: Float32Array, closeDown: boolean): void => {
      const X = (i: number): number => (i + 0.5) * dx, Y = (i: number): number => base - clamp(arr[clamp(i, 0, nb - 1)], 0, 1) * ah;
      g.beginPath();
      if (closeDown) { g.moveTo(0, base); g.lineTo(0, Y(0)); } else g.moveTo(X(0), Y(0));
      for (let i = 0; i < nb - 1; i++) {
        const x0 = X(i - 1), y0 = Y(i - 1), x1 = X(i), y1 = Y(i), x2 = X(i + 1), y2 = Y(i + 1), x3 = X(i + 2), y3 = Y(i + 2);
        g.bezierCurveTo(x1 + (x2 - x0) / 6, Math.min(base, y1 + (y2 - y0) / 6), x2 - (x3 - x1) / 6, Math.min(base, y2 - (y3 - y1) / 6), x2, y2);
      }
      if (closeDown) { g.lineTo(w, Y(nb - 1)); g.lineTo(w, base); g.closePath(); }
    };
    const fill = g.createLinearGradient(0, base, 0, top);
    for (const [o, col] of C.areaFill) fill.addColorStop(o, col);
    curve(this.bars.level, true); g.fillStyle = fill; g.fill();
    const line = g.createLinearGradient(0, base, 0, top);
    for (const [o, col] of C.areaLine) line.addColorStop(o, col);
    curve(this.bars.level, false); g.lineJoin = 'round'; g.lineWidth = 1.4; g.strokeStyle = line; g.stroke();
    curve(this.bars.peak, false); g.lineWidth = 1; g.strokeStyle = C.peakLine; g.stroke();   // garis puncak redup (penahan + jatuh)
    if (this.readout) { g.font = FONT; g.textBaseline = 'top'; g.textAlign = 'right'; g.fillStyle = C.ink(.7); g.fillText(this.readout, w - 6, 2); g.textAlign = 'left'; }
  }
}

