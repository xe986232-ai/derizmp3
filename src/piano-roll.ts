// Piano roll (tahap 1: tampilan saja, tanpa suara / synth / data nada).
// Markup persis dari Soundtrap ada di piano-roll.html; file ini hanya membuka, menutup, dan menghidupkan scroll + toolbar.
import markup from './piano-roll.html?raw';

const ROW_H = 17.25;   // tinggi satu baris nada (px)
const BEAT_W = 88;     // lebar satu ketukan (px)
const BEATS = 4, BARS = 64;

// Ikon: markup memakai class icon-font Soundtrap yang tidak ada di proyek ini, jadi diisi SVG sederhana.
const SVG = (d: string) => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const ICONS: Record<string, string> = {
  'ic-cursor-filled': '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 3l13 7-5.5 1.8L17 19l-2.6 1.2-3.5-7.3L6 17z"/></svg>',
  'ic-edit': SVG('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/>'),
  'ic-delete': SVG('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  'ic-zoom-in': SVG('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/>'),
  'ic-zoom-out': SVG('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8 11h6"/>'),
};
const SYMBOLS =
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">' +
  '<symbol id="snap-to-grid-icon" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 4v16M12 4v16M20 4v16M4 12h16"/></symbol>' +
  '<symbol id="snap-to-playhead-icon" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3v18M7 8l5-5 5 5"/></symbol></svg>';

const MODES = ['movebutton', 'drawbutton', 'velocitybutton', 'erasebutton'] as const;
const MODE_CLASS: Record<string, string> = {movebutton: 'editmode-move', drawbutton: 'editmode-draw', velocitybutton: 'editmode-velocity', erasebutton: 'editmode-erase'};

export interface PianoRollOpts { track: string; pattern: string; color?: string; }

let root: HTMLElement | null = null;
let onClose: (() => void) | null = null;

function drawRuler(canvas: HTMLCanvasElement, scrollLeft: number) {
  const w = canvas.parentElement!.clientWidth, h = 48, dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = h * dpr; }
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const cs = getComputedStyle(root!);
  c.font = '11px system-ui, sans-serif'; c.textBaseline = 'top';
  const first = Math.floor(scrollLeft / BEAT_W), last = Math.ceil((scrollLeft + w) / BEAT_W);
  for (let b = first; b <= last; b++) {
    const x = Math.round(b * BEAT_W - scrollLeft) + .5, bar = b % BEATS === 0;
    c.strokeStyle = bar ? cs.getPropertyValue('--muted') : cs.getPropertyValue('--line');
    c.beginPath(); c.moveTo(x, bar ? 6 : 30); c.lineTo(x, h); c.stroke();
    if (bar) { c.fillStyle = cs.getPropertyValue('--text'); c.fillText(String(b / BEATS + 1), x + 5, 8); }
  }
}

function build(): HTMLElement {
  const el = document.createElement('section');
  el.id = 'pianoRoll'; el.className = 'pr'; el.setAttribute('aria-label', 'Piano roll'); el.hidden = true;
  el.innerHTML =
    SYMBOLS +
    '<header class="pr__head"><button type="button" class="pr__back" aria-label="Kembali ke timeline" title="Kembali (Esc)">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<div class="pr__title"><b class="pr__track"></b><span class="pr__pattern"></span></div></header>' +
    '<div class="pr__body">' + markup + '</div>';

  // sampel nada bawaan markup dikosongkan: pattern baru memang masih kosong (hapus baris ini kalau mau melihat contohnya)
  el.querySelectorAll('.rollnote').forEach(n => n.remove());

  // ikon
  for (const [cls, svg] of Object.entries(ICONS)) el.querySelectorAll('.' + cls).forEach(s => { s.innerHTML = svg; });

  // ukuran dari konstanta (menggantikan angka pixel sampel di markup)
  const grid = el.querySelector<HTMLElement>('.grid')!;
  const gridW = BARS * BEATS * BEAT_W;
  el.style.setProperty('--pr-row', ROW_H + 'px');
  el.style.setProperty('--pr-beat', BEAT_W + 'px');
  grid.style.width = gridW + 'px';
  el.querySelector<HTMLElement>('.keys-and-grid')!.style.width = '';
  el.querySelector<HTMLElement>('.regionsnotes')!.style.width = gridW + 'px';
  const fake = el.querySelector<HTMLElement>('.position-scrollbar > div')!; fake.style.width = gridW + 70 + 'px';

  // tombol toolbar: pilih satu mode (gambar / pindah / velositas / hapus)
  const tb = el.querySelector('.mango-toolbar')!, rn = el.querySelector('.regionsnotes')!;
  tb.addEventListener('click', e => {
    const wrap = (e.target as HTMLElement).closest<HTMLElement>('.fatfingerbutton'); if (!wrap) return;
    const mode = MODES.find(m => wrap.classList.contains(m)); if (!mode) return;
    tb.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
    wrap.querySelector('button')!.classList.add('selected');
    Object.values(MODE_CLASS).forEach(c => rn.classList.remove(c)); rn.classList.add(MODE_CLASS[mode]);
  });
  // toggle snap / tangkap playhead
  el.querySelectorAll<HTMLButtonElement>('.icon-toggle__toggle-button').forEach(b => b.addEventListener('click', () => {
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(on)); b.parentElement!.classList.toggle('on', on);
  }));

  // scroll: ruler & scrollbar bawah ikut lane
  const sc = el.querySelector<HTMLElement>('.scrollable')!, bar = el.querySelector<HTMLElement>('.position-scrollbar')!;
  const cv = el.querySelector<HTMLCanvasElement>('.beatruler canvas')!;
  let lock = false;
  const paint = () => drawRuler(cv, sc.scrollLeft);
  sc.addEventListener('scroll', () => { paint(); if (!lock) { lock = true; bar.scrollLeft = sc.scrollLeft; lock = false; } }, {passive: true});
  bar.addEventListener('scroll', () => { if (!lock) { lock = true; sc.scrollLeft = bar.scrollLeft; lock = false; } }, {passive: true});
  window.addEventListener('resize', () => { if (root && !root.hidden) paint(); });
  (el as any)._paint = paint;

  el.querySelector('.pr__back')!.addEventListener('click', closePianoRoll);
  return el;
}

export function openPianoRoll(opts: PianoRollOpts, host: HTMLElement = document.querySelector('.stage') as HTMLElement) {
  if (!root) { root = build(); host.appendChild(root); }
  root.style.setProperty('--pr-color', opts.color || '#3fbf5f');
  root.querySelector('.pr__track')!.textContent = opts.track;
  root.querySelector('.pr__pattern')!.textContent = opts.pattern;
  root.hidden = false; void root.offsetWidth; root.classList.add('is-open');
  const sc = root.querySelector<HTMLElement>('.scrollable')!;
  sc.scrollTop = ROW_H * 60 - sc.clientHeight / 2;   // mulai di sekitar G4 / C4
  sc.scrollLeft = 0;
  (root as any)._paint();
}

export function closePianoRoll() {
  if (!root || root.hidden) return;
  const r = root; r.classList.remove('is-open');
  setTimeout(() => { if (!r.classList.contains('is-open')) r.hidden = true; }, 200);
  onClose && onClose();
}
export const isPianoRollOpen = () => !!root && !root.hidden && root.classList.contains('is-open');
export const setPianoRollCloseHandler = (fn: () => void) => { onClose = fn; };

document.addEventListener('keydown', e => { if (e.key === 'Escape' && isPianoRollOpen()) closePianoRoll(); });
