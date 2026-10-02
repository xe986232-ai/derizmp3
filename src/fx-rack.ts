// Isi panel efek: tombol "+" bulat putih (di atas saat kosong, pindah ke bawah setelah ada efek), card gelap (gaya card track)
// untuk memilih efek, dan satu card per efek. Parameter diatur dengan knob seperti knob pan di channel mixer.
// Efek disimpan per track (kunci = id track); panel selalu menampilkan efek milik track yang sedang dipilih.
// Selain efek (Reverb, Equalizer) ada plugin instrumen (Supersaw): kartunya otomatis muncul di paling atas saat track synth dibuat,
// memakai knob + slider vertikal, dan tidak bisa dihapus / tidak muncul di daftar pilihan efek.
// Efek / plugin baru cukup ditambah ke EFFECTS (nama, parameter) dan ke applyAudio().
// DERIZ: plugin dengan canvas audio (spektrogram, zoom) + upload file; tahap ini baru menampilkan audio, belum memproses suara.

import { setReverb, setEq, reverbSeconds, eqDb, decodeStandalone } from './audio-engine';
import { isAudio, ACCEPT as AUDIO_ACCEPT } from './audio-upload-card';
import { setSupersaw, detuneCents, cutoffHz, attackSec, decaySec, releaseSec } from './synth-engine';

type FxType = 'reverb' | 'eq' | 'supersaw' | 'deriz';
// DERIZ: audio yang di-upload ke canvas plugin (buffer disimpan untuk tahap berikutnya; peaks + max khusus untuk menggambar waveform)
interface DerizData { name: string; dur: number; buf: AudioBuffer; start: number; zoom: number; view: number; spec: Spec | null; busy?: number; }   // start: posisi garis start, 0..1 dari durasi; zoom >= 1: jendela terlihat = [view, view + 1/zoom] dari durasi; spec: spektrogram (null selagi dianalisis, busy = persen)
// Spektrogram: frames x ROWS nilai dB (0..255 = -100..0 dBFS), baris 0 = frekuensi terendah (skala log); lut = palet warna yang disesuaikan dengan level puncak
interface Spec { frames: number; hop: number; fmin: number; fmax: number; d: Uint8Array; lut: Uint32Array }   // cols: cache min/max per kolom pixel device (dihitung ulang hanya kalau lebar canvas berubah)   // start: posisi garis start, 0..1 dari durasi
interface Fx { id: number; type: FxType; on: boolean; min: boolean; tab?: number; v: Record<string, number>; deriz?: DerizData; tok?: number; }
interface Param { key: string; label: string; def: number; fmt: (v: number) => string; bipolar?: boolean; slider?: boolean; tab?: string; }   // tab: nama kategori (plugin dengan tab)   // bipolar: arc dari tengah (seperti knob pan); slider: slider vertikal, bukan knob
interface EffectDef { type: FxType; name: string; params: Param[]; synth?: boolean; }   // synth: plugin instrumen (otomatis ada di track synth)

