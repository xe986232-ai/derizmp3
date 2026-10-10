// PRINTER (Melody Printer): vokal masuk seperti kertas, melodinya keluar sebagai cetakan nada (MIDI).
//   upload / rekam vokal -> analisis pitch di Worker (mpcs-worker.ts) -> nada dibulatkan penuh (printer-midi.ts, tanpa knob)
//   -> dicetak di "kertas": print head bergeser ke kanan-kiri mengikuti pitch (sumbu x), kertas keluar ke bawah mengikuti waktu (sumbu y).
//   Keluaran: SAVE .MID (file) atau TEAR OFF (kirim ke pattern yang dipilih di timeline, lewat bridge yang dipasang main.ts).
// Kartunya ada di panel efek (fx-rack.ts) tapi plugin ini DISEMBUNYIKAN dari daftar tombol + (lihat PRINTER_HIDDEN); jendelanya dibuka dari kartu itu.
// Mesin MIDI murni ada di printer-midi.ts (dites: node tools/printer-midi.ts), suara di printer-sfx.ts.

import { ACCEPT as AUDIO_ACCEPT, isAudio } from './audio-upload-card';
import { snapTargets, toMono, type Note, type PitchTrack } from './mpcs-dsp';
import { notesToPrint, writeMidiFile, type PrintNote } from './printer-midi';
import { createSfx, type Sfx } from './printer-sfx';
import { saveBlob } from './mpcs-save';
import { DEMO, LIMITS } from './demo';
import { bringFront, dragWindow } from './win-drag';

/** Printer disembunyikan dari publik: tidak muncul di daftar plugin (tombol +). Hanya terlihat di `npm run dev`.
 *  Untuk membukanya ke publik nanti: ubah jadi `false`. Kode dan project yang sudah berisi kartu Printer tetap jalan. */
export const PRINTER_HIDDEN: boolean = !import.meta.env.DEV;

export interface PrinterNote { p: number; s: number; l: number; v: number }   // v: 0..1 (sama dengan bridge MGCHORD)
export interface PrinterBridge {
  bpm(): number;
  /** Tulis nada ke pattern yang dipilih (menggantikan isinya). Mengembalikan pesan kalau ada masalah / catatan, null kalau mulus. */
  send(notes: PrinterNote[], beats: number): string | null;
}
let bridge: PrinterBridge | null = null;
export const setPrinterBridge = (b: PrinterBridge): void => { bridge = b; };

const svg = (inner: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  up: svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>', 22),
  rec: svg('<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>', 16),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>', 16),
  play: svg('<path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/>', 16),
  print: svg('<path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="6" rx="1"/>', 16),
  tear: svg('<path d="M4 12h3l2-3 3 6 3-6 2 3h3"/>', 16),
  dl: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', 16),
  snd: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>', 16),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6"/>', 16),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 12)
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m: number): string => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const MUTE_KEY = 'derizmp3.printerMute', VOX_KEY = 'derizmp3.printerVocal', VOL_KEY = 'derizmp3.printerVocalVol', GRID_KEY = 'derizmp3.printerGrid';

interface Sess { name: string; pt: PitchTrack; notes: Note[]; buf: AudioBuffer }   // buf: audio asli (diputar bareng nadanya)
let root: HTMLElement | null = null, openFn: (() => void) | null = null;

/** Dibuka dari kartu Printer di panel efek (fx-rack.ts). */
export function openPrinter(): void {
  if (!root) build();
  openFn?.();
}

