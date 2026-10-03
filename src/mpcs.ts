// MPCS (Manual Pitch Correct Sample): jendela editor pitch ala Melodyne, bergaya plugin DERIZ (faceplate logam 3D). Tahap 1 (starter):
//   upload audio -> analisis di Worker -> blok nada di piano roll -> seret blok ke atas / bawah (snap semiton) -> knob Trans / Variation / Center -> putar hasil.
// Tombol buka sengaja tidak ada di daftar efek: jendela hanya terbuka lewat ketukan beruntun pada judul panel "Effects".
// Inti DSP ada di mpcs-dsp.ts (murni), jalan di mpcs-worker.ts.

import { ACCEPT as AUDIO_ACCEPT, isAudio } from './audio-upload-card';
import { DEFAULT_CONTROLS, shiftCurve, snapTargets, toMono, type Controls, type Note, type PitchTrack } from './mpcs-dsp';

const svg = (inner: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  up: svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>', 16),
  play: svg('<path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/>', 22),
  pause: svg('<rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>', 22),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 12)
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const noteName = (m: number): string => { const r = Math.round(m); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const fmtShift = (s: number): string => { const c = Math.round(s * 100); return (c > 0 ? '+' : '') + (Math.abs(c) % 100 === 0 ? c / 100 + ' st' : c + ' ct'); };

// Tiga knob global ala NewTone. Markup & kelas sama dengan knob efek (fx-rack.ts) supaya gayanya menyatu dengan DAW.
const knobSvg = '<svg viewBox="0 0 36 36" aria-hidden="true" class="circular-chart">' +
  '<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dasharray="75, 100" class="circle-bg" style="transform-origin:18px 18px;transform:rotate(225deg)"></path>' +
  '<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dashoffset="0" stroke-dasharray="0 100" class="circle primary-theme" style="transform:rotate(225deg)"></path>' +
  '<path d="M18 5.142857142857142 a 12.857142857142858 12.857142857142858 0 0 1 0 25.714285714285715 a 12.857142857142858 12.857142857142858 0 0 1 0 -25.714285714285715" fill="var(--background-tinted-press)" stroke="none" class="circle-inner"></path>' +
  '<path d="M18 5.7857142857142865 a 12.214285714285714 12.214285714285714 0 0 1 0 24.428571428571427 a 12.214285714285714 12.214285714285714 0 0 1 0 -24.428571428571427" stroke="var(--background-tinted-base)" fill="none" class="circle-inner-stroke"></path>' +
  '<path d="M 18 7.5 L 18 12" class="knob-pos" style="transform:rotate(-135deg)"></path></svg>';
type KnobKey = keyof Controls;
const KNOBS: Record<KnobKey, { label: string; tip: string; bipolar?: boolean }> = {
  transition: { label: 'Trans', bipolar: true, tip: 'Transition: cara pindah antar nada. 50% = luncuran asli dipertahankan. Ke kiri: makin tajam sampai lompat robotik. Ke kanan: makin legato (luncuran lebar). Klik dua kali = reset' },
  variation: { label: 'Variation', tip: 'Variation: variasi alami di dalam nada (vibrato dan pitch yang goyang). 100% = asli, 0% = datar di pusat nada. Klik dua kali = reset' },
  center: { label: 'Center', tip: 'Center: tarik pitch pusat tiap nada ke semiton terdekat. 0% = pitch asli, 100% = tepat di nada. Klik dua kali = reset' }
};
const KNOB_KEYS: KnobKey[] = ['transition', 'variation', 'center'];   // urutan tampil: Trans, Variation, Center
const knobHtml = (k: KnobKey): string =>
  `<div class="mpcs__knob is-off" title="${KNOBS[k].tip}"><div class="knob fxk"><div class="knob-inner"><div role="slider" tabindex="0" class="knob-input" data-kn="${k}" aria-label="${KNOBS[k].label}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${DEFAULT_CONTROLS[k]}"><div class="knobwheel">${knobSvg}</div></div></div></div>` +
  `<span class="mpcs__lbl">${KNOBS[k].label}</span><output>${Math.round(DEFAULT_CONTROLS[k] * 100)}%</output></div>`;

interface Peaks { mn: Float32Array; mx: Float32Array; norm: number }
interface Session {
  name: string; sr: number; dur: number; pt: PitchTrack; notes: Note[];
  orig: AudioBuffer; out: AudioBuffer | null; lo: number; hi: number; ref: number; pk: Peaks;
}

// Waveform: sample dipecah per kolom pixel, tiap kolom diambil min/max-nya (semua channel digabung), lalu digambar sebagai SATU polygon solid yang menyambung.
// Supaya cepat saat knob diputar / scroll, min/max per blok 64 sample dihitung sekali saat audio dimuat; kolom tinggal menggabungkan blok.
const PK_BLOCK = 64;
function buildPeaks(buf: AudioBuffer): Peaks {
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const n = buf.length, nb = Math.max(1, Math.ceil(n / PK_BLOCK));
  const mn = new Float32Array(nb), mx = new Float32Array(nb);
  let peak = 0;
  for (let b = 0; b < nb; b++) {
    let lo = 1, hi = -1; const e = Math.min(n, (b + 1) * PK_BLOCK);
    for (const d of chs) for (let i = b * PK_BLOCK; i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (e <= b * PK_BLOCK) { lo = 0; hi = 0; }
    mn[b] = lo; mx[b] = hi; peak = Math.max(peak, -lo, hi);
  }
  return { mn, mx, norm: peak > 1e-4 ? 1 / peak : 1 };   // dinormalkan ke puncak sample: rekaman pelan tetap kelihatan bentuknya
}
function peakRange(p: Peaks, sr: number, t0: number, t1: number, out: number[]): void {
  const nb = p.mn.length, b0 = Math.floor(t0 * sr / PK_BLOCK);
  if (b0 >= nb || t1 <= 0) { out[0] = 0; out[1] = 0; return; }
  const b1 = Math.min(nb - 1, Math.max(b0, Math.ceil(t1 * sr / PK_BLOCK) - 1));
  let lo = 1, hi = -1;
  for (let b = Math.max(0, b0); b <= b1; b++) { if (p.mn[b] < lo) lo = p.mn[b]; if (p.mx[b] > hi) hi = p.mx[b]; }
  out[0] = lo; out[1] = hi;
}
// satu polygon solid: sisi atas kiri->kanan, lalu sisi bawah kanan->kiri (kolom selalu tersambung, tanpa persegi terpisah)
function fillColumns(c: CanvasRenderingContext2D, x0: number, step: number, tops: Float32Array, bots: Float32Array, n: number): void {
  if (n < 1) return;
  c.beginPath(); c.moveTo(x0, bots[0]);
  for (let i = 0; i < n; i++) c.lineTo(x0 + i * step + step / 2, bots[i]);
  c.lineTo(x0 + n * step, bots[n - 1]);
  for (let i = n - 1; i >= 0; i--) c.lineTo(x0 + i * step + step / 2, tops[i]);
  c.lineTo(x0, tops[0]); c.closePath(); c.fill();
}

let root: HTMLElement | null = null, openFn: (() => void) | null = null;

export function initMpcs(): void {
  const title = document.querySelector<HTMLElement>('.fx__title');
  if (!title) return;
  title.style.userSelect = 'none'; title.style.touchAction = 'manipulation'; title.style.setProperty('-webkit-tap-highlight-color', 'transparent');
  let taps = 0, last = 0;
  title.addEventListener('click', () => {
    const t = performance.now();
    taps = t - last > 900 ? 1 : taps + 1; last = t;
    if (taps >= 7) { taps = 0; navigator.vibrate?.(18); open(); }
  });
}

function open(): void {
  if (!root) build();
  openFn?.();
}

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'mpcs'; el.hidden = true;
  el.innerHTML =
    '<div class="mpcs__back"></div>' +
    '<div class="mpcs__win is-off" role="dialog" aria-modal="true" aria-label="MPCS" tabindex="-1">' +
      `<header class="mpcs__head"><i class="mpcs__led" aria-hidden="true"></i><span class="mpcs__title">MPCS</span><div class="mpcs__lcd"><span class="mpcs__stat" role="status" aria-live="polite"></span></div><button type="button" class="mpcs__close" aria-label="Tutup MPCS">${ICON.close}</button></header>` +
      '<div class="mpcs__mid">' +
      '<canvas class="mpcs__ov" aria-label="Peta posisi sample (ketuk / seret untuk pindah)" hidden></canvas>' +
      '<div class="mpcs__stage">' +
        '<canvas class="mpcs__keys" aria-hidden="true"></canvas>' +
        '<div class="mpcs__scroll"><canvas class="mpcs__cv" role="img" aria-label="Editor pitch"></canvas><i class="mpcs__ph" aria-hidden="true"></i></div>' +
        `<div class="mpcs__empty"><button type="button" class="mpcs__up" data-a="up">${ICON.up}<span>Upload audio</span></button><p>Pakai vokal atau instrumen satu nada (monofonik) yang bersih tanpa efek.</p></div>` +
        '<div class="mpcs__busy" hidden><i></i></div>' +
      '</div>' +
      '</div>' +
      '<div class="mpcs__bar">' +
        `<button type="button" class="mpcs__up" data-a="up">${ICON.up}<span>Upload audio</span></button>` +
        `<div class="mpcs__knobs">${KNOB_KEYS.map(knobHtml).join('')}</div>` +
        `<button type="button" class="mpcs__play" data-a="play" aria-label="Putar" disabled>${ICON.play}</button>` +
      '</div>' +
      '<div class="mpcs__glass" aria-hidden="true"></div>' +
      `<input type="file" class="mpcs__file" accept="${AUDIO_ACCEPT}" hidden>` +
    '</div>';
  document.body.appendChild(el);
  root = el;

  const win = el.querySelector<HTMLElement>('.mpcs__win')!;
  const stat = el.querySelector<HTMLElement>('.mpcs__stat')!;
  const stage = el.querySelector<HTMLElement>('.mpcs__stage')!;
  const scroll = el.querySelector<HTMLElement>('.mpcs__scroll')!;
  const cv = el.querySelector<HTMLCanvasElement>('.mpcs__cv')!;
  const keys = el.querySelector<HTMLCanvasElement>('.mpcs__keys')!;
  const ph = el.querySelector<HTMLElement>('.mpcs__ph')!;
  const empty = el.querySelector<HTMLElement>('.mpcs__empty')!;
  const busy = el.querySelector<HTMLElement>('.mpcs__busy')!;
  const file = el.querySelector<HTMLInputElement>('.mpcs__file')!;
  const btn = (a: string): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`.mpcs__bar [data-a="${a}"]`)!;
  const ov = el.querySelector<HTMLCanvasElement>('.mpcs__ov')!;
  const g = cv.getContext('2d')!, gk = keys.getContext('2d')!, go = ov.getContext('2d')!;

  // ---------- knob Center / Variation / Transition ----------
  let kv: Controls = { ...DEFAULT_CONTROLS };
  const knobEl = {} as Record<KnobKey, HTMLElement>;
  KNOB_KEYS.forEach(k => { knobEl[k] = el.querySelector<HTMLElement>(`.mpcs__bar [data-kn="${k}"]`)!; });
  function paintKnob(k: KnobKey): void {
    const e = knobEl[k], v = kv[k], arc = e.querySelector('.circle')!;
    e.querySelector<SVGElement>('.knob-pos')!.style.transform = `rotate(${-135 + v * 270}deg)`;
    if (KNOBS[k].bipolar) { const a = Math.min(v, 0.5) * 75, b = Math.max(v, 0.5) * 75; arc.setAttribute('stroke-dasharray', `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 100`); }   // arc dari tengah (50% = bawaan), seperti knob pan
    else arc.setAttribute('stroke-dasharray', `${(v * 75).toFixed(2)} 100`);
    const t = Math.round(v * 100) + '%';
    e.setAttribute('aria-valuenow', v.toFixed(3)); e.setAttribute('aria-valuetext', KNOBS[k].label + ' ' + t);
    e.closest('.mpcs__knob')!.querySelector('output')!.textContent = t;
  }
  const paintKnobs = (): void => KNOB_KEYS.forEach(paintKnob);
  const resetKnobs = (): void => { kv = { ...DEFAULT_CONTROLS }; paintKnobs(); };
  let restartT = 0;
  const lazyRestart = (): void => { if (!playing) return; clearTimeout(restartT); restartT = window.setTimeout(() => { if (playing) restartPlay(); }, 140); };   // memutar knob tidak memicu render tiap piksel
  function setKnob(k: KnobKey, v: number): void {
    const nv = Math.max(0, Math.min(1, v)); if (!S || nv === kv[k]) return;
    kv[k] = nv; paintKnob(k); dirty = true; ver++; draw(); info(); lazyRestart();   // draw(): garis oranye ikut berubah persis seperti yang akan terdengar
  }
  KNOB_KEYS.forEach(k => {
    const e = knobEl[k]; let sx = 0, sy = 0, sv = 0, dr = false;
    e.style.touchAction = 'none';
    e.addEventListener('pointerdown', ev => { if (!S) return; dr = true; e.classList.add('is-dragging'); sx = ev.clientX; sy = ev.clientY; sv = kv[k]; e.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    e.addEventListener('pointermove', ev => { if (dr) setKnob(k, sv + ((sy - ev.clientY) + (ev.clientX - sx)) / 150); });   // atas / kanan = naik, sama seperti knob lain
    const end = (): void => { dr = false; e.classList.remove('is-dragging'); };
    e.addEventListener('pointerup', end); e.addEventListener('pointercancel', end);
    e.addEventListener('dblclick', () => setKnob(k, DEFAULT_CONTROLS[k]));
    e.addEventListener('keydown', ev => {
      const st = ev.shiftKey ? 0.1 : 0.02;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { setKnob(k, kv[k] + st); ev.preventDefault(); ev.stopPropagation(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { setKnob(k, kv[k] - st); ev.preventDefault(); ev.stopPropagation(); }
    });
  });

  let S: Session | null = null, sel = -1, pps = 100, W = 0, H = 0, viewH = 0, rowH = 12, dpr = 1;
  let ac: AudioContext | null = null, src: AudioBufferSourceNode | null = null, playing = false, playPos = 0, t0 = 0, raf = 0, mode: 'out' | 'orig' = 'out';
  let dirty = false, rendering = false, ver = 0, worker: Worker | null = null, jobId = 0;
  const jobs = new Map<number, { ok: (m: any) => void; fail: (e: Error) => void }>();   // eslint-disable-line @typescript-eslint/no-explicit-any

  // ---------- worker ----------
  function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./mpcs-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') { stat.textContent = 'Menganalisis ' + Math.round(m.p * 100) + '%'; return; }
      const j = jobs.get(m.id); if (!j) return;
      jobs.delete(m.id);
      if (m.type === 'error') j.fail(new Error(m.msg)); else j.ok(m);
    };
    worker.onerror = () => { jobs.forEach(j => j.fail(new Error('Worker gagal'))); jobs.clear(); };
    return worker;
  }
  const job = (msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> =>   // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((ok, fail) => { const id = ++jobId; jobs.set(id, { ok, fail }); getWorker().postMessage({ ...msg, id }, transfer); });

  // ---------- tata letak & gambar ----------
  const xOf = (sec: number): number => sec * pps;
  const yOf = (midi: number): number => (S!.hi + 0.5 - midi) * rowH;
  function layout(): void {
    dpr = Math.min(2, devicePixelRatio || 1);
    viewH = stage.clientHeight;
    const rows = S ? S.hi - S.lo + 1 : 1;
    rowH = S ? Math.max(16, viewH / rows) : 12;   // baris tidak dipepatkan lagi: kalau rentang nada lebar, kanvas jadi lebih tinggi dan di-scroll
    H = S ? Math.round(rowH * rows) : viewH;
    const viewW = scroll.clientWidth;
    W = S ? Math.max(viewW, Math.ceil(S.dur * pps)) : viewW;
    while (W * dpr > 16000 && pps > 10) { pps /= 1.25; W = Math.max(viewW, Math.ceil(S!.dur * pps)); }
    dpr = Math.max(1, Math.min(dpr, Math.sqrt(14e6 / (W * H))));   // batas luas kanvas supaya aman di HP
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
    keys.width = Math.round(44 * dpr); keys.height = Math.round(viewH * dpr); keys.style.width = '44px'; keys.style.height = viewH + 'px';
    ph.style.height = H + 'px';
    draw();
  }
  const ro = new ResizeObserver(() => { if (!el.hidden) layout(); });
  ro.observe(stage);

  function drawKeys(): void {
    gk.setTransform(dpr, 0, 0, dpr, 0, 0); gk.clearRect(0, 0, 44, viewH);
    if (!S) return;
    const off = scroll.scrollTop;
    for (let m = S.lo; m <= S.hi; m++) {
      const y = (S.hi - m) * rowH - off, pc = ((m % 12) + 12) % 12;
      if (y > viewH || y + rowH < 0) continue;
      gk.fillStyle = BLACK.has(pc) ? '#111118' : '#d9d9e4'; gk.fillRect(0, y, 44, rowH);
      if (rowH >= 13 || pc === 0) { gk.fillStyle = BLACK.has(pc) ? '#8a8a9a' : '#33333f'; gk.font = '600 9px system-ui,sans-serif'; gk.textBaseline = 'middle'; gk.fillText(noteName(m), 6, y + rowH / 2); }
    }
  }

  // peta seluruh sample: bentuk amplitudo + posisi nada + kotak jendela yang sedang terlihat. Ketuk / seret buat pindah.
  let ovProf: Float32Array | null = null, ovKey = '';
  function drawOv(): void {
    if (!S) { ov.hidden = true; return; }
    ov.hidden = false;
    const w = ov.clientWidth, h = ov.clientHeight; if (!w || !h) return;
    const d = Math.min(2, devicePixelRatio || 1);
    if (ov.width !== Math.round(w * d) || ov.height !== Math.round(h * d)) { ov.width = Math.round(w * d); ov.height = Math.round(h * d); }
    go.setTransform(d, 0, 0, d, 0, 0); go.clearRect(0, 0, w, h);
    const key = S.name + '|' + S.pk.mn.length + '|' + w + '|' + h;
    if (key !== ovKey || !ovProf) {   // atas & bawah polygon per pixel (min/max sample), dihitung ulang hanya kalau ukuran berubah / sample baru
      ovKey = key; ovProf = new Float32Array(w * 2);
      const r = [0, 0], mid = h / 2, amp = h * .45;
      for (let px = 0; px < w; px++) {
        peakRange(S.pk, S.sr, px / w * S.dur, (px + 1) / w * S.dur, r);
        let yt = mid - r[1] * S.pk.norm * amp, yb = mid - r[0] * S.pk.norm * amp;
        if (yb - yt < 1.5) { yt = mid - .75; yb = mid + .75; }
        ovProf[px] = yt; ovProf[w + px] = yb;
      }
    }
    go.fillStyle = 'rgba(214,60,130,.35)';
    fillColumns(go, 0, 1, ovProf.subarray(0, w), ovProf.subarray(w, w * 2), w);
    const rows = S.hi - S.lo + 1, hopSec = S.pt.hop / S.pt.sr;
    go.fillStyle = '#ffc857';
    for (const n of S.notes) go.fillRect(n.s * hopSec / S.dur * w, (S.hi + .5 - n.target) / rows * h - 1.5, Math.max(2, (n.e - n.s) * hopSec / S.dur * w), 3);
    go.fillStyle = '#fff'; go.fillRect(Math.min(w - 1, playPos / S.dur * w), 0, 1.5, h);
    go.strokeStyle = 'rgba(255,255,255,.9)'; go.lineWidth = 1.2; go.fillStyle = 'rgba(255,255,255,.08)';
    const vx = scroll.scrollLeft / W * w, vw = Math.min(w, scroll.clientWidth / W * w), vy = scroll.scrollTop / H * h, vh = Math.min(h, viewH / H * h);
    go.beginPath(); go.roundRect(vx + .5, vy + .5, Math.max(4, vw - 1), Math.max(4, vh - 1), 3); go.fill(); go.stroke();
  }
  const ovGo = (e: PointerEvent): void => {
    if (!S) return;
    const r = ov.getBoundingClientRect(), fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    scroll.scrollLeft = fx * W - scroll.clientWidth / 2; scroll.scrollTop = fy * H - viewH / 2;
  };
  let ovDrag = false;
  ov.addEventListener('pointerdown', e => { ovDrag = true; ov.setPointerCapture(e.pointerId); ovGo(e); });
  ov.addEventListener('pointermove', e => { if (ovDrag) ovGo(e); });
  const ovEnd = (): void => { ovDrag = false; };
  ov.addEventListener('pointerup', ovEnd); ov.addEventListener('pointercancel', ovEnd);
  scroll.addEventListener('scroll', () => { drawKeys(); drawOv(); }, { passive: true });

  function draw(): void {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    drawKeys(); drawOv();
    if (!S) return;
    const { lo, hi, pt, notes, pk, sr } = S, hopSec = pt.hop / pt.sr;
    const sc = shiftCurve(pt, notes, undefined, kv);   // geseran per frame persis seperti yang dirender (target, knob, drift, vibrato), jadi garis = yang terdengar
    // baris semiton
    for (let m = lo; m <= hi; m++) {
      const y = (hi - m) * rowH, pc = ((m % 12) + 12) % 12;
      g.fillStyle = BLACK.has(pc) ? '#120f14' : '#1b161d'; g.fillRect(0, y, W, rowH);
      if (pc === 0) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, y + rowH - 1, W, 1); }
    }
    // garis detik
    g.font = '9px system-ui,sans-serif'; g.textBaseline = 'top';
    for (let s = 0; s <= S.dur; s++) { const x = Math.round(xOf(s)) + .5; g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(x, 0, 1, H); g.fillStyle = '#6c6c7c'; g.fillText(s + 's', x + 3, 2); }
    // nada
    notes.forEach((nt, i) => {
      const x0 = xOf((nt.s - .5) * hopSec), x1 = xOf((nt.e - .5) * hopSec), yc = yOf(nt.target);
      const on = i === sel;
      g.fillStyle = on ? 'rgba(255,92,160,.30)' : 'rgba(255,92,160,.16)';
      g.strokeStyle = on ? '#fff' : 'rgba(255,92,160,.7)'; g.lineWidth = on ? 1.5 : 1;
      g.beginPath(); g.roundRect(x0, yc - rowH * .5, Math.max(4, x1 - x0), rowH, Math.min(5, rowH / 2)); g.fill(); g.stroke();
      // waveform sample asli (min/max per kolom pixel, satu polygon solid) mengikuti garis pitch hasil
      const nF = nt.e - nt.s, cy = new Float32Array(nF); let last = NaN;
      for (let i = 0; i < nF; i++) { const f = nt.s + i; cy[i] = pt.f0[f] ? yOf(69 + 12 * Math.log2(pt.f0[f] / 440) + sc[f]) : NaN; }
      for (let i = 0; i < nF; i++) { if (cy[i] === cy[i]) last = cy[i]; else cy[i] = last; }   // frame tanpa pitch: pakai titik sebelumnya
      for (let i = nF - 1, nx = NaN; i >= 0; i--) { if (cy[i] === cy[i]) nx = cy[i]; else cy[i] = nx; }
      if (nF > 0 && cy[0] === cy[0]) {
        const px = 1 / dpr, xa = Math.max(0, Math.floor(x0 * dpr) / dpr), xb = Math.min(W, x1), n = Math.ceil((xb - xa) / px);
        const tops = new Float32Array(Math.max(0, n)), bots = new Float32Array(Math.max(0, n)), r = [0, 0], half = rowH * .46 * .92;
        for (let i = 0; i < n; i++) {
          const x = xa + i * px;
          peakRange(pk, sr, x / pps, (x + px) / pps, r);
          const fi = Math.max(0, Math.min(nF - 1, x / pps / hopSec - nt.s)), i0 = Math.floor(fi), i1 = Math.min(nF - 1, i0 + 1);
          const m = cy[i0] + (cy[i1] - cy[i0]) * (fi - i0);
          let yt = m - r[1] * pk.norm * half, yb = m - r[0] * pk.norm * half;
          if (yb - yt < 2 * px) { yt = m - px; yb = m + px; }   // minimal 2 pixel supaya bagian senyap tetap terlihat
          tops[i] = yt; bots[i] = yb;
        }
        g.fillStyle = 'rgba(214,60,130,.9)';
        fillColumns(g, xa, px, tops, bots, n);
      }
      // pitch asli (redup, hanya kalau digeser) dan pitch hasil (oranye)
      const line = (add: number | Float32Array, style: string, w: number): void => {
        g.strokeStyle = style; g.lineWidth = w; g.beginPath();
        for (let f = nt.s; f < nt.e; f++) { if (!pt.f0[f]) continue; const x = xOf(f * hopSec), y = yOf(69 + 12 * Math.log2(pt.f0[f] / 440) + (typeof add === 'number' ? add : add[f])); f === nt.s ? g.moveTo(x, y) : g.lineTo(x, y); }
        g.stroke();
      };
      let moved = false; for (let f = nt.s; f < nt.e; f++) if (pt.f0[f] && Math.abs(sc[f]) > .01) { moved = true; break; }
      if (moved) line(0, 'rgba(255,255,255,.28)', 1);   // pitch asli (redup) kalau hasilnya berbeda: digeser, drift, atau vibrato diubah
      line(sc, '#ffc857', 1.4);
    });
  }

  // ---------- status ----------
  function info(): void {
    if (!S) { stat.textContent = ''; return; }
    if (sel >= 0) { const n = S.notes[sel], eff = (n.man ? 1 : kv.center) * (n.target - n.midi); stat.textContent = noteName(n.midi) + (Math.round((n.midi - Math.round(n.midi)) * 100) ? ' ' + fmtShift(n.midi - Math.round(n.midi)) : '') + ' → ' + noteName(n.target) + '  (' + fmtShift(eff) + (n.man ? ', manual' : '') + ')'; }
    else stat.textContent = S.notes.length ? S.notes.length + ' nada terdeteksi' : 'Tidak ada nada terdeteksi';
  }
  function enable(on: boolean): void {
    btn('play').disabled = !on; win.classList.toggle('is-off', !on);
    KNOB_KEYS.forEach(k => { knobEl[k].closest('.mpcs__knob')!.classList.toggle('is-off', !on); });
  }
  function setBusy(on: boolean): void { busy.hidden = !on; }

  // ---------- muat & analisis ----------
  async function load(f: File): Promise<void> {
    if (!isAudio(f)) { stat.textContent = 'File bukan audio'; return; }
    stopPlay(); enable(false); setBusy(true); empty.hidden = true; stat.textContent = 'Membaca audio';
    try {
      ac ??= new AudioContext();
      const buf = await ac.decodeAudioData(await f.arrayBuffer());
      const mono = toMono(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice()));
      stat.textContent = 'Menganalisis 0%';
      const r = await job({ type: 'analyze', x: mono, sr: buf.sampleRate }, [mono.buffer]);
      const notes: Note[] = r.notes, pt: PitchTrack = r.pt;
      snapTargets(notes); resetKnobs();   // target = semiton terdekat (hysteresis); Center 0% jadi audio belum berubah sampai knob diputar
      let lo = 48, hi = 72;
      if (notes.length) {
        lo = Math.floor(Math.min(...notes.map(n => Math.min(n.midi, n.target)))) - 3; hi = Math.ceil(Math.max(...notes.map(n => Math.max(n.midi, n.target)))) + 3;
        while (hi - lo < 23) { lo--; hi++; }
        if (hi - lo > 84) { const c = (hi + lo) >> 1; lo = c - 42; hi = c + 42; }
      }
      const sorted = Array.from(pt.rms).sort((a, b) => a - b);
      S = { name: f.name.replace(/\.[^.]+$/, ''), sr: buf.sampleRate, dur: buf.duration, pt, notes, orig: buf, out: null, lo, hi, ref: sorted[Math.floor(sorted.length * .95)] || 0.1, pk: buildPeaks(buf) };
      sel = -1; dirty = true; playPos = 0; ph.style.transform = 'translateX(0)';
      pps = Math.max(40, Math.min(220, scroll.clientWidth / Math.max(1, buf.duration)));
      scroll.scrollLeft = 0; layout(); info(); enable(true);
      if (notes.length) { const mt = notes.reduce((a, n) => a + n.target, 0) / notes.length; scroll.scrollTop = Math.max(0, yOf(mt) - viewH / 2); drawKeys(); drawOv(); } else scroll.scrollTop = 0;
    } catch (err) {
      S = null; empty.hidden = false; draw(); stat.textContent = 'Gagal memuat audio';
      console.error(err);
    } finally { setBusy(false); }
  }

  // ---------- render hasil (di Worker), lalu putar ----------
  async function ensureRendered(): Promise<AudioBuffer | null> {
    if (!S) return null;
    if (!dirty && S.out) return S.out;
    if (rendering) { await new Promise<void>(r => { const t = setInterval(() => { if (!rendering) { clearInterval(t); r(); } }, 40); }); return ensureRendered(); }
    rendering = true; const my = ver;
    try {
      const r = await job({ type: 'render', notes: S.notes, ctl: { ...kv } });
      const out = ac!.createBuffer(1, r.y.length, S.sr); out.copyToChannel(r.y, 0);
      S.out = out; if (my === ver) dirty = false;
    } finally { rendering = false; }
    return dirty ? ensureRendered() : S.out;
  }
  const edit = (): void => { dirty = true; ver++; draw(); info(); if (playing) restartPlay(); };

  function stopPlay(): void {
    if (src) { src.onended = null; try { src.stop(); } catch { /* sudah berhenti */ } src.disconnect(); src = null; }
    if (playing) { playing = false; btn('play').innerHTML = ICON.play; btn('play').setAttribute('aria-label', 'Putar'); btn('play').classList.remove('is-on'); }
    cancelAnimationFrame(raf); raf = 0;
  }
  async function startPlay(): Promise<void> {
    if (!S || !ac) return;
    await ac.resume();
    let b: AudioBuffer | null = S.orig;
    if (mode === 'out') { btn('play').disabled = true; stat.textContent = 'Merender'; try { b = await ensureRendered(); } finally { btn('play').disabled = false; } info(); }
    if (!b || !S) return;
    stopPlay();
    if (playPos >= S.dur - .02) playPos = 0;
    src = ac.createBufferSource(); src.buffer = b; src.connect(ac.destination);
    src.onended = () => { if (playing) { playPos = 0; stopPlay(); moveHead(0); } };
    src.start(0, playPos); t0 = ac.currentTime - playPos; playing = true;
    btn('play').innerHTML = ICON.pause; btn('play').setAttribute('aria-label', 'Jeda'); btn('play').classList.add('is-on');
    const tick = (): void => {
      if (!playing || !ac) return;
      playPos = Math.min(S!.dur, ac.currentTime - t0); moveHead(playPos, true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function restartPlay(): void { if (playing) { playPos = Math.max(0, (ac?.currentTime ?? 0) - t0); void startPlay(); } }
  function moveHead(sec: number, follow = false): void {
    const x = xOf(sec); ph.style.transform = `translateX(${x}px)`; drawOv();
    if (follow) { const v = scroll.clientWidth; if (x < scroll.scrollLeft || x > scroll.scrollLeft + v * .9) scroll.scrollLeft = Math.max(0, x - v * .1); }
  }

  // ---------- seret blok ----------
  let drag: { i: number; y0: number; base: number; moved: boolean; id: number } | null = null;
  let pan: { x0: number; y0: number; sl: number; st: number; px: number; moved: boolean; id: number; mouse: boolean } | null = null;
  const hit = (x: number, y: number): number => {
    if (!S) return -1;
    const hopSec = S.pt.hop / S.pt.sr; let best = -1, bd = 1e9;
    S.notes.forEach((n, i) => {
      const x0 = xOf((n.s - .5) * hopSec) - 4, x1 = xOf((n.e - .5) * hopSec) + 4, yc = yOf(n.target), pad = Math.max(rowH * .7, 16);
      if (x < x0 || x > x1 || Math.abs(y - yc) > pad) return;
      const d = Math.abs(y - yc); if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  cv.addEventListener('pointerdown', e => {
    if (!S) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, i = hit(x, y);
    if (i < 0) { pan = { x0: e.clientX, y0: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop, px: x, moved: false, id: e.pointerId, mouse: e.pointerType === 'mouse' }; cv.setPointerCapture(e.pointerId); return; }
    sel = i; drag = { i, y0: e.clientY, base: Math.round(S.notes[i].target), moved: false, id: e.pointerId };
    cv.setPointerCapture(e.pointerId); draw(); info();
  });
  cv.addEventListener('pointermove', e => {
    if (pan && e.pointerId === pan.id) {
      const dx = e.clientX - pan.x0, dy = e.clientY - pan.y0;
      if (!pan.moved && Math.hypot(dx, dy) < 6) return;
      pan.moved = true; scroll.scrollTop = pan.st - dy; if (pan.mouse) scroll.scrollLeft = pan.sl - dx;
      return;
    }
    if (!drag || !S || e.pointerId !== drag.id) return;
    const dy = drag.y0 - e.clientY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    const t = Math.max(S.lo + 1, Math.min(S.hi - 1, drag.base + Math.round(dy / rowH)));
    if (t !== S.notes[drag.i].target || !S.notes[drag.i].man) { S.notes[drag.i].target = t; S.notes[drag.i].man = true; edit(); }   // diseret tangan: dikoreksi penuh, di luar knob Center
  });
  const endDrag = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) drag = null;
    if (pan && e.pointerId === pan.id) {
      const p = pan; pan = null;
      if (!p.moved && e.type === 'pointerup' && S) { sel = -1; playPos = Math.max(0, Math.min(S.dur, p.px / pps)); moveHead(playPos); if (playing) restartPlay(); draw(); info(); }   // ketuk kosong = pindah playhead
    }
  };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

  // ---------- tombol ----------
  el.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.mpcs__bar button'); if (!b || b.disabled) return;
    if (b.dataset.a === 'up') file.click(); else if (b.dataset.a === 'play') { if (playing) stopPlay(); else void startPlay(); }
  });
  empty.querySelector('button')!.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void load(f); });
  el.addEventListener('dragover', e => e.preventDefault());
  el.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) void load(f); });

  // ---------- efek 3D: faceplate miring mengikuti kursor (mouse saja, mati di atas editor / saat drag / reduced-motion), kilau mengikuti arah cahaya ----------
  const untilt = (): void => { win.classList.remove('is-tilting'); win.style.setProperty('--rx', '0deg'); win.style.setProperty('--ry', '0deg'); win.style.setProperty('--mx', '50%'); win.style.setProperty('--my', '0%'); };
  el.addEventListener('pointermove', e => {
    if (reduce || e.pointerType !== 'mouse') return;
    if (e.buttons || (e.target as Element).closest('.mpcs__stage, .mpcs__ov')) { untilt(); return; }
    const r = win.getBoundingClientRect(), px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    win.classList.add('is-tilting');
    win.style.setProperty('--ry', ((px - .5) * 4).toFixed(2) + 'deg'); win.style.setProperty('--rx', ((.5 - py) * 3).toFixed(2) + 'deg');
    win.style.setProperty('--mx', (px * 100).toFixed(1) + '%'); win.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  });
  el.addEventListener('pointerleave', untilt);

  // ---------- buka / tutup ----------
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();   // pintasan DAW (Space, tuts keyboard) tidak ikut jalan selagi MPCS terbuka
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const onBtn = (e.target as Element).closest?.('button');
    if (e.key === ' ' && !onBtn && S) { e.preventDefault(); playing ? stopPlay() : void startPlay(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel >= 0 && S && !(e.target as Element).closest?.('.knob-input')) {
      e.preventDefault(); const n = S.notes[sel], t = Math.max(S.lo + 1, Math.min(S.hi - 1, Math.round(n.target) + (e.key === 'ArrowUp' ? 1 : -1)));
      if (t !== n.target) { n.target = t; n.man = true; edit(); }
    }
  };
  el.addEventListener('keydown', onKey); el.addEventListener('keyup', e => e.stopPropagation());
  el.querySelector('.mpcs__close')!.addEventListener('click', () => close());
  el.querySelector('.mpcs__back')!.addEventListener('pointerdown', () => close());

  function close(): void {
    stopPlay(); untilt();
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    el.querySelector('.mpcs__back')!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.96)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false; empty.hidden = !!S;
    layout(); info();
    if (!reduce) win.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.34,1.3,.64,1)' });
    win.focus({ preventScroll: true });
  };
}
