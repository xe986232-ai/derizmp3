// SPECTRUM: plugin gelombang suara langsung (scope). Membaca keluaran master (persis yang terdengar), jadi apa pun yang diputar ikut tergambar.
//   Kiri  : riwayat amplitudo yang bergulir (isi solid lavender tanpa outline, ekor pluck meluruh halus)
//   Kanan : gelombang NYATA beberapa siklus terakhir, dikunci ke periode nada (nada rendah = lebar, tinggi = rapat) dan dikunci fase supaya diam di layar
// Semua hitungan ada di spectrum-dsp.ts (murni, ada tesnya: tools/spectrum-test.ts); file ini hanya jendela + menggambar.
// Kartunya ada di halaman Plugin pada panel efek (fx-rack.ts). Tampil sebagai strip solid selebar layar yang menempel di dasar (tanpa bingkai); tidak modal, jadi Space / pintasan DAW tetap jalan.

import { PitchDetector, PitchTracker, TraceBuilder, Envelope, AutoGain, shape, rmsDb, noteName, clamp } from './spectrum-dsp';

export interface SpectrumBridge { tap(): AudioNode | null }   // titik ambil audio: keluaran master (guardOut di main.ts)
let bridge: SpectrumBridge | null = null;
export const setSpectrumBridge = (b: SpectrumBridge): void => { bridge = b; };

