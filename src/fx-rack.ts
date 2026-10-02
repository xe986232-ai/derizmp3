// Isi panel efek: tombol "+" bulat putih (di atas saat kosong, pindah ke bawah setelah ada efek), card gelap (gaya card track)
// untuk memilih efek, dan satu card per efek. Parameter diatur dengan knob seperti knob pan di channel mixer.
// Efek disimpan per track (kunci = id track); panel selalu menampilkan efek milik track yang sedang dipilih.
// Selain efek (Reverb, Equalizer) ada plugin instrumen (Supersaw): kartunya otomatis muncul di paling atas saat track synth dibuat,
// memakai knob + slider vertikal, dan tidak bisa dihapus / tidak muncul di daftar pilihan efek.
// Efek / plugin baru cukup ditambah ke EFFECTS (nama, parameter) dan ke applyAudio().
// DERIZ: plugin dengan canvas audio (waveform) + upload file; tahap ini baru menampilkan audio, belum memproses suara.

import { setReverb, setEq, reverbSeconds, eqDb, decodeStandalone, bucketPeaks } from './audio-engine';
import { isAudio, ACCEPT as AUDIO_ACCEPT } from './audio-upload-card';
import { setSupersaw, detuneCents, cutoffHz, attackSec, decaySec, releaseSec } from './synth-engine';

type FxType = 'reverb' | 'eq' | 'supersaw' | 'deriz';
// DERIZ: audio yang di-upload ke canvas plugin (buffer disimpan untuk tahap berikutnya; peaks + max khusus untuk menggambar waveform)
interface DerizData { name: string; dur: number; buf: AudioBuffer; peaks: Float32Array; max: number; start: number; cols?: { n: number; a: Float32Array }; }   // cols: cache min/max per kolom pixel device (dihitung ulang hanya kalau lebar canvas berubah)   // start: posisi garis start, 0..1 dari durasi
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
const posText = (z: DerizData | undefined): string => (z ? 'Start ' + fmtPos(z.start * z.dur) : 'Belum ada audio');
const DERIZ_PAD = 6;   // jarak kiri/kanan canvas: garis start di 0 / 1 dan ujung waveform sejajar, pegangan tidak terpotong

// Tinggi isi sama dengan card knob (Reverb / EQ): canvas 72 px (= tinggi knob) + satu baris label, dalam wadah .fxc__knobs yang sama.
function derizHtml(fx: Fx): string {
  const z = fx.deriz;
  return `<div class="fxc__knobs deriz"><div class="fxc__cell deriz__cell">` +
    `<div class="deriz__stage${z ? ' has-audio' : ''}" style="--s:${z ? z.start.toFixed(4) : 0}"><canvas class="deriz__canvas" role="img" aria-label="Waveform audio DERIZ"></canvas>` +
    `<div class="deriz__start" role="slider" tabindex="0" aria-label="Garis start" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${z ? z.start.toFixed(4) : 0}" aria-valuetext="${posText(z)}"></div>` +
    `<button type="button" class="deriz__up">${ICON_UP}<span>Upload audio</span></button><i class="deriz__glass" aria-hidden="true"></i></div>` +
    `<div class="fxc__label deriz__meta"><span class="deriz__pos">${posText(z)}</span>` +
    `<span class="deriz__dur"${z ? '' : ' hidden'}>${z ? fmtDur(z.dur) : ''}</span>` +
    `<button type="button" class="deriz__swap"${z ? '' : ' hidden'}>Ganti</button></div>` +
    `<input type="file" class="deriz__file" accept="${AUDIO_ACCEPT}" hidden></div></div>`;
}

function updateDerizUi(card: HTMLElement, fx: Fx): void {
  const z = fx.deriz;
  card.querySelector('.deriz__stage')!.classList.toggle('has-audio', !!z);
  card.querySelector('.deriz__stage')!.classList.remove('is-loading');
  card.querySelector('.deriz__pos')!.textContent = posText(z);
  card.querySelector<HTMLElement>('.deriz__stage')!.style.setProperty('--s', z ? z.start.toFixed(4) : '0');
  const dur = card.querySelector<HTMLElement>('.deriz__dur')!, swap = card.querySelector<HTMLElement>('.deriz__swap')!;
  dur.hidden = swap.hidden = !z;
  dur.textContent = z ? fmtDur(z.dur) : '';
}

