// Piano roll: editor nada berbasis canvas (belum ada suara, sesuai tahap ini).
// Fitur: pasang / geser / ubah panjang / hapus nada, pilih banyak (marquee), snap, undo,
// zoom horizontal & vertikal (tombol, Ctrl+scroll, Alt+scroll, pinch 2 jari), geser (scroll / tool tangan / 2 jari).
// Nada disimpan di memori per pattern (kunci `id`), jadi tetap ada saat piano roll ditutup lalu dibuka lagi.

export interface PianoRollOpts {
  id?: string;        // kunci pattern supaya nada tersimpan per pattern
  track: string;
  pattern: string;
  color?: string;
  ghosts?: Ghost[];   // nada milik instrumen lain di pattern yang sama: ditampilkan meredup; tidak bisa diedit, tapi ditahan = pindah ke VST pemiliknya (lewat open)
  keepView?: boolean; // dipanggil saat pindah antar VST: pertahankan zoom, scroll & tool, jangan reset tampilan
}
export interface Ghost { key: string; color: string; open?: () => void; }   // open: membuka piano roll untuk VST pemilik nada ini

interface Note { id: number; p: number; s: number; l: number; sl?: boolean; }   // p: MIDI, s/l: dalam ketukan
interface State { notes: Note[]; nextId: number; }
type Tool = 'draw' | 'select' | 'erase' | 'pan';

import { slideSource, glideBeats } from './note-slide';
const P_MIN = 24, P_MAX = 108, ROWS = P_MAX - P_MIN + 1;   // C1..C8
const KEY_W = 64, RULER_H = 32, BEATS_PER_BAR = 4, BARS = 15;   // grid selalu 15 bar (nomor 1..15)
const PPB_MIN = 8, PPB_MAX = 480, ROW_MIN = 10, ROW_MAX = 40;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

