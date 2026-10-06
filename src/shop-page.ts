// Halaman "Shop Plugin" di Menu (kategori sejajar Project / Export / Pengaturan).
// Tahap 1: hanya halamannya. Katalog = plugin yang sudah ada di aplikasi (status "Terpasang"); belum ada pembelian / unduhan.
// Gaya flat: warna solid + garis tipis, tanpa bayangan / glow / gradasi (lihat blok ".shop" di styles.css).

type ShopKind = 'instrument' | 'effect';
interface ShopItem { name: string; kind: ShopKind; desc: string }

const CATALOG: ShopItem[] = [
  { name: 'DERIZ', kind: 'instrument', desc: 'Sampler: upload audio, mainkan dari keyboard atau piano roll, atur Speed, Pitch, dan Volume.' },
  { name: 'MPCS', kind: 'instrument', desc: 'Manual Pitch Correct Sample: edit pitch sample dengan blok nada, seret naik atau turun.' },
  { name: 'MGCHORD', kind: 'instrument', desc: 'Pembuat chord progression: pilih Key, Length, Sound, dan Style strum.' },
  { name: 'Supersaw', kind: 'instrument', desc: 'Synth supersaw dengan Detune, Mix, filter, dan envelope.' },
  { name: 'Reverb', kind: 'effect', desc: 'Gema ruang: Mix, Size, Pre-Delay, Tone, dan Low Cut.' },
  { name: 'Equalizer', kind: 'effect', desc: 'EQ 5 band dengan grafik respons dan level Output.' },
  { name: 'Filter', kind: 'effect', desc: 'Low-pass dan high-pass dalam satu knob Cutoff, plus Reso.' },
  { name: 'De-esser', kind: 'effect', desc: 'Meredam desis (sibilance) pada vokal: Freq, Thresh, Amount.' },
  { name: 'Delay', kind: 'effect', desc: 'Delay stereo dengan panel sendiri.' },
];

const KIND_LABEL: Record<ShopKind, string> = { instrument: 'Instrumen', effect: 'Efek' };
const esc = (t: string): string => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const IC_SHOP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
const IC_CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

// Tombol kategori di halaman utama Menu
export const SHOP_CAT =
  '<button type="button" class="mp__cat mp__item" style="--i:3" data-go="shop">' + IC_SHOP +
  '<span class="mp__cat__t"><b>Shop Plugin</b><small>Daftar plugin &amp; efek</small></span>' + IC_CHEV + '</button>';

// Halaman Shop Plugin (data-page="shop", memakai sistem halaman Menu: ada tombol kembali)
export const SHOP_PAGE =
  '<section class="mp__page shop" data-page="shop" aria-label="Shop Plugin" hidden>' +
    '<div class="shop__filter mp__item" style="--i:1" role="radiogroup" aria-label="Jenis plugin">' +
      '<button type="button" class="shop__chip is-on" role="radio" aria-checked="true" data-shopf="all">Semua</button>' +
      '<button type="button" class="shop__chip" role="radio" aria-checked="false" data-shopf="instrument">Instrumen</button>' +
      '<button type="button" class="shop__chip" role="radio" aria-checked="false" data-shopf="effect">Efek</button>' +
    '</div>' +
    '<ul class="shop__list mp__item" style="--i:2">' +
      CATALOG.map(p =>
        '<li class="shop__item" data-kind="' + p.kind + '">' +
          '<div class="shop__top"><b class="shop__name">' + esc(p.name) + '</b><span class="shop__tag">' + KIND_LABEL[p.kind] + '</span></div>' +
          '<p class="shop__desc">' + esc(p.desc) + '</p>' +
          '<span class="shop__state">Terpasang</span>' +
        '</li>').join('') +
    '</ul>' +
    '<p class="mp__hint mp__item shop__more" style="--i:3">Plugin tambahan belum tersedia. Yang baru akan muncul di halaman ini.</p>' +
  '</section>';

// Filter Semua / Instrumen / Efek (hanya menyembunyikan kartu; tidak menyimpan apa pun)
export function initShopPage(panel: HTMLElement): void {
  const chips = [...panel.querySelectorAll<HTMLButtonElement>('[data-shopf]')];
  const items = [...panel.querySelectorAll<HTMLElement>('.shop__item')];
  const apply = (f: string): void => {
    chips.forEach(c => { const on = c.dataset.shopf === f; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', String(on)); });
    items.forEach(it => { it.hidden = f !== 'all' && it.dataset.kind !== f; });
  };
  chips.forEach(c => c.addEventListener('click', () => apply(c.dataset.shopf as string)));
  apply('all');
}
