// Tombol titik tiga di pojok kiri atas playlist: membuka dropdown dengan bentuk yang sama seperti menu titik tiga di channel mixer
// (card .track-menu.mixer-menu: item beserta ikon, panah di kanan untuk submenu, card submenu terpisah di sebelah kanan menu utama).
// Isi: "View" -> submenu berisi "Automatic Scroll" (centang di kanan = nyala). Animasi masuk card / item / panah mengikuti CSS .track-menu.
// Tutup: klik tombol lagi, klik di luar, atau Esc.

export interface PlaylistMenuOptions {
  isAutoScroll(): boolean;
  setAutoScroll(on: boolean): void;
}

const ICON_EYE = '<svg class="ico-ln" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_SCROLL = '<svg class="ico-ln" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/></svg>';
const ICON_CHEV = '<svg class="track-menu__chev ico-ln" viewBox="0 0 24 24" width="14" height="14" stroke-width="2.4" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHECK = '<svg class="track-menu__check ico-ln" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.6" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export function initPlaylistMenu(btn: HTMLButtonElement, opts: PlaylistMenuOptions): { close(instant?: boolean): void } {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let menu: HTMLElement | null = null, sub: HTMLElement | null = null;

  const fadeOut = (el: HTMLElement, instant: boolean): void => {
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  };

  const onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (!menu?.contains(t) && !sub?.contains(t) && !btn.contains(t)) close();
  };
  const onResize = (): void => close(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    close(); btn.focus({ preventScroll: true });
  };

  function close(instant = false): void {
    const m = menu, s = sub;
    if (!m) return;
    menu = sub = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (s) fadeOut(s, instant);
    fadeOut(m, instant);
  }

  function closeSub(item: HTMLElement): void {
    if (sub) { fadeOut(sub, false); sub = null; }
    item.setAttribute('aria-expanded', 'false');
  }

  // card submenu di sebelah kanan menu utama (pindah ke kiri kalau tidak muat), sejajar dengan item "View"
  function openView(item: HTMLElement): void {
    if (!menu) return;
    if (sub) { closeSub(item); return; }   // klik "View" lagi = tutup submenu
    const s = document.createElement('div');
    s.className = 'track-menu mixer-menu';
    s.setAttribute('role', 'menu');
    s.innerHTML =
      '<button role="menuitemcheckbox" class="track-menu__item" data-act="autoscroll" aria-checked="' + opts.isAutoScroll() + '">' +
        '<span class="ico">' + ICON_SCROLL + '</span><span>Automatic Scroll</span>' + ICON_CHECK + '</button>';
    document.body.appendChild(s);
    const mr = menu.getBoundingClientRect(), ir = item.getBoundingClientRect(), sr = s.getBoundingClientRect();
    let left = mr.right + 4;
    if (left + sr.width > innerWidth - 8) left = Math.max(8, mr.left - sr.width - 4);
    s.style.left = left + 'px';
    s.style.top = Math.max(8, Math.min(ir.top - 6, innerHeight - sr.height - 8)) + 'px';
    s.style.transformOrigin = left >= mr.right ? 'left top' : 'right top';
    item.setAttribute('aria-expanded', 'true');
    sub = s;
    s.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan
    s.addEventListener('keyup', e => e.stopPropagation());
    s.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-act="autoscroll"]');
      if (!it) return;
      opts.setAutoScroll(!opts.isAutoScroll());
      it.setAttribute('aria-checked', String(opts.isAutoScroll()));   // centang muncul / hilang lewat transisi CSS; menu ditutup sebentar kemudian supaya sempat terlihat
      window.setTimeout(() => close(), reduce ? 0 : 280);
    });
    s.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  function open(): void {
    if (menu) return;
    const el = document.createElement('div');
    el.className = 'track-menu mixer-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Opsi playlist');
    el.innerHTML =
      '<button role="menuitem" class="track-menu__item" data-act="view" aria-haspopup="menu" aria-expanded="false">' +
        '<span class="ico">' + ICON_EYE + '</span><span>View</span>' + ICON_CHEV + '</button>';
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect(), m = el.getBoundingClientRect();   // tombol di pojok kiri atas layar: menu terbuka ke bawah, rata kiri dengan tombol
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - m.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 8, innerHeight - m.height - 8)) + 'px';
    el.style.transformOrigin = 'left top';
    menu = el;
    btn.setAttribute('aria-expanded', 'true');
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
    el.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-act="view"]');
      if (it) openView(it);
    });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  btn.addEventListener('click', () => { menu ? close() : open(); });
  return { close };
}