const isBlack = (p: number) => BLACK.has(p % 12);
const pname = (p: number) => NAMES[p % 12] + (Math.floor(p / 12) - 1);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const ic = (d: string) =>
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const ICON = {
  close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
  chev: ic('<path d="M9 6l6 6-6 6"/>'),
  more: ic('<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>'),
  draw: ic('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/>'),
  select: ic('<path d="M5 3l14 7-6 2-2 6z"/>'),
  erase: ic('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  pan: ic('<path d="M9 11V5a1.5 1.5 0 013 0v5m0-1a1.5 1.5 0 013 0v2m0-1a1.5 1.5 0 013 0v5a6 6 0 01-6 6h-1a6 6 0 01-5-3l-2-4a1.5 1.5 0 012.5-1.5L9 15"/>'),
  undo: ic('<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>'),
  redo: ic('<path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3"/>'),
  minus: ic('<path d="M5 12h14"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
};

const states = new Map<string, State>();
let root: HTMLElement | null = null;
let onClose: (() => void) | null = null;
let closeMenu: () => void = () => {};
let menuOpen: () => boolean = () => false;

// elemen
let sc!: HTMLElement, space!: HTMLElement, gc!: HTMLCanvasElement, gclip!: HTMLElement, kc!: HTMLCanvasElement, rc!: HTMLCanvasElement;
let phDom!: HTMLElement, phBeat = -1;   // playhead: posisi dalam ketukan relatif ke awal pattern (<0 = tersembunyi)
let btnUndo!: HTMLButtonElement, btnRedo!: HTMLButtonElement, selBar!: HTMLElement, btnPaste!: HTMLButtonElement, btnSlide!: HTMLButtonElement;

// state editor
let st: State = {notes: [], nextId: 1};
let curKey = '';
const total = BARS * BEATS_PER_BAR;
let ppb = 64, rowH = 18;
let tool: Tool = 'draw';
let snapOn = true;   // tombol Snap (lampu indikator): nyala = note menempel ke garis grid yang terlihat
let color = '#3fbf5f';
let ghostSrc: Ghost[] = [];
let selected = new Set<number>();
let undoStack: string[] = [];
let redoStack: string[] = [];
let lastLen = 1;
let hoverP = -1;
let raf = 0;

const handleR = () => clamp(rowH * 0.3, 4, 7);   // jari-jari bulatan handle
const HANDLE_GAP = 3;                            // jarak ujung note ke tepi luar bulatan (bulatan sepenuhnya di luar note)
const handleCX = (n: Note) => (n.s + n.l) * ppb + Math.max(0, 3 - n.l * ppb) + handleR() + HANDLE_GAP;   // titik tengah bulatan (koordinat konten)
const EDGE_PAD = 44;                             // ruang ekstra di kanan grid supaya bulatan note di ujung tetap kelihatan & bisa dipegang

// animasi bulatan: muncul (pop) saat note dibuat, hilang saat note dihapus, membesar sedikit saat ditarik
const REDUCE = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const T_IN = 240, T_OUT = 170, T_PRESS = 130, PRESS_K = 0.35;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
let born = new Map<number, number>();                     // id -> waktu mulai muncul
let ghosts: Array<{n: Note; t0: number; h: boolean}> = [];            // note yang baru dihapus (diputar keluar dulu)
let lastDrawn = new Map<number, Note>();
let lastSel = new Set<number>();                          // note yang terpilih pada gambar terakhir (bulatan handle hanya untuk note terpilih)
let rel: {id: number; t0: number} | null = null;          // bulatan baru dilepas -> kembali ke ukuran normal
function resetAnim() { born.clear(); ghosts = []; rel = null; lastSel = new Set(selected); lastDrawn = new Map(st.notes.map(n => [n.id, {...n}])); }
const snapshot = () => JSON.stringify(st.notes);
// langkah snap = garis grid paling halus yang sedang tampil (ikut zoom), jadi note menempel ke semua garis grid
const gridStep = () => { let s = LEVELS[0][0]; for (const [st] of LEVELS) if (st * ppb >= 11) s = st; return s; };
const unit = () => (snapOn ? gridStep() : 1 / 16);
const snapRound = (b: number) => { if (!snapOn) return b; const s = gridStep(); return Math.round(b / s) * s; };
const snapFloor = (b: number) => { if (!snapOn) return b; const s = gridStep(); return Math.floor(b / s + 1e-9) * s; };

// ---------- gambar ----------
function fit(c: HTMLCanvasElement, w: number, h: number, cap = 8) {
  const dpr = Math.min(window.devicePixelRatio || 1, cap);   // cap: canvas grid yang lebar dibatasi (jumlah pixel di HP 3x turun ~55%)
  const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// garis vertikal bertingkat: bar > ketukan > 1/2 > 1/4 > 1/8
const LEVELS: Array<[number, number]> = [[4, 0.42], [1, 0.2], [0.5, 0.11], [0.25, 0.08], [0.125, 0.06]];
const LEVEL_FILL = LEVELS.map(l => 'rgba(255,255,255,' + l[1] + ')');
function eachVLine(sx: number, vw: number, fn: (x: number, beat: number, level: number) => void) {
  for (let li = 0; li < LEVELS.length; li++) {
    const step = LEVELS[li][0];
    if (step * ppb < 11) continue;
    const prev = li > 0 ? LEVELS[li - 1][0] : 0;
    const k0 = Math.max(0, Math.floor(sx / (step * ppb))), k1 = Math.min(Math.floor(total / step), Math.ceil((sx + vw) / (step * ppb)));
    for (let k = k0; k <= k1; k++) {
      const beat = k * step;
      if (prev && Math.abs(beat / prev - Math.round(beat / prev)) < 1e-6) continue;   // sudah digambar level di atasnya
      fn(Math.round(beat * ppb - sx) + 0.5, beat, li);
    }
  }
}

function drawNoteBody(c: CanvasRenderingContext2D, n: Note, sx: number, sy: number, sel: boolean) {
  const x = n.s * ppb - sx, w = Math.max(3, n.l * ppb), y = (P_MAX - n.p) * rowH - sy;
  c.fillStyle = color; c.beginPath(); c.roundRect(x + 0.5, y + 1, w - 1, rowH - 2, 3); c.fill();
  if (sel) { c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.roundRect(x + 0.5, y + 1, w - 1, rowH - 2, 3); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke(); }
  if (n.sl) {   // slide: lebih terang + tanda panah miring di kiri
    c.fillStyle = 'rgba(255,255,255,.3)'; c.beginPath(); c.roundRect(x + 0.5, y + 1, w - 1, rowH - 2, 3); c.fill();
    if (w > 18 && rowH >= 12) { c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x + 5, y + rowH - 5); c.lineTo(x + 12, y + 5); c.stroke(); }
  }
  if (w > (n.sl ? 44 : 30) && rowH >= 14) { c.fillStyle = 'rgba(0,0,0,.65)'; c.fillText(pname(n.p), x + (n.sl ? 17 : 5), y + rowH / 2 + 0.5); }
}
// bulatan putih di LUAR ujung kanan note (tidak menyentuh badan note); k = skala animasi
function drawHandle(c: CanvasRenderingContext2D, n: Note, sx: number, sy: number, k: number) {
  const r = handleR() * k; if (r < 0.4) return;
  const cx = handleCX(n) - sx, cy = (P_MAX - n.p + 0.5) * rowH - sy;
  c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.arc(cx, cy + 0.5, r + k, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
}

// Canvas grid sengaja LEBIH BESAR dari layar (overscan): geser kecil cukup menggeser canvas lewat CSS transform tanpa gambar ulang.
const OV_X = 0.4, OV_Y = 0.3;
let drawn = {ppb: 0, rowH: 0, ox: 0, oy: 0, w: 0, h: 0, vw: 0, vh: 0};   // apa yang sedang ada di canvas: konten mulai di (ox,oy), ukuran w x h, untuk layar vw x vh
let gridDirty = true;   // true = isi grid berubah (note, hover, animasi, ukuran); false = hanya posisi scroll
function placeGrid(l: number, t: number) {
  const d = drawn; if (!d.ppb) return;
  const kx = ppb / d.ppb, ky = rowH / d.rowH;
  gc.style.transform = 'translate(' + (d.ox * kx - l) + 'px,' + (d.oy * ky - t) + 'px) scale(' + kx + ',' + ky + ')';
}
function gridCovers(l: number, t: number) {
  const d = drawn;
  return d.ppb === ppb && d.rowH === rowH && d.vw === sc.clientWidth && d.vh === sc.clientHeight && l >= d.ox && l + d.vw <= d.ox + d.w && t >= d.oy && t + d.vh <= d.oy + d.h;
}
function drawGrid(zoomOnly = false) {
  const tg = performance.now();   // zoomOnly: frame ini hanya zoom, note tidak berubah -> lewati deteksi note baru / hilang
  const vw0 = sc.clientWidth, vh0 = sc.clientHeight, sl = sc.scrollLeft, stp = sc.scrollTop;
  const mx = Math.round(vw0 * OV_X), my = Math.round(vh0 * OV_Y);
  const vw = vw0 + 2 * mx, vh = vh0 + 2 * my;           // ukuran canvas (vw/vh di bawah = ukuran canvas)
  const sx = Math.max(0, sl - mx), sy = Math.max(0, stp - my);   // konten di pojok kiri-atas canvas
  gclip.style.width = vw0 + 'px'; gclip.style.height = vh0 + 'px';
  const c = fit(gc, vw, vh, 2);
  c.fillStyle = '#101016'; c.fillRect(0, 0, vw, vh);
  const xr = Math.min(vw, total * ppb - sx);
  const r0 = Math.max(0, Math.floor(sy / rowH)), r1 = Math.min(ROWS - 1, Math.floor((sy + vh) / rowH));
  if (xr > 0) {
    for (let r = r0; r <= r1; r++) {
      const p = P_MAX - r, y = r * rowH - sy;
      c.fillStyle = isBlack(p) ? '#17171e' : '#1f1f29'; c.fillRect(0, y, xr, rowH);
      if (p === hoverP) { c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(0, y, xr, rowH); }
      c.fillStyle = p % 12 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.05)';
      c.fillRect(0, Math.round(y + rowH) - 1, xr, 1);
    }
    eachVLine(sx, vw, (x, _b, li) => { c.fillStyle = LEVEL_FILL[li]; c.fillRect(x - 0.5, 0, 1, vh); });
    // garis akhir pattern
    const ex = Math.round(total * ppb - sx);
    if (ex >= 0 && ex <= vw) { c.fillStyle = color; c.fillRect(ex - 1, 0, 2, vh); }
  }
  // nada
  const now = performance.now(); let animating = false;
  if (!REDUCE && !zoomOnly) {                   // deteksi note baru / hilang sejak gambar terakhir (mencakup undo, hapus, erase)
    const cur = new Set(st.notes.map(n => n.id));
    for (const n of st.notes) if (!lastDrawn.has(n.id) || (selected.has(n.id) && !lastSel.has(n.id))) born.set(n.id, now);   // baru dibuat / baru dipilih -> bulatan pop
    for (const [id, n] of lastDrawn) if (!cur.has(id)) ghosts.push({n, t0: now, h: lastSel.has(id)});
  }
  if (!zoomOnly) { lastDrawn = new Map(st.notes.map(n => [n.id, {...n}])); lastSel = new Set(selected); }
  const fs = Math.min(11, rowH - 4);
  c.font = '600 ' + fs + 'px system-ui,sans-serif'; c.textBaseline = 'middle';
  const visible = (n: Note) => {
    const x = n.s * ppb - sx, w = Math.max(3, n.l * ppb), y = (P_MAX - n.p) * rowH - sy;
    return !(x + w + 2 * handleR() + 8 < 0 || x > vw || y + rowH < 0 || y > vh);
  };
  for (const gs of ghostSrc) {   // nada instrumen lain: di belakang nada yang sedang diedit, warna meredup
    const gst = states.get(gs.key); if (!gst || !gst.notes.length) continue;
    c.fillStyle = gs.color; c.strokeStyle = gs.color; c.lineWidth = 1;
    for (const n of gst.notes) {
      if (!visible(n)) continue;
      const x = n.s * ppb - sx, w = Math.max(3, n.l * ppb), y = (P_MAX - n.p) * rowH - sy;
      c.beginPath(); c.roundRect(x + 0.5, y + 1, w - 1, rowH - 2, 3);
      c.globalAlpha = .28; c.fill(); c.globalAlpha = .5; c.stroke();
    }
    c.globalAlpha = 1;
  }
  for (const n of st.notes) if (visible(n)) drawNoteBody(c, n, sx, sy, selected.has(n.id));
  for (const n of st.notes) {   // jalur luncuran: dari tinggi nada sumber ke tinggi nada slide
    if (!n.sl) continue;
    const src = slideSource(st.notes, n); if (!src) continue;
    const x0 = n.s * ppb - sx, x1 = (n.s + glideBeats(n)) * ppb - sx;
    if (x1 < 0 || x0 > vw) continue;
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5; c.beginPath();
    c.moveTo(x0, (P_MAX - src.p + 0.5) * rowH - sy); c.lineTo(x1, (P_MAX - n.p + 0.5) * rowH - sy); c.stroke();
  }
  for (const n of st.notes) {
    if (!selected.has(n.id) || !visible(n)) continue;   // bulatan panjang/pendek hanya di note yang dipilih
    let k = 1;
    const b0 = born.get(n.id);
    if (b0 !== undefined) { const t = (now - b0) / T_IN; if (t >= 1) born.delete(n.id); else { k *= easeOutBack(Math.max(0, t)); animating = true; } }
    if (g && g.kind === 'resize' && g.anchor && g.anchor.id === n.id) { const t = Math.min(1, (now - g.t0) / T_PRESS); k *= 1 + PRESS_K * easeOut(t); if (t < 1) animating = true; }
    else if (rel && rel.id === n.id) { const t = (now - rel.t0) / T_PRESS; if (t >= 1) rel = null; else { k *= 1 + PRESS_K * (1 - easeOut(t)); animating = true; } }
    drawHandle(c, n, sx, sy, k);
  }
  for (let i = ghosts.length - 1; i >= 0; i--) {   // note yang dihapus: memudar, bulatan mengecil
    const gh = ghosts[i], t = (now - gh.t0) / T_OUT;
    if (t >= 1) { ghosts.splice(i, 1); continue; }
    animating = true;
    if (!visible(gh.n)) continue;
    c.globalAlpha = 1 - t; drawNoteBody(c, gh.n, sx, sy, false); if (gh.h) drawHandle(c, gh.n, sx, sy, 1 - easeOut(t)); c.globalAlpha = 1;
  }
  if (animating) schedule();
  drawn = {ppb, rowH, ox: sx, oy: sy, w: vw, h: vh, vw: vw0, vh: vh0}; placeGrid(sl, stp); hudGrid = performance.now() - tg;
  // marquee
  if (g && g.kind === 'marquee') {
    const a = g.x0 - sx, b = g.y0 - sy, w = g.x - g.x0, h = g.y - g.y0;
    c.fillStyle = 'rgba(255,255,255,.12)'; c.strokeStyle = '#fff'; c.lineWidth = 1;
    c.fillRect(a, b, w, h); c.strokeRect(a + 0.5, b + 0.5, w, h);
  }
}

let keysSig = '', rulerSig = '';   // tanda masukan gambar terakhir: kalau sama, tidak digambar ulang (mis. pinch horizontal tidak menyentuh keys)
function drawKeys() {
  const vh = sc.clientHeight, sy = curT();
  const sig = sy + '|' + rowH + '|' + vh + '|' + hoverP + '|' + showNoteNames + '|' + color + '|' + (window.devicePixelRatio || 1);
  if (sig === keysSig) return; keysSig = sig;
  const c = fit(kc, KEY_W, vh);
  c.fillStyle = '#e9eaf0'; c.fillRect(0, 0, KEY_W, vh);
  const r0 = Math.max(0, Math.floor(sy / rowH)), r1 = Math.min(ROWS - 1, Math.floor((sy + vh) / rowH));
  c.font = '600 10px system-ui,sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'right';
  for (let r = r0; r <= r1; r++) {
    const p = P_MAX - r, y = r * rowH - sy;
    if (p === hoverP) { c.fillStyle = color; c.fillRect(0, y, KEY_W, rowH); }
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, Math.round(y + rowH) - 1, KEY_W, 1);
    if (isBlack(p)) { c.fillStyle = p === hoverP ? '#0e0e12' : '#1a1a21'; c.fillRect(0, y + 1, KEY_W * (showNoteNames ? 0.5 : 0.62), rowH - 2); }   // nama nada tampil: tuts hitam dipendekkan supaya label tidak tertutup
    if (p % 12 === 0 || p === hoverP || (showNoteNames && rowH >= 11)) { c.fillStyle = p === hoverP ? '#fff' : '#555566'; c.fillText(pname(p), KEY_W - 6, y + rowH / 2 + 0.5); }
  }
  c.textAlign = 'start';
  c.fillStyle = '#33333f'; c.fillRect(KEY_W - 1, 0, 1, vh);
}

function drawRuler() {
  const vw = sc.clientWidth, sx = curL();
  const sig = sx + '|' + ppb + '|' + vw + '|' + color + '|' + (window.devicePixelRatio || 1);
  if (sig === rulerSig) return; rulerSig = sig;
  const c = fit(rc, vw, RULER_H);
  c.fillStyle = '#1e1e26'; c.fillRect(0, 0, vw, RULER_H);
  c.font = '11px system-ui,sans-serif'; c.textBaseline = 'top';
  eachVLine(sx, vw, (x, beat, li) => {
    if (li === 0) { c.fillStyle = '#8a8a9a'; c.fillRect(x - 0.5, 4, 1, RULER_H - 4); if (beat < total) { c.fillStyle = '#e8e8f0'; c.fillText(String(1 + beat / BEATS_PER_BAR), x + 5, 5); } }
    else if (li === 1) { c.fillStyle = '#55556a'; c.fillRect(x - 0.5, RULER_H - 12, 1, 12); if (ppb >= 64) { c.fillStyle = '#8a8a9a'; c.fillText(String(Math.round(beat % BEATS_PER_BAR) + 1), x + 4, 14); } }
    else { c.fillStyle = '#3c3c4c'; c.fillRect(x - 0.5, RULER_H - 6, 1, 6); }
  });
  const ex = Math.round(total * ppb - sx);
  if (ex >= 0 && ex <= vw) { c.fillStyle = color; c.fillRect(ex - 1, 0, 2, RULER_H); }
  c.fillStyle = '#33333f'; c.fillRect(0, RULER_H - 1, vw, 1);
}

// ---------- menu bulat di atas / bawah note terpilih (gaya sama dengan menu pattern di timeline) ----------
let selBarOn = false;
let barOff = false;   // true setelah note selesai di-DRAG (pindah / ubah panjang): menu tidak muncul; baru muncul lagi kalau note di-KLIK
function flashBtn(act: string) {
  const b = selBar.querySelector<HTMLElement>('[data-sel="' + act + '"]'); if (!b || REDUCE) return;
  b.animate([{transform: 'scale(1)'}, {transform: 'scale(1.18)'}, {transform: 'scale(1)'}], {duration: 240, easing: 'ease-out'});
}
function shakeSelBar() { selBar.classList.remove('is-shake'); void selBar.offsetWidth; selBar.classList.add('is-shake'); }
function placeSelBar() {
  if (!selBar) return;
  const dragging = !!g && g.kind !== 'pan' && g.kind !== 'tapdraw';   // saat menyeret / seleksi kotak, menu disembunyikan dulu
  const sel = selected.size && !dragging && !barOff ? st.notes.filter(n => selected.has(n.id)) : [];
  if (!sel.length) { selBar.hidden = true; selBarOn = false; return; }
  const vw = sc.clientWidth, vh = sc.clientHeight, sx = sc.scrollLeft, sy = sc.scrollTop;
  const x0 = Math.min(...sel.map(n => n.s)) * ppb - sx, x1 = Math.max(...sel.map(n => n.s + n.l)) * ppb - sx;
  const y0 = (P_MAX - Math.max(...sel.map(n => n.p))) * rowH - sy, y1 = (P_MAX - Math.min(...sel.map(n => n.p)) + 1) * rowH - sy;
  if (x1 < 0 || x0 > vw || y1 < 0 || y0 > vh) { selBar.hidden = true; selBarOn = false; return; }   // seluruh pilihan di luar layar
  btnSlide.classList.toggle('is-on', sel.every(n => n.sl));   // tombol menyala kalau semua nada terpilih sudah slide
  const wasHidden = selBar.hidden; selBar.hidden = false;
  const bw = selBar.offsetWidth, bh = selBar.offsetHeight || 46;
  const ix0 = Math.max(x0, 0), ix1 = Math.min(x1, vw);
  const left = clamp((ix0 + ix1) / 2 - bw / 2, 6, Math.max(6, vw - bw - 6));
  let top = y0 - bh - 8;                                   // di atas note; kalau tidak muat, pindah ke bawah
  if (top < 4) top = y1 + 8;
  top = clamp(top, 4, Math.max(4, vh - bh - 4));
  selBar.style.left = KEY_W + left + 'px'; selBar.style.top = RULER_H + top + 'px';
  if (wasHidden || !selBarOn) { selBar.classList.remove('is-open'); void selBar.offsetWidth; if (!REDUCE) selBar.classList.add('is-open'); }
  selBarOn = true;
}

// ---------- playhead (garis + kepala di penggaris, ikut posisi playhead timeline) ----------
// Saat lagu main, playhead digerakkan animasi CSS (jalan di compositor / GPU), BUKAN per frame lewat JavaScript: kalau main thread
// sibuk (banyak nada dibunyikan sekaligus) gerakan playhead tetap mulus. JS hanya membuat ulang animasi saat zoom / geser berubah.
let phMo: {beat0: number; perSec: number; t0: number} | null = null, phAnim: Animation | null = null, phSig = '', phTimer = 0;
const phVis = (v: boolean) => { phDom.style.visibility = v ? 'visible' : 'hidden'; };
function phStop() { if (phAnim) { phAnim.onfinish = null; phAnim.cancel(); phAnim = null; } window.clearTimeout(phTimer); phTimer = 0; }
function placePlayhead() {
  if (!phDom) return;
  const L = curL();
  if (phMo) {
    const sig = ppb + '|' + L;
    if (sig === phSig) return;                       // animasi sudah benar untuk zoom / posisi geser ini
    phSig = sig; phStop();
    const m = phMo, now = performance.now(), waitMs = Math.max(0, m.t0 - now);
    const b0 = waitMs > 0 ? m.beat0 : m.beat0 + (now - m.t0) / 1000 * m.perSec;   // posisi (ketukan) saat ini dari jam transport
    if (b0 > total) { phVis(false); return; }
    if (b0 < 0) {                                    // playhead masih di sebelum pattern ini: muncul begitu masuk
      phVis(false);
      phTimer = window.setTimeout(() => { phSig = ''; placePlayhead(); }, waitMs + (-b0 / m.perSec) * 1000 + 1);
      return;
    }
    const x0 = b0 * ppb - L, x1 = total * ppb - L, durMs = (total - b0) / m.perSec * 1000;
    phVis(true); phDom.style.translate = x0 + 'px 0';
    if (durMs <= 0) return;
    phAnim = phDom.animate([{translate: x0 + 'px 0'}, {translate: x1 + 'px 0'}], {duration: durMs, delay: waitMs, easing: 'linear', fill: 'none'});
    phAnim.onfinish = () => { phAnim = null; phVis(false); };
    return;
  }
  phStop();
  const x = phBeat * ppb - L;
  const vis = phBeat >= 0 && phBeat <= total && x >= -5 && x <= sc.clientWidth + 5;
  phVis(vis);
  if (vis) phDom.style.translate = x + 'px 0';
}
// motion (opsional): playhead sedang berjalan dari `beats` dengan kecepatan perSec ketukan/detik, mulai setelah `delay` detik (count-in)
export function setPianoRollPlayhead(beats: number, motion?: {perSec: number; delay: number}) {
  phBeat = beats;
  phMo = motion ? {beat0: beats, perSec: motion.perSec, t0: performance.now() + motion.delay * 1000} : null;
  phSig = '';
  if (root && !root.hidden) placePlayhead();
}

// ---------- sinkron ke timeline: isi note ditampilkan mini di dalam pattern ----------
let onChange: ((id: string) => void) | null = null, notified = '';
export const setPianoRollChangeHandler = (fn: (id: string) => void) => { onChange = fn; };
// Tap / seret di penggaris (atas) = pindahkan playhead ke posisi itu. beats = ketukan dari awal pattern; final = jari/klik dilepas.
let onSeek: ((beats: number, final: boolean) => void) | null = null;
export const setPianoRollSeekHandler = (fn: (beats: number, final: boolean) => void) => { onSeek = fn; };
let seekId = -1;
function seekAt(e: PointerEvent, final: boolean) {
  if (!onSeek) return;
  const x = e.clientX - rc.getBoundingClientRect().left;
  onSeek(clamp((curL() + x) / ppb, 0, total), final);
}
function onRulerDown(e: PointerEvent) {
  if (seekId !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
  seekId = e.pointerId; rc.setPointerCapture(e.pointerId); seekAt(e, false);
}
function onRulerMove(e: PointerEvent) { if (e.pointerId === seekId) seekAt(e, false); }
function onRulerUp(e: PointerEvent) { if (e.pointerId !== seekId) return; seekId = -1; seekAt(e, true); }
function notifyChange() {
  if (!onChange || !curKey) return;
  const sn = curKey + snapshot();
  if (sn !== notified) { notified = sn; onChange(curKey); }
}
export const PR_BEATS = total;   // lebar grid piano roll (ketukan)
export function getPianoRollNotes(id: string): Array<{p: number; s: number; l: number; sl?: boolean}> {
  const x = states.get(id);
  return x ? x.notes.map(n => (n.sl ? {p: n.p, s: n.s, l: n.l, sl: true} : {p: n.p, s: n.s, l: n.l})) : [];
}
// isi nada satu kunci dari data yang disimpan (memuat project)
export function setPianoRollNotes(id: string, notes: Array<{p: number; s: number; l: number; sl?: boolean}>) {
  const st: State = {notes: [], nextId: 1};
  for (const n of notes) st.notes.push({id: st.nextId++, p: n.p, s: n.s, l: n.l, ...(n.sl ? {sl: true} : {})});
  states.set(id, st);
  onChange && onChange(id);
}
// salin nada dari satu pattern ke pattern lain (rentang ketukan [fromBeat, toBeat), digeser supaya mulai dari 0)
export function copyPianoRollNotes(from: string, to: string, fromBeat = 0, toBeat = Infinity) {
  const src = states.get(from); if (!src) return;
  const dst: State = {notes: [], nextId: 1};
  for (const n of src.notes) {
    const a = Math.max(n.s, fromBeat), b = Math.min(n.s + n.l, toBeat);
    if (b > a + 1e-9) dst.notes.push({id: dst.nextId++, p: n.p, s: a - fromBeat, l: b - a, ...(n.sl ? {sl: true} : {})});
  }
  states.set(to, dst);
}
// nada milik DERIZ lain di pattern yang sama disimpan dengan kunci "<id pattern>@<id track DERIZ>"; daftar kunci tambahan itu untuk id ini
export function clearPianoRollNotes(id: string) { if (states.delete(id)) onChange && onChange(id); }   // kosongkan nada satu kunci (mis. pemilik kunci polos dihapus)
export function dropPianoRollNotesOf(suffix: string) {   // buang semua nada berkunci "<pattern>@<suffix>" dan kabarkan perubahannya
  for (const k of [...states.keys()]) if (k.endsWith('@' + suffix)) { states.delete(k); onChange && onChange(k); }
}
export const pianoRollExtraKeys = (id: string): string[] => [...states.keys()].filter(k => k.startsWith(id + '@') && states.get(k)!.notes.length);
export function trimPianoRollNotes(id: string, toBeat: number) {   // buang / potong nada yang melewati toBeat
  const x = states.get(id); if (!x) return;
  x.notes = x.notes.filter(n => n.s < toBeat - 1e-9).map(n => ({...n, l: Math.min(n.l, toBeat - n.s)}));
}

// Zoom (pinch 2 jari / wheel) bisa memicu ratusan event per detik. Dulu tiap event menulis lebar ruang scroll + scrollLeft + scrollTop
// langsung (beberapa layout paksa per event). Sekarang event hanya mencatat target; DOM ditulis SEKALI per frame di redraw().
let zoomPend: {l: number; t: number} | null = null, zoomFrame = false;
const curL = () => (zoomPend ? zoomPend.l : sc.scrollLeft), curT = () => (zoomPend ? zoomPend.t : sc.scrollTop);   // posisi scroll efektif (termasuk zoom yang belum ditulis)
function flushZoom() {
  if (!zoomPend) return;
  const z = zoomPend; zoomPend = null;
  applySize(); sc.scrollLeft = z.l; sc.scrollTop = z.t;
}
// Saat zoom, grid TIDAK digambar ulang: gambar terakhir hanya diskalakan GPU lewat CSS transform (hampir gratis).
// Begitu zoom berhenti ZOOM_IDLE ms (atau jari lepas), layout ditulis sekali dan grid digambar ulang tajam.
const ZOOM_IDLE = 120;
let zoomEndT = 0, hudGrid = 0, hudMode = 'full';
function commitZoom() {
  zoomEndT = 0;
  if (!zoomPend) return;
  if (pinch) { zoomEndT = window.setTimeout(commitZoom, ZOOM_IDLE); return; }   // jari masih menempel
  flushZoom(); zoomFrame = true; schedule();
}
function redraw() {
  const t0 = performance.now();
  if (zoomPend) {
    const z = zoomPend;
    if (!pinch && drawn.ppb === ppb && drawn.rowH === rowH && !gridCovers(z.l, z.t)) {   // geser sudah melewati overscan: gambar ulang sekarang
      window.clearTimeout(zoomEndT); zoomEndT = 0; flushZoom(); zoomFrame = true; gridDirty = true;
    } else {
      hudMode = 'preview';
      placeGrid(z.l, z.t); drawKeys(); drawRuler(); placePlayhead();
      if (selBar && !selBar.hidden) { selBar.hidden = true; selBarOn = false; }
      window.clearTimeout(zoomEndT); zoomEndT = window.setTimeout(commitZoom, ZOOM_IDLE);
      hudTick(t0); return;
    }
  }
  if (!gridDirty && gridCovers(sc.scrollLeft, sc.scrollTop)) {   // hanya scroll biasa & masih di dalam canvas: geser saja
    hudMode = 'scroll';
    placeGrid(sc.scrollLeft, sc.scrollTop); drawKeys(); drawRuler(); placeSelBar(); placePlayhead();
    hudTick(t0); return;
  }
  hudMode = 'full'; gridDirty = false;
  const zo = zoomFrame; zoomFrame = false;
  drawGrid(zo); drawKeys(); drawRuler(); placeSelBar(); placePlayhead();
  // notifyChange membuat JSON seluruh note: di frame zoom ditunda (note tidak berubah), supaya tidak ikut membebani gesture
  if (zo) { window.clearTimeout(notifyT); notifyT = window.setTimeout(notifyChange, 250); } else notifyChange();
  hudTick(t0);
}

// ---------- penghitung FPS sementara (hapus blok ini + elemen .pr__hud kalau sudah tidak perlu) ----------
let hudEl: HTMLElement | null = null; const hudT: number[] = []; let hudJs = 0;
function hudTick(t0: number) {
  const now = performance.now(); hudJs = now - t0;
  hudT.push(now); if (hudT.length > 30) hudT.shift();
  if (!hudEl) return;
  let fps = 0;
  if (hudT.length > 1) { const span = hudT[hudT.length - 1] - hudT[0]; fps = span > 0 ? (hudT.length - 1) * 1000 / span : 0; }
  hudEl.textContent = 'FPS ' + Math.round(fps) + ' · js ' + hudJs.toFixed(1) + 'ms · grid ' + hudGrid.toFixed(1) + 'ms · ' + hudMode;
}
let notifyT = 0;
function schedule() { gridDirty = true; scheduleScroll(); }
function scheduleScroll() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); }   // scroll murni: isi grid tidak berubah
// geser (sentuh / tool tangan): posisi disimpan di zoomPend, canvas digeser lewat transform; layout baru ditulis saat berhenti
function panTo(l: number, t: number) {
  const maxL = Math.max(0, total * ppb + EDGE_PAD - sc.clientWidth), maxT = Math.max(0, ROWS * rowH - sc.clientHeight);
  zoomPend = {l: clamp(l, 0, maxL), t: clamp(t, 0, maxT)};
  scheduleScroll();
}

