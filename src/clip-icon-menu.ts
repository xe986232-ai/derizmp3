// Tap 3x icon microphone di header pattern audio clip -> muncul card putih berisi menu "Tempo".
// Icon-nya pseudo-element CSS (.pattern__head::before), jadi tidak bisa diberi listener sendiri:
// area icon dihitung dari posisi tap relatif ke kiri header (padding 8px + icon 13px + toleransi jari).
// Tutup card: ketuk di luar, Esc, atau pilih item.

const ICON_ZONE = 8 + 13 + 7;   // px dari tepi kiri header: padding + lebar icon + toleransi
const TAP_GAP = 450;            // ms maksimum antar ketukan
const TAP_SLOP = 24;            // px maksimum pergeseran antar ketukan

export function initClipIconMenu(lanesEl: HTMLElement): void {
  let card: HTMLDivElement | null = null;
  let count = 0, lastT = 0, lastX = 0, lastY = 0;
  let lastEl: Element | null = null;

  const close = (): void => { if (card) { card.remove(); card = null; } };

  const open = (icon: DOMRect): void => {
    close();
    const c = document.createElement('div');
    c.className = 'clip-card'; c.setAttribute('role', 'menu');
    const it = document.createElement('button');
    it.type = 'button'; it.className = 'clip-card__item'; it.setAttribute('role', 'menuitem');
    it.textContent = 'Tempo';
    it.addEventListener('click', close);   // aksi Tempo menyusul
    c.appendChild(it);
    document.body.appendChild(c);
    const w = c.offsetWidth, h = c.offsetHeight;
    c.style.left = Math.max(8, Math.min(icon.left, innerWidth - w - 8)) + 'px';
    c.style.top = (icon.bottom + 6 + h > innerHeight - 8 ? icon.top - 6 - h : icon.bottom + 6) + 'px';
    card = c;
  };

  // 'click' hanya terkirim untuk ketukan (bukan seret), jadi menggeser pattern tidak ikut terhitung
  lanesEl.addEventListener('click', (e: MouseEvent) => {
    const head = (e.target as Element).closest('.pattern[data-clip] .pattern__head') as HTMLElement | null;
    if (!head) { count = 0; return; }
    const r = head.getBoundingClientRect();
    if (e.clientX - r.left > ICON_ZONE) { count = 0; return; }
    const pat = head.parentElement;
    const near = pat === lastEl && e.timeStamp - lastT < TAP_GAP &&
      Math.hypot(e.clientX - lastX, e.clientY - lastY) < TAP_SLOP;
    count = near ? count + 1 : 1;
    lastEl = pat; lastT = e.timeStamp; lastX = e.clientX; lastY = e.clientY;
    if (count >= 3) {
      count = 0;
      open(new DOMRect(r.left + 8, r.top, 13, r.height));
    }
  });

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (card && !card.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') close(); });
}
