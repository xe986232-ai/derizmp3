// Piano roll: editor nada berbasis canvas (belum ada suara, sesuai tahap ini).
// Fitur: pasang / geser / ubah panjang / hapus nada, pilih banyak (marquee), snap, undo,
// geser (scroll / 2 jari).
// Nada disimpan di memori per pattern (kunci `id`), jadi tetap ada saat piano roll ditutup lalu dibuka lagi.

export interface PianoRollOpts {
  id?: string;        // kunci pattern supaya nada tersimpan per pattern
  track: string;
  pattern: string;
  color?: string;
}

interface Note { id: number; p: number; s: number; l: number; }   // p: MIDI, s/l: dalam ketukan
interface State { notes: Note[]; nextId: number; }
type Tool = 'draw' | 'select' | 'erase' | 'pan';

const P_MIN = 24, P_MAX = 108, ROWS = P_MAX - P_MIN + 1;   // C1..C8
const KEY_W = 64, RULER_H = 32, BEATS_PER_BAR = 4, BARS = 8;   // grid selalu 8 bar (nomor 1..8)
const PPB_MIN = 8, PPB_MAX = 480, ROW_MIN = 10, ROW_MAX = 40;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

const isBlack = (p: number) => BLACK.has(p % 12);
const pname = (p: number) => NAMES[p % 12] + (Math.floor(p / 12) - 1);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const ic = (d: string) =>
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const ICON = {
  back: ic('<path d="M15 5l-7 7 7 7"/>'),
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

// elemen
let sc!: HTMLElement, space!: HTMLElement, gc!: HTMLCanvasElement, kc!: HTMLCanvasElement, rc!: HTMLCanvasElement;
let phDom!: HTMLElement, phBeat = -1;   // playhead: posisi dalam ketukan relatif ke awal pattern (<0 = tersembunyi)
let btnUndo!: HTMLButtonElement, btnRedo!: HTMLButtonElement, selBar!: HTMLElement, btnPaste!: HTMLButtonElement;

// state editor
let st: State = {notes: [], nextId: 1};
let curKey = '';
const total = BARS * BEATS_PER_BAR;
let ppb = 64, rowH = 18;
let tool: Tool = 'draw';
let snapOn = true;   // tombol Snap (lampu indikator): nyala = note menempel ke garis grid yang terlihat
let color = '#3fbf5f';
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
function fit(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// garis vertikal bertingkat: bar > ketukan > 1/2 > 1/4 > 1/8
const LEVELS: Array<[number, number]> = [[4, 0.42], [1, 0.2], [0.5, 0.11], [0.25, 0.08], [0.125, 0.06]];
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
  if (w > 30 && rowH >= 14) { c.fillStyle = 'rgba(0,0,0,.65)'; c.fillText(pname(n.p), x + 5, y + rowH / 2 + 0.5); }
}
// bulatan putih di LUAR ujung kanan note (tidak menyentuh badan note); k = skala animasi
function drawHandle(c: CanvasRenderingContext2D, n: Note, sx: number, sy: number, k: number) {
  const r = handleR() * k; if (r < 0.4) return;
  const cx = handleCX(n) - sx, cy = (P_MAX - n.p + 0.5) * rowH - sy;
  c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.arc(cx, cy + 0.5, r + k, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
}

function drawGrid() {
  const vw = sc.clientWidth, vh = sc.clientHeight;
  const c = fit(gc, vw, vh), sx = sc.scrollLeft, sy = sc.scrollTop;
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
    eachVLine(sx, vw, (x, _b, li) => { c.fillStyle = 'rgba(255,255,255,' + LEVELS[li][1] + ')'; c.fillRect(x - 0.5, 0, 1, vh); });
    // garis akhir pattern
    const ex = Math.round(total * ppb - sx);
    if (ex >= 0 && ex <= vw) { c.fillStyle = color; c.fillRect(ex - 1, 0, 2, vh); }
  }
  // nada
  const now = performance.now(); let animating = false;
  if (!REDUCE) {                                // deteksi note baru / hilang sejak gambar terakhir (mencakup undo, hapus, erase)
    const cur = new Set(st.notes.map(n => n.id));
    for (const n of st.notes) if (!lastDrawn.has(n.id) || (selected.has(n.id) && !lastSel.has(n.id))) born.set(n.id, now);   // baru dibuat / baru dipilih -> bulatan pop
    for (const [id, n] of lastDrawn) if (!cur.has(id)) ghosts.push({n, t0: now, h: lastSel.has(id)});
  }
  lastDrawn = new Map(st.notes.map(n => [n.id, {...n}])); lastSel = new Set(selected);
  const fs = Math.min(11, rowH - 4);
  c.font = '600 ' + fs + 'px system-ui,sans-serif'; c.textBaseline = 'middle';
  const visible = (n: Note) => {
    const x = n.s * ppb - sx, w = Math.max(3, n.l * ppb), y = (P_MAX - n.p) * rowH - sy;
    return !(x + w + 2 * handleR() + 8 < 0 || x > vw || y + rowH < 0 || y > vh);
  };
  for (const n of st.notes) if (visible(n)) drawNoteBody(c, n, sx, sy, selected.has(n.id));
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
  // marquee
  if (g && g.kind === 'marquee') {
    const a = g.x0 - sx, b = g.y0 - sy, w = g.x - g.x0, h = g.y - g.y0;
    c.fillStyle = 'rgba(255,255,255,.12)'; c.strokeStyle = '#fff'; c.lineWidth = 1;
    c.fillRect(a, b, w, h); c.strokeRect(a + 0.5, b + 0.5, w, h);
  }
}

function drawKeys() {
  const vh = sc.clientHeight, sy = sc.scrollTop;
  const c = fit(kc, KEY_W, vh);
  c.fillStyle = '#e9eaf0'; c.fillRect(0, 0, KEY_W, vh);
  const r0 = Math.max(0, Math.floor(sy / rowH)), r1 = Math.min(ROWS - 1, Math.floor((sy + vh) / rowH));
  c.font = '600 10px system-ui,sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'right';
  for (let r = r0; r <= r1; r++) {
    const p = P_MAX - r, y = r * rowH - sy;
    if (p === hoverP) { c.fillStyle = color; c.fillRect(0, y, KEY_W, rowH); }
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, Math.round(y + rowH) - 1, KEY_W, 1);
    if (isBlack(p)) { c.fillStyle = p === hoverP ? '#0e0e12' : '#1a1a21'; c.fillRect(0, y + 1, KEY_W * 0.62, rowH - 2); }
    if (p % 12 === 0 || p === hoverP) { c.fillStyle = p === hoverP ? '#fff' : '#555566'; c.fillText(pname(p), KEY_W - 6, y + rowH / 2 + 0.5); }
  }
  c.textAlign = 'start';
  c.fillStyle = '#33333f'; c.fillRect(KEY_W - 1, 0, 1, vh);
}