// ---------- ukuran & zoom ----------
function applySize() {
  space.style.width = total * ppb + EDGE_PAD + 'px';
  space.style.height = ROWS * rowH + 'px';
}
function setZoomAt(nppb: number, nrow: number, vx: number, vy: number, beatAt: number, rowAt: number) {
  ppb = clamp(nppb, PPB_MIN, PPB_MAX); rowH = clamp(nrow, ROW_MIN, ROW_MAX);
  zoomPend = {l: Math.max(0, beatAt * ppb - vx), t: Math.max(0, rowAt * rowH - vy)}; zoomFrame = true;
  schedule();
}
function zoomBy(fx: number, fy: number) {
  const vw = sc.clientWidth, vh = sc.clientHeight;
  setZoomAt(ppb * fx, rowH * fy, vw / 2, vh / 2, (curL() + vw / 2) / ppb, (curT() + vh / 2) / rowH);
  commitZoom();   // tombol / keyboard: satu langkah, tidak perlu preview
}

// ---------- operasi data ----------
function pushUndo(s?: string) {
  undoStack.push(s ?? snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUI();
}
function undo() {
  const s = undoStack.pop(); if (s === undefined) return;
  redoStack.push(snapshot());
  st.notes = JSON.parse(s) as Note[];
  selected = new Set([...selected].filter(id => st.notes.some(n => n.id === id)));
  updateUI(); schedule();
}
function redo() {
  const s = redoStack.pop(); if (s === undefined) return;
  undoStack.push(snapshot());
  st.notes = JSON.parse(s) as Note[];
  selected = new Set([...selected].filter(id => st.notes.some(n => n.id === id)));
  updateUI(); schedule();
}
function deleteSelected() {
  if (!selected.size) return;
  pushUndo();
  st.notes = st.notes.filter(n => !selected.has(n.id));
  selected.clear(); updateUI(); schedule();
}
// salin / tempel nada (clipboard dibagi antar pattern; posisi disimpan relatif ke nada paling kiri)
let clip: Array<{p: number; s: number; l: number; sl?: boolean}> = [];
function copySelected() {
  if (!selected.size) return;
  const sel = st.notes.filter(n => selected.has(n.id)), s0 = Math.min(...sel.map(n => n.s));
  clip = sel.map(n => ({p: n.p, s: n.s - s0, l: n.l, ...(n.sl ? {sl: true} : {})}));
  updateUI(); flashBtn('copy');
}
function pasteNotes() {
  if (!clip.length) return;
  const span = Math.max(...clip.map(c => c.s + c.l));
  if (span > total) return shakeSelBar();
  const sel = st.notes.filter(n => selected.has(n.id));
  // ada pilihan: tempel tepat di kanan pilihan; tidak ada: di awal area yang terlihat
  let at = sel.length ? snapRound(Math.max(...sel.map(n => n.s + n.l))) : snapFloor(sc.scrollLeft / ppb);
  if (at + span > total + 1e-9) { if (sel.length) return shakeSelBar(); at = total - span; }
  pushUndo();
  const made = clip.map(c => ({id: st.nextId++, p: c.p, s: at + c.s, l: c.l, ...(c.sl ? {sl: true} : {})}));
  st.notes.push(...made);
  selected = new Set(made.map(n => n.id));
  updateUI(); schedule();
  sc.scrollLeft = clamp(sc.scrollLeft, Math.max(0, (at + span) * ppb - sc.clientWidth + 60), at * ppb);   // pastikan hasil tempel terlihat
}
function toggleSlide() {   // semua nada terpilih: kalau sudah slide semua -> matikan, selain itu -> nyalakan
  if (!selected.size) return;
  const sel = st.notes.filter(n => selected.has(n.id)), all = sel.every(n => n.sl);
  pushUndo();
  for (const n of sel) { if (all) delete n.sl; else n.sl = true; }
  updateUI(); schedule(); flashBtn('slide');
}
function selectAll() { selected = new Set(st.notes.map(n => n.id)); updateUI(); schedule(); }
function nudge(dB: number, dP: number) {
  if (!selected.size) return;
  const sel = st.notes.filter(n => selected.has(n.id));
  const minS = Math.min(...sel.map(n => n.s)), maxE = Math.max(...sel.map(n => n.s + n.l));
  const minP = Math.min(...sel.map(n => n.p)), maxP = Math.max(...sel.map(n => n.p));
  dB = clamp(dB, -minS, total - maxE); dP = clamp(dP, P_MIN - minP, P_MAX - maxP);
  if (!dB && !dP) return;
  pushUndo();
  for (const n of sel) { n.s += dB; n.p += dP; }
  schedule();
}

function updateUI() {
  if (!root) return;
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
  if (btnPaste) btnPaste.disabled = clip.length === 0;
}

// ---------- interaksi pointer ----------
interface Gesture {
  kind: 'new' | 'move' | 'resize' | 'marquee' | 'erase' | 'pan' | 'tapdraw';
  id: number;                 // pointerId
  x0: number; y0: number;     // posisi awal (koordinat konten)
  x: number; y: number;       // posisi sekarang (koordinat konten)
  snap0: string; pushed: boolean; changed: boolean;
  anchor?: Note; orig?: Note[]; base?: Set<number>;
  sl: number; stp: number;    // scroll awal (untuk pan)
  cx: number; cy: number;     // posisi client awal (untuk pan)
  t0: number;                 // waktu mulai (animasi bulatan)
  desel?: boolean;            // tap di area kosong saat ada seleksi: hanya lepas seleksi, jangan pasang nada
  touch?: boolean; moved?: boolean; timer?: number;   // tahan di area kosong (timer) lalu seret = blok / marquee
  gh?: Ghost;                 // tap awal jatuh di nada VST lain: kalau ditahan sampai HOLD_MS, pindah ke VST itu
}
let g: Gesture | null = null;
const ptrs = new Map<number, {x: number; y: number}>();
let pinch: {d0x: number; d0y: number; ppb0: number; row0: number; beat0: number; rowPos0: number} | null = null;

function localXY(e: {clientX: number; clientY: number}) {
  const r = sc.getBoundingClientRect();
  return {x: e.clientX - r.left + curL(), y: e.clientY - r.top + curT()};
}
function hit(cx: number, cy: number): {n: Note} | null {
  const row = Math.floor(cy / rowH), p = P_MAX - row;
  for (let i = st.notes.length - 1; i >= 0; i--) {
    const n = st.notes[i];
    if (n.p !== p) continue;
    const x0 = n.s * ppb, x1 = (n.s + n.l) * ppb;
    if (cx >= x0 && cx <= x1) return {n};
  }
  return null;
}
// nada VST lain (ghost) di titik ini; yang digambar paling atas (terakhir) menang. Hanya ghost yang punya open() yang bisa dituju.
function hitGhost(cx: number, cy: number): Ghost | null {
  const p = P_MAX - Math.floor(cy / rowH);
  for (let i = ghostSrc.length - 1; i >= 0; i--) {
    const gs = ghostSrc[i], gst = states.get(gs.key);
    if (!gs.open || !gst) continue;
    for (let j = gst.notes.length - 1; j >= 0; j--) {
      const n = gst.notes[j];
      if (n.p === p && cx >= n.s * ppb && cx <= n.s * ppb + Math.max(3, n.l * ppb)) return gs;
    }
  }
  return null;
}
function hitHandle(cx: number, cy: number): Note | null {
  let best: Note | null = null, bd = 1e9;
  for (const n of st.notes) {
    if (!selected.has(n.id)) continue;   // hanya note terpilih yang punya bulatan
    const ex = handleCX(n), ey = (P_MAX - n.p + 0.5) * rowH, endX = n.s * ppb + Math.max(3, n.l * ppb);
    if (cx < endX || cx > ex + 16 || Math.abs(cy - ey) > Math.max(rowH / 2, 11)) continue;   // tidak pernah masuk ke badan note
    const d = Math.hypot(cx - ex, cy - ey);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
function commit() { if (g && !g.pushed) { pushUndo(g.snap0); g.pushed = true; } }

function cancelGesture() {
  if (g) clearTimeout(g.timer);
  if (g && g.pushed) { st.notes = JSON.parse(g.snap0) as Note[]; undoStack.pop(); }
  g = null; updateUI(); schedule();
}

function onDown(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
  gc.setPointerCapture(e.pointerId);
  barOff = false;   // sentuhan baru: klik note = menu muncul lagi
  if (ptrs.size === 2) {                       // pinch: batalkan apa pun yang sedang digambar
    if (g) cancelGesture();
    const [a, b] = [...ptrs.values()];
    const r = sc.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    pinch = {d0x: Math.abs(a.x - b.x), d0y: Math.abs(a.y - b.y), ppb0: ppb, row0: rowH, beat0: (curL() + mx) / ppb, rowPos0: (curT() + my) / rowH};
    return;
  }
  if (ptrs.size > 2 || pinch) return;

  const {x, y} = localXY(e);
  const base: Gesture = {kind: 'pan', id: e.pointerId, x0: x, y0: y, x, y, snap0: snapshot(), pushed: false, changed: false, sl: curL(), stp: curT(), cx: e.clientX, cy: e.clientY, t0: performance.now()};
  const t: Tool = e.button === 1 ? 'pan' : tool;

  if (t === 'pan') { g = base; gc.style.cursor = 'grabbing'; return; }
  const h = hit(x, y);

  if (t === 'erase') {
    g = {...base, kind: 'erase'};
    if (h) { commit(); st.notes = st.notes.filter(n => n !== h.n); selected.delete(h.n.id); g.changed = true; updateUI(); schedule(); }
    return;
  }
  const hh = hitHandle(x, y);
  if (hh) {                                     // tarik bulatan putih: ubah panjang
    if (!selected.has(hh.id)) selected = new Set([hh.id]);
    g = {...base, kind: 'resize', anchor: {...hh}, orig: st.notes.filter(n => selected.has(n.id)).map(n => ({...n}))};
    updateUI(); schedule(); return;
  }
  if (h) {                                      // klik di nada: pilih + pindah
    if (e.shiftKey && t === 'select') {
      if (selected.has(h.n.id)) selected.delete(h.n.id); else selected.add(h.n.id);
      updateUI(); schedule(); return;
    }
    if (!selected.has(h.n.id)) { if (!e.shiftKey) selected.clear(); selected.add(h.n.id); }
    g = {...base, kind: 'move', anchor: {...h.n}, orig: st.notes.filter(n => selected.has(n.id)).map(n => ({...n}))};
    updateUI(); schedule(); return;
  }
  if (t === 'select') {                         // area kosong: marquee
    g = {...base, kind: 'marquee', base: e.shiftKey ? new Set(selected) : new Set()};
    if (!e.shiftKey) selected.clear();
    updateUI(); schedule(); return;
  }
  // draw di area kosong: tap/klik = pasang nada; seret = nada panjang (mouse) / scroll (sentuh); TAHAN lalu seret = blok nada (marquee)
  const touch = e.pointerType === 'touch', desel = selected.size > 0;
  if (desel && !touch) { selected.clear(); updateUI(); schedule(); }   // ada seleksi: klik kosong cuma melepas seleksi dulu
  g = {...base, kind: 'tapdraw', desel, touch, gh: hitGhost(x, y) || undefined};
  g.timer = window.setTimeout(holdMarquee, HOLD_MS);
}
const HOLD_MS = 320;
function holdMarquee() {
  if (!g || g.kind !== 'tapdraw' || g.moved) return;
  if (g.gh) {                                   // tahan di nada VST lain: pindah ke VST itu (zoom & scroll tetap)
    const open = g.gh.open!;
    g = null; ptrs.clear(); updateUI(); schedule();
    if (navigator.vibrate) navigator.vibrate(12);
    open();
    return;
  }
  g.timer = undefined; g.kind = 'marquee'; g.base = new Set(); selected.clear();
  if (navigator.vibrate) navigator.vibrate(12);
  updateUI(); schedule();
}

function addNoteAt(x: number, y: number): Note | null {
  const p = P_MAX - Math.floor(y / rowH);
  if (p < P_MIN || p > P_MAX || x < 0 || x >= total * ppb) return null;
  const s = clamp(snapFloor(x / ppb), 0, total - unit());
  const l = Math.min(lastLen, total - s);
  if (l <= 0) return null;
  pushUndo();
  const n: Note = {id: st.nextId++, p, s, l};
  st.notes.push(n);   // note baru tidak langsung terpilih; baru terpilih kalau diklik lagi
  return n;
}

function onMove(e: PointerEvent) {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const r = sc.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    const nppb = pinch.d0x > 40 ? pinch.ppb0 * dx / pinch.d0x : pinch.ppb0;
    const nrow = pinch.d0y > 40 ? pinch.row0 * dy / pinch.d0y : pinch.row0;
    setZoomAt(nppb, nrow, mx, my, pinch.beat0, pinch.rowPos0);
    return;
  }
  const {x, y} = localXY(e);
  if (!g || g.id !== e.pointerId) {            // hover (mouse)
    const p = P_MAX - Math.floor(y / rowH);
    const np = p >= P_MIN && p <= P_MAX ? p : -1;
    if (np !== hoverP) { hoverP = np; schedule(); }
    const h = hit(x, y), onHandle = (tool === 'draw' || tool === 'select') && !!hitHandle(x, y);
    gc.style.cursor = tool === 'pan' ? 'grab' : tool === 'erase' ? (h ? 'pointer' : 'default') : onHandle ? 'ew-resize' : h ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    return;
  }
  g.x = x; g.y = y;
  if ((g.kind === 'move' || g.kind === 'resize') && !g.moved && Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > (e.pointerType === 'touch' ? 8 : 5)) g.moved = true;   // sudah digeser = drag, bukan klik
  if (g.kind === 'tapdraw' && !g.moved && Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > (g.touch ? 8 : 5)) {
    g.moved = true; clearTimeout(g.timer); g.timer = undefined;       // gerak sebelum ditahan: bukan blok
    if (g.touch) g.kind = 'pan';                                      // sentuh: scroll
    else if (!g.desel) {                                              // mouse / pen: pasang nada, seret ke kanan = nada panjang
      selected.clear();
      const n = addNoteAt(g.x0, g.y0);
      if (n) { g.kind = 'new'; g.anchor = n; g.changed = true; updateUI(); schedule(); }
    }
  }
  switch (g.kind) {
    case 'pan':
      panTo(g.sl - (e.clientX - g.cx), g.stp - (e.clientY - g.cy)); break;
    case 'new': {
      const n = g.anchor!;
      if (Math.abs(x - g.x0) > 3) {
        const end = clamp(snapRound(x / ppb), n.s + unit(), total);
        n.l = Math.max(unit(), end - n.s);
      }
      schedule(); break;
    }
    case 'move': {
      const a0 = g.orig!.find(o => o.id === g!.anchor!.id)!;
      let dB = snapRound(a0.s + (x - g.x0) / ppb) - a0.s;
      let dP = -Math.round((y - g.y0) / rowH);
      const minS = Math.min(...g.orig!.map(o => o.s)), maxE = Math.max(...g.orig!.map(o => o.s + o.l));
      const minP = Math.min(...g.orig!.map(o => o.p)), maxP = Math.max(...g.orig!.map(o => o.p));
      dB = clamp(dB, -minS, total - maxE); dP = clamp(dP, P_MIN - minP, P_MAX - maxP);
      if (!g.changed && (dB || dP)) { commit(); g.changed = true; }
      for (const o of g.orig!) { const n = st.notes.find(q => q.id === o.id); if (n) { n.s = o.s + dB; n.p = o.p + dP; } }
      schedule(); break;
    }
    case 'resize': {
      const a0 = g.anchor!, end0 = a0.s + a0.l;
      const dL = snapRound(end0 + (x - g.x0) / ppb) - end0;
      if (!g.changed && dL) { commit(); g.changed = true; }
      for (const o of g.orig!) {
        const n = st.notes.find(q => q.id === o.id);
        if (n) n.l = clamp(o.l + dL, unit(), total - o.s);
      }
      schedule(); break;
    }
    case 'marquee': {
      const x0 = Math.min(g.x0, x), x1 = Math.max(g.x0, x), y0 = Math.min(g.y0, y), y1 = Math.max(g.y0, y);
      const sel = new Set(g.base);
      for (const n of st.notes) {
        const nx0 = n.s * ppb, nx1 = (n.s + n.l) * ppb, ny0 = (P_MAX - n.p) * rowH, ny1 = ny0 + rowH;
        if (nx1 >= x0 && nx0 <= x1 && ny1 >= y0 && ny0 <= y1) sel.add(n.id);
      }
      selected = sel; updateUI(); schedule(); break;
    }
    case 'erase': {
      const h = hit(x, y);
      if (h) { commit(); st.notes = st.notes.filter(n => n !== h.n); selected.delete(h.n.id); g.changed = true; updateUI(); schedule(); }
      break;
    }
  }
}

function onUp(e: PointerEvent) {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) { const was = !!pinch; pinch = null; if (was && zoomPend) { window.clearTimeout(zoomEndT); commitZoom(); } }
  if (g && g.id === e.pointerId) {
    clearTimeout(g.timer);
    if (g.kind === 'tapdraw' && !g.moved && e.type === 'pointerup') {
      if (g.desel) { selected.clear(); }          // ada seleksi: tap kosong cuma melepas seleksi
      else {
        selected.clear();
        const n = addNoteAt(g.x0, g.y0);
        if (n) lastLen = n.l;
      }
    }
    if ((g.kind === 'move' || g.kind === 'resize') && g.moved) barOff = true;   // habis drag note: jangan tampilkan menu
    if (g.kind === 'resize') rel = {id: g.anchor!.id, t0: performance.now()};
    if (g.kind === 'new' || g.kind === 'resize') {
      const id = g.anchor!.id, n = st.notes.find(q => q.id === id);
      if (n && n.l >= unit()) lastLen = n.l;
    }
    g = null;
    updateUI(); schedule();
    gc.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  }
}

function onWheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return;     // scroll biasa dibiarkan native
  e.preventDefault();
  const r = sc.getBoundingClientRect(), vx = e.clientX - r.left, vy = e.clientY - r.top;
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.006));
  const beat = (curL() + vx) / ppb, rowPos = (curT() + vy) / rowH;
  if (e.altKey) setZoomAt(ppb, rowH * f, vx, vy, beat, rowPos); else setZoomAt(ppb * f, rowH, vx, vy, beat, rowPos);
}

