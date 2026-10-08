// SPECTRUM GAYA 2: tampilan ranah frekuensi, dipakai spectrum.ts saat Pengaturan > Spectrum > Gaya 2.
//   Kiri  : spectrogram bergulir (waktu ke kiri, frekuensi ke atas dengan skala log, warna = kekerasan)
//   Kanan : analyzer bar bulat dengan penanda puncak yang jatuh pelan + pembacaan frekuensi/nada paling keras
// Hitungan ada di spectrum2-dsp.ts (murni, ada tesnya); file ini hanya menyimpan keadaan dan menggambar.
// Kelas ini tidak menyentuh Web Audio: spectrum.ts yang membaca analyser lalu memanggil update() dengan dB per bin.

import { BandMap, BarDynamics, buildPalette, contrast, loudestPeak, hzToPos, fmtHz, clamp } from './spectrum2-dsp';
import { noteName } from './spectrum-dsp';

export const FFT2 = 8192;           // jendela baca ~170 ms @48 kHz: cukup rapat untuk bass (5,9 Hz per bin)
const SPLIT2 = 0.56;                // porsi lebar untuk spectrogram; sisanya analyzer
const GAP = 12;                     // jarak spectrogram -> analyzer (px CSS)
const PAD_T = 14, PAD_B = 6;        // ruang atas (pembacaan) dan bawah analyzer
const FONT = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
const TICKS: [number, string][] = [[100, '100'], [1000, '1k'], [10000, '10k']];

export class SpectrumStyle2 {
  private pal = buildPalette();
  private sg = document.createElement('canvas');          // spectrogram di resolusi piksel CSS (1 kolom = 1 px), digambar ulang ke kanvas utama
  private sgx = this.sg.getContext('2d', { willReadFrequently: false })!;
  private col: ImageData | null = null;
  private rows = new Float32Array(0); private prevRows = new Float32Array(0); private haveRows = false;
  private rowMap: BandMap | null = null; private barMap: BandMap | null = null;
  private bars = new BarDynamics(0); private target = new Float32Array(0);
  private W = 0; private H = 0; private xs = 0; private sr = 48000; private bins = FFT2 / 2;
  private acc = 0; private readout = ''; private readAge = 99; private readT = 0;

  // ---------- ukuran ----------
  layout(W: number, H: number, sr: number, bins = this.bins): void {
    this.W = W; this.H = H; this.sr = sr; this.bins = bins;
    this.xs = Math.max(8, Math.round(W * SPLIT2) - GAP / 2 | 0);
    const sgW = Math.max(8, this.xs), sgH = Math.max(8, H);
    if (this.sg.width !== sgW || this.sg.height !== sgH) {
      this.sg.width = sgW; this.sg.height = sgH;
      this.col = this.sgx.createImageData(1, sgH);
      this.clearSg();
    }
    if (this.rows.length !== sgH) { this.rows = new Float32Array(sgH); this.prevRows = new Float32Array(sgH); this.haveRows = false; }
    if (!this.rowMap || this.rowMap.n !== sgH || this.rowMap.sr !== sr || this.rowMap.bins !== bins) this.rowMap = new BandMap(sgH, bins, sr, 3);
    const aw = Math.max(0, W - this.xs - GAP - 4), nb = clamp(Math.floor(aw / 7), 16, 56);
    if (!this.barMap || this.barMap.n !== nb || this.barMap.sr !== sr || this.barMap.bins !== bins) this.barMap = new BandMap(nb, bins, sr, 4);
    if (this.target.length !== nb) { this.target = new Float32Array(nb); this.bars.resize(nb); }
  }
  private clearSg(): void {
    const [r, g, b] = [this.pal[0], this.pal[1], this.pal[2]];
    this.sgx.fillStyle = `rgb(${r},${g},${b})`; this.sgx.fillRect(0, 0, this.sg.width, this.sg.height);
  }
  reset(): void {
    this.bars.reset(); this.target.fill(0); this.haveRows = false; this.acc = 0; this.readout = ''; this.readAge = 99;
    if (this.sg.width) this.clearSg();
  }