function drawRuler() {
  const vw = sc.clientWidth, sx = sc.scrollLeft;
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
function flashBtn(act: string) {
  const b = selBar.querySelector<HTMLElement>('[data-sel="' + act + '"]'); if (!b || REDUCE) return;
  b.animate([{transform: 'scale(1)'}, {transform: 'scale(1.18)'}, {transform: 'scale(1)'}], {duration: 240, easing: 'ease-out'});
}
function shakeSelBar() { selBar.classList.remove('is-shake'); void selBar.offsetWidth; selBar.classList.add('is-shake'); }
function placeSelBar() {
  if (!selBar) return;
  const dragging = !!g && g.kind !== 'pan' && g.kind !== 'tapdraw';   // saat menyeret / seleksi kotak, menu disembunyikan dulu
  const sel = selected.size && !dragging ? st.notes.filter(n => selected.has(n.id)) : [];
  if (!sel.length) { selBar.hidden = true; selBarOn = false; return; }
  const vw = sc.clientWidth, vh = sc.clientHeight, sx = sc.scrollLeft, sy = sc.scrollTop;
  const x0 = Math.min(...sel.map(n => n.s)) * ppb - sx, x1 = Math.max(...sel.map(n => n.s + n.l)) * ppb - sx;
  const y0 = (P_MAX - Math.max(...sel.map(n => n.p))) * rowH - sy, y1 = (P_MAX - Math.min(...sel.map(n => n.p)) + 1) * rowH - sy;
  if (x1 < 0 || x0 > vw || y1 < 0 || y0 > vh) { selBar.hidden = true; selBarOn = false; return; }   // seluruh pilihan di luar layar
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
function placePlayhead() {
  if (!phDom) return;
  const x = phBeat * ppb - sc.scrollLeft;
  const vis = phBeat >= 0 && phBeat <= total && x >= -5 && x <= sc.clientWidth + 5;
  phDom.style.visibility = vis ? 'visible' : 'hidden';
  if (vis) phDom.style.translate = x + 'px 0';
}
export function setPianoRollPlayhead(beats: number) { phBeat = beats; if (root && !root.hidden) placePlayhead(); }

// ---------- sinkron ke timeline: isi note ditampilkan mini di dalam pattern ----------
let onChange: ((id: string) => void) | null = null, notified = '';
export const setPianoRollChangeHandler = (fn: (id: string) => void) => { onChange = fn; };
function notifyChange() {
  if (!onChange || !curKey) return;
  const sn = curKey + snapshot();
  if (sn !== notified) { notified = sn; onChange(curKey); }
}
export const PR_BEATS = total;   // lebar grid piano roll (ketukan)
export function getPianoRollNotes(id: string): Array<{p: number; s: number; l: number}> {
  const x = states.get(id);
  return x ? x.notes.map(n => ({p: n.p, s: n.s, l: n.l})) : [];
}
// salin nada dari satu pattern ke pattern lain (rentang ketukan [fromBeat, toBeat), digeser supaya mulai dari 0)
export function copyPianoRollNotes(from: string, to: string, fromBeat = 0, toBeat = Infinity) {
  const src = states.get(from); if (!src) return;
  const dst: State = {notes: [], nextId: 1};
  for (const n of src.notes) {
    const a = Math.max(n.s, fromBeat), b = Math.min(n.s + n.l, toBeat);
    if (b > a + 1e-9) dst.notes.push({id: dst.nextId++, p: n.p, s: a - fromBeat, l: b - a});
  }
  states.set(to, dst);
}
export function trimPianoRollNotes(id: string, toBeat: number) {   // buang / potong nada yang melewati toBeat
  const x = states.get(id); if (!x) return;
  x.notes = x.notes.filter(n => n.s < toBeat - 1e-9).map(n => ({...n, l: Math.min(n.l, toBeat - n.s)}));
}

function redraw() { drawGrid(); drawKeys(); drawRuler(); placeSelBar(); placePlayhead(); notifyChange(); }
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); }

