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

// ---------- gambar plugin: SVG flat kecil (warna solid, tanpa gradasi / bayangan) yang meniru tampilan tiap plugin ----------
const n = (v: number): number => Math.round(v * 10) / 10;
const range = (k: number): number[] => Array.from({ length: k }, (_, i) => i);
const gau = (x: number, c: number, w: number): number => Math.exp(-(((x - c) / w) ** 2));
const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0, extra = ''): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}" fill="${fill}"${extra}/>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 1, extra = ''): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`;
const label = (x: number, y: number, s: string, size: number, fill: string, o: { anchor?: string; family?: string; spacing?: number } = {}): string =>
  `<text x="${x}" y="${y}" text-anchor="${o.anchor ?? 'middle'}" font-size="${size}" font-weight="700" fill="${fill}" font-family="${o.family ?? 'system-ui,sans-serif'}"${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${s}</text>`;
const knob = (cx: number, cy: number, r: number, deg: number, body: string, ring: string, mark: string): string => {
  const a = (deg - 90) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${body}" stroke="${ring}" stroke-width="1"/>` +
    `<line x1="${n(cx + c * r * 0.2)}" y1="${n(cy + s * r * 0.2)}" x2="${n(cx + c * r * 0.85)}" y2="${n(cy + s * r * 0.85)}" stroke="${mark}" stroke-width="1.6" stroke-linecap="round"/>`;
};
const curve = (f: (x: number) => number, x0: number, x1: number): string => range(Math.round((x1 - x0) / 2) + 1).map(i => { const x = x0 + i * 2; return `${i ? 'L' : 'M'}${x},${n(f(x))}`; }).join('');
const art = (bg: string, inner: string): string =>
  `<svg viewBox="0 0 160 72" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${rect(0, 0, 160, 72, bg)}${inner}</svg>`;

const lowpass = (x: number): number => 16 + 30 * (1 - 1 / (1 + Math.exp((x - 92) / 6))) - 8 * gau(x, 88, 5);   // kurva low-pass dengan puncak resonansi di dekat cutoff