// ---------- bangun UI ----------
function setTool(t: Tool) {
  tool = t;
  root!.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  gc.style.cursor = t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
}

// ---------- menu pengaturan (titik tiga): card berlapis seperti menu track di mixer ----------
// card 1: View + Note Key  ->  klik View: card 2 (Color + Style)  ->  klik Color: card 3 (pilihan warna)
let showNoteNames = false;   // Note Key: tampilkan nama semua nada (C, C#, D, D#, ...) di keyboard kiri; mati = hanya C
const PR_COLORS = ['#5b3de8', '#2f7bff', '#14b8a6', '#3fbf5f', '#ff9f1c', '#ff4d8d', '#ef4444', '#facc15'];   // sama dengan pilihan warna track di mixer
const CHEV = '<svg class="track-menu__chev" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6.045 20.89a1.164 1.164 0 0 0 1.639.174l5.05-4.079 5.048-4.078a1.164 1.164 0 0 0 0-1.813l-5.049-4.078-5.049-4.078A1.165 1.165 0 1 0 6.22 4.75l4.488 3.625L15.196 12l-4.488 3.625L6.22 19.25a1.166 1.166 0 0 0-.175 1.64Z"/></svg>';
const mico = (d: string) => '<svg class="pr__mico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const MICO = {
  view: mico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  keys: mico('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M15 4v16"/>'),
  style: mico('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/>'),
};