// Min/max per kolom pixel device, dihitung dari SAMPLE ASLI (bukan dari peaks 1200 bucket) supaya tajam di lebar / dpr berapa pun.
// Semua channel digabung. Kalau sample lebih sedikit dari kolom (one-shot pendek di canvas lebar), nilainya diinterpolasi linear
// antar sample supaya tidak ada lubang datar. Hasil: [min0, max0, min1, max1, ...]
function columnPeaks(buf: AudioBuffer, cols: number): Float32Array {
  const out = new Float32Array(cols * 2), len = buf.length, spp = len / cols;
  for (let b = 0; b < cols; b++) { out[b * 2] = Infinity; out[b * 2 + 1] = -Infinity; }
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let b = 0; b < cols; b++) {
      let lo = out[b * 2], hi = out[b * 2 + 1];
      if (spp >= 1) {
        const s0 = Math.floor(b * spp), s1 = Math.min(len, Math.max(s0 + 1, Math.floor((b + 1) * spp)));
        for (let i = s0; i < s1; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      } else {
        const pos = b * spp, i0 = Math.min(len - 1, Math.floor(pos)), f = pos - i0, v = d[i0] * (1 - f) + d[Math.min(len - 1, i0 + 1)] * f;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      out[b * 2] = lo; out[b * 2 + 1] = hi;
    }
  }
  return out;
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
  g.setTransform(1, 0, 0, 1, 0, 0);   // gambar langsung dalam pixel device (1 kolom = 1 pixel device)
  g.clearRect(0, 0, W, H);
  const mid = H / 2;
  const gl = Math.max(1, Math.round(dpr));
  g.fillStyle = 'rgba(255,255,255,.05)';   // grid layar ala scope: 8 kolom waktu + garis +/-50% (juga tampil saat canvas masih kosong)
  for (let i = 1; i < 8; i++) g.fillRect(Math.round(W * i / 8), 0, gl, H);
  g.fillRect(0, Math.round(H * .25), W, gl); g.fillRect(0, Math.round(H * .75), W, gl);
  const cl = g.createLinearGradient(0, 0, W, 0);   // garis tengah memudar di kedua ujung
  cl.addColorStop(0, 'rgba(255,255,255,0)'); cl.addColorStop(.5, 'rgba(255,255,255,.26)'); cl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = cl; g.fillRect(0, Math.round(mid - gl / 2), W, gl);
  const z = fx.deriz;
  if (!z) return;
  const pad = Math.round(DERIZ_PAD * dpr), cols = Math.max(1, W - pad * 2);
  if (!z.cols || z.cols.n !== cols) z.cols = { n: cols, a: columnPeaks(z.buf, cols) };
  const a = z.cols.a, k = (mid - 4 * dpr) / Math.max(z.max, 0.05);   // normalisasi: puncak tertinggi hampir memenuhi tinggi canvas
  const top = new Float32Array(cols), bot = new Float32Array(cols), minH = Math.max(2, 2 * dpr);
  for (let x = 0; x < cols; x++) {
    let y0 = mid - a[x * 2 + 1] * k, y1 = mid - a[x * 2] * k;   // sample positif ke atas
    if (y1 - y0 < minH) { y0 = mid - minH / 2; y1 = mid + minH / 2; }   // bagian senyap tetap kelihatan sebagai garis tipis
    top[x] = y0; bot[x] = y1;
  }
  // satu polygon tersambung (bukan bar terpisah): kolom bersebelahan selalu nyambung, bentuknya meruncing mulus
  const acc = getComputedStyle(cv).getPropertyValue('--accent').trim() || '#a66cff';
  const gr = g.createLinearGradient(0, 0, 0, H);   // tepi berwarna aksen, inti terang: kesan gelombang bercahaya
  gr.addColorStop(0, acc); gr.addColorStop(.5, '#f4eeff'); gr.addColorStop(1, acc);
  g.fillStyle = gr; g.shadowColor = acc; g.shadowBlur = 9 * dpr;
  g.beginPath();
  g.moveTo(pad, top[0]);
  for (let x = 0; x < cols; x++) g.lineTo(pad + x + .5, top[x]);
  g.lineTo(pad + cols, top[cols - 1]);
  g.lineTo(pad + cols, bot[cols - 1]);
  for (let x = cols - 1; x >= 0; x--) g.lineTo(pad + x + .5, bot[x]);
  g.lineTo(pad, bot[0]);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
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
      const buf = await decodeStandalone(file), peaks = bucketPeaks(buf, 1200);
      let max = 0; for (let i = 0; i < peaks.length; i++) max = Math.max(max, Math.abs(peaks[i]));
      if (my !== fx.tok) return;
      fx.deriz = { name: file.name, dur: buf.duration, buf, peaks, max, start: 0 };
    } catch (err) {
      console.error(err);
      if (my === fx.tok) warn('File tidak bisa dibaca');
      return;
    }
    const live = list.querySelector<HTMLElement>(`.fxc[data-fx="${fx.id}"]`);   // kartu bisa saja sudah dihapus / track diganti selama decode
    if (!live) return;
    updateDerizUi(live, fx); paintDeriz(live, fx);
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
  const fracAt = (stage: HTMLElement, x: number): number => {
    const r = stage.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left - DERIZ_PAD) / Math.max(1, r.width - DERIZ_PAD * 2)));
  };
  const setStart = (card: HTMLElement, fx: Fx, f: number, tipMs = -1): void => {   // tipMs: -1 tanpa tooltip, 0 tooltip menetap, >0 hilang otomatis
    const z = fx.deriz; if (!z) return;
    z.start = Math.max(0, Math.min(1, f));
    const mk = card.querySelector<HTMLElement>('.deriz__start')!;
    card.querySelector<HTMLElement>('.deriz__stage')!.style.setProperty('--s', z.start.toFixed(4));
    card.querySelector('.deriz__pos')!.textContent = posText(z);
    mk.setAttribute('aria-valuenow', z.start.toFixed(4)); mk.setAttribute('aria-valuetext', posText(z));
    if (tipMs >= 0) showTip(mk, fmtPos(z.start * z.dur), tipMs);
  };
  let sd: { stage: HTMLElement; card: HTMLElement; fx: Fx; sx: number; off: number; drag: boolean } | null = null;
  list.addEventListener('pointerdown', e => {
    const stage = (e.target as Element).closest<HTMLElement>('.deriz__stage.has-audio'); if (!stage || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card); if (!card || !fx?.deriz) return;
    const lineX = stage.getBoundingClientRect().left + DERIZ_PAD + fx.deriz.start * (stage.clientWidth - DERIZ_PAD * 2);
    const near = Math.abs(e.clientX - lineX) <= 18;
    // mouse: langsung pindah + drag. Sentuh: hanya drag kalau menyentuh garisnya; sentuhan lain = tap (dihitung saat dilepas) supaya scroll panel tidak menggeser garis
    sd = { stage, card, fx, sx: e.clientX, off: near ? lineX - e.clientX : 0, drag: near || e.pointerType === 'mouse' };
    stage.setPointerCapture(e.pointerId); stage.classList.add('is-dragging');
    card.querySelector<HTMLElement>('.deriz__start')!.focus({ preventScroll: true });
    if (sd.drag) { setStart(card, fx, fracAt(stage, e.clientX + sd.off), 0); e.preventDefault(); }
  });
  list.addEventListener('pointermove', e => {
    if (sd?.drag) setStart(sd.card, sd.fx, fracAt(sd.stage, e.clientX + sd.off), 0);
  });
  const endStart = (e: PointerEvent): void => {
    if (!sd) return;
    const s = sd; sd = null;
    s.stage.classList.remove('is-dragging'); hideTip();
    if (e.type === 'pointerup' && !s.drag && Math.abs(e.clientX - s.sx) < 8) setStart(s.card, s.fx, fracAt(s.stage, e.clientX), 900);   // tap
  };
  list.addEventListener('pointerup', endStart);
  list.addEventListener('pointercancel', endStart);
  list.addEventListener('dblclick', e => {
    const stage = (e.target as Element).closest<HTMLElement>('.deriz__stage.has-audio'); if (!stage) return;
    const card = stage.closest<HTMLElement>('.fxc'), fx = card && find(card);
    if (card && fx?.deriz) setStart(card, fx, 0, 900);
  });
  list.addEventListener('keydown', e => {
    const mk = (e.target as Element).closest<HTMLElement>('.deriz__start'); if (!mk) return;
    const card = mk.closest<HTMLElement>('.fxc'), fx = card && find(card), z = fx?.deriz; if (!card || !fx || !z) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    let f: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') f = z.start + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') f = z.start - step;
    else if (e.key === 'Home') f = 0; else if (e.key === 'End') f = 1;
    if (f === null) return;
    e.preventDefault(); e.stopPropagation();   // panah tidak ikut memicu mundur / maju milik DAW
    setStart(card, fx, f, 900);
  });

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
