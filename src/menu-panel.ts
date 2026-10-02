// Tombol menu di pojok kanan atas (card 3D + bevel) yang membuka panel geser dari kanan, gaya sama dengan panel efek.
// Panel menimpa layar (tidak mendorong timeline). Tutup: klik tombol lagi, klik di luar panel, atau Esc.
// Saat piano roll terbuka tombolnya disembunyikan (CSS) supaya tidak menimpa tombol X piano roll, dan panel ikut menutup.

const ICON_GRID =
  '<svg class="menu-btn__ic menu-btn__ic--grid" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="4" y="4" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="13.5" y="4" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="4" y="13.5" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" fill="#9d86ff"/></svg>';
const ICON_CLOSE =
  '<svg class="menu-btn__ic menu-btn__ic--x" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

export interface MenuPanel {
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

export function initMenuPanel(): MenuPanel {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'menuBtn'; btn.className = 'menu-btn';
  btn.setAttribute('aria-controls', 'menuPanel');
  btn.innerHTML = ICON_GRID + ICON_CLOSE;

  const panel = document.createElement('aside');
  panel.id = 'menuPanel'; panel.className = 'mp'; panel.setAttribute('aria-label', 'Menu');
  panel.innerHTML =
    '<div class="mp__panel">' +
      '<header class="mp__head mp__item" style="--i:0"><h2 class="mp__title">Menu</h2></header>' +
      '<div class="mp__body">' +
        '<div class="mp__card mp__item" style="--i:1"><p class="mp__hint">Isi panel menyusul.</p></div>' +
      '</div>' +
    '</div>';

  let open = false;

  const apply = (next: boolean, animate: boolean): void => {
    open = next;
    panel.classList.toggle('mp--open', open);
    btn.classList.toggle('is-open', open);
    const label = open ? 'Tutup menu' : 'Buka menu';
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', label); btn.title = label;
    // saat tertutup, isi panel tidak boleh bisa difokus / dibaca screen reader
    if (open) { panel.removeAttribute('inert'); panel.removeAttribute('aria-hidden'); }
    else { panel.setAttribute('inert', ''); panel.setAttribute('aria-hidden', 'true'); }
    void animate;
  };

  btn.addEventListener('click', () => apply(!open, true));

  document.addEventListener('pointerdown', e => {
    if (!open) return;
    const t = e.target as Node;
    if (panel.contains(t) || btn.contains(t)) return;
    apply(false, true);
  });
  document.addEventListener('keydown', e => {
    if (open && e.key === 'Escape') { apply(false, true); btn.focus(); }
  });

  // piano roll terbuka -> panel menutup (tombolnya sendiri disembunyikan lewat CSS)
  const stage = document.querySelector('.stage');
  if (stage) {
    new MutationObserver(() => { if (open && document.querySelector('.pr.is-open')) apply(false, true); })
      .observe(stage, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  apply(false, false);
  document.body.append(panel, btn);
  requestAnimationFrame(() => panel.classList.add('mp--ready'));   // transisi baru aktif setelah keadaan awal terpasang

  return { isOpen: () => open, setOpen: v => { if (v !== open) apply(v, true); } };
}