function buildSettingsMenu(el: HTMLElement) {
  const more = el.querySelector<HTMLButtonElement>('.pr__more')!;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cards: HTMLElement[] = [];   // [card utama, card View, card warna]

  const fade = (c: HTMLElement) => {
    if (reduce()) { c.remove(); return; }
    c.style.pointerEvents = 'none';
    c.animate([{opacity: 1, transform: 'scale(1)'}, {opacity: 0, transform: 'scale(.9) translateY(-4px)'}],
      {duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards'}).onfinish = () => c.remove();
  };
  const dropFrom = (level: number) => {
    cards.splice(level).forEach(fade);
    const items = cards.map(c => c.querySelector<HTMLElement>('[aria-expanded]'));
    items.forEach((it, i) => it && it.setAttribute('aria-expanded', String(i < cards.length - 1)));
  };
  const closeAll = () => { cards.splice(0).forEach(fade); more.setAttribute('aria-expanded', 'false'); };

  const makeCard = (extra: string, html: string) => {
    const c = document.createElement('div');
    c.className = 'track-menu pr-menu ' + extra; c.setAttribute('role', 'menu'); c.innerHTML = html;
    document.body.appendChild(c); cards.push(c);
    return c;
  };
  // card di sebelah kanan card induk (kalau tidak muat: kiri; kalau layar sempit: bertumpuk di atas induk)
  const placeSub = (c: HTMLElement, parent: HTMLElement, item: HTMLElement) => {
    const mr = parent.getBoundingClientRect(), ir = item.getBoundingClientRect(), w = c.offsetWidth, h = c.offsetHeight;
    let left = mr.right + 4, top = ir.top - 6, origin = 'left top';
    if (left + w > innerWidth - 8) {
      if (mr.left - w - 4 >= 8) { left = mr.left - w - 4; origin = 'right top'; }
      else { left = Math.max(8, Math.min(mr.left, innerWidth - w - 8)); top = mr.bottom + 6; }   // layar sempit: card ditumpuk ke bawah
    }
    c.style.left = left + 'px';
    c.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
    c.style.transformOrigin = origin;
  };

  const openColors = (parent: HTMLElement, item: HTMLElement) => {
    const c = makeCard('track-menu--colors',
      '<div class="track-menu__swatches">' +
      PR_COLORS.map((col, i) => '<button type="button" class="track-menu__swatch" data-c="' + col + '" style="background:' + col + ';--i:' + i + '" aria-label="Warna ' + col + '"></button>').join('') +
      '</div>');
    placeSub(c, parent, item);
    item.setAttribute('aria-expanded', 'true');
    c.addEventListener('click', e => {
      const sw = (e.target as HTMLElement).closest<HTMLElement>('.track-menu__swatch');
      if (!sw) return;
      color = sw.dataset.c!;
      root!.style.setProperty('--pr-color', color);
      schedule();
      closeAll();
    });
  };

  const openView = (parent: HTMLElement, item: HTMLElement) => {
    const c = makeCard('',
      '<button type="button" role="menuitem" class="track-menu__item" data-act="color" aria-expanded="false">' +
        '<span class="track-menu__dot" style="background:' + color + '"></span><span>Color</span>' + CHEV + '</button>' +
      '<button type="button" role="menuitem" class="track-menu__item" data-act="style">' + MICO.style + '<span>Style</span></button>');
    placeSub(c, parent, item);
    item.setAttribute('aria-expanded', 'true');
    c.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!it || it.dataset.act !== 'color') return;   // Style: tampilan saja
      if (cards.length > 2) dropFrom(2); else openColors(c, it);
    });
  };

  const openMain = () => {
    const c = makeCard('',
      '<button type="button" role="menuitem" class="track-menu__item" data-act="view" aria-expanded="false">' + MICO.view + '<span>View</span>' + CHEV + '</button>' +
      '<button type="button" role="menuitemcheckbox" class="track-menu__item pr__mtoggle" data-act="notekey" aria-checked="' + showNoteNames + '">' + MICO.keys + '<span>Note Key</span><i class="pr__sw" aria-hidden="true"></i></button>');
    const r = more.getBoundingClientRect();
    c.style.left = Math.max(8, Math.min(r.left, innerWidth - c.offsetWidth - 8)) + 'px';
    c.style.top = (r.bottom + 8) + 'px';
    c.style.transformOrigin = 'left top';
    more.setAttribute('aria-expanded', 'true');
    c.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!it) return;
      if (it.dataset.act === 'view') { if (cards.length > 1) dropFrom(1); else openView(c, it); }
      else if (it.dataset.act === 'notekey') {
        showNoteNames = !showNoteNames;
        it.setAttribute('aria-checked', String(showNoteNames));
        schedule();   // gambar ulang keyboard kiri
      }
    });
  };

  more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => { if (cards.length) closeAll(); else openMain(); });

  // klik di luar menu: tutup semua card (klik di area canvas tidak ikut menggambar nada)
  document.addEventListener('pointerdown', e => {
    if (!cards.length) return;
    const t = e.target as Node;
    if (cards.some(c => c.contains(t)) || more.contains(t)) return;
    closeAll();
    if (el.querySelector('.pr__main')!.contains(t)) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  closeMenu = closeAll;
  menuOpen = () => cards.length > 0;
}

function build(): HTMLElement {
  const el = document.createElement('section');
  el.id = 'pianoRoll'; el.className = 'pr'; el.setAttribute('aria-label', 'Piano roll'); el.hidden = true;
  const btn = (attr: string, label: string, svg: string, extra = '') =>
    '<button type="button" class="pr__btn ' + extra + '" ' + attr + ' title="' + label + '" aria-label="' + label + '">' + svg + '</button>';
  el.innerHTML =
    '<div class="pr__bar">' +
      '<button type="button" class="pr__btn pr__more" aria-label="Menu lainnya" title="Lainnya">' + ICON.more + '</button>' +
      '<button type="button" class="pr__snap" aria-pressed="true" aria-label="Snap ke grid" title="Snap ke grid: nyala / mati"><i class="pr__led" aria-hidden="true"></i><span>Snap</span></button>' +
      '<div class="pr__grp">' +
        btn('data-act="undo"', 'Urungkan (Ctrl+Z)', ICON.undo) +
        btn('data-act="redo"', 'Ulangi (Ctrl+Shift+Z / Ctrl+Y)', ICON.redo) +
      '</div>' +
      '<div class="pr__grp pr__grp--close">' +
        '<button type="button" class="pr__btn pr__back" aria-label="Tutup piano roll" title="Tutup (Esc)">' + ICON.close + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="pr__main">' +
      '<div class="pr__corner"></div>' +
      '<canvas class="pr__ruler" aria-hidden="true"></canvas>' +
      '<canvas class="pr__keys" aria-hidden="true"></canvas>' +
      '<div class="pr__scroll"><div class="pr__space"></div><div class="pr__clip"><canvas class="pr__grid" role="img" aria-label="Grid nada"></canvas></div></div>' +
      '<div class="pr__phclip" aria-hidden="true"><div class="pr__ph"><svg width="9" height="20" viewBox="0 0 9 20"><path d="M5 0H4C1.79 0 0 1.79 0 4v8.6c0 .86.27 1.69.78 2.38L4.5 20l3.72-5.02A4 4 0 0 0 9 12.6V4c0-2.21-1.79-4-4-4Z" fill="currentColor"/></svg><i></i></div></div>' +
    '</div>';

  sc = el.querySelector<HTMLElement>('.pr__scroll')!;
  space = el.querySelector<HTMLElement>('.pr__space')!;
  gc = el.querySelector<HTMLCanvasElement>('.pr__grid')!;
  gclip = el.querySelector<HTMLElement>('.pr__clip')!;
  kc = el.querySelector<HTMLCanvasElement>('.pr__keys')!;
  rc = el.querySelector<HTMLCanvasElement>('.pr__ruler')!;
  hudEl = document.createElement('div'); hudEl.className = 'pr__hud'; hudEl.setAttribute('aria-hidden', 'true'); el.querySelector('.pr__main')!.appendChild(hudEl);
  btnUndo = el.querySelector<HTMLButtonElement>('[data-act="undo"]')!;
  btnRedo = el.querySelector<HTMLButtonElement>('[data-act="redo"]')!;

  // menu bulat Copy / Delete / Paste yang muncul di dekat note terpilih
  phDom = el.querySelector<HTMLElement>('.pr__ph')!;
  selBar = el.querySelector<HTMLElement>('.pr__main')!.appendChild(document.createElement('div'));
  selBar.className = 'pat-bar pr__sel'; selBar.hidden = true; selBar.setAttribute('role', 'toolbar'); selBar.setAttribute('aria-label', 'Aksi nada');
  ([['copy', 'Copy', 'Salin nada (Ctrl+C)', copySelected], ['del', 'Delete', 'Hapus nada (Del)', deleteSelected], ['paste', 'Paste', 'Tempel nada (Ctrl+V)', pasteNotes], ['slide', 'Slide', 'Slide: nada sebelumnya meluncur ke nada ini', toggleSlide]] as const)
    .forEach(([act, txt, label, fn], i) => {
      const b = document.createElement('button');
      b.className = 'pat-btn'; b.type = 'button'; b.dataset.sel = act; b.textContent = txt;
      b.setAttribute('aria-label', label); b.title = label; b.style.setProperty('--i', String(i));
      b.addEventListener('click', fn);
      selBar.appendChild(b);
    });
  btnPaste = selBar.querySelector<HTMLButtonElement>('[data-sel="paste"]')!;
  btnSlide = selBar.querySelector<HTMLButtonElement>('[data-sel="slide"]')!;
  btnPaste.disabled = clip.length === 0;

  const snapBtn = el.querySelector<HTMLButtonElement>('.pr__snap')!;
  snapBtn.addEventListener('click', () => { snapOn = !snapOn; snapBtn.setAttribute('aria-pressed', String(snapOn)); });
  const acts: Record<string, () => void> = {
    undo, redo,
  };
  el.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act!]()));

  rc.addEventListener('pointerdown', onRulerDown);
  rc.addEventListener('pointermove', onRulerMove);
  rc.addEventListener('pointerup', onRulerUp);
  rc.addEventListener('pointercancel', onRulerUp);
  gc.addEventListener('pointerdown', onDown);
  gc.addEventListener('pointermove', onMove);
  gc.addEventListener('pointerup', onUp);
  gc.addEventListener('pointercancel', onUp);
  gc.addEventListener('pointerleave', () => { if (hoverP !== -1 && !g) { hoverP = -1; schedule(); } });
  gc.addEventListener('wheel', onWheel, {passive: false});
  gc.addEventListener('contextmenu', e => e.preventDefault());
  sc.addEventListener('scroll', scheduleScroll, {passive: true});
  new ResizeObserver(() => { if (root && !root.hidden) schedule(); }).observe(sc);

  el.querySelector('.pr__back')!.addEventListener('click', closePianoRoll);
  buildSettingsMenu(el);
  return el;
}