const ART: Record<string, string> = {
  // DERIZ: faceplate gelap, waveform sample + garis start merah, tiga knob (Speed / Pitch / Volume)
  DERIZ: art('#2b2b36',
    label(8, 12, 'DERIZ', 8, '#ececf4', { anchor: 'start', family: 'Syncopate,system-ui,sans-serif', spacing: 1.6 }) +
    rect(8, 17, 144, 28, '#17171d', 3) +
    range(36).map(i => { const h = 3 + Math.abs(Math.sin(i * 0.9) * Math.sin(i * 0.31 + 1)) * 22; return rect(11 + i * 3.9, 31 - h / 2, 2.2, h, i < 3 ? '#52526a' : '#8f8fa6', 1); }).join('') +
    rect(24, 17, 1, 28, '#ff6b6b') +
    knob(40, 58, 8, -50, '#3a3a48', '#52526a', '#ececf4') + knob(80, 58, 8, 0, '#3a3a48', '#52526a', '#ececf4') + knob(120, 58, 8, 60, '#3a3a48', '#52526a', '#ececf4')),
  // MPCS: blok nada pink di piano roll (satu blok digeser) + tiga knob
  MPCS: art('#26232b',
    rect(8, 8, 144, 38, '#1c1a21', 3) +
    range(5).map(i => line(8, 14.3 + i * 6.3, 152, 14.3 + i * 6.3, '#2e2b36')).join('') +
    [[14, 12, 26], [44, 18, 18], [66, 24, 30], [100, 18, 22], [126, 12, 22]].map(([x, y, w]) => rect(x, y, w, 5, '#ff5c9e', 1.5)).join('') +
    rect(100, 30, 22, 5, 'none', 1.5, ' stroke="#ff5c9e" stroke-width="1" stroke-dasharray="2 2"') +
    knob(40, 58, 7, -40, '#3a3342', '#4f4559', '#ff5c9e') + knob(80, 58, 7, 20, '#3a3342', '#4f4559', '#ff5c9e') + knob(120, 58, 7, 70, '#3a3342', '#4f4559', '#ff5c9e')),
  // MGCHORD: header terang + blok chord biru + piano roll gelap dengan pasak oranye di batas chord
  MGCHORD: art('#e9edf7',
    rect(0, 0, 160, 14, '#f4f6fb') + rect(40, 3, 60, 8, '#e6eaf4', 2) + rect(120, 3, 32, 8, '#3f6fd8', 2) +
    ['Fm', 'Cm7', 'Ab', 'Eb'].map((c, i) => { const x = 8 + i * 36.67; return rect(x, 18, 34, 14, '#4a7de6', 3) + label(x + 17, 28, c, 7, '#ffffff'); }).join('') +
    rect(8, 36, 144, 30, '#1e2230', 3) +
    [0, 1, 2, 3].map(i => { const x = 8 + i * 36.67; return [[2, 40, 30], [5, 47, 24], [2, 54, 28]].map(([dx, y, w]) => rect(x + dx, y, w, 3, '#7fa6f5', 1)).join('') + (i ? rect(x - 1.8, 36, 1.5, 30, '#f2b632') : ''); }).join('')),
  // Supersaw: tab OSC / FILTER / ENV, dua knob + dua slider vertikal
  Supersaw: art('#25252f',
    rect(8, 6, 34, 11, '#5b3de8', 5.5) + label(25, 14, 'OSC', 6.5, '#ffffff') +
    rect(46, 6.5, 38, 10, 'none', 5, ' stroke="#3a3a48" stroke-width="1"') + label(65, 14, 'FILTER', 6.5, '#b9b9c9') +
    rect(88, 6.5, 30, 10, 'none', 5, ' stroke="#3a3a48" stroke-width="1"') + label(103, 14, 'ENV', 6.5, '#b9b9c9') +
    knob(28, 44, 11, -35, '#34343f', '#4a4a5a', '#a66cff') + knob(62, 44, 11, 45, '#34343f', '#4a4a5a', '#a66cff') +
    rect(104, 26, 3, 38, '#3a3a48', 1.5) + rect(100, 32, 11, 5, '#a66cff', 2) +
    rect(130, 26, 3, 38, '#3a3a48', 1.5) + rect(126, 46, 11, 5, '#a66cff', 2)),
  // Reverb: sinyal langsung + ekor gema yang meluruh
  Reverb: art('#202428',
    line(8, 56, 152, 56, '#2f353b') +
    range(26).map(i => { const h = i === 0 ? 40 : 30 * Math.exp(-i * 0.14) * (0.7 + 0.3 * Math.abs(Math.sin(i * 1.7))); return rect(10 + i * 5.4, 56 - h, 2.6, h, i === 0 ? '#e8e8f0' : '#14b8a6', 1); }).join('')),
  // Equalizer: kurva respons dengan lima titik band
  Equalizer: art('#1f2228',
    [20, 36, 52].map(y => line(8, y, 152, y, '#2d3038')).join('') + [34, 62, 90, 118].map(x => line(x, 8, x, 64, '#2d3038')).join('') +
    `<path d="${curve(x => 36 - 12 * gau(x, 56, 14) + 9 * gau(x, 92, 12) - 7 * gau(x, 130, 14), 8, 152)}" fill="none" stroke="#2f7bff" stroke-width="2" stroke-linejoin="round"/>` +
    [20, 56, 92, 130, 148].map(x => `<circle cx="${x}" cy="${n(36 - 12 * gau(x, 56, 14) + 9 * gau(x, 92, 12) - 7 * gau(x, 130, 14))}" r="3" fill="#2f7bff" stroke="#e8e8f0" stroke-width="1"/>`).join('')),
  // Filter: kurva low-pass dengan puncak resonansi + dua knob
  Filter: art('#28232a',
    line(8, 48, 152, 48, '#38303b') +
    `<path d="${curve(lowpass, 8, 152)}L152,48L8,48Z" fill="#ff9f1c" fill-opacity=".22" stroke="none"/>` +
    `<path d="${curve(lowpass, 8, 152)}" fill="none" stroke="#ff9f1c" stroke-width="2" stroke-linejoin="round"/>` +
    knob(60, 60, 5.5, 30, '#3a3340', '#50455a', '#ff9f1c') + knob(100, 60, 5.5, -30, '#3a3340', '#50455a', '#ff9f1c')),
  // De-esser: desis tinggi (pink) diratakan oleh garis threshold
  'De-esser': art('#272229',
    range(31).map(i => { const sib = i >= 18 && i <= 26, h = 6 + Math.abs(Math.sin(i * 1.3)) * 12; return rect(10 + i * 4.6, 36 - h / 2, 2.4, h, '#8f8a98', 1) + (sib ? rect(10 + i * 4.6, 36 - 24, 2.4, 48, '#ff4d8d', 1, ' fill-opacity=".3"') + rect(10 + i * 4.6, 36 - 12, 2.4, 24, '#ff4d8d', 1) : ''); }).join('') +
    line(8, 24, 152, 24, '#ff4d8d', 1, ' stroke-dasharray="3 2"') + line(8, 48, 152, 48, '#ff4d8d', 1, ' stroke-dasharray="3 2"') +
    knob(50, 63, 5, -20, '#3a3340', '#50455a', '#ff4d8d') + knob(80, 63, 5, 30, '#3a3340', '#50455a', '#ff4d8d') + knob(110, 63, 5, 65, '#3a3340', '#50455a', '#ff4d8d')),
  // Delay: pantulan berulang yang makin kecil dan pudar
  Delay: art('#26241f',
    line(8, 56, 152, 56, '#38352c') +
    [[40, 1], [30, 0.75], [22, 0.55], [15, 0.4], [10, 0.28]].map(([h, o], i) => rect(14 + i * 27, 56 - h, 15, h, '#facc15', 2, ` fill-opacity="${o}"`)).join('') +
    line(14, 62, 148, 62, '#facc15', 1, ' stroke-dasharray="2 3" stroke-opacity=".5"')),
};

const IC_SHOP ='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
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
          '<div class="shop__art">' + (ART[p.name] ?? '') + '</div>' +
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
