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
import { DEMO, LIMITS, demoTrim } from './demo';
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
const MUTE_KEY = 'derizmp3.printerMute';

interface Sess { name: string; pt: PitchTrack; notes: Note[] }
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
      '</div></div>' +
      '<div class="prn__opts">' +
        '<label>BPM<input type="number" class="prn__bpm" min="30" max="300" step="1" inputmode="numeric" value="120"></label>' +
        '<label>Grid<select class="prn__grid"><option value="0">Off</option><option value="0.5">1/8</option><option value="0.25">1/16</option></select></label>' +
        `<label>Key<select class="prn__key">${keyOpts}</select></label>` +
        '<button type="button" class="prn__spd" title="Kecepatan cetak: FAST = beberapa detik, LIVE = sepanjang durasi vokal" aria-pressed="false">FAST</button>' +
      '</div>' +
      '<div class="prn__bar">' +
        `<button type="button" class="prn__b prn__rec" aria-label="Rekam vokal" title="Rekam vokal">${ICON.rec}<span>REC</span></button>` +
        `<button type="button" class="prn__b prn__play" aria-label="Dengar melodi" title="Cetak ulang sepanjang durasi sambil membunyikan nadanya" disabled>${ICON.play}<span>PLAY</span></button>` +
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
  const bpmIn = q<HTMLInputElement>('.prn__bpm'), gridSel = q<HTMLSelectElement>('.prn__grid'), keySel = q<HTMLSelectElement>('.prn__key'), spdBtn = q<HTMLButtonElement>('.prn__spd');
  const recBtn = q<HTMLButtonElement>('.prn__rec'), playBtn = q<HTMLButtonElement>('.prn__play'), printBtn = q<HTMLButtonElement>('.prn__print'), tearBtn = q<HTMLButtonElement>('.prn__tear'), midBtn = q<HTMLButtonElement>('.prn__midi'), muteBtn = q<HTMLButtonElement>('.prn__mute');
  dragWindow({ root: el, move: win, handle: '.prn__head' });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let S: Sess | null = null, P: PrintNote[] = [], total = 0;   // total = panjang kertas (ketukan)
  let TB = 0;               // posisi kertas: ketukan yang sedang berada di celah (kepala cetak)
  let headX = 0.5, headTo = 0.5;   // posisi kepala 0..1 (0 = nada terendah)
  let lo = 55, hi = 79;     // rentang nada yang digambar
  let W = 0, H = 0, dpr = 1, raf = 0, animating = false, ink = 0;
  let ac: AudioContext | null = null, sfx: Sfx | null = null, loadTok = 0, statT = 0;
  let live = false, jobId = 0, worker: Worker | null = null;
  const jobs = new Map<number, { ok: (m: any) => void; fail: (e: Error) => void }>();   // eslint-disable-line @typescript-eslint/no-explicit-any
  let mute = false; try { mute = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* abaikan */ }
  const K = 30, HEAD_H = 52, X0 = 30;   // K = piksel per ketukan; HEAD_H = tinggi badan printer di atas kertas; X0 = tepi kiri area nada

  // ---------- status (layar LCD) ----------
  const info = (): void => { stat.textContent = S ? (P.length ? `${P.length} NOTES · ${Math.round(bpm())} BPM` : 'PAPER JAM') : 'READY'; };
  const say = (m: string): void => { stat.textContent = m; clearTimeout(statT); };
  const flash = (m: string): void => { stat.textContent = m; clearTimeout(statT); statT = window.setTimeout(info, 2400); };
  const bpm = (): number => { const v = parseFloat(bpmIn.value); return v >= 30 && v <= 300 ? v : 120; };
  const syncMute = (): void => { muteBtn.innerHTML = mute ? ICON.mute : ICON.snd; muteBtn.setAttribute('aria-pressed', String(mute)); if (sfx) sfx.muted = mute; };
  syncMute();
  const enable = (): void => { const has = P.length > 0; playBtn.disabled = printBtn.disabled = tearBtn.disabled = midBtn.disabled = !has || recording; win.classList.toggle('is-off', !S); };

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
    if (!S) { P = []; total = 0; return; }
    const kv = keySel.value, [r, m] = kv === 'off' ? [0, ''] : kv.split('-');
    P = notesToPrint(S.notes, S.pt, { bpm: bpm(), grid: parseFloat(gridSel.value) || 0, scale: kv === 'off' ? null : { root: +r, mode: m as 'major' | 'minor' } });
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

  // ---------- animasi cetak ----------
  function stopAnim(finish = false): void {
    cancelAnimationFrame(raf); animating = false; sfx?.stop();
    if (finish) TB = total;
    headTo = 0.5; headX = 0.5; setBtns(); draw();
  }
  function run(asLive: boolean, withTones: boolean): void {
    if (!S || !P.length) return;
    audio(); stopAnim();
    const spb = 60 / bpm(), secs = total * spb;
    const dur = asLive ? Math.max(0.6, secs) : reduce ? 0.01 : Math.min(4, Math.max(1.6, secs * 0.25));
    animating = true; TB = 0; let t0 = 0, next = 0, ended = false;
    setBtns();
    if (!withTones) sfx!.start();
    const frame = (now: number): void => {
      if (!animating) return;
      if (!t0) t0 = now;
      const u = Math.min(1, (now - t0) / 1000 / dur);
      TB = total * u;
      while (next < P.length && P[next].s <= TB) { const n = P[next++]; if (withTones) sfx!.tone(n.p, n.l * spb, n.v / 127); }
      const cur = P.find(n => n.s <= TB && TB < n.s + n.l);
      if (cur) { headTo = (cur.p - lo + 0.5) / (hi - lo + 1); if (!withTones) sfx!.zzt(cur.p, cur.v / 127); }
      else { const nx = P.find(n => n.s > TB); if (nx) headTo = (nx.p - lo + 0.5) / (hi - lo + 1); }
      headX += (headTo - headX) * 0.35;
      say((withTones ? 'PLAYING ' : 'PRINTING ') + Math.round(u * 100) + '%');
      draw();
      if (u < 1) { raf = requestAnimationFrame(frame); return; }
      if (!ended) { ended = true; animating = false; sfx!.stop(); if (!withTones) sfx!.ding(); stopAnim(true); flash(ink < 1 ? `LOW INK · ${P.length} NOTES` : `DONE · ${P.length} NOTES`); }
    };
    raf = requestAnimationFrame(frame);
  }
  const setBtns = (): void => {
    playBtn.innerHTML = animating && live ? `${ICON.stop}<span>STOP</span>` : `${ICON.play}<span>PLAY</span>`;
    printBtn.innerHTML = animating && !live ? `${ICON.stop}<span>STOP</span>` : `${ICON.print}<span>PRINT</span>`;
    enable();
  };

  // ---------- muat & analisis ----------
  async function loadWith(get: () => Promise<{ buf: AudioBuffer; name: string }>): Promise<void> {
    const my = ++loadTok;
    stopAnim(); P = []; total = 0; enable(); drop.hidden = true; say('READING AUDIO');
    try {
      audio();
      let { buf, name } = await get();
      if (my !== loadTok) return;
      if (DEMO && buf.duration > LIMITS.mpcsSec) { buf = demoTrim(buf, LIMITS.mpcsSec); say(`DEMO · ${LIMITS.mpcsSec} DETIK PERTAMA`); }
      const mono = toMono(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice()));
      say('READING 0%');
      const r = await job({ type: 'analyze', x: mono, sr: buf.sampleRate }, [mono.buffer]);
      if (my !== loadTok) return;
      const notes: Note[] = r.notes; snapTargets(notes);   // sama dengan MPCS: target = semiton terdekat (dengan hysteresis)
      S = { name, pt: r.pt as PitchTrack, notes };
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
  const reprint = (): void => { if (!S) return; stopAnim(); rebuild(); TB = total; enable(); info(); draw(); };
  bpmIn.addEventListener('change', reprint); gridSel.addEventListener('change', reprint); keySel.addEventListener('change', reprint);
  spdBtn.addEventListener('click', () => { live = !live; spdBtn.textContent = live ? 'LIVE' : 'FAST'; spdBtn.setAttribute('aria-pressed', String(live)); });
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) loadFile(f); });
  recBtn.addEventListener('click', () => { void toggleRec(); });
  printBtn.addEventListener('click', () => { if (animating && !live) stopAnim(true); else run(live, false); });
  playBtn.addEventListener('click', () => { if (animating && live) stopAnim(true); else run(true, true); });
  tearBtn.addEventListener('click', tearOff);
  midBtn.addEventListener('click', saveMid);
  muteBtn.addEventListener('click', () => { mute = !mute; try { localStorage.setItem(MUTE_KEY, mute ? '1' : '0'); } catch { /* abaikan */ } syncMute(); });
  q('.prn__close').addEventListener('click', () => { loadTok++; stopAnim(); if (recording) rec?.stop(); el.hidden = true; });
  win.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan saat mengetik BPM
  win.addEventListener('keyup', e => e.stopPropagation());
  // drag & drop file audio ke jendela
  win.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); win.classList.add('is-drop'); } });
  win.addEventListener('dragleave', () => win.classList.remove('is-drop'));
  win.addEventListener('drop', e => { win.classList.remove('is-drop'); const f = e.dataTransfer?.files[0]; if (f) { e.preventDefault(); loadFile(f); } });
  // gulung kertas: seret naik / turun atau roda mouse (setelah selesai dicetak)
  let drag: { y: number; tb: number } | null = null;
  const scrollTo = (tb: number): void => { TB = Math.max(0, Math.min(total, tb)); draw(); };
  cv.addEventListener('pointerdown', e => { if (animating || !P.length) return; drag = { y: e.clientY, tb: TB }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (drag) scrollTo(drag.tb + (e.clientY - drag.y) / K); });
  const endDrag = (): void => { drag = null; };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('wheel', e => { if (animating || !P.length) return; e.preventDefault(); scrollTo(TB - e.deltaY / K); }, { passive: false });
  new ResizeObserver(layout).observe(stage);

  openFn = () => {
    bringFront(el); el.hidden = false;
    if (bridge && !S) { const b = bridge.bpm(); if (b >= 30 && b <= 300) bpmIn.value = String(Math.round(b)); }   // BPM awal mengikuti proyek
    layout(); win.focus({ preventScroll: true });
  };
}