function build(): void {
  const el = document.createElement('div');
  el.className = 'prn'; el.hidden = true;
  const keyOpts = '<option value="off">Off</option>' + (['major', 'minor'] as const).map(m => `<optgroup label="${m === 'major' ? 'Mayor' : 'Minor'}">${NAMES.map((n, i) => `<option value="${i}-${m}">${n} ${m === 'major' ? 'mayor' : 'minor'}</option>`).join('')}</optgroup>`).join('');
  el.innerHTML =
    '<div class="prn__win is-off" role="dialog" aria-label="PRINTER" tabindex="-1">' +
      `<header class="prn__head"><i class="prn__led" aria-hidden="true"></i><span class="prn__title">PRINTER</span><div class="prn__lcd"><span class="prn__stat" role="status" aria-live="polite">READY</span></div>` +
        `<button type="button" class="prn__mute" aria-label="Suara printer" title="Suara printer">${ICON.snd}</button>` +
        `<button type="button" class="prn__close" aria-label="Tutup PRINTER">${ICON.close}</button></header>` +
      '<div class="prn__mid"><div class="prn__stage">' +
        '<canvas class="prn__cv" role="img" aria-label="Kertas cetak melodi. Seret naik turun untuk menggulung"></canvas>' +
        `<button type="button" class="prn__drop">${ICON.up}<span>Masukkan vokal</span><small>drop file audio, ketuk untuk memilih, atau tekan REC</small></button>` +
        '<div class="prn__crop" hidden>' +
          '<div class="prn__ch"><span>Trim audio</span><span class="prn__cl" role="status" aria-live="polite">0:00.0 – 0:00.0</span></div>' +
          '<canvas class="prn__wv" role="img" aria-label="Gelombang audio. Seret pegangan kiri dan kanan untuk memilih bagian yang dicetak, seret bagian tengah untuk menggeser"></canvas>' +
          '<div class="prn__cb">' +
            `<button type="button" class="prn__b prn__cprev" title="Dengar bagian yang dipilih">${ICON.play}<span>PREVIEW</span></button>` +
            '<button type="button" class="prn__b prn__call" title="Pilih seluruh audio">ALL</button>' +
            `<button type="button" class="prn__b prn__ccancel" title="Batalkan">${ICON.close}<span>CANCEL</span></button>` +
            `<button type="button" class="prn__b prn__cok" title="Cetak bagian yang dipilih">${ICON.print}<span>PRINT</span></button>` +
          '</div>' +
        '</div>' +
      '</div></div>' +
      '<div class="prn__prog">' +
        '<span class="prn__t prn__tc">0:00</span>' +
        '<div class="prn__track" role="slider" tabindex="0" aria-label="Posisi putar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="Klik / seret untuk loncat posisi"><i class="prn__fill"></i><i class="prn__knob"></i></div>' +
        '<span class="prn__t prn__tt">0:00</span>' +
      '</div>' +
      '<div class="prn__mix">' +
        '<button type="button" class="prn__vox" title="Putar vokal asli bareng nadanya saat PLAY (sinkron)" aria-pressed="true">VOCAL</button>' +
        '<input type="range" class="prn__vol" min="0" max="100" step="1" value="80" aria-label="Volume vokal">' +
        '<span class="prn__pct">80%</span>' +
      '</div>' +
      '<div class="prn__opts">' +
        '<label>BPM<input type="number" class="prn__bpm" min="30" max="300" step="1" inputmode="numeric" value="120"></label>' +
        '<label>Grid<select class="prn__grid"><option value="0">Off</option><option value="1">1/4</option><option value="0.5">1/8</option><option value="0.25" selected>1/16</option><option value="0.125">1/32</option></select></label>' +
        `<label>Key<select class="prn__key">${keyOpts}</select></label>` +
        '<label>Cetak<button type="button" class="prn__spd" title="Kecepatan cetak: FAST = beberapa detik, LIVE = sepanjang durasi vokal" aria-pressed="false">FAST</button></label>' +
      '</div>' +
      '<div class="prn__bar">' +
        `<button type="button" class="prn__b prn__rec" aria-label="Rekam vokal" title="Rekam vokal">${ICON.rec}<span>REC</span></button>` +
        `<button type="button" class="prn__b prn__play" aria-label="Dengar melodi" title="Putar sepanjang durasi: nada melodi + vokal asli (kalau VOCAL nyala), sinkron" disabled>${ICON.play}<span>PLAY</span></button>` +
        `<button type="button" class="prn__b prn__print" aria-label="Cetak ulang" title="Cetak ulang" disabled>${ICON.print}<span>PRINT</span></button>` +
        `<button type="button" class="prn__b prn__tear" aria-label="Sobek kertas: kirim ke pattern" title="Kirim nada ke pattern yang dipilih di timeline" disabled>${ICON.tear}<span>TEAR OFF</span></button>` +
        `<button type="button" class="prn__b prn__midi" aria-label="Simpan file MIDI" title="Simpan sebagai file .mid" disabled>${ICON.dl}<span>.MID</span></button>` +
      '</div>' +
      `<input type="file" class="prn__file" accept="${AUDIO_ACCEPT}" hidden>` +
    '</div>';
  document.body.appendChild(el);
  root = el;

  const q = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const win = q<HTMLElement>('.prn__win'), stat = q('.prn__stat'), stage = q('.prn__stage'), cv = q<HTMLCanvasElement>('.prn__cv'), g = cv.getContext('2d')!;
  const drop = q<HTMLButtonElement>('.prn__drop'), file = q<HTMLInputElement>('.prn__file');
  const bpmIn = q<HTMLInputElement>('.prn__bpm'), gridSel = q<HTMLSelectElement>('.prn__grid'), keySel = q<HTMLSelectElement>('.prn__key'), spdBtn = q<HTMLButtonElement>('.prn__spd'), voxBtn = q<HTMLButtonElement>('.prn__vox');
  try { const gv = localStorage.getItem(GRID_KEY); if (gv !== null && [...gridSel.options].some(o => o.value === gv)) gridSel.value = gv; } catch { /* abaikan */ }   // grid bawaan 1/16 (nada selalu menempel ke grid)
  const gridV = (): number => parseFloat(gridSel.value) || 0;
  const track = q<HTMLElement>('.prn__track'), tcEl = q('.prn__tc'), ttEl = q('.prn__tt'), volIn = q<HTMLInputElement>('.prn__vol'), pctEl = q('.prn__pct'), mixEl = q('.prn__mix');
  const recBtn = q<HTMLButtonElement>('.prn__rec'), playBtn = q<HTMLButtonElement>('.prn__play'), printBtn = q<HTMLButtonElement>('.prn__print'), tearBtn = q<HTMLButtonElement>('.prn__tear'), midBtn = q<HTMLButtonElement>('.prn__midi'), muteBtn = q<HTMLButtonElement>('.prn__mute');
  dragWindow({ root: el, move: win, handle: '.prn__head' });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let S: Sess | null = null, P: PrintNote[] = [], total = 0;   // total = panjang kertas (ketukan)
  let C: { buf: AudioBuffer; name: string; peaks: Float32Array; s: number; e: number } | null = null;   // sesi trim: audio yang baru dimuat, menunggu bagian yang dipilih (s..e, detik)
  let PL: PrintNote[] = [];   // nada untuk PLAY: waktu asli (tanpa grid) supaya pas dengan vokal; P (menempel grid) hanya untuk kertas / MIDI / pattern
  let TB = 0;               // posisi kertas: ketukan yang sedang berada di celah (kepala cetak)
  let headX = 0.5, headTo = 0.5;   // posisi kepala 0..1 (0 = nada terendah)
  let lo = 55, hi = 79;     // rentang nada yang digambar
  let W = 0, H = 0, dpr = 1, raf = 0, animating = false, ink = 0;
  let ac: AudioContext | null = null, sfx: Sfx | null = null, loadTok = 0, statT = 0;
  let live = false, jobId = 0, worker: Worker | null = null;
  const jobs = new Map<number, { ok: (m: any) => void; fail: (e: Error) => void }>();   // eslint-disable-line @typescript-eslint/no-explicit-any
  let vox = true; try { vox = localStorage.getItem(VOX_KEY) !== '0'; } catch { /* abaikan */ }   // putar vokal asli bareng nadanya (bawaan nyala)
  let voxSrc: AudioBufferSourceNode | null = null, voxGain: GainNode | null = null;
  let vol = 0.8; try { const v = parseInt(localStorage.getItem(VOL_KEY) ?? '', 10); if (v >= 0 && v <= 100) vol = v / 100; } catch { /* abaikan */ }   // volume vokal 0..1
  let pos = 0, scrubbing = false, mode: 'play' | 'print' | null = null;   // pos = posisi putar (detik)
  let mute = false; try { mute = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* abaikan */ }
  const K = 30, HEAD_H = 52, X0 = 30;   // K = piksel per ketukan; HEAD_H = tinggi badan printer di atas kertas; X0 = tepi kiri area nada

  // ---------- status (layar LCD) ----------
  const info = (): void => { stat.textContent = S ? (P.length ? `${P.length} NOTES · ${Math.round(bpm())} BPM` : 'PAPER JAM') : 'READY'; };
  const say = (m: string): void => { stat.textContent = m; clearTimeout(statT); };
  const flash = (m: string): void => { stat.textContent = m; clearTimeout(statT); statT = window.setTimeout(info, 2400); };
  const bpm = (): number => { const v = parseFloat(bpmIn.value); return v >= 30 && v <= 300 ? v : 120; };
  const syncMute = (): void => { muteBtn.innerHTML = mute ? ICON.mute : ICON.snd; muteBtn.setAttribute('aria-pressed', String(mute)); if (sfx) sfx.muted = mute; };
  syncMute();
  const voxLevel = (): number => vox ? vol : 0;
  const syncVox = (): void => {
    voxBtn.setAttribute('aria-pressed', String(vox)); mixEl.classList.toggle('is-off', !vox);
    volIn.value = String(Math.round(vol * 100)); pctEl.textContent = Math.round(vol * 100) + '%';
    if (voxGain) voxGain.gain.setTargetAtTime(voxLevel(), voxGain.context.currentTime, 0.02);
  };
  syncVox();
  const enable = (): void => { const has = P.length > 0; playBtn.disabled = printBtn.disabled = tearBtn.disabled = midBtn.disabled = !has || recording || !!C; win.classList.toggle('is-off', !S); };

  // ---------- worker (analisis pitch: sama dengan MPCS) ----------
  function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./mpcs-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') { say('READING ' + Math.round(m.p * 100) + '%'); return; }
      const j = jobs.get(m.id); if (!j) return;
      jobs.delete(m.id);
      if (m.type === 'error') j.fail(new Error(m.msg)); else j.ok(m);
    };
    worker.onerror = () => { jobs.forEach(j => j.fail(new Error('Worker gagal'))); jobs.clear(); };
    return worker;
  }
  const job = (msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> =>   // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((ok, fail) => { const id = ++jobId; jobs.set(id, { ok, fail }); getWorker().postMessage({ ...msg, id }, transfer); });

  const audio = (): AudioContext => {
    ac ??= new AudioContext(); sfx ??= createSfx(ac); sfx.muted = mute;
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  };

  // ---------- nada MIDI (tanpa knob: pembulatan penuh) ----------
  function rebuild(): void {
    if (!S) { P = []; PL = []; total = 0; return; }
    const kv = keySel.value, [r, m] = kv === 'off' ? [0, ''] : kv.split('-');
    const scale = kv === 'off' ? null : { root: +r, mode: m as 'major' | 'minor' };
    P = notesToPrint(S.notes, S.pt, { bpm: bpm(), grid: gridV(), scale });
    PL = gridV() > 0 ? notesToPrint(S.notes, S.pt, { bpm: bpm(), grid: 0, scale }) : P;   // tanpa grid: awal nada = awal vokal, tidak bergeser sampai ±1/2 langkah grid
    total = P.length ? Math.max(...P.map(n => n.s + n.l)) : 0;
    if (P.length) { lo = Math.min(...P.map(n => n.p)) - 1; hi = Math.max(...P.map(n => n.p)) + 1; if (hi - lo < 14) { const c = (hi + lo) / 2; lo = Math.floor(c - 7); hi = lo + 14; } }
    ink = P.length ? Math.min(1, P.length / 3) : 0;
  }

  // ---------- gambar ----------
  const layout = (): void => {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = stage.clientWidth; H = stage.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    draw();
  };
  const colW = (): number => (W - X0 * 2) / (hi - lo + 1);
  const xOfP = (p: number): number => X0 + (p - lo) * colW();
  function draw(): void {
    if (!W) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // badan printer
    const body = g.createLinearGradient(0, 0, 0, HEAD_H);
    body.addColorStop(0, '#d8d3c6'); body.addColorStop(1, '#a9a393');
    g.fillStyle = body; g.fillRect(0, 0, W, HEAD_H);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, HEAD_H - 1, W, 1);
    // rel kepala
    g.fillStyle = '#6d695d'; g.fillRect(14, 20, W - 28, 3);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(14, 19, W - 28, 1);
    // kertas
    const py = HEAD_H, pl = 8, pr = W - 8;
    g.save(); g.beginPath(); g.rect(pl, py, pr - pl, H - py); g.clip();
    g.fillStyle = '#f5f2e9'; g.fillRect(pl, py, pr - pl, H - py);
    // lubang tractor (ikut bergerak bersama kertas)
    const off = (TB * K) % 18; g.fillStyle = '#c9c4b3';
    for (let y = py + off - 18; y < H; y += 18) { g.beginPath(); g.arc(pl + 8, y, 2.4, 0, 6.3); g.arc(pr - 8, y, 2.4, 0, 6.3); g.fill(); }
    g.fillStyle = 'rgba(80,110,160,.1)'; g.fillRect(pl + 18, py, 1, H - py); g.fillRect(pr - 19, py, 1, H - py);
    // garis tiap nada C
    if (S && P.length) {
      // garis grid: tiap langkah grid (lebih tebal tiap ketukan, paling tebal tiap bar) supaya terlihat nada menempel di grid
      const gs = gridV() || 1;
      for (let b = Math.max(0, Math.floor((TB - (H - py) / K) / gs) * gs); b <= TB + 1e-9; b = Math.round((b + gs) * 1e6) / 1e6) {
        const y = py + (TB - b) * K; if (y < py || y > H) continue;
        const beat = Math.abs(b - Math.round(b)) < 1e-6, bar = beat && Math.round(b) % 4 === 0;
        g.fillStyle = bar ? 'rgba(80,110,160,.32)' : beat ? 'rgba(80,110,160,.18)' : 'rgba(80,110,160,.08)';
        g.fillRect(pl + 18, Math.round(y), pr - pl - 36, 1);
      }
      g.font = '600 9px system-ui,sans-serif'; g.textAlign = 'center';
      for (let p = lo; p <= hi; p++) if (p % 12 === 0) { const x = xOfP(p) + colW() / 2; g.fillStyle = 'rgba(80,110,160,.2)'; g.fillRect(x, py, 1, H - py); g.fillStyle = 'rgba(80,110,160,.55)'; g.fillText(noteName(p), x, py + 12); }
      // nada tercetak: baris paling baru ada di celah, makin lama makin turun
      const cw = colW();
      for (const n of P) {
        if (n.s > TB + 1e-9) continue;
        const bottom = py + (TB - n.s) * K, top = py + (TB - Math.min(TB, n.s + n.l)) * K;
        if (bottom < py || top > H) continue;
        const x = xOfP(n.p) + 1, w = Math.max(3, cw - 2);
        g.fillStyle = `rgba(22,24,40,${(0.55 + 0.4 * n.v / 127).toFixed(2)})`; g.fillRect(x, top, w, Math.max(2, bottom - top));
        g.fillStyle = 'rgba(245,242,233,.22)'; for (let y = Math.ceil(top / 4) * 4; y < bottom; y += 4) g.fillRect(x, y, w, 1);   // garis cetak dot-matrix
        if (cw >= 15 && bottom - top >= 11) { g.fillStyle = '#ffd9a8'; g.font = '700 8px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText(noteName(n.p), x + w / 2, Math.min(bottom - 3, H - 3)); }
      }
    } else {
      g.fillStyle = 'rgba(90,90,110,.4)'; g.font = '700 11px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText('NO PAPER', W / 2, py + 56);
    }
    // bayangan di bawah celah: kertas tampak keluar dari dalam mesin
    const sh = g.createLinearGradient(0, py, 0, py + 18); sh.addColorStop(0, 'rgba(0,0,0,.4)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.fillRect(pl, py, pr - pl, 18);
    g.restore();
    // celah kertas
    g.fillStyle = '#1b1a17'; g.beginPath(); g.roundRect(pl - 2, HEAD_H - 5, pr - pl + 4, 6, 3); g.fill();
    // kepala cetak
    const hx = Math.max(X0, Math.min(W - X0, X0 + headX * (W - X0 * 2)));
    g.fillStyle = '#5b574c'; g.fillRect(hx - 13, 11, 26, 20);
    g.fillStyle = ink ? '#e4572e' : '#8d897b'; g.fillRect(hx - 9, 14, 18, 9);   // kartrid tinta (abu-abu = tinta habis)
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(hx - 13, 11, 26, 2);
    g.fillStyle = '#1b1a17'; g.fillRect(hx - 2, 31, 4, HEAD_H - 36);   // jarum menuju celah
    if (animating) { g.fillStyle = 'rgba(255,200,120,.9)'; g.fillRect(hx - 2, HEAD_H - 6, 4, 3); }
  }

  // ---------- progres & animasi cetak ----------
  const lenSec = (): number => S && P.length ? Math.max(total * 60 / bpm(), S.buf.duration) : 0;   // panjang bar progres (detik): nada terakhir atau vokal, mana yang lebih panjang
  const fmt = (s: number): string => { const r = Math.max(0, Math.round(s)); return Math.floor(r / 60) + ':' + String(r % 60).padStart(2, '0'); };
  function updProg(preview?: number): void {
    const len = lenSec(), p = Math.max(0, Math.min(len, preview ?? pos)), f = len > 0 ? p / len : 0;
    track.style.setProperty('--p', f.toFixed(4));
    tcEl.textContent = fmt(p); ttEl.textContent = fmt(len);
    track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    track.setAttribute('aria-valuetext', `${fmt(p)} dari ${fmt(len)}`);
  }
  function stopVox(): void {
    if (voxSrc) { try { voxSrc.stop(); } catch { /* sudah berhenti */ } voxSrc.disconnect(); voxSrc = null; }
    voxGain?.disconnect(); voxGain = null;
  }
  function stopAnim(finish = false): void {
    cancelAnimationFrame(raf); animating = false; mode = null; sfx?.stop(); stopVox();
    if (finish) { TB = total; pos = Math.max(pos, total * 60 / bpm()); }
    headTo = 0.5; headX = 0.5; setBtns(); draw(); if (!scrubbing) updProg();
  }
  /** asLive: jalan sesuai durasi asli; withTones: mode PLAY (nada + vokal asli); from: mulai dari detik ke-berapa (hanya PLAY / LIVE). */
  function run(asLive: boolean, withTones: boolean, from = 0): void {
    if (!S || !P.length) return;
    const a = audio(); stopAnim();
    const spb = 60 / bpm(), len = lenSec();
    // PLAY: vokal asli ikut diputar dan kertas mengikuti jam audio, jadi nada, kertas, dan vokal selalu sejajar (beat 0 = detik 0 audio)
    const withVox = withTones && !!S.buf;
    from = asLive ? Math.max(0, Math.min(from, len - 0.05)) : 0;
    const dur = asLive ? Math.max(0.6, withTones ? len : total * spb) : reduce ? 0.01 : Math.min(4, Math.max(1.6, total * spb * 0.25));
    mode = withTones ? 'play' : 'print';
    animating = true; TB = Math.min(total, from / spb); pos = from;
    let next = P.findIndex(n => n.s >= TB - 1e-9); if (next < 0) next = P.length;   // nada yang sudah lewat tidak dibunyikan lagi (hanya untuk kertas / kepala cetak)
    let nextT = PL.findIndex(n => n.s * spb >= from - 1e-6); if (nextT < 0) nextT = PL.length;   // indeks nada yang dibunyikan (PLAY)
    const LOOK = 0.15;   // jadwalkan nada sampai 150 ms ke depan di jam audio, bukan dibunyikan saat frame animasi sempat jalan
    let ended = false;
    const startAt = a.currentTime + 0.06;   // jeda kecil supaya vokal dan nada mulai bersamaan
    if (withVox && from < S.buf.duration - 0.02) {
      voxSrc = a.createBufferSource(); voxSrc.buffer = S.buf;
      voxGain = a.createGain(); voxGain.gain.value = voxLevel();
      voxSrc.connect(voxGain).connect(a.destination); voxSrc.start(startAt, from);
    }
    setBtns();
    if (!withTones) sfx!.start();
    const frame = (): void => {
      if (!animating) return;
      const el = from + Math.max(0, a.currentTime - startAt);
      const u = Math.min(1, el / dur);
      TB = asLive ? Math.min(total, el / spb) : total * u;
      pos = asLive ? el : TB * spb;
      while (next < P.length && P[next].s <= TB) next++;
      if (withTones) {   // nada dijadwalkan tepat di jam audio yang sama dengan vokal: start = startAt + waktu nada (detik) - from
        while (nextT < PL.length && PL[nextT].s * spb <= el + LOOK) {
          const n = PL[nextT++];
          sfx!.tone(n.p, n.l * spb, n.v / 127, Math.max(0, startAt + n.s * spb - from - a.currentTime));
        }
      }
      const cur = P.find(n => n.s <= TB && TB < n.s + n.l);
      if (cur) { headTo = (cur.p - lo + 0.5) / (hi - lo + 1); if (!withTones) sfx!.zzt(cur.p, cur.v / 127); }
      else { const nx = P.find(n => n.s > TB); if (nx) headTo = (nx.p - lo + 0.5) / (hi - lo + 1); }
      headX += (headTo - headX) * 0.35;
      say((withTones ? 'PLAYING ' : 'PRINTING ') + Math.round(u * 100) + '%');
      draw(); if (!scrubbing) updProg();
      if (u < 1) { raf = requestAnimationFrame(frame); return; }
      if (!ended) { ended = true; animating = false; sfx!.stop(); if (!withTones) sfx!.ding(); stopAnim(true); flash(ink < 1 ? `LOW INK · ${P.length} NOTES` : `DONE · ${P.length} NOTES`); }
    };
    raf = requestAnimationFrame(frame);
  }
  const setBtns = (): void => {
    playBtn.innerHTML = mode === 'play' ? `${ICON.stop}<span>STOP</span>` : `${ICON.play}<span>PLAY</span>`;
    printBtn.innerHTML = mode === 'print' ? `${ICON.stop}<span>STOP</span>` : `${ICON.print}<span>PRINT</span>`;
    enable();
  };

  // ---------- muat & analisis ----------
  // Muat -> TRIM (pilih bagian yang mau dicetak) -> analisis. Kertas lama tetap utuh sampai PRINT ditekan, CANCEL mengembalikannya.
  async function loadWith(get: () => Promise<{ buf: AudioBuffer; name: string }>): Promise<void> {
    const my = ++loadTok;
    stopAnim(); stopPrev(); closeCrop(); drop.hidden = true; say('READING AUDIO');
    try {
      audio();
      const { buf, name } = await get();
      if (my !== loadTok) return;
      openCrop(buf, name);
    } catch (err) {
      if (my !== loadTok) return;
      sfx?.jam(); drop.hidden = P.length > 0; flash('PAPER JAM · ' + String((err as Error).message || 'gagal membaca'));
    }
  }
  async function analyzeBuf(buf: AudioBuffer, name: string): Promise<void> {
    const my = ++loadTok;
    stopAnim(); P = []; PL = []; total = 0; pos = 0; updProg(); enable(); drop.hidden = true;
    try {
      const mono = toMono(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice()));
      say('READING 0%');
      const r = await job({ type: 'analyze', x: mono, sr: buf.sampleRate }, [mono.buffer]);
      if (my !== loadTok) return;
      const notes: Note[] = r.notes; snapTargets(notes);   // sama dengan MPCS: target = semiton terdekat (dengan hysteresis)
      S = { name, pt: r.pt as PitchTrack, notes, buf };
      rebuild(); TB = 0; enable();
      if (!P.length) { sfx?.jam(); say('PAPER JAM'); drop.hidden = false; layout(); return; }
      drop.hidden = true; layout(); run(live, false);
    } catch (err) {
      if (my !== loadTok) return;
      sfx?.jam(); drop.hidden = false; flash('PAPER JAM · ' + String((err as Error).message || 'gagal membaca'));
    }
  }
  const loadFile = (f: File): void => {
    if (!isAudio(f)) { flash('BUKAN FILE AUDIO'); return; }
    void loadWith(async () => ({ buf: await audio().decodeAudioData(await f.arrayBuffer()), name: f.name.replace(/\.[^.]+$/, '') }));
  };

  // ---------- trim: pilih bagian audio yang mau dicetak ----------
  const crop = q<HTMLElement>('.prn__crop'), wv = q<HTMLCanvasElement>('.prn__wv'), wg = wv.getContext('2d')!, cLbl = q('.prn__cl');
  const cPrev = q<HTMLButtonElement>('.prn__cprev'), cAll = q<HTMLButtonElement>('.prn__call'), cCancel = q<HTMLButtonElement>('.prn__ccancel'), cOk = q<HTMLButtonElement>('.prn__cok');
  const NPK = 1200, MIN_SEL = 0.2;
  let cPlay: AudioBufferSourceNode | null = null, cRaf = 0, cT0 = 0;
  const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
  const fmtS = (s: number): string => { const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };
  const maxSel = (): number => DEMO ? LIMITS.mpcsSec : Infinity;   // demo: bagian yang dicetak dibatasi
  function peaksOf(buf: AudioBuffer): Float32Array {   // puncak amplitudo per kolom (semua kanal), dinormalkan
    const pk = new Float32Array(NPK), n = buf.length;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < NPK; i++) {
        const a = Math.floor(i * n / NPK), b = Math.max(a + 1, Math.floor((i + 1) * n / NPK)), st = Math.max(1, Math.floor((b - a) / 48));
        let m = pk[i]; for (let j = a; j < b; j += st) { const v = Math.abs(d[j]); if (v > m) m = v; }
        pk[i] = m;
      }
    }
    let mx = 1e-6; for (const v of pk) if (v > mx) mx = v;
    for (let i = 0; i < NPK; i++) pk[i] /= mx;
    return pk;
  }
  function drawCrop(playT?: number): void {
    const w = wv.clientWidth, h = wv.clientHeight; if (!C || !w || !h) return;
    const d = Math.min(2, devicePixelRatio || 1);
    if (wv.width !== Math.round(w * d) || wv.height !== Math.round(h * d)) { wv.width = Math.round(w * d); wv.height = Math.round(h * d); }
    wg.setTransform(d, 0, 0, d, 0, 0); wg.clearRect(0, 0, w, h);
    const dur = C.buf.duration, xs = C.s / dur * w, xe = C.e / dur * w, mid = h / 2;
    wg.fillStyle = 'rgba(255,255,255,.08)'; wg.fillRect(0, mid, w, 1);
    for (let x = 0; x < w; x++) {
      const a = Math.max(1, C.peaks[Math.min(NPK - 1, Math.floor(x / w * NPK))] * (mid - 6));
      wg.fillStyle = x >= xs && x <= xe ? '#ffb347' : 'rgba(255,179,71,.28)'; wg.fillRect(x, mid - a, 1, a * 2);
    }
    wg.fillStyle = 'rgba(0,0,0,.4)'; wg.fillRect(0, 0, xs, h); wg.fillRect(xe, 0, w - xe, h);   // bagian di luar pilihan digelapkan
    for (const x of [xs, xe]) {   // pegangan: garis amber + knob krem (sama dengan knob progres)
      wg.fillStyle = '#ffb347'; wg.fillRect(x - 1.5, 0, 3, h);
      wg.fillStyle = '#f7f3e6'; wg.strokeStyle = '#3a372f'; wg.lineWidth = 2; wg.beginPath(); wg.arc(x, mid, 7, 0, 6.3); wg.fill(); wg.stroke();
    }
    if (playT !== undefined) { wg.fillStyle = '#fff'; wg.fillRect(playT / dur * w - 0.5, 0, 1, h); }
    cLbl.textContent = `${fmtS(C.s)} – ${fmtS(C.e)} · ${(C.e - C.s).toFixed(1)}s`;
  }
  function stopPrev(): void {
    cancelAnimationFrame(cRaf);
    if (cPlay) { const s = cPlay; cPlay = null; try { s.stop(); } catch { /* sudah berhenti */ } s.disconnect(); }
    cPrev.innerHTML = `${ICON.play}<span>PREVIEW</span>`; drawCrop();
  }
  function startPrev(): void {
    if (!C) return;
    const a = audio(); stopPrev();
    const src = a.createBufferSource(); src.buffer = C.buf; src.connect(a.destination);
    const s0 = C.s; src.start(0, C.s, C.e - C.s); cPlay = src; cT0 = a.currentTime;
    src.onended = () => { if (cPlay === src) stopPrev(); };
    cPrev.innerHTML = `${ICON.stop}<span>STOP</span>`;
    const tick = (): void => { if (!cPlay) return; drawCrop(s0 + a.currentTime - cT0); cRaf = requestAnimationFrame(tick); };
    tick();
  }
  function openCrop(buf: AudioBuffer, name: string): void {
    const mx = maxSel();
    C = { buf, name, peaks: peaksOf(buf), s: 0, e: Math.min(buf.duration, mx) };
    crop.hidden = false; win.classList.add('is-crop'); enable();
    say(DEMO && buf.duration > mx ? `DEMO · MAKS ${LIMITS.mpcsSec} DETIK` : 'TRIM · PILIH BAGIAN');
    drawCrop();
  }
  function closeCrop(): void { C = null; crop.hidden = true; win.classList.remove('is-crop'); enable(); }
  function confirmCrop(): void {
    if (!C) return;
    const { buf, name, s, e } = C; stopPrev(); closeCrop();
    const sr = buf.sampleRate, i0 = Math.floor(s * sr), i1 = Math.min(buf.length, Math.ceil(e * sr));
    if (i0 <= 0 && i1 >= buf.length) { void analyzeBuf(buf, name); return; }   // seluruh audio: tidak perlu dipotong
    const out = audio().createBuffer(buf.numberOfChannels, Math.max(1, i1 - i0), sr), fade = Math.min(Math.round(0.005 * sr), (i1 - i0) >> 1);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const dst = out.getChannelData(c); dst.set(buf.getChannelData(c).subarray(i0, i1));
      if (i0 > 0) for (let i = 0; i < fade; i++) dst[i] *= i / fade;   // fade 5 ms di titik potong supaya tidak klik
      if (i1 < buf.length) for (let i = 0; i < fade; i++) dst[dst.length - 1 - i] *= i / fade;
    }
    void analyzeBuf(out, name);
  }
  function cancelCrop(): void { stopPrev(); closeCrop(); drop.hidden = P.length > 0; info(); }
  let cd: { mode: 's' | 'e' | 'm'; x0: number; s0: number; e0: number } | null = null;
  function applyDrag(ev: PointerEvent): void {
    if (!C || !cd) return;
    const r = wv.getBoundingClientRect(); if (!r.width) return;
    const dur = C.buf.duration, t = clamp((ev.clientX - r.left) / r.width, 0, 1) * dur, min = Math.min(MIN_SEL, dur), mx = maxSel();
    if (cd.mode === 's') C.s = clamp(Math.max(t, C.e - mx), 0, C.e - min);
    else if (cd.mode === 'e') C.e = clamp(Math.min(t, C.s + mx), C.s + min, dur);
    else { const len = cd.e0 - cd.s0, s = clamp(cd.s0 + (ev.clientX - cd.x0) / r.width * dur, 0, dur - len); C.s = s; C.e = s + len; }
    drawCrop();
  }
  wv.addEventListener('pointerdown', ev => {
    if (!C) return;
    stopPrev();
    const r = wv.getBoundingClientRect(), px = ev.clientX - r.left, dur = C.buf.duration, xs = C.s / dur * r.width, xe = C.e / dur * r.width, near = 16;
    let mode: 's' | 'e' | 'm';
    if (Math.abs(px - xs) <= near && Math.abs(px - xs) <= Math.abs(px - xe)) mode = 's';
    else if (Math.abs(px - xe) <= near) mode = 'e';
    else if (px > xs && px < xe) mode = 'm';
    else mode = Math.abs(px - xs) < Math.abs(px - xe) ? 's' : 'e';   // klik di luar pilihan: tepi terdekat loncat ke situ
    cd = { mode, x0: ev.clientX, s0: C.s, e0: C.e }; wv.setPointerCapture(ev.pointerId); applyDrag(ev);
  });
  wv.addEventListener('pointermove', ev => { if (cd) applyDrag(ev); });
  const endCd = (): void => { cd = null; };
  wv.addEventListener('pointerup', endCd); wv.addEventListener('pointercancel', endCd);
  new ResizeObserver(() => drawCrop()).observe(wv);
  cPrev.addEventListener('click', () => { if (cPlay) stopPrev(); else startPrev(); });
  cAll.addEventListener('click', () => { if (!C) return; stopPrev(); C.s = 0; C.e = Math.min(C.buf.duration, maxSel()); drawCrop(); });
  cCancel.addEventListener('click', cancelCrop);
  cOk.addEventListener('click', confirmCrop);

  // ---------- rekam ----------
  let recording = false, rec: MediaRecorder | null = null, recTick = 0;
  async function toggleRec(): Promise<void> {
    if (recording) { rec?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); clearInterval(recTick); recording = false; recBtn.classList.remove('is-rec'); recBtn.innerHTML = `${ICON.rec}<span>REC</span>`; enable();
        if (!chunks.length) { flash('REKAMAN KOSONG'); return; }
        const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' });
        void loadWith(async () => ({ buf: await audio().decodeAudioData(await blob.arrayBuffer()), name: 'rekaman' }));
      };
      stopAnim(); recording = true; recBtn.classList.add('is-rec'); recBtn.innerHTML = `${ICON.stop}<span>STOP</span>`; enable();
      const t0 = Date.now(); rec.start();
      recTick = window.setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); say(`REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); if (s >= 60) rec?.stop(); }, 250);
    } catch { flash('MIC TIDAK BISA DIPAKAI'); }
  }

  // ---------- keluaran ----------
  const baseName = (): string => (S?.name || 'melody').replace(/[^\w\- ]+/g, '').trim() || 'melody';
  function saveMid(): void {
    if (!P.length) return;
    saveBlob(new Blob([writeMidiFile(P, bpm(), 'Melody Printer') as BlobPart], { type: 'audio/midi' }), baseName() + '.mid');
    flash('SAVED .MID');
  }
  function tearOff(): void {
    if (!P.length) return;
    if (!bridge) { flash('TIDAK ADA PATTERN'); return; }
    const msg = bridge.send(P.map(n => ({ p: n.p, s: n.s, l: n.l, v: n.v / 127 })), Math.max(4, Math.ceil(total / 4) * 4));
    if (!reduce) { cv.classList.remove('is-tear'); void cv.offsetWidth; cv.classList.add('is-tear'); }
    flash(msg ? msg.toUpperCase().slice(0, 60) : 'TORN OFF → PATTERN');
  }

  // ---------- event ----------
  const reprint = (): void => { if (!S) return; stopAnim(); rebuild(); TB = total; pos = total * 60 / bpm(); enable(); info(); draw(); updProg(); };
  bpmIn.addEventListener('change', reprint); gridSel.addEventListener('change', () => { try { localStorage.setItem(GRID_KEY, gridSel.value); } catch { /* abaikan */ } reprint(); }); keySel.addEventListener('change', reprint);
  spdBtn.addEventListener('click', () => { live = !live; spdBtn.textContent = live ? 'LIVE' : 'FAST'; spdBtn.setAttribute('aria-pressed', String(live)); });
  voxBtn.addEventListener('click', () => { vox = !vox; if (vox && vol === 0) vol = 0.8; try { localStorage.setItem(VOL_KEY, String(Math.round(vol * 100))); } catch { /* abaikan */ } try { localStorage.setItem(VOX_KEY, vox ? '1' : '0'); } catch { /* abaikan */ } syncVox(); });   // bisa diganti saat sedang PLAY
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) loadFile(f); });
  recBtn.addEventListener('click', () => { void toggleRec(); });
  printBtn.addEventListener('click', () => { if (mode === 'print') stopAnim(true); else run(live, false); });
  playBtn.addEventListener('click', () => { if (mode === 'play') { stopAnim(); info(); } else run(true, true); });   // STOP = jeda: posisi tetap, klik bar progres untuk lanjut
  tearBtn.addEventListener('click', tearOff);
  midBtn.addEventListener('click', saveMid);
  muteBtn.addEventListener('click', () => { mute = !mute; try { localStorage.setItem(MUTE_KEY, mute ? '1' : '0'); } catch { /* abaikan */ } syncMute(); });
  q('.prn__close').addEventListener('click', () => { loadTok++; stopAnim(); stopPrev(); closeCrop(); drop.hidden = P.length > 0; if (recording) rec?.stop(); el.hidden = true; });
  win.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan saat mengetik BPM
  win.addEventListener('keyup', e => e.stopPropagation());
  // drag & drop file audio ke jendela
  win.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); win.classList.add('is-drop'); } });
  win.addEventListener('dragleave', () => win.classList.remove('is-drop'));
  win.addEventListener('drop', e => { win.classList.remove('is-drop'); const f = e.dataTransfer?.files[0]; if (f) { e.preventDefault(); loadFile(f); } });
  // gulung kertas: seret naik / turun atau roda mouse (setelah selesai dicetak)
  let drag: { y: number; tb: number } | null = null;
  const scrollTo = (tb: number): void => { TB = Math.max(0, Math.min(total, tb)); pos = TB * 60 / bpm(); draw(); updProg(); };
  cv.addEventListener('pointerdown', e => { if (animating || !P.length) return; drag = { y: e.clientY, tb: TB }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (drag) scrollTo(drag.tb + (e.clientY - drag.y) / K); });
  const endDrag = (): void => { drag = null; };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('wheel', e => { if (animating || !P.length) return; e.preventDefault(); scrollTo(TB - e.deltaY / K); }, { passive: false });
  // progres: klik / seret bar untuk loncat posisi (otomatis PLAY dari titik itu); panah kiri-kanan = 5 detik
  const seekTo = (sec: number): void => { if (!S || !P.length || recording) return; run(true, true, sec); };
  const fracOf = (e: PointerEvent): number => { const r = track.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; };
  track.addEventListener('pointerdown', e => { if (!S || !P.length || recording) return; scrubbing = true; track.setPointerCapture(e.pointerId); updProg(fracOf(e) * lenSec()); });
  track.addEventListener('pointermove', e => { if (scrubbing) updProg(fracOf(e) * lenSec()); });
  const endScrub = (e: PointerEvent, go: boolean): void => { if (!scrubbing) return; scrubbing = false; if (go) seekTo(fracOf(e) * lenSec()); else updProg(); };
  track.addEventListener('pointerup', e => endScrub(e, true));
  track.addEventListener('pointercancel', e => endScrub(e, false));
  track.addEventListener('keydown', e => {
    if (!S || !P.length || recording || C) return;
    const len = lenSec(); let t: number | null = null;
    if (e.key === 'ArrowRight') t = pos + 5; else if (e.key === 'ArrowLeft') t = pos - 5; else if (e.key === 'Home') t = 0; else if (e.key === 'End') t = len - 0.1;
    if (t !== null) { e.preventDefault(); seekTo(Math.max(0, Math.min(len, t))); }
  });
  // volume vokal: geser slider; kalau VOCAL sedang mati, menggeser slider menyalakannya lagi
  volIn.addEventListener('input', () => {
    vol = Math.max(0, Math.min(1, (+volIn.value || 0) / 100));
    if (!vox && vol > 0) { vox = true; try { localStorage.setItem(VOX_KEY, '1'); } catch { /* abaikan */ } }
    try { localStorage.setItem(VOL_KEY, String(Math.round(vol * 100))); } catch { /* abaikan */ }
    syncVox();
  });
  new ResizeObserver(layout).observe(stage);

  openFn = () => {
    bringFront(el); el.hidden = false;
    if (bridge && !S) { const b = bridge.bpm(); if (b >= 30 && b <= 300) bpmIn.value = String(Math.round(b)); }   // BPM awal mengikuti proyek
    layout(); win.focus({ preventScroll: true });
  };
}