export function openPianoRoll(opts: PianoRollOpts, host: HTMLElement = document.querySelector('.stage') as HTMLElement) {
  if (!root) { root = build(); host.appendChild(root); }
  const key = opts.id || opts.track + '/' + opts.pattern;
  if (key !== curKey) { undoStack = []; redoStack = []; selected = new Set(); }
  curKey = key;
  st = states.get(key) || {notes: [], nextId: 1};
  states.set(key, st);

  color = opts.color || '#3fbf5f';
  ghostSrc = opts.ghosts || [];
  root.style.setProperty('--pr-color', color);
  root.setAttribute('aria-label', opts.track + ' – ' + opts.pattern);

  const keep = !!opts.keepView && isPianoRollOpen();   // pindah antar VST saat piano roll sudah terbuka: tampilan tidak direset
  const kl = keep ? curL() : 0, kt = keep ? curT() : 0;
  root.hidden = false; void root.offsetWidth; root.classList.add('is-open');
  const vw = sc.clientWidth, vh = sc.clientHeight;
  if (!keep) { ppb = clamp(Math.floor(vw / total), 32, 96); rowH = 18; }
  applySize();
  if (keep) { sc.scrollLeft = kl; sc.scrollTop = kt; }
  else {
    const seen = st.notes.length ? st.notes : ghostSrc.flatMap(gs => states.get(gs.key)?.notes ?? []);   // belum ada nada sendiri: pusatkan ke nada instrumen lain
    const mid = seen.length ? seen.reduce((a, n) => a + n.p, 0) / seen.length : 62;   // mulai di sekitar C4
    sc.scrollLeft = 0; sc.scrollTop = Math.max(0, (P_MAX - mid) * rowH - vh / 2);
  }
  resetAnim(); selBarOn = false; selBar.hidden = true;
  phSig = ''; keysSig = rulerSig = ''; zoomPend = null; zoomFrame = false; window.clearTimeout(zoomEndT); gc.style.transform = ''; drawn.ppb = 0; gridDirty = true;
  if (!keep) setTool('draw');
  updateUI(); redraw();
}