// ---------- ukuran ----------
function applySize() {
  space.style.width = total * ppb + EDGE_PAD + 'px';
  space.style.height = ROWS * rowH + 'px';
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
let clip: Array<{p: number; s: number; l: number}> = [];
function copySelected() {
  if (!selected.size) return;
  const sel = st.notes.filter(n => selected.has(n.id)), s0 = Math.min(...sel.map(n => n.s));
  clip = sel.map(n => ({p: n.p, s: n.s - s0, l: n.l}));
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
  const made = clip.map(c => ({id: st.nextId++, p: c.p, s: at + c.s, l: c.l}));
  st.notes.push(...made);
  selected = new Set(made.map(n => n.id));
  updateUI(); schedule();
  sc.scrollLeft = clamp(sc.scrollLeft, Math.max(0, (at + span) * ppb - sc.clientWidth + 60), at * ppb);   // pastikan hasil tempel terlihat
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
}
let g: Gesture | null = null;
const ptrs = new Map<number, {x: number; y: number}>();
let pinch: {d0x: number; d0y: number; ppb0: number; row0: number; beat0: number; rowPos0: number} | null = null;

function localXY(e: {clientX: number; clientY: number}) {
  const r = gc.getBoundingClientRect();
  return {x: e.clientX - r.left + sc.scrollLeft, y: e.clientY - r.top + sc.scrollTop};
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
  if (ptrs.size === 2) {                       // pinch: batalkan apa pun yang sedang digambar
    if (g) cancelGesture();
    const [a, b] = [...ptrs.values()];
    const r = gc.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    pinch = {d0x: Math.abs(a.x - b.x), d0y: Math.abs(a.y - b.y), ppb0: ppb, row0: rowH, beat0: (sc.scrollLeft + mx) / ppb, rowPos0: (sc.scrollTop + my) / rowH};
    return;
  }
  if (ptrs.size > 2 || pinch) return;

  const {x, y} = localXY(e);
  const base: Gesture = {kind: 'pan', id: e.pointerId, x0: x, y0: y, x, y, snap0: snapshot(), pushed: false, changed: false, sl: sc.scrollLeft, stp: sc.scrollTop, cx: e.clientX, cy: e.clientY, t0: performance.now()};
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
  g = {...base, kind: 'tapdraw', desel, touch};
  g.timer = window.setTimeout(holdMarquee, HOLD_MS);
}
const HOLD_MS = 320;
function holdMarquee() {
  if (!g || g.kind !== 'tapdraw' || g.moved) return;
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
      sc.scrollLeft = g.sl - (e.clientX - g.cx); sc.scrollTop = g.stp - (e.clientY - g.cy); break;
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
  if (ptrs.size < 2) pinch = null;
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


// ---------- bangun UI ----------
function setTool(t: Tool) {
  tool = t;
  root!.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  gc.style.cursor = t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
}

function build(): HTMLElement {
  const el = document.createElement('section');
  el.id = 'pianoRoll'; el.className = 'pr'; el.setAttribute('aria-label', 'Piano roll'); el.hidden = true;
  const btn = (attr: string, label: string, svg: string, extra = '') =>
    '<button type="button" class="pr__btn ' + extra + '" ' + attr + ' title="' + label + '" aria-label="' + label + '">' + svg + '</button>';
  el.innerHTML =
    '<div class="pr__bar">' +
      '<div class="pr__grp pr__grp--back">' +
        '<button type="button" class="pr__btn pr__back" aria-label="Kembali ke timeline" title="Kembali (Esc)">' + ICON.back + '</button>' +
      '</div>' +
      '<button type="button" class="pr__snap" aria-pressed="true" aria-label="Snap ke grid" title="Snap ke grid: nyala / mati"><i class="pr__led" aria-hidden="true"></i><span>Snap</span></button>' +
      '<div class="pr__grp">' +
        btn('data-act="undo"', 'Urungkan (Ctrl+Z)', ICON.undo) +
        btn('data-act="redo"', 'Ulangi (Ctrl+Shift+Z / Ctrl+Y)', ICON.redo) +
      '</div>' +
    '</div>' +
    '<div class="pr__main">' +
      '<div class="pr__corner"></div>' +
      '<canvas class="pr__ruler" aria-hidden="true"></canvas>' +
      '<canvas class="pr__keys" aria-hidden="true"></canvas>' +
      '<div class="pr__scroll"><div class="pr__space"></div><canvas class="pr__grid" role="img" aria-label="Grid nada"></canvas></div>' +
      '<div class="pr__phclip" aria-hidden="true"><div class="pr__ph"><svg width="9" height="20" viewBox="0 0 9 20"><path d="M5 0H4C1.79 0 0 1.79 0 4v8.6c0 .86.27 1.69.78 2.38L4.5 20l3.72-5.02A4 4 0 0 0 9 12.6V4c0-2.21-1.79-4-4-4Z" fill="currentColor"/></svg><i></i></div></div>' +
    '</div>';

  sc = el.querySelector<HTMLElement>('.pr__scroll')!;
  space = el.querySelector<HTMLElement>('.pr__space')!;
  gc = el.querySelector<HTMLCanvasElement>('.pr__grid')!;
  kc = el.querySelector<HTMLCanvasElement>('.pr__keys')!;
  rc = el.querySelector<HTMLCanvasElement>('.pr__ruler')!;
  btnUndo = el.querySelector<HTMLButtonElement>('[data-act="undo"]')!;
  btnRedo = el.querySelector<HTMLButtonElement>('[data-act="redo"]')!;

  // menu bulat Copy / Delete / Paste yang muncul di dekat note terpilih
  phDom = el.querySelector<HTMLElement>('.pr__ph')!;
  selBar = el.querySelector<HTMLElement>('.pr__main')!.appendChild(document.createElement('div'));
  selBar.className = 'pat-bar pr__sel'; selBar.hidden = true; selBar.setAttribute('role', 'toolbar'); selBar.setAttribute('aria-label', 'Aksi nada');
  ([['copy', 'Copy', 'Salin nada (Ctrl+C)', copySelected], ['del', 'Delete', 'Hapus nada (Del)', deleteSelected], ['paste', 'Paste', 'Tempel nada (Ctrl+V)', pasteNotes]] as const)
    .forEach(([act, txt, label, fn], i) => {
      const b = document.createElement('button');
      b.className = 'pat-btn'; b.type = 'button'; b.dataset.sel = act; b.textContent = txt;
      b.setAttribute('aria-label', label); b.title = label; b.style.setProperty('--i', String(i));
      b.addEventListener('click', fn);
      selBar.appendChild(b);
    });
  btnPaste = selBar.querySelector<HTMLButtonElement>('[data-sel="paste"]')!;
  btnPaste.disabled = clip.length === 0;

  const snapBtn = el.querySelector<HTMLButtonElement>('.pr__snap')!;
  snapBtn.addEventListener('click', () => { snapOn = !snapOn; snapBtn.setAttribute('aria-pressed', String(snapOn)); });
  const acts: Record<string, () => void> = {
    undo, redo,
  };
  el.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act!]()));

  gc.addEventListener('pointerdown', onDown);
  gc.addEventListener('pointermove', onMove);
  gc.addEventListener('pointerup', onUp);
  gc.addEventListener('pointercancel', onUp);
  gc.addEventListener('pointerleave', () => { if (hoverP !== -1 && !g) { hoverP = -1; schedule(); } });
  gc.addEventListener('contextmenu', e => e.preventDefault());
  sc.addEventListener('scroll', schedule, {passive: true});
  new ResizeObserver(() => { if (root && !root.hidden) schedule(); }).observe(sc);

  el.querySelector('.pr__back')!.addEventListener('click', closePianoRoll);
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
  root.style.setProperty('--pr-color', color);
  root.setAttribute('aria-label', opts.track + ' – ' + opts.pattern);

  root.hidden = false; void root.offsetWidth; root.classList.add('is-open');
  const vw = sc.clientWidth, vh = sc.clientHeight;
  ppb = clamp(Math.floor(vw / total), 32, 96); rowH = 18;
  applySize();
  const mid = st.notes.length ? st.notes.reduce((a, n) => a + n.p, 0) / st.notes.length : 62;   // mulai di sekitar C4
  sc.scrollLeft = 0; sc.scrollTop = Math.max(0, (P_MAX - mid) * rowH - vh / 2);
  resetAnim(); selBarOn = false; selBar.hidden = true;
  setTool('draw'); updateUI(); redraw();
}

export function closePianoRoll() {
  if (!root || root.hidden) return;
  const r = root; r.classList.remove('is-open'); g = null; ptrs.clear(); pinch = null;
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
  if (k === 'Escape') { closePianoRoll(); return; }
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
});