  // ---------- satu langkah: db = hasil getFloatFrequencyData; pps = px per detik (kecepatan gulir dari Pengaturan) ----------
  update(db: Float32Array, dt: number, pps: number): void {
    const rm = this.rowMap, bm = this.barMap, col = this.col;
    if (!rm || !bm || !col) return;
    // bar
    bm.map(db, this.target); this.bars.update(this.target, dt);
    // spectrogram: geser kiri sebanyak kolom yang jatuh tempo, isi kolom baru di tepi kanan (interpolasi dari frame sebelumnya supaya halus)
    this.prevRows.set(this.rows); rm.map(db, this.rows);
    if (!this.haveRows) { this.prevRows.set(this.rows); this.haveRows = true; }
    this.acc += dt * pps;
    const n = Math.min(Math.floor(this.acc), this.sg.width);
    if (n > 0) {
      this.acc -= Math.floor(this.acc);
      this.sgx.drawImage(this.sg, -n, 0);   // semua piksel opak: sama dengan menyalin; n kolom paling kanan ditimpa di bawah
      const H = this.sg.height, d = col.data, pal = this.pal;
      for (let k = 0; k < n; k++) {
        const t = (k + 1) / n;
        for (let y = 0; y < H; y++) {
          const i = H - 1 - y;   // baris atas = frekuensi tinggi
          const v = contrast(this.prevRows[i] + (this.rows[i] - this.prevRows[i]) * t);
          const p = Math.round(v * 255) * 4, o = y * 4;
          d[o] = pal[p]; d[o + 1] = pal[p + 1]; d[o + 2] = pal[p + 2]; d[o + 3] = 255;
        }
        this.sgx.putImageData(col, this.sg.width - n + k, 0);
      }
    }
    // pembacaan frekuensi terkeras ~8x per detik
    this.readT += dt; this.readAge += dt;
    if (this.readT >= 0.12) {
      this.readT = 0;
      const pk = loudestPeak(db, this.sr);
      if (pk) { const nn = noteName(pk.hz); this.readout = fmtHz(pk.hz) + '  ·  ' + nn.name; this.readAge = 0; }
      else if (this.readAge > 0.5) this.readout = '';
    }
  }

  // ---------- gambar (g sudah diberi setTransform(dpr) oleh pemanggil; koordinat = piksel CSS) ----------
  draw(g: CanvasRenderingContext2D): void {
    const W = this.W, H = this.H, xs = this.xs;
    if (!W || !H) return;
    // spectrogram
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(this.sg, 0, 0, xs, H);
    // garis bantu frekuensi (100 Hz, 1 kHz, 10 kHz) + label kecil
    g.font = FONT; g.textBaseline = 'middle';
    for (const [hz, label] of TICKS) {
      const y = Math.round(H - hzToPos(hz) * H) + 0.5;
      g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(0, y - 0.5, xs, 1);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(label, xs - 4 - g.measureText(label).width, Math.min(H - 6, Math.max(6, y - 6)));
    }
    // tepi kiri spectrogram memudar ("keluar" dari layar)
    g.save(); g.globalCompositeOperation = 'destination-out';
    const fw = Math.min(36, xs * 0.2), fade = g.createLinearGradient(0, 0, fw, 0); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade; g.fillRect(0, 0, fw, H); g.restore();
    // pemisah
    g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(xs + GAP / 2, 6, 1, H - 12);

    // analyzer
    const ax = xs + GAP, aw = W - ax - 4, nb = this.bars.n;
    if (aw < 24 || nb < 1) return;
    const base = H - PAD_B, top = PAD_T, ah = base - top, step = aw / nb, bw = Math.max(2, step * 0.66), r = bw / 2;
    g.fillStyle = 'rgba(255,255,255,.06)';
    for (const q of [0.25, 0.5, 0.75]) g.fillRect(ax, Math.round(base - q * ah), aw, 1);
    const grad = g.createLinearGradient(0, base, 0, top);
    grad.addColorStop(0, '#3a2a8a'); grad.addColorStop(0.45, '#9d86ee'); grad.addColorStop(0.8, '#7ee2f0'); grad.addColorStop(1, '#fffaea');
    g.fillStyle = grad;
    const rr = (g as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number | number[]) => void }).roundRect;
    for (let i = 0; i < nb; i++) {
      const h = Math.max(2, this.bars.level[i] * ah), x = ax + i * step + (step - bw) / 2, y = base - h;
      if (rr && h > bw) { g.beginPath(); rr.call(g, x, y, bw, h, [r, r, 1, 1]); g.fill(); } else g.fillRect(x, y, bw, h);
    }
    // penanda puncak
    g.fillStyle = 'rgba(255,250,234,.9)';
    for (let i = 0; i < nb; i++) {
      const p = this.bars.peak[i]; if (p < 0.02) continue;
      g.fillRect(ax + i * step + (step - bw) / 2, base - p * ah - 3, bw, 1.5);
    }
    // pembacaan frekuensi terkeras
    if (this.readout) {
      g.font = FONT; g.textBaseline = 'top'; g.textAlign = 'right';
      g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText(this.readout, W - 6, 2); g.textAlign = 'left';
    }
  }
}