const svg = (inner: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_MORE = svg('<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>', 18);

const fmtDb = (v: number): string => { const d = Math.round(eqDb(v) * 10) / 10; return (d > 0 ? '+' : '') + d.toFixed(1) + ' dB'; };

const pct = (v: number): string => Math.round(v * 100) + '%';
const fmtSec = (s: number): string => (s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(2) + ' s');
const fmtHz = (hz: number): string => (hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz');

const EFFECTS: EffectDef[] = [
  {
    type: 'reverb', name: 'Reverb',
    params: [
      { key: 'mix', label: 'Mix', def: 0.3, fmt: v => Math.round(v * 100) + '%' },
      { key: 'size', label: 'Size', def: 0.4, fmt: v => reverbSeconds(v).toFixed(1) + ' s' }
    ]
  },
  {
    type: 'eq', name: 'Equalizer',
    params: [
      { key: 'low', label: 'Low', def: 0.5, bipolar: true, fmt: fmtDb },
      { key: 'mid', label: 'Mid', def: 0.5, bipolar: true, fmt: fmtDb },
      { key: 'high', label: 'High', def: 0.5, bipolar: true, fmt: fmtDb }
    ]
  },
  { type: 'deriz', name: 'DERIZ', params: [] },   // plugin canvas audio: isinya canvas waveform + upload (tanpa knob)
  {
    type: 'supersaw', name: 'Supersaw', synth: true,
    params: [
      { key: 'detune', label: 'Detune', tab: 'OSC', def: 0.45, fmt: v => Math.round(detuneCents(v)) + ' ct' },
      { key: 'mix', label: 'Mix', tab: 'OSC', def: 0.6, fmt: pct },
      { key: 'level', label: 'Level', tab: 'OSC', def: 0.8, slider: true, fmt: pct },
      { key: 'cutoff', label: 'Cutoff', tab: 'FILTER', def: 0.78, fmt: v => fmtHz(cutoffHz(v)) },
      { key: 'reso', label: 'Reso', tab: 'FILTER', def: 0.15, slider: true, fmt: pct },
      { key: 'attack', label: 'Atk', tab: 'ENV', def: 0.05, slider: true, fmt: v => fmtSec(attackSec(v)) },
      { key: 'decay', label: 'Dec', tab: 'ENV', def: 0.4, slider: true, fmt: v => fmtSec(decaySec(v)) },
      { key: 'sustain', label: 'Sus', tab: 'ENV', def: 0.7, slider: true, fmt: pct },
      { key: 'release', label: 'Rel', tab: 'ENV', def: 0.35, slider: true, fmt: v => fmtSec(releaseSec(v)) }
    ]
  }
];
const defOf = (t: FxType) => EFFECTS.find(e => e.type === t)!;

const racks = new Map<string, Fx[]>();   // id track -> efek miliknya
let cur: string | null = null, seq = 0;

function applyAudio(track: string): void {
  const rack = racks.get(track) ?? [];
  const r = rack.find(f => f.type === 'reverb'), e = rack.find(f => f.type === 'eq'), s = rack.find(f => f.type === 'supersaw');
  setReverb(track, r ? { on: r.on, mix: r.v.mix, size: r.v.size } : null);
  setEq(track, e ? { on: e.on, low: e.v.low, mid: e.v.mid, high: e.v.high } : null);
  setSupersaw(track, s ? { on: s.on, detune: s.v.detune, mix: s.v.mix, level: s.v.level, cutoff: s.v.cutoff, reso: s.v.reso, attack: s.v.attack, decay: s.v.decay, sustain: s.v.sustain, release: s.v.release } : null);
}

// ---------- knob (struktur & kelas sama dengan knob pan di channel mixer, tapi satu arah: 0 → 1) ----------
const KNOB_SWEEP = 270, ARC_LEN = 75, DRAG_PX = 90;   // sapuan 270° = 75 satuan dari keliling 100; DRAG_PX = jarak drag (px) untuk menempuh 0 → 1
const knobSvg = `<svg viewBox="0 0 36 36" aria-hidden="true" class="circular-chart">` +
  `<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dasharray="75, 100" class="circle-bg" style="transform-origin:18px 18px;transform:rotate(225deg)"></path>` +
  `<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dashoffset="0" stroke-dasharray="0 100" class="circle primary-theme" style="transform:rotate(225deg)"></path>` +
  `<path d="M18 5.142857142857142 a 12.857142857142858 12.857142857142858 0 0 1 0 25.714285714285715 a 12.857142857142858 12.857142857142858 0 0 1 0 -25.714285714285715" fill="var(--background-tinted-press)" stroke="none" class="circle-inner"></path>` +
  `<path d="M18 5.7857142857142865 a 12.214285714285714 12.214285714285714 0 0 1 0 24.428571428571427 a 12.214285714285714 12.214285714285714 0 0 1 0 -24.428571428571427" stroke="var(--background-tinted-base)" fill="none" class="circle-inner-stroke"></path>` +
  `<path d="M 18 7.5 L 18 12" class="knob-pos" style="transform:rotate(-135deg)"></path></svg>`;

function paintKnob(el: HTMLElement, v: number, p: Param, name: string): void {
  (el.querySelector('.knob-pos') as SVGElement).style.transform = `rotate(${-KNOB_SWEEP / 2 + v * KNOB_SWEEP}deg)`;
  const arc = el.querySelector('.circle')!;
  if (p.bipolar) {   // arc dari tengah: ke kiri atau ke kanan, seperti knob pan
    const a = Math.min(v, 0.5) * ARC_LEN, b = Math.max(v, 0.5) * ARC_LEN;
    arc.setAttribute('stroke-dasharray', `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 100`);
  } else arc.setAttribute('stroke-dasharray', `${(v * ARC_LEN).toFixed(2)} 100`);
  el.setAttribute('aria-valuenow', v.toFixed(3));
  el.setAttribute('aria-valuetext', `${name} ${p.label} ${p.fmt(v)}`);
}

// slider vertikal: isi & posisi pegangan dikendalikan lewat variabel CSS --v (0..1)
function paintSlider(el: HTMLElement, v: number, p: Param, name: string): void {
  el.style.setProperty('--v', v.toFixed(3));
  el.setAttribute('aria-valuenow', v.toFixed(3));
  el.setAttribute('aria-valuetext', `${name} ${p.label} ${p.fmt(v)}`);
}
const paintCtl = (el: HTMLElement, v: number, p: Param, name: string): void => (p.slider ? paintSlider : paintKnob)(el, v, p, name);
const CTL = '.knob-input, .vsl';   // knob atau slider vertikal

const cellHtml = (d: EffectDef, fx: Fx, p: Param): string => p.slider
  ? `<div class="fxc__cell"><div role="slider" tabindex="0" class="vsl" data-k="${p.key}" aria-orientation="vertical" aria-label="${d.name} ${p.label}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${fx.v[p.key]}">` +
    `<span class="vsl__fill"></span><span class="vsl__thumb"></span></div><span class="fxc__label">${p.label}</span></div>`
  : `<div class="fxc__cell"><div class="knob fxk"><div class="knob-inner">` +
    `<div role="slider" tabindex="0" class="knob-input" data-k="${p.key}" aria-label="${d.name} ${p.label}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${fx.v[p.key]}">` +
    `<div class="knobwheel">${knobSvg}</div></div></div></div><span class="fxc__label">${p.label}</span></div>`;

// ---------- DERIZ: canvas audio ----------
const ICON_UP = svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>', 16);
const esc = (t: string): string => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDur = (s: number): string => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const fmtPos = (s: number): string => { const q = Math.round(Math.max(0, s) * 10), m = Math.floor(q / 600), r = (q % 600) / 10; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };   // m:ss.d
const posText = (z: DerizData | undefined): string => (z ? (z.busy !== undefined ? 'Menganalisis ' + z.busy + '%' : 'Start ' + fmtPos(z.start * z.dur)) : 'Belum ada audio');
const zoomText = (z: DerizData | undefined): string => (z ? (z.zoom < 10 ? String(Math.round(z.zoom * 10) / 10) : String(Math.round(z.zoom))) : '1') + '×';
const visS = (z: DerizData): number => (z.start - z.view) * z.zoom;   // posisi garis start dalam jendela yang terlihat (bisa di luar 0..1 saat di-zoom)
const DERIZ_PAD = 6;   // jarak kiri/kanan canvas: garis start di 0 / 1 dan ujung waveform sejajar, pegangan tidak terpotong

// Tinggi isi sama dengan card knob (Reverb / EQ): canvas 72 px (= tinggi knob) + satu baris label, dalam wadah .fxc__knobs yang sama.
function derizHtml(fx: Fx): string {
  const z = fx.deriz;
  return `<div class="fxc__knobs deriz"><div class="fxc__cell deriz__cell">` +
    `<div class="deriz__stage${z ? ' has-audio' : ''}${z && z.zoom > 1.001 ? ' is-zoomed' : ''}" style="--s:${z ? visS(z).toFixed(4) : 0}"><canvas class="deriz__canvas" role="img" aria-label="Spektrogram audio DERIZ"></canvas>` +
    `<div class="deriz__start" role="slider" tabindex="0" aria-label="Garis start" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${z ? z.start.toFixed(4) : 0}" aria-valuetext="${posText(z)}"></div>` +
    `<div class="deriz__zoom" role="group" aria-label="Zoom waveform"><button type="button" class="deriz__zb" data-z="out" aria-label="Perkecil" title="Perkecil">&minus;</button><button type="button" class="deriz__zv" aria-label="Reset zoom" title="Reset zoom">${zoomText(z)}</button><button type="button" class="deriz__zb" data-z="in" aria-label="Perbesar" title="Perbesar">+</button></div>` +
    `<div class="deriz__nav" aria-hidden="true"><i class="deriz__thumb"${z ? ` style="left:${(z.view * 100).toFixed(3)}%;width:${(100 / z.zoom).toFixed(3)}%"` : ''}></i></div>` +
    `<button type="button" class="deriz__up">${ICON_UP}<span>Upload audio</span></button><i class="deriz__glass" aria-hidden="true"></i></div>` +
    `<div class="fxc__label deriz__meta"><span class="deriz__pos">${posText(z)}</span>` +
    `<span class="deriz__dur"${z ? '' : ' hidden'}>${z ? fmtDur(z.dur) : ''}</span>` +
    `<button type="button" class="deriz__swap"${z ? '' : ' hidden'}>Ganti</button></div>` +
    `<input type="file" class="deriz__file" accept="${AUDIO_ACCEPT}" hidden></div></div>`;
}

function updateZoomUi(card: HTMLElement, z: DerizData | undefined): void {
  const stage = card.querySelector<HTMLElement>('.deriz__stage')!;
  stage.classList.toggle('is-zoomed', !!z && z.zoom > 1.001);
  stage.style.setProperty('--s', z ? visS(z).toFixed(4) : '0');
  const zv = card.querySelector<HTMLElement>('.deriz__zv'); if (zv) zv.textContent = zoomText(z);
  const th = card.querySelector<HTMLElement>('.deriz__thumb');
  if (th && z) { th.style.left = (z.view * 100).toFixed(3) + '%'; th.style.width = (100 / z.zoom).toFixed(3) + '%'; }
}

function updateDerizUi(card: HTMLElement, fx: Fx): void {
  const z = fx.deriz;
  card.querySelector('.deriz__stage')!.classList.toggle('has-audio', !!z);
  card.querySelector('.deriz__stage')!.classList.remove('is-loading');
  card.querySelector('.deriz__pos')!.textContent = posText(z);
  updateZoomUi(card, z);
  const dur = card.querySelector<HTMLElement>('.deriz__dur')!, swap = card.querySelector<HTMLElement>('.deriz__swap')!;
  dur.hidden = swap.hidden = !z;
  dur.textContent = z ? fmtDur(z.dur) : '';
}

// ---------- spektrogram: STFT (jendela Hann, FFT radix-2; dua frame nyata dikemas satu FFT kompleks), frekuensi skala log ----------
const SPEC_ROWS = 288, SPEC_FMIN = 30, SPEC_RANGE = 72;   // jumlah baris, frekuensi terendah (Hz), rentang dB yang diwarnai di bawah puncak
const PALETTE: [number, number[]][] = [[0, [2, 4, 10]], [.3, [8, 40, 70]], [.6, [40, 170, 205]], [.85, [190, 240, 255]], [1, [255, 255, 255]]];   // hitam -> biru -> cyan -> putih

function makeLut(topV: number): Uint32Array {
  const lut = new Uint32Array(256), top = topV / 2.55 - 100;
  for (let v = 0; v < 256; v++) {
    const t = Math.pow(Math.max(0, Math.min(1, (v / 2.55 - 100 - (top - SPEC_RANGE)) / SPEC_RANGE)), 1.15);
    let k = 1; while (k < PALETTE.length - 1 && PALETTE[k][0] < t) k++;
    const [t0, c0] = PALETTE[k - 1], [t1, c1] = PALETTE[k], u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    const ch = (i: number): number => Math.round(c0[i] + (c1[i] - c0[i]) * u);
    lut[v] = (255 << 24) | (ch(2) << 16) | (ch(1) << 8) | ch(0);   // RGBA little-endian
  }
  return lut;
}

// Analisis di latar (diselingi yield supaya UI tidak macet). alive() false = dibatalkan -> null.
async function computeSpec(buf: AudioBuffer, onProgress: (pct: number) => void, alive: () => boolean): Promise<Spec | null> {
  const len = buf.length, sr = buf.sampleRate, hop = Math.max(256, Math.ceil(len / 12000)), frames = Math.floor(len / hop) + 1;
  const N = frames <= 4000 ? 4096 : 2048, half = N / 2, R = SPEC_ROWS;
  const fmax = Math.min(20000, sr / 2 * 0.99), binHz = sr / N;
  // tabel FFT + jendela Hann
  const rev = new Uint16Array(N), cs = new Float32Array(half), sn = new Float32Array(half), win = new Float32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N); }
  for (let k = 0; k < half; k++) { cs[k] = Math.cos(2 * Math.PI * k / N); sn[k] = Math.sin(2 * Math.PI * k / N); }
  // pemetaan baris (log) -> bin: rentang sempit diinterpolasi, rentang lebar diambil nilai maksimumnya
  const ratio = fmax / SPEC_FMIN, posOf = (r: number): number => SPEC_FMIN * Math.pow(ratio, r / (R - 1)) / binHz;
  const rLo = new Int32Array(R), rHi = new Int32Array(R), rFr = new Float32Array(R);
  for (let r = 0; r < R; r++) {
    const e0 = posOf(r - .5), e1 = posOf(r + .5), c = posOf(r);
    if (e1 - e0 < 1) { rLo[r] = Math.min(half - 1, Math.floor(c)); rFr[r] = c - rLo[r]; rHi[r] = -1; }
    else { rLo[r] = Math.max(0, Math.floor(e0)); rHi[r] = Math.min(half, Math.ceil(e1)); }
  }
  const d = new Uint8Array(frames * R), hist = new Float64Array(256), re = new Float32Array(N), im = new Float32Array(N);
  const m1 = new Float32Array(half + 1), m2 = new Float32Array(half + 1), norm = 1 / ((N / 4) * (N / 4)), nch = buf.numberOfChannels;
  const chans: Float32Array[] = []; for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
  const fill = (f: number, out: Float32Array): void => {
    const st = f * hop - half;
    for (let n = 0; n < N; n++) {
      const i = st + n; let v = 0;
      if (i >= 0 && i < len) { for (let c = 0; c < nch; c++) v += chans[c][i]; v /= nch; }
      out[n] = v * win[n];
    }
  };
  const x1 = new Float32Array(N), x2 = new Float32Array(N);
  const rows = (m: Float32Array, f: number): void => {
    for (let r = 0; r < R; r++) {
      let v: number;
      if (rHi[r] < 0) v = m[rLo[r]] * (1 - rFr[r]) + m[rLo[r] + 1] * rFr[r];
      else { v = 0; for (let i = rLo[r]; i < rHi[r]; i++) if (m[i] > v) v = m[i]; }
      const q = Math.max(0, Math.min(255, Math.round((10 * Math.log10(v * norm + 1e-12) + 100) * 2.55)));
      d[f * R + r] = q; hist[q]++;
    }
  };
  let t0 = performance.now();
  for (let f = 0; f < frames; f += 2) {
    const two = f + 1 < frames;
    fill(f, x1); if (two) fill(f + 1, x2); else x2.fill(0);
    for (let i = 0; i < N; i++) { re[rev[i]] = x1[i]; im[rev[i]] = x2[i]; }
    for (let size = 2; size <= N; size <<= 1) {
      const h = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < h; j++, k += step) {
        const a = i + j, b = a + h, tr = re[b] * cs[k] + im[b] * sn[k], ti = im[b] * cs[k] - re[b] * sn[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let k = 0; k <= half; k++) {   // pisahkan dua spektrum nyata dari satu FFT kompleks
      const kk = (N - k) % N, ar = (re[k] + re[kk]) / 2, ai = (im[k] - im[kk]) / 2, br = (im[k] + im[kk]) / 2, bi = -(re[k] - re[kk]) / 2;
      m1[k] = ar * ar + ai * ai; m2[k] = br * br + bi * bi;
    }
    rows(m1, f); if (two) rows(m2, f + 1);
    if (performance.now() - t0 > 12) {
      onProgress(Math.min(99, Math.round(100 * f / frames)));
      await new Promise<void>(r => setTimeout(r, 0));
      if (!alive()) return null;
      t0 = performance.now();
    }
  }
  let acc = 0, top = 255; const lim = frames * R * 0.0005;   // puncak = persentil 99,95 supaya satu klik keras tidak meredupkan semuanya
  for (; top > 0; top--) { acc += hist[top]; if (acc >= lim) break; }
  return { frames, hop, fmin: SPEC_FMIN, fmax, d, lut: makeLut(top) };
}

function paintDeriz(card: HTMLElement, fx: Fx): void {
  const cv = card.querySelector<HTMLCanvasElement>('.deriz__canvas');
  if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  const gl = Math.max(1, Math.round(dpr)), z = fx.deriz, sp = z?.spec;
  if (!z || !sp) {   // belum ada audio / masih dianalisis: grid layar kosong
    g.fillStyle = 'rgba(255,255,255,.05)';
    for (let i = 1; i < 8; i++) g.fillRect(Math.round(W * i / 8), 0, gl, H);
    g.fillRect(0, Math.round(H * .25), W, gl); g.fillRect(0, Math.round(H * .75), W, gl);
    const cl = g.createLinearGradient(0, 0, W, 0);
    cl.addColorStop(0, 'rgba(255,255,255,0)'); cl.addColorStop(.5, 'rgba(255,255,255,.26)'); cl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cl; g.fillRect(0, Math.round(H / 2 - gl / 2), W, gl);
    return;
  }
  const pad = Math.round(DERIZ_PAD * dpr), cols = Math.max(1, W - pad * 2), R = SPEC_ROWS, d = sp.d, lut = sp.lut;
  const img = g.createImageData(cols, H), px = new Uint32Array(img.data.buffer);
  const s0 = z.view * z.buf.length, span = z.buf.length / z.zoom, vec = new Float32Array(R);
  const rA = new Int32Array(H), rT = new Float32Array(H);   // baris layar -> baris spektrogram (0 = frekuensi terendah, di bawah)
  for (let y = 0; y < H; y++) { const rp = Math.max(0, Math.min(R - 1, (1 - (y + .5) / H) * (R - 1))); rA[y] = Math.min(R - 2, Math.floor(rp)); rT[y] = rp - rA[y]; }
  for (let x = 0; x < cols; x++) {
    const p0 = (s0 + x / cols * span) / sp.hop, p1 = (s0 + (x + 1) / cols * span) / sp.hop;
    if (p1 - p0 > 1) {   // zoom out: banyak frame per kolom -> ambil yang paling keras (transien tidak hilang)
      const a = Math.max(0, Math.min(sp.frames - 1, Math.floor(p0))), b = Math.max(a, Math.min(sp.frames - 1, Math.ceil(p1)));
      vec.fill(0);
      for (let f = a; f <= b; f++) for (let r = 0, o = f * R; r < R; r++) if (d[o + r] > vec[r]) vec[r] = d[o + r];
    } else {   // zoom in: interpolasi linear antar dua frame
      const p = Math.max(0, Math.min(sp.frames - 1, (p0 + p1) / 2)), fa = Math.min(sp.frames - 1, Math.floor(p)), fb = Math.min(sp.frames - 1, fa + 1), ft = p - fa;
      for (let r = 0; r < R; r++) vec[r] = d[fa * R + r] * (1 - ft) + d[fb * R + r] * ft;
    }
    for (let y = 0; y < H; y++) { const a = rA[y], v = vec[a] * (1 - rT[y]) + vec[a + 1] * rT[y]; px[y * cols + x] = lut[v | 0]; }
  }
  g.putImageData(img, pad, 0);
  // sumbu frekuensi (100 Hz, 1 kHz, 10 kHz)
  g.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`; g.textBaseline = 'bottom';
  for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']] as [number, string][]) {
    if (f <= sp.fmin || f >= sp.fmax) continue;
    const y = Math.round((1 - Math.log(f / sp.fmin) / Math.log(sp.fmax / sp.fmin)) * H);
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(pad, y, cols, gl);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(label, pad + 4 * dpr, y - 2 * dpr);
  }
}

const tabNames = (d: EffectDef): string[] => [...new Set(d.params.map(p => p.tab).filter((t): t is string => !!t))];

function cardHtml(fx: Fx, i: number): string {
  const d = defOf(fx.type), tabs = tabNames(d), cur = Math.min(fx.tab ?? 0, Math.max(0, tabs.length - 1));
  // plugin dengan kategori: tab di baris judul (tinggi card tetap sama dengan Reverb / EQ), tiap tab punya panel kontrolnya sendiri
  const tabBar = tabs.length
    ? `<div class="fxc__tabs" role="tablist" aria-label="Kategori ${d.name}">` +
      tabs.map((t, k) => `<button type="button" role="tab" class="fxc__tab" data-tab="${k}" aria-selected="${k === cur}">${t}</button>`).join('') + `</div>`
    : '';
  const body = fx.type === 'deriz' ? derizHtml(fx) : tabs.length
    ? tabs.map((t, k) => `<div class="fxc__knobs fxc__panel" role="tabpanel" data-tab="${k}"${k === cur ? '' : ' hidden'}>${d.params.filter(p => p.tab === t).map(p => cellHtml(d, fx, p)).join('')}</div>`).join('')
    : `<div class="fxc__knobs">${d.params.map(p => cellHtml(d, fx, p)).join('')}</div>`;
  return `<section class="fxc${fx.on ? '' : ' is-off'}${fx.min ? ' is-min' : ''}${tabs.length ? ' has-tabs' : ''}${fx.type === 'deriz' ? ' fxc--deriz' : ''}" data-fx="${fx.id}" style="--i:${i}" aria-label="${d.name}">` +
    `<header class="fxc__head"><h3 class="fxc__name"><button type="button" class="fxc__title" aria-expanded="${!fx.min}" title="Klik untuk minimize / maximize">${d.name}</button></h3>${tabBar}` +
    `<button type="button" class="fxc__pwr" role="switch" aria-checked="${fx.on}" aria-label="${d.name} nyala / mati" title="Nyala / mati"></button>` +
    (d.synth ? '' : `<button type="button" class="fxc__more" aria-haspopup="menu" aria-expanded="false" aria-label="Opsi ${d.name}" title="Opsi">${ICON_MORE}</button>`) + `</header>` +
    `<div class="fxc__collapse"><div class="fxc__body">${body}</div></div></section>`;
}

export interface FxRack {
  show(track: string | null): void;   // tampilkan efek milik track ini (null = tidak ada track terpilih)
  drop(track: string): void;          // track dihapus: buang efeknya
  addInstrument(track: string, type: 'supersaw'): void;   // track synth baru: pasang plugin instrumennya (kartu di paling atas)
  closePicker(instant?: boolean): void;
}

export function initFxRack(): FxRack {
  const addBtn = document.getElementById('fxAdd') as HTMLButtonElement;
  const list = document.getElementById('fxList')!;
  const bodyEl = addBtn.closest('.fx__body') as HTMLElement;
  const topEl = addBtn.closest('.fx__top') as HTMLElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fxs = () => (cur ? racks.get(cur) ?? [] : []);
  const find = (el: Element | null) => {
    const id = el?.closest<HTMLElement>('.fxc')?.dataset.fx;
    return fxs().find(f => String(f.id) === id);
  };

  // canvas DERIZ digambar ulang saat ukurannya berubah (panel efek dibuka / ditutup, layar diputar)
  const ro = new ResizeObserver(es => es.forEach(en => {
    const card = (en.target as Element).closest<HTMLElement>('.fxc'), fx = card && find(card);
    if (card && fx) paintDeriz(card, fx);
  }));
  const watch = (card: Element): void => { const cv = card.querySelector('.deriz__canvas'); if (cv) ro.observe(cv); };

  // Tombol "+": di atas saat belum ada efek, pindah ke bawah daftar setelah ada efek (dengan animasi geser halus)
  function layout(animate: boolean): void {
    const has = fxs().length > 0;
    if (bodyEl.classList.contains('has-fx') === has) return;
    const first = topEl.getBoundingClientRect().top;
    bodyEl.classList.toggle('has-fx', has);
    if (!animate || reduce) return;
    const dy = first - topEl.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) topEl.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.34,1.3,.64,1)' });
  }

  // ---------- tooltip putih saat knob diputar (kelas & gaya sama dengan tooltip knob pan) ----------
  const tip = document.createElement('div');
  tip.className = 'pan-tip'; tip.hidden = true; tip.setAttribute('role', 'status');
  document.body.appendChild(tip);
  let tipTimer = 0;
  const hideTip = () => { tip.hidden = true; };
  const showTip = (knob: HTMLElement, text: string, ms = 0) => {
    tip.textContent = text; tip.hidden = false;
    const r = knob.getBoundingClientRect(), w = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w.width / 2, innerWidth - w.width - 8)) + 'px';
    tip.style.top = (r.top - w.height - 8 < 8 ? r.bottom + 8 : r.top - w.height - 8) + 'px';
    clearTimeout(tipTimer);
    if (ms) tipTimer = window.setTimeout(hideTip, ms);
  };

  // ---------- card pilihan efek, muncul di dekat tombol + ----------
  let pick: HTMLElement | null = null;

  const closePicker = (instant = false) => {
    const el = pick; if (!el) return;
    pick = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    addBtn.setAttribute('aria-expanded', 'false');
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  };
  const onOutside = (e: PointerEvent) => { const t = e.target as Node; if (!pick?.contains(t) && !addBtn.contains(t)) closePicker(); };
  const onResize = () => closePicker(true);
  const onKey = (e: KeyboardEvent) => {   // Esc menutup card pilihan dari mana pun fokusnya
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    closePicker(); addBtn.focus({ preventScroll: true });
  };

  const openPicker = () => {
    if (pick || !cur) return;
    closeMenu(true);
    const have = new Set(fxs().map(f => f.type));
    const choices = EFFECTS.filter(d => !d.synth);   // plugin instrumen tidak dipilih manual
    const el = document.createElement('div');
    el.className = 'fx-pick';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Pilih efek');
    el.innerHTML = choices.map((d, k) => {
      const used = have.has(d.type);
      return `<button type="button" role="menuitem" class="fx-pick__item" data-type="${d.type}" style="--i:${k}"${used ? ' disabled title="Sudah ditambahkan"' : ''}>` +
        `<span>${d.name}</span></button>`;
    }).join('');
    document.body.appendChild(el);
    const r = addBtn.getBoundingClientRect(), w = Math.min(220, innerWidth - 16), h = el.offsetHeight;
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    // buka ke bawah tombol; kalau tidak muat (tombol sekarang di bagian bawah), buka ke atas
    const below = r.bottom + 10, above = r.top - 10 - h;
    el.style.top = Math.max(8, below + h > innerHeight - 8 && above >= 8 ? above : Math.min(below, innerHeight - h - 8)) + 'px';
    el.style.transformOrigin = below + h > innerHeight - 8 && above >= 8 ? 'bottom center' : 'top center';
    pick = el;
    addBtn.setAttribute('aria-expanded', 'true');
    el.addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLButtonElement>('.fx-pick__item');
      if (!b || b.disabled) return;
      addEffect(b.dataset.type as FxType);
      closePicker();
      addBtn.focus({ preventScroll: true });
    });
    el.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan
    el.addEventListener('keyup', e => e.stopPropagation());
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    el.querySelector<HTMLButtonElement>('.fx-pick__item:not(:disabled)')?.focus({ preventScroll: true });
  };

  addBtn.addEventListener('click', () => { pick ? closePicker() : openPicker(); });

  // ---------- menu titik tiga (Delete) ----------
  let menu: HTMLElement | null = null, menuBtn: HTMLButtonElement | null = null;

  function closeMenu(instant = false): void {
    const el = menu; if (!el) return;
    menu = null;
    menuBtn?.setAttribute('aria-expanded', 'false'); menuBtn = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', onMenuResize);
    window.removeEventListener('scroll', onMenuResize, true);
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  }
  const onMenuOutside = (e: PointerEvent) => { const t = e.target as Node; if (!menu?.contains(t) && !menuBtn?.contains(t)) closeMenu(); };
  const onMenuResize = () => closeMenu(true);
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    const b = menuBtn; closeMenu(); b?.focus({ preventScroll: true });
  };

  function openMenu(btn: HTMLButtonElement, card: HTMLElement): void {
    closePicker(true); closeMenu(true);
    const el = document.createElement('div');
    el.className = 'track-menu fx-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = '<button type="button" role="menuitem" class="track-menu__item track-menu__item--danger">Delete</button>';
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - h - 8)) + 'px';
    el.style.transformOrigin = 'top right';
    menu = el; menuBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    el.querySelector('button')!.addEventListener('click', () => { closeMenu(true); removeEffect(card); });
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', onMenuResize);
    window.addEventListener('scroll', onMenuResize, true);
    el.querySelector<HTMLButtonElement>('button')!.focus({ preventScroll: true });
  }

  // ---------- kartu efek ----------
  const paintAll = (card: HTMLElement, fx: Fx) => {
    const d = defOf(fx.type);
    card.querySelectorAll<HTMLElement>(CTL).forEach(k => {
      const p = d.params.find(x => x.key === k.dataset.k)!;
      paintCtl(k, fx.v[p.key], p, d.name);
    });
  };

  function addEffect(type: FxType): void {
    if (!cur) return;
    const d = defOf(type), v: Record<string, number> = {};
    d.params.forEach(p => { v[p.key] = p.def; });
    const fx: Fx = { id: ++seq, type, on: true, min: false, v };
    racks.set(cur, [...fxs(), fx]);
    applyAudio(cur);
    list.insertAdjacentHTML('beforeend', cardHtml(fx, 0));
    const card = list.lastElementChild as HTMLElement;
    paintAll(card, fx);
    watch(card);
    layout(true);
    card.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  // plugin instrumen (mis. Supersaw): ditambahkan otomatis saat track synth dibuat, selalu di paling atas, hanya satu per track
  function addInstrument(trackId: string | number, type: FxType): void {
    const track = String(trackId);   // id track dari dataset selalu string; kunci Map harus sama
    const rack = racks.get(track) ?? [];
    if (rack.some(f => f.type === type)) return;
    const d = defOf(type), v: Record<string, number> = {};
    d.params.forEach(p => { v[p.key] = p.def; });
    const fx: Fx = { id: ++seq, type, on: true, min: false, v };
    racks.set(track, [fx, ...rack]);
    applyAudio(track);
    if (track !== cur) return;   // track lain belum dipilih: kartu digambar saat show()
    list.insertAdjacentHTML('afterbegin', cardHtml(fx, 0));
    paintAll(list.firstElementChild as HTMLElement, fx);
    layout(true);
  }

  function removeEffect(card: HTMLElement): void {
    const fx = find(card); if (!fx || !cur || defOf(fx.type).synth) return;
    hideTip();
    racks.set(cur, fxs().filter(f => f !== fx));
    applyAudio(cur);
    if (pick) closePicker(true);
    const done = () => { card.querySelectorAll('canvas').forEach(c => ro.unobserve(c)); card.remove(); layout(true); };
    if (reduce) { done(); return; }
    const h = card.offsetHeight, mb = parseFloat(getComputedStyle(card).marginBottom) || 0;
    card.style.overflow = 'hidden'; card.style.pointerEvents = 'none';
    card.animate([
      { height: h + 'px', marginBottom: mb + 'px', opacity: 1, transform: 'translateX(0) scale(1)' },
      { opacity: 0, transform: 'translateX(36px) scale(.94)', offset: .5 },
      { height: '0px', marginBottom: '0px', opacity: 0, transform: 'translateX(36px) scale(.94)' }
    ], { duration: 380, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).onfinish = done;
  }

  // ---------- knob: drag (atas/kanan = naik), panah keyboard, dobel klik = reset ke nilai awal ----------
  let drag: { el: HTMLElement; fx: Fx; p: Param; sx: number; sy: number; sv: number; box: DOMRect | null } | null = null;
  const sliderVal = (box: DOMRect, y: number): number => 1 - (y - box.top - 7) / Math.max(1, box.height - 14);   // 7 px = setengah tinggi pegangan
  const ctx = (el: HTMLElement) => {
    const fx = find(el); if (!fx) return null;
    const p = defOf(fx.type).params.find(x => x.key === el.dataset.k)!;
    return { fx, p };
  };
  const setVal = (el: HTMLElement, fx: Fx, p: Param, n: number) => {
    const v = Math.max(0, Math.min(1, n));
    fx.v[p.key] = v;
    paintCtl(el, v, p, defOf(fx.type).name);
    if (cur) applyAudio(cur);
    if (!tip.hidden) showTip(el, p.fmt(v));
  };

  list.addEventListener('pointerdown', e => {
    const el = (e.target as Element).closest<HTMLElement>(CTL); if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const c = ctx(el); if (!c) return;
    drag = { el, fx: c.fx, p: c.p, sx: e.clientX, sy: e.clientY, sv: c.fx.v[c.p.key], box: c.p.slider ? el.getBoundingClientRect() : null };
    el.classList.add('is-dragging'); el.setPointerCapture(e.pointerId); e.preventDefault();
    el.focus({ preventScroll: true });
    if (drag.box) setVal(el, c.fx, c.p, sliderVal(drag.box, e.clientY));   // slider: pegangan langsung lompat ke titik yang disentuh
    showTip(el, c.p.fmt(c.fx.v[c.p.key]));
  });
  list.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.box) { setVal(drag.el, drag.fx, drag.p, sliderVal(drag.box, e.clientY)); return; }
    setVal(drag.el, drag.fx, drag.p, drag.sv + ((drag.sy - e.clientY) + (e.clientX - drag.sx)) / DRAG_PX);
  });
  const endDrag = () => { if (!drag) return; drag.el.classList.remove('is-dragging'); drag = null; hideTip(); };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);
  list.addEventListener('lostpointercapture', endDrag);
  list.addEventListener('dblclick', e => {
    const el = (e.target as Element).closest<HTMLElement>(CTL); if (!el) return;
    const c = ctx(el); if (!c) return;
    showTip(el, c.p.fmt(c.p.def), 900); setVal(el, c.fx, c.p, c.p.def);
  });
  list.addEventListener('keydown', e => {
    const el = (e.target as Element).closest<HTMLElement>(CTL); if (!el) return;
    const up = e.key === 'ArrowUp' || e.key === 'ArrowRight', down = e.key === 'ArrowDown' || e.key === 'ArrowLeft';
    if (!up && !down) return;
    const c = ctx(el); if (!c) return;
    e.preventDefault(); e.stopPropagation();   // panah tidak ikut memicu mundur / maju milik DAW
    setVal(el, c.fx, c.p, Math.round((c.fx.v[c.p.key] + (up ? 0.02 : -0.02)) * 100) / 100);
    showTip(el, c.p.fmt(c.fx.v[c.p.key]), 900);
  });
  list.addEventListener('blur', e => { if ((e.target as Element).matches?.(CTL) && !drag) hideTip(); }, true);

  // ---------- DERIZ: upload audio ke canvas (tombol, "Ganti", atau drag & drop file) ----------
  async function loadDeriz(card: HTMLElement, file: File): Promise<void> {
    const fx = find(card); if (!fx) return;
    const stage = card.querySelector<HTMLElement>('.deriz__stage')!, name = card.querySelector<HTMLElement>('.deriz__pos')!;
    const warn = (msg: string): void => {   // pesan singkat di baris label, lalu kembali ke keadaan semula
      stage.classList.remove('is-loading', 'is-shake'); void stage.offsetWidth; stage.classList.add('is-shake');
      name.textContent = msg;
      window.setTimeout(() => { if (card.isConnected) updateDerizUi(card, fx); }, 2400);
    };
    if (!isAudio(file)) { warn('Bukan file audio'); return; }
    const my = fx.tok = (fx.tok ?? 0) + 1;   // upload yang lebih baru membatalkan yang lama
    stage.classList.add('is-loading'); name.textContent = 'Memuat…';
    try {
      const buf = await decodeStandalone(file);
      if (my !== fx.tok) return;
      fx.deriz = { name: file.name, dur: buf.duration, buf, start: 0, zoom: 1, view: 0, spec: null, busy: 0 };
    } catch (err) {
      console.error(err);
      if (my === fx.tok) warn('File tidak bisa dibaca');
      return;
    }
    const live = list.querySelector<HTMLElement>(`.fxc[data-fx="${fx.id}"]`);   // kartu bisa saja sudah dihapus / track diganti selama decode
    if (!live) return;
    updateDerizUi(live, fx); paintDeriz(live, fx);
    // analisis spektrogram di latar; label menampilkan persennya, hasilnya digambar begitu selesai
    const z = fx.deriz, cardOf = (): HTMLElement | null => list.querySelector<HTMLElement>(`.fxc[data-fx="${fx.id}"]`);
    if (!z) return;
    const spec = await computeSpec(z.buf, pct => { z.busy = pct; const c = cardOf(); if (c && fx.deriz === z) c.querySelector('.deriz__pos')!.textContent = posText(z); }, () => fx.deriz === z && fx.tok === my);
    if (!spec || fx.deriz !== z) return;
    z.spec = spec; z.busy = undefined;
    const c2 = cardOf(); if (c2) { updateDerizUi(c2, fx); paintDeriz(c2, fx); }
  }
  list.addEventListener('change', e => {
    const inp = e.target as HTMLInputElement;
    if (!inp.matches?.('.deriz__file')) return;
    const card = inp.closest<HTMLElement>('.fxc'), f = inp.files?.[0];
    inp.value = '';
    if (card && f) void loadDeriz(card, f);
  });
  const dropZone = (e: Event) => (e.target as Element).closest<HTMLElement>('.deriz__stage');
  list.addEventListener('dragover', e => { const z = dropZone(e); if (!z) return; e.preventDefault(); z.classList.add('is-over'); });
  list.addEventListener('dragleave', e => { dropZone(e)?.classList.remove('is-over'); });
  list.addEventListener('drop', e => {
    const z = dropZone(e); if (!z) return;
    e.preventDefault(); z.classList.remove('is-over');
    const card = z.closest<HTMLElement>('.fxc'), f = e.dataTransfer?.files?.[0];
    if (card && f) void loadDeriz(card, f);
  });

  // ---------- DERIZ: garis start. Drag garisnya (atau tap / klik di mana saja pada canvas untuk memindahkan), panah keyboard menggeser, dobel klik = kembali ke 0 ----------
  const winAt = (stage: HTMLElement, x: number): number => {   // posisi x dalam jendela yang terlihat, 0..1
    const r = stage.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left - DERIZ_PAD) / Math.max(1, r.width - DERIZ_PAD * 2)));
  };
  const fracAt = (stage: HTMLElement, x: number, z: DerizData): number => Math.max(0, Math.min(1, z.view + winAt(stage, x) / z.zoom));   // posisi global 0..1 dari durasi
  const setStart = (card: HTMLElement, fx: Fx, f: number, tipMs = -1): void => {   // tipMs: -1 tanpa tooltip, 0 tooltip menetap, >0 hilang otomatis
    const z = fx.deriz; if (!z) return;
    z.start = Math.max(0, Math.min(1, f));
    const mk = card.querySelector<HTMLElement>('.deriz__start')!;
    updateZoomUi(card, z);
    card.querySelector('.deriz__pos')!.textContent = posText(z);
    mk.setAttribute('aria-valuenow', z.start.toFixed(4)); mk.setAttribute('aria-valuetext', posText(z));
    if (tipMs >= 0) showTip(mk, fmtPos(z.start * z.dur), tipMs);
  };
  let sd: { stage: HTMLElement; card: HTMLElement; fx: Fx; sx: number; off: number; drag: boolean } | null = null;
  list.addEventListener('pointerdown', e => {
    const stage = (e.target as Element).closest<HTMLElement>('.deriz__stage.has-audio'); if (!stage || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as Element).closest('.deriz__zoom, .deriz__nav')) return;   // tombol zoom / bar navigasi punya penanganan sendiri
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, e.clientX);
      if (touches.size === 2) { startPinch(stage); return; }   // dua jari = cubit untuk zoom
    }
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card); if (!card || !fx?.deriz) return;
    const lineX = stage.getBoundingClientRect().left + DERIZ_PAD + visS(fx.deriz) * (stage.clientWidth - DERIZ_PAD * 2);
    const near = Math.abs(e.clientX - lineX) <= 18;
    // mouse: langsung pindah + drag. Sentuh: hanya drag kalau menyentuh garisnya; sentuhan lain = tap (dihitung saat dilepas) supaya scroll panel tidak menggeser garis
    sd = { stage, card, fx, sx: e.clientX, off: near ? lineX - e.clientX : 0, drag: near || e.pointerType === 'mouse' };
    stage.setPointerCapture(e.pointerId); stage.classList.add('is-dragging');
    card.querySelector<HTMLElement>('.deriz__start')!.focus({ preventScroll: true });
    if (sd.drag) { setStart(card, fx, fracAt(stage, e.clientX + sd.off, fx.deriz), 0); e.preventDefault(); }
  });
  list.addEventListener('pointermove', e => {
    if (sd?.drag) setStart(sd.card, sd.fx, fracAt(sd.stage, e.clientX + sd.off, sd.fx.deriz!), 0);
  });
  const endStart = (e: PointerEvent): void => {
    if (!sd) return;
    const s = sd; sd = null;
    s.stage.classList.remove('is-dragging'); hideTip();
    if (e.type === 'pointerup' && !s.drag && Math.abs(e.clientX - s.sx) < 8) setStart(s.card, s.fx, fracAt(s.stage, e.clientX, s.fx.deriz!), 900);   // tap
  };
  list.addEventListener('pointerup', endStart);
  list.addEventListener('pointercancel', endStart);
  list.addEventListener('dblclick', e => {
    const stage = (e.target as Element).closest<HTMLElement>('.deriz__stage.has-audio'); if (!stage || (e.target as Element).closest('.deriz__zoom, .deriz__nav')) return;
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card);
    if (card && fx?.deriz) setStart(card, fx, 0, 900);
  });
  list.addEventListener('keydown', e => {
    const mk = (e.target as Element).closest<HTMLElement>('.deriz__start'); if (!mk) return;
    const card = mk.closest<HTMLElement>('.fxc'), fx = card && find(card), z = fx?.deriz; if (!card || !fx || !z) return;
    const step = (e.shiftKey ? 0.05 : 0.01) / z.zoom;
    let f: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') f = z.start + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') f = z.start - step;
    else if (e.key === 'Home') f = 0; else if (e.key === 'End') f = 1;
    if (f === null) return;
    e.preventDefault(); e.stopPropagation();   // panah tidak ikut memicu mundur / maju milik DAW
    setStart(card, fx, f, 900);
  });

  // ---------- DERIZ: zoom canvas. Tombol + / - / reset, Ctrl+scroll (juga cubit di trackpad), cubit dua jari, bar navigasi di bawah untuk geser ----------
  const maxZoom = (z: DerizData): number => (z.spec ? Math.max(1, Math.min(2000, z.spec.frames / 10)) : 1);   // jendela terkecil kira-kira 10 frame analisis (lebih kecil dari itu tidak ada detail baru)
  const setView = (card: HTMLElement, fx: Fx, zoom: number, ga: number, wa: number): void => {   // ga: titik global yang dijaga tetap di posisi jendela wa (0..1)
    const z = fx.deriz; if (!z) return;
    z.zoom = Math.max(1, Math.min(maxZoom(z), zoom));
    z.view = Math.max(0, Math.min(1 - 1 / z.zoom, ga - wa / z.zoom));
    updateZoomUi(card, z); paintDeriz(card, fx);
  };
  const touches = new Map<number, number>();
  let pinch: { card: HTMLElement; fx: Fx; stage: HTMLElement; d0: number; z0: number; ga: number } | null = null;
  const startPinch = (stage: HTMLElement): void => {
    if (sd) { sd.stage.classList.remove('is-dragging'); sd = null; hideTip(); }
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card), z = fx?.deriz; if (!card || !fx || !z) return;
    const [x1, x2] = [...touches.values()];
    pinch = { card, fx, stage, d0: Math.max(24, Math.abs(x1 - x2)), z0: z.zoom, ga: fracAt(stage, (x1 + x2) / 2, z) };
  };
  list.addEventListener('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, e.clientX);
    if (!pinch || touches.size < 2) return;
    const [x1, x2] = [...touches.values()];
    setView(pinch.card, pinch.fx, pinch.z0 * Math.max(1, Math.abs(x1 - x2)) / pinch.d0, pinch.ga, winAt(pinch.stage, (x1 + x2) / 2));   // titik di antara dua jari tetap di bawah jari
  });
  const endTouch = (e: PointerEvent): void => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  list.addEventListener('pointerup', endTouch); list.addEventListener('pointercancel', endTouch);
  list.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('.deriz__zb, .deriz__zv'); if (!b) return;
    const card = b.closest<HTMLElement>('.fxc'), fx = card && find(card), z = fx?.deriz; if (!card || !fx || !z) return;
    if (b.classList.contains('deriz__zv')) setView(card, fx, 1, 0, 0);
    else setView(card, fx, z.zoom * (b.dataset.z === 'in' ? 2 : .5), z.view + .5 / z.zoom, .5);   // zoom ke tengah jendela
  });
  list.addEventListener('wheel', e => {
    const stage = (e.target as Element).closest<HTMLElement>('.deriz__stage.has-audio'); if (!stage) return;
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card), z = fx?.deriz; if (!card || !fx || !z) return;
    if (e.ctrlKey || e.metaKey) {   // Ctrl / Cmd + scroll, atau cubit di trackpad: zoom ke arah kursor
      e.preventDefault();
      const wa = winAt(stage, e.clientX);
      setView(card, fx, z.zoom * Math.exp(-e.deltaY * 0.004), z.view + wa / z.zoom, wa);
    } else if (z.zoom > 1.001 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {   // Shift + scroll / geser horizontal: geser jendela
      e.preventDefault();
      setView(card, fx, z.zoom, z.view + ((e.deltaX || e.deltaY) / Math.max(1, stage.clientWidth)) / z.zoom * 1 + 0.5 / z.zoom, .5);
    }
  }, { passive: false });
  let nd: { card: HTMLElement; fx: Fx; nav: HTMLElement } | null = null;   // geser lewat bar navigasi (mouse / sentuh)
  const navTo = (x: number): void => {
    if (!nd) return;
    const r = nd.nav.getBoundingClientRect();
    setView(nd.card, nd.fx, nd.fx.deriz!.zoom, Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))), .5);
  };
  list.addEventListener('pointerdown', e => {
    const nav = (e.target as Element).closest<HTMLElement>('.deriz__nav'); if (!nav || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const card = nav.closest<HTMLElement>('.fxc'), fx = card && find(card); if (!card || !fx?.deriz) return;
    nd = { card, fx, nav }; nav.setPointerCapture(e.pointerId); e.preventDefault(); navTo(e.clientX);
  });
  list.addEventListener('pointermove', e => { if (nd) navTo(e.clientX); });
  list.addEventListener('pointerup', () => { nd = null; }); list.addEventListener('pointercancel', () => { nd = null; });

  // ---------- DERIZ: card miring 3D mengikuti kursor + kilau mengikuti arah cahaya (mouse saja; mati saat reduced-motion / drag garis start) ----------
  const untilt = (c: HTMLElement): void => { c.classList.remove('is-tilting'); c.style.setProperty('--rx', '0deg'); c.style.setProperty('--ry', '0deg'); c.style.setProperty('--mx', '50%'); c.style.setProperty('--my', '0%'); };
  list.addEventListener('pointermove', e => {
    if (reduce || e.pointerType !== 'mouse' || sd) return;
    const card = (e.target as Element).closest<HTMLElement>('.fxc--deriz');
    list.querySelectorAll<HTMLElement>('.fxc--deriz.is-tilting').forEach(c => { if (c !== card) untilt(c); });
    if (!card) return;
    const r = card.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    card.classList.add('is-tilting');
    card.style.setProperty('--ry', ((px - .5) * 7).toFixed(2) + 'deg'); card.style.setProperty('--rx', ((.5 - py) * 5).toFixed(2) + 'deg');
    card.style.setProperty('--mx', (px * 100).toFixed(1) + '%'); card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  });
  list.addEventListener('pointerleave', () => list.querySelectorAll<HTMLElement>('.fxc--deriz.is-tilting').forEach(untilt));

  list.addEventListener('click', e => {
    const t = e.target as Element, card = t.closest<HTMLElement>('.fxc');
    if (!card || t.matches('.deriz__file')) return;
    if (t.closest('.deriz__up, .deriz__swap')) { card.querySelector<HTMLInputElement>('.deriz__file')!.click(); return; }
    const more = t.closest<HTMLButtonElement>('.fxc__more');
    if (more) { menu && menuBtn === more ? closeMenu() : openMenu(more, card); return; }
    const tabBtn = t.closest<HTMLButtonElement>('.fxc__tab');   // ganti kategori plugin
    if (tabBtn) {
      const fx = find(card); if (!fx) return;
      fx.tab = +tabBtn.dataset.tab!;
      hideTip();
      card.querySelectorAll<HTMLElement>('.fxc__tab').forEach(b => b.setAttribute('aria-selected', String(b === tabBtn)));
      card.querySelectorAll<HTMLElement>('.fxc__panel').forEach(pn => { pn.hidden = pn.dataset.tab !== tabBtn.dataset.tab; });
      return;
    }
    const pwr = t.closest<HTMLButtonElement>('.fxc__pwr');
    if (pwr) {
      const fx = find(card); if (!fx || !cur) return;
      fx.on = !fx.on;
      card.classList.toggle('is-off', !fx.on);
      pwr.setAttribute('aria-checked', String(fx.on));
      applyAudio(cur);
      return;
    }
    const title = t.closest<HTMLButtonElement>('.fxc__title');   // klik nama efek: minimize / maximize
    if (title) {
      const fx = find(card); if (!fx) return;
      fx.min = !fx.min;
      hideTip();
      card.classList.toggle('is-min', fx.min);
      title.setAttribute('aria-expanded', String(!fx.min));
    }
  });
  // Space / Enter pada tombol di panel ini jangan ikut memicu play / pause milik DAW
  const guard = (e: KeyboardEvent) => { if ((e.key === ' ' || e.code === 'Space') && (e.target as Element).closest?.('button')) e.stopPropagation(); };
  document.getElementById('fxBody')!.addEventListener('keydown', guard);
  document.getElementById('fxBody')!.addEventListener('keyup', guard);

  return {
    show(track) {
      closePicker(true); closeMenu(true); hideTip(); drag = null; ro.disconnect();
      cur = track;
      addBtn.disabled = !track;
      list.replaceChildren();
      if (!track) { layout(false); return; }
      applyAudio(track);
      list.innerHTML = fxs().map((f, i) => cardHtml(f, i)).join('');
      list.querySelectorAll<HTMLElement>('.fxc').forEach(c => { const f = find(c); if (f) paintAll(c, f); watch(c); });
      layout(false);
    },
    drop(track) {
      racks.delete(track);
      setReverb(track, null); setEq(track, null); setSupersaw(track, null);
      if (cur === track) { closePicker(true); closeMenu(true); hideTip(); ro.disconnect(); cur = null; addBtn.disabled = true; list.replaceChildren(); layout(false); }
    },
    addInstrument,
    closePicker
  };
}