const svg = (inner: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON_CLOSE = svg('<path d="M6 6l12 12M18 6L6 18"/>', 12);

const FFT = 4096;                 // jendela baca ~85 ms: cukup untuk 2 siklus nada 25 Hz
const SPLIT = 0.6;                // bagian kiri (riwayat) = 60% lebar, sisanya scope langsung
const STEP = 0.5;                 // jarak titik gambar riwayat (px CSS): halus di layar HP beresolusi tinggi
const SPEEDS = [{ k: 'slow', label: 'Lambat', pps: 90 }, { k: 'mid', label: 'Normal', pps: 170 }, { k: 'fast', label: 'Cepat', pps: 320 }];   // px per detik
const SPEED_KEY = 'derizmp3.spectrum.speed';
const FILL = '#b3a1f7', OUTLINE = '#f4f0ff';   // riwayat = isi solid tanpa outline; scope langsung = garis saja tanpa isi (tanpa gradasi / glow)

let root: HTMLElement | null = null, openFn: (() => void) | null = null;
export function openSpectrum(): void { if (!root) build(); openFn?.(); }

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'spec'; el.hidden = true;
  el.innerHTML =
    '<div class="spec__win is-off" role="dialog" aria-label="SPECTRUM" tabindex="-1">' +
      '<div class="spec__stage"><canvas class="spec__cv" role="img" aria-label="Gelombang suara langsung dari keluaran master"></canvas></div>' +
      '<div class="spec__ui"><span class="spec__stat" role="status"></span>' +
        '<div class="spec__bar" role="group" aria-label="Kecepatan gulir riwayat">' +
          SPEEDS.map(s => `<button type="button" class="spec__spd" data-k="${s.k}" aria-pressed="false">${s.label}</button>`).join('') + '</div>' +
        `<button type="button" class="spec__close" aria-label="Tutup SPECTRUM">${ICON_CLOSE}</button></div>` +
    '</div>';
  document.body.appendChild(el);
  root = el;

  const win = el.querySelector<HTMLElement>('.spec__win')!;
  const stat = el.querySelector<HTMLElement>('.spec__stat')!;
  const stage = el.querySelector<HTMLElement>('.spec__stage')!;
  const cv = el.querySelector<HTMLCanvasElement>('.spec__cv')!;
  const g = cv.getContext('2d')!;
  const spdBtns = [...el.querySelectorAll<HTMLButtonElement>('.spec__spd')];

  // ---------- kecepatan gulir (diingat) ----------
  let speed = 1;
  try { const k = localStorage.getItem(SPEED_KEY), i = SPEEDS.findIndex(s => s.k === k); if (i >= 0) speed = i; } catch { /* penyimpanan diblokir: bawaan Normal */ }
  const syncSpeed = (): void => spdBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === speed)));
  syncSpeed();
  for (const b of spdBtns) b.addEventListener('click', () => {
    speed = SPEEDS.findIndex(s => s.k === b.dataset.k); syncSpeed(); b.blur();   // blur: Space tetap untuk play / jeda DAW
    try { localStorage.setItem(SPEED_KEY, SPEEDS[speed].k); } catch { /* abaikan */ }
  });

  // ---------- audio: analyser di keluaran master ----------
  let ctx: BaseAudioContext | null = null, an: AnalyserNode | null = null, mute: GainNode | null = null, tapNode: AudioNode | null = null;
  const buf = new Float32Array(FFT);
  let sr = 48000;
  let env = new Envelope(sr), det = new PitchDetector(FFT), trk = new PitchTracker(), tb = new TraceBuilder(FFT, 64);
  const gainH = new AutoGain(6), gainL = new AutoGain(1.2, 0.02);   // riwayat: turun lambat (6 s); scope: lebih cepat menyesuaikan (1,2 s)
  let trace = new Float32Array(64), prevTrace = new Float32Array(64), traceOk = false;
  let clk = 0, lastClk = 0, carry = 0, lastPitch = 0, silentSince = 0, lvl = -120, lcdAt = 0;

  function connect(): boolean {
    const src = bridge?.tap() ?? null;
    if (!src) return false;
    ctx = src.context;
    if (!an || an.context !== ctx) {
      an = ctx.createAnalyser(); an.fftSize = FFT; an.smoothingTimeConstant = 0;
      mute = ctx.createGain(); mute.gain.value = 0; an.connect(mute); mute.connect(ctx.destination);   // sambungan senyap: beberapa browser baru memproses node yang tersambung ke output
    }
    if (sr !== ctx.sampleRate) { sr = ctx.sampleRate; env = new Envelope(sr); }
    try { src.connect(an); tapNode = src; } catch { return false; }
    return true;
  }
  function disconnect(): void {
    if (tapNode && an) { try { tapNode.disconnect(an); } catch { /* sudah lepas */ } }
    tapNode = null;
  }
  function resetState(): void {
    env.clear(); gainH.reset(); gainL.reset(); trk.reset(); prevTrace.fill(0); trace.fill(0); traceOk = false;
    carry = 0; lastPitch = 0; silentSince = performance.now(); lvl = -120;
    clk = lastClk = ctx ? ctx.currentTime : 0;
  }

  // ---------- ukuran kanvas ----------
  let W = 0, H = 0, dpr = 1, tops = new Float32Array(0), bots = new Float32Array(0), rts = new Float32Array(0);
  function layout(): void {
    dpr = Math.min(3, devicePixelRatio || 1);
    W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const xs = Math.round(W * SPLIT), m = clamp(Math.round((W - xs) / 1.5), 48, 400);
    if (trace.length !== m) { trace = new Float32Array(m); prevTrace = new Float32Array(m); tb = new TraceBuilder(FFT, m); traceOk = false; }
    const np = Math.ceil(xs / STEP) + 1;
    if (tops.length !== np) { tops = new Float32Array(np); bots = new Float32Array(np); rts = new Float32Array(np); }
    if (!el.hidden) draw();
  }
  const ro = new ResizeObserver(() => { if (!el.hidden) layout(); });
  ro.observe(stage);

  // ---------- gambar ----------
  function draw(): void {
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const mid = H / 2, amp = H / 2 - 7, xs = Math.round(W * SPLIT), live = W - xs, np = tops.length;
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, Math.round(mid), W, 1);

    // riwayat: posisi kolom ke-i = xs - (frac + i) * pxPerCol; kolom yang sedang terisi ada di x = xs, jadi geseran halus sampai ke sub-piksel
    const pxCol = SPEEDS[speed].pps * env.binSec, frac = env.frac, sc = gainH.scale;
    for (let p = 0; p < np; p++) {
      const x = Math.min(xs, p * STEP), b = (xs - x) / pxCol;
      let v: number, r: number;
      if (b < frac) { const u = frac > 0 ? b / frac : 0; v = env.partial + (env.at(0) - env.partial) * u; r = env.partialRms + (env.rmsAt(0) - env.partialRms) * u; }
      else { v = env.cubic(b - frac); r = env.cubic(b - frac, true); }
      const a = shape(v * sc), ar = Math.min(a, shape(r * sc * 1.5));
      tops[p] = a; rts[p] = ar;
    }
    for (let p = 0; p < np; p++) { const a = Math.max(tops[p], 0.004); bots[p] = mid + a * amp; tops[p] = mid - a * amp; }
    // riwayat: isi solid satu warna saja, tanpa outline (sama seperti referensi); tanpa gradasi, inti, atau glow
    g.fillStyle = FILL;
    g.beginPath(); g.moveTo(0, mid);
    for (let p = 0; p < np; p++) g.lineTo(Math.min(xs, p * STEP), tops[p]);
    for (let p = np - 1; p >= 0; p--) g.lineTo(Math.min(xs, p * STEP), bots[p]);
    g.closePath(); g.fill();
    // tepi kiri memudar (gelombang "keluar" dari layar)
    g.save(); g.globalCompositeOperation = 'destination-out';
    const fade = g.createLinearGradient(0, 0, Math.min(36, xs * 0.2), 0); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade; g.fillRect(0, 0, Math.min(36, xs * 0.2), H); g.restore();

    // scope langsung: titik-titik trace dari zero-crossing naik, jumlah siklus mengikuti nada
    const m = trace.length;
    if (traceOk && live > 8) {
      const ls = gainL.scale, k = 1 / (m - 1);
      // scope langsung: hanya garis (tanpa isi)
      g.beginPath();
      for (let i = 0; i < m; i++) { const y = mid - clamp(trace[i] * ls, -1, 1) * amp * 0.96; if (i) g.lineTo(xs + i * k * live, y); else g.moveTo(xs, y); }
      g.lineJoin = 'round'; g.lineWidth = 1.5; g.strokeStyle = OUTLINE; g.stroke();
    }
    // petunjuk saat tidak ada suara
    const idle = silentSince ? performance.now() - silentSince : 0;
    if (idle > 1500) {
      g.globalAlpha = clamp((idle - 1500) / 600, 0, 1);
      g.fillStyle = 'rgba(205,195,255,.75)'; g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('Putar lagu untuk melihat gelombangnya', W / 2, mid - 20); g.globalAlpha = 1; g.textAlign = 'start';
    }
  }

  // ---------- satu frame ----------
  let raf = 0, lastTs = 0;
  function frame(ts: number): void {
    raf = requestAnimationFrame(frame);
    const dt = clamp((ts - lastTs) / 1000, 0.001, 0.1); lastTs = ts;
    if (an && ctx) {
      an.getFloatTimeDomainData(buf);
      // jam halus: maju mengikuti rAF, dikoreksi pelan ke jam audio (currentTime naik per blok besar, kalau dipakai langsung gulirannya patah-patah)
      if (ctx.state !== 'running') { lastClk = clk = ctx.currentTime; carry = 0; }
      else {
        clk += dt; clk += (ctx.currentTime - clk) * 0.05;
        if (Math.abs(ctx.currentTime - clk) > 0.25) clk = ctx.currentTime;
        const total = Math.max(0, (clk - lastClk) * sr + carry); lastClk = clk;
        const n = Math.min(Math.floor(total), FFT); carry = total - Math.floor(total);
        if (n > 0) env.push(buf, n);
        gainH.update(env.lastPeak, dt);
      }
      lvl = rmsDb(buf, 1024);
      if (lvl > -70) silentSince = 0; else if (silentSince === 0) silentSince = performance.now();   // 0 = sedang ada suara; selain itu = kapan mulai senyap
      if (ts - lastPitch >= 40) { trk.update(det.detect(buf, sr)); lastPitch = ts; }
      const info = tb.build(buf, trk.period, sr, trace, traceOk ? prevTrace : null);
      traceOk = !info.silent;
      gainL.update(info.peak, dt);
      prevTrace.set(trace);
    }
    draw();
    if (ts - lcdAt > 130) {
      lcdAt = ts;
      const silent = lvl <= -70, hz = trk.hz(sr);
      win.classList.toggle('is-off', silent);
      if (silent) stat.textContent = 'Senyap';
      else if (hz > 0) { const n = noteName(hz); stat.textContent = n.name + ' · ' + hz.toFixed(1) + ' Hz · ' + Math.round(lvl) + ' dB'; }
      else stat.textContent = 'Tanpa nada jelas · ' + Math.round(lvl) + ' dB';
    }
  }
  const start = (): void => { cancelAnimationFrame(raf); lastTs = performance.now(); raf = requestAnimationFrame(frame); };
  const stop = (): void => { cancelAnimationFrame(raf); raf = 0; };

  // ---------- buka / tutup ----------
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });   // pintasan lain (Space = play / jeda) tetap sampai ke DAW
  el.querySelector('.spec__close')!.addEventListener('click', () => close());
  function close(): void {
    stop(); disconnect();
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    win.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false;
    connect(); resetState(); layout(); start();
    stat.textContent = 'Senyap';
    if (!reduce) win.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
  document.addEventListener('visibilitychange', () => { if (!el.hidden) { if (document.hidden) stop(); else { resetState(); start(); } } });
}
