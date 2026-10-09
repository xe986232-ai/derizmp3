// Tombol titik tiga di pojok kiri atas playlist: membuka dropdown kecil tepat di bawah tombol.
// Isi menu dikelompokkan per judul (sekarang: "View" -> "Automatic Scroll", berupa saklar nyala / mati).
// Menu memakai gaya kartu yang sama dengan menu lain (.fx-pats). Tutup: klik tombol lagi, klik di luar, atau Esc.
// Animasi: kartu mekar dari sudut tombol, item masuk bergantian, saklar bergeser; tombol titik tiga memutar 90 derajat dan berwarna putih selama menu terbuka
// (animasi tombolnya ada di CSS, lewat aria-expanded).

export interface PlaylistMenuOptions {
  isAutoScroll(): boolean;
  setAutoScroll(on: boolean): void;
}

export function initPlaylistMenu(btn: HTMLButtonElement, opts: PlaylistMenuOptions): { close(instant?: boolean): void } {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let menu: HTMLElement | null = null;

  const onOutside = (e: PointerEvent): void => { const t = e.target as Node; if (!menu?.contains(t) && !btn.contains(t)) close(); };
  const onResize = (): void => close(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    close(); btn.focus({ preventScroll: true });
  };

  function close(instant = false): void {
    const el = menu; if (!el) return;
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-6px)' }],
      { duration: 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  }

  function addHeading(el: HTMLElement, text: string): void {
    const h = document.createElement('div');
    h.className = 'plmenu__head'; h.setAttribute('role', 'presentation'); h.textContent = text;
    el.appendChild(h);
  }

  function addSwitch(el: HTMLElement, label: string, isOn: () => boolean, set: (on: boolean) => void): void {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitemcheckbox'); b.className = 'fx-pats__item plmenu__item';
    b.setAttribute('aria-checked', String(isOn()));
    const t = document.createElement('span'); t.className = 'fx-pats__name'; t.textContent = label;
    const sw = document.createElement('span'); sw.className = 'plmenu__sw'; sw.setAttribute('aria-hidden', 'true');
    b.append(t, sw);
    b.addEventListener('click', () => {
      const on = !isOn(); set(on);
      b.setAttribute('aria-checked', String(isOn()));   // saklar bergeser lewat transisi CSS; menu ditutup sebentar kemudian supaya geserannya sempat terlihat
      window.setTimeout(() => close(), reduce ? 0 : 260);
    });
    el.appendChild(b);
  }

  function open(): void {
    if (menu) return;
    const el = document.createElement('div');
    el.className = 'fx-pats plmenu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Opsi playlist');
    addHeading(el, 'View');
    addSwitch(el, 'Automatic Scroll', opts.isAutoScroll, opts.setAutoScroll);
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;   // tombol ada di pojok kiri atas layar: menu terbuka ke bawah
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 8, innerHeight - h - 8)) + 'px';
    el.style.transformOrigin = 'top left';
    menu = el;
    btn.setAttribute('aria-expanded', 'true');
    el.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan
    el.addEventListener('keyup', e => e.stopPropagation());
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    if (!reduce) {
      el.animate([{ opacity: 0, transform: 'scale(.82) translateY(-8px)' }, { opacity: 1, transform: 'scale(1) translateY(0)' }],
        { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.25)' });
      el.querySelectorAll<HTMLElement>('.plmenu__head, .plmenu__item').forEach((it, i) => {   // item masuk bergantian dari kiri
        it.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'translateX(0)' }],
          { duration: 220, delay: 70 + i * 55, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
      });
    }
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  btn.addEventListener('click', () => { menu ? close() : open(); });
  return { close };
}
