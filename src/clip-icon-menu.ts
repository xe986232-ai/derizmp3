// Tahan icon microphone di header pattern audio clip -> muncul card putih berisi menu "Tempo" (animasi masuk + keluar).
// Icon-nya pseudo-element CSS (.pattern__head::before), jadi tidak bisa diberi listener sendiri:
// area icon dihitung dari posisi sentuhan relatif ke kiri header (padding 8px + icon 13px + toleransi jari).
// Tutup card: ketuk di luar, Esc, scroll, atau pilih item.

const ICON_ZONE = 8 + 13 + 7;   // px dari tepi kiri header: padding + lebar icon + toleransi
const HOLD_MS = 450;            // lama menahan
const HOLD_SLOP = 10;           // px maksimum bergeser selama menahan (lebih dari ini = batal)
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface ClipIconMenuHooks {
  onOpen?(): void;    // dipanggil saat card muncul (main.ts menyembunyikan menu bulat)
  onClose?(): void;   // dipanggil saat card ditutup
}

export function initClipIconMenu(lanesEl: HTMLElement, hooks: ClipIconMenuHooks = {}): void {
  let card: HTMLDivElement | null = null;
  let timer = 0, pending = false, fired = false;
  let sx = 0, sy = 0;

  const iconHead = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest('.pattern[data-clip] .pattern__head') as HTMLElement | null : null;

  const close = (instant = false): void => {
    const c = card; if (!c) return;
    card = null;
    hooks.onClose && hooks.onClose();
    c.style.pointerEvents = 'none';
    if (instant || REDUCE) { c.remove(); return; }
    c.animate(
      [{opacity: 1, transform: 'scale(1) translateY(0)'}, {opacity: 0, transform: 'scale(.85) translateY(-6px)'}],
      {duration: 140, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards'}
    ).onfinish = () => c.remove();
  };

  const open = (icon: DOMRect): void => {
    close(true);
    const c = document.createElement('div');
    c.className = 'clip-card'; c.setAttribute('role', 'menu');
    const it = document.createElement('button');
    it.type = 'button'; it.className = 'clip-card__item'; it.setAttribute('role', 'menuitem');
    it.textContent = 'Tempo';
    it.addEventListener('click', () => close());   // aksi Tempo menyusul
    c.appendChild(it);
    document.body.appendChild(c);
    const w = c.offsetWidth, h = c.offsetHeight;
    const left = Math.max(8, Math.min(icon.left, innerWidth - w - 8));
    const below = icon.bottom + 6 + h <= innerHeight - 8;
    c.style.left = left + 'px';
    c.style.top = (below ? icon.bottom + 6 : icon.top - 6 - h) + 'px';
    c.style.transformOrigin = (icon.left + icon.width / 2 - left) + 'px ' + (below ? '0' : h + 'px');   // tumbuh dari icon
    card = c;
    hooks.onOpen && hooks.onOpen();
    if (!REDUCE) {
      const dy = below ? -6 : 6;
      c.animate(
        [{opacity: 0, transform: 'scale(.82) translateY(' + dy + 'px)'}, {opacity: 1, transform: 'scale(1) translateY(0)'}],
        {duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.25)'}
      );
    }
  };

  const cancel = (): void => { clearTimeout(timer); pending = false; };

  lanesEl.addEventListener('pointerdown', (e: PointerEvent) => {
    cancel(); fired = false;
    if (e.button > 0) return;
    const head = iconHead(e.target);
    if (!head) return;
    const r = head.getBoundingClientRect();
    if (e.clientX - r.left > ICON_ZONE) return;
    pending = true; sx = e.clientX; sy = e.clientY;
    timer = window.setTimeout(() => {
      pending = false; fired = true;
      open(new DOMRect(r.left + 8, r.top, 13, r.height));
    }, HOLD_MS);
  });
  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (pending && Math.hypot(e.clientX - sx, e.clientY - sy) > HOLD_SLOP) cancel();
  });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  // tahan lama di layar sentuh bisa memunculkan menu bawaan browser: dimatikan untuk area icon
  lanesEl.addEventListener('contextmenu', (e: Event) => { if ((pending || fired) && iconHead(e.target)) e.preventDefault(); });

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (card && !card.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') close(); });
  document.addEventListener('scroll', () => close(true), {capture: true, passive: true});
}