export function closePianoRoll() {
  if (!root || root.hidden) return;
  closeMenu();
  const r = root; r.classList.remove('is-open'); g = null; ptrs.clear(); pinch = null; phStop(); phSig = ''; window.clearTimeout(zoomEndT); zoomPend = null; gc.style.transform = '';
  setTimeout(() => { if (!r.classList.contains('is-open')) r.hidden = true; }, 200);
  onClose && onClose();
}
export const isPianoRollOpen = () => !!root && !root.hidden && root.classList.contains('is-open');
export const setPianoRollCloseHandler = (fn: () => void) => { onClose = fn; };

document.addEventListener('keydown', e => {
  if (!isPianoRollOpen()) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (k === 'Escape') { if (menuOpen()) closeMenu(); else closePianoRoll(); return; }
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && k.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return; }
  if (mod && k.toLowerCase() === 'v') { e.preventDefault(); pasteNotes(); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  if (mod) return;
  if (k === 'ArrowUp') { e.preventDefault(); nudge(0, e.shiftKey ? 12 : 1); }
  else if (k === 'ArrowDown') { e.preventDefault(); nudge(0, e.shiftKey ? -12 : -1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); nudge(-unit(), 0); }
  else if (k === 'ArrowRight') { e.preventDefault(); nudge(unit(), 0); }
  else if (k === '=' || k === '+') zoomBy(1.4, 1);
  else if (k === '-') zoomBy(1 / 1.4, 1);
  else if (k.toLowerCase() === 'b') setTool('draw');
  else if (k.toLowerCase() === 'v') setTool('select');
  else if (k.toLowerCase() === 'e') setTool('erase');
  else if (k.toLowerCase() === 'h') setTool('pan');
});
