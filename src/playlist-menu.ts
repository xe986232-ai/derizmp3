// Tombol titik tiga di pojok kiri atas playlist: membuka dropdown dengan bentuk yang sama seperti menu titik tiga di channel mixer
// (card .track-menu.mixer-menu: item beserta ikon, panah di kanan untuk submenu, card submenu terpisah di sebelah kanan menu utama).
// Isi: "View" -> submenu berisi "Automatic Scroll" (centang = nyala) dan "Track Size" -> card pilihan ukuran (Compact / Small / Normal / Large).
// Animasi masuk card / item / panah mengikuti CSS .track-menu. Tutup: klik tombol lagi, klik di luar, atau Esc.

export interface PlaylistMenuOptions {
  isAutoScroll(): boolean;
  setAutoScroll(on: boolean): void;
  getTrackSize(): string;
  setTrackSize(size: string): void;
}

const ICON_EYE = '<svg class="ico-ln" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_SCROLL = '<svg class="ico-ln" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/></svg>';
const ICON_VERT = '<svg class="ico-ln" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/></svg>';
const ICON_CHEV = '<svg class="track-menu__chev ico-ln" viewBox="0 0 24 24" width="14" height="14" stroke-width="2.4" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHECK = '<svg class="track-menu__check ico-ln" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.6" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// pilihan ukuran track; h = tinggi batang kecil di ikon (menggambarkan tinggi track)
const SIZES: { id: string; label: string; h: number }[] = [
  { id: 'compact', label: 'Compact', h: 5 },
  { id: 'small', label: 'Small', h: 8 },
  { id: 'normal', label: 'Normal', h: 11 },
  { id: 'large', label: 'Large', h: 15 },
];

export function initPlaylistMenu(btn: HTMLButtonElement, opts: PlaylistMenuOptions): { close(instant?: boolean): void } {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let menu: HTMLElement | null = null, sub: HTMLElement | null = null, sub2: HTMLElement | null = null;

  const fadeOut = (el: HTMLElement, instant: boolean): void => {
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  };

  const onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (!menu?.contains(t) && !sub?.contains(t) && !sub2?.contains(t) && !btn.contains(t)) close();
  };
  const onResize = (): void => close(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    close(); btn.focus({ preventScroll: true });
  };

  function close(instant = false): void {
    const m = menu, s = sub, s2 = sub2;
    if (!m) return;
    menu = sub = sub2 = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (s2) fadeOut(s2, instant);
    if (s) fadeOut(s, instant);
    fadeOut(m, instant);
  }

  // taruh card `el` di sebelah kanan card `parent` (pindah ke kiri kalau tidak muat), sejajar dengan item `item`
  function placeBeside(el: HTMLElement, parent: HTMLElement, item: HTMLElement): void {
    const pr = parent.getBoundingClientRect(), ir = item.getBoundingClientRect(), er = el.getBoundingClientRect();
    let left = pr.right + 4;
    if (left + er.width > innerWidth - 8) left = Math.max(8, pr.left - er.width - 4);
    el.style.left = left + 'px';
    el.style.top = Math.max(8, Math.min(ir.top - 6, innerHeight - er.height - 8)) + 'px';
    el.style.transformOrigin = left >= pr.right ? 'left top' : 'right top';
  }

  function makeCard(html: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'track-menu mixer-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = html;
    el.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan
    el.addEventListener('keyup', e => e.stopPropagation());
    document.body.appendChild(el);
    return el;
  }

  function closeSub2(): void {
    if (sub2) { fadeOut(sub2, false); sub2 = null; }
    sub?.querySelectorAll('[data-act="tracksize"]').forEach(x => x.setAttribute('aria-expanded', 'false'));
  }

  // card pilihan ukuran track, di kanan submenu View. Pilihan langsung berlaku (track bergerak ke ukuran baru) dan card tetap terbuka supaya bisa dicoba satu per satu
  function openSizes(item: HTMLElement): void {
    if (!sub) return;
    if (sub2) { closeSub2(); return; }   // klik "Track Size" lagi = tutup card
    const cur = opts.getTrackSize();
    const s2 = makeCard(SIZES.map(z =>
      '<button role="menuitemradio" class="track-menu__item" data-size="' + z.id + '" aria-checked="' + (z.id === cur) + '">' +
        '<span class="track-menu__sz"><i style="--h:' + z.h + 'px"></i></span><span>' + z.label + '</span>' + ICON_CHECK + '</button>').join(''));
    placeBeside(s2, sub, item);
    item.setAttribute('aria-expanded', 'true');
    sub2 = s2;
    s2.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-size]');
      if (!it) return;
      opts.setTrackSize(it.dataset.size as string);
      const now = opts.getTrackSize();
      s2.querySelectorAll<HTMLElement>('[data-size]').forEach(x => x.setAttribute('aria-checked', String(x.dataset.size === now)));
    });
    s2.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
  }

  function closeSub(item: HTMLElement): void {
    closeSub2();
    if (sub) { fadeOut(sub, false); sub = null; }
    item.setAttribute('aria-expanded', 'false');
  }

  // submenu View: card di sebelah kanan menu utama, sejajar dengan item "View"
  function openView(item: HTMLElement): void {
    if (!menu) return;
    if (sub) { closeSub(item); return; }   // klik "View" lagi = tutup submenu
    const s = makeCard(
      '<button role="menuitemcheckbox" class="track-menu__item" data-act="autoscroll" aria-checked="' + opts.isAutoScroll() + '">' +
        '<span class="ico">' + ICON_SCROLL + '</span><span>Automatic Scroll</span>' + ICON_CHECK + '</button>' +
      '<button role="menuitem" class="track-menu__item" data-act="tracksize" aria-haspopup="menu" aria-expanded="false">' +
        '<span class="ico">' + ICON_VERT + '</span><span>Track Size</span>' + ICON_CHEV + '</button>');
    placeBeside(s, menu, item);
    item.setAttribute('aria-expanded', 'true');
    sub = s;
    s.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const as = t.closest<HTMLElement>('[data-act="autoscroll"]');
      if (as) {
        opts.setAutoScroll(!opts.isAutoScroll());
        as.setAttribute('aria-checked', String(opts.isAutoScroll()));   // centang muncul / hilang lewat transisi CSS; menu ditutup sebentar kemudian supaya sempat terlihat
        window.setTimeout(() => close(), reduce ? 0 : 280);
        return;
      }
      const ts = t.closest<HTMLElement>('[data-act="tracksize"]');
      if (ts) openSizes(ts);
    });
    s.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  function open(): void {
    if (menu) return;
    const el = makeCard(
      '<button role="menuitem" class="track-menu__item" data-act="view" aria-haspopup="menu" aria-expanded="false">' +
        '<span class="ico">' + ICON_EYE + '</span><span>View</span>' + ICON_CHEV + '</button>');
    el.setAttribute('aria-label', 'Opsi playlist');
    const r = btn.getBoundingClientRect(), m = el.getBoundingClientRect();   // tombol di pojok kiri atas layar: menu terbuka ke bawah, rata kiri dengan tombol
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - m.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 8, innerHeight - m.height - 8)) + 'px';
    el.style.transformOrigin = 'left top';
    menu = el;
    btn.setAttribute('aria-expanded', 'true');
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
