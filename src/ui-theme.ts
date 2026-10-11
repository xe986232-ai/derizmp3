// Tema UI (atribut data-ui di <html>): 'ink' = Ink Rose (bawaan), 'mono' = Mono Graphite.
// Warna CSS ada di styles.css; file ini hanya untuk bagian yang digambar lewat canvas / diisi dari JS.
export type UiTheme = 'ink' | 'mono';

export const uiTheme = (): UiTheme => {
  const v = document.documentElement.dataset.ui;
  return v === 'mono' ? v : 'ink';
};

const INK = ['#ff5c9e', '#a66cff', '#5b8ff3', '#2dd4bf', '#3fbf5f', '#f2b632', '#ff8a4c', '#ef4444'];
// warna track baru / menu warna per tema
export const TRACK_COLORS: Record<UiTheme, string[]> = {
  ink: INK,
  mono: INK
};
// Gaya UI Flat (atribut data-uistyle="flat"): warna track mengikuti palet Muted Flat Industrial (lavender = MIDI, oranye = audio, teal, dst)
export const isFlat = (): boolean => document.documentElement.dataset.uistyle === 'flat';
// Sub-tema Flat (atribut data-flatstyle, hanya ada saat Flat aktif): "1" = Style 1 = Muted Flat Industrial (beige, bawaan), "2" = Style 2 = Midnight Slate (gelap).
export const flatStyle = (): string => document.documentElement.dataset.flatstyle || '1';
// Style 2 = Midnight Slate (UI gelap). Warna track (FLAT_TRACK_COLORS) sengaja dipakai bersama semua style: nada tengah yang terbaca di latar terang maupun gelap,
// jadi track / clip yang sudah ada tidak berubah warna saat ganti style.
export const isFlatDark = (): boolean => isFlat() && flatStyle() === '2';

// Palet UI Flat untuk bagian yang digambar lewat canvas / JS. Nilainya HARUS sama dengan token --flat-ap-* di flat-ui.css
// (Style 1 = blok dasar, Style 2 = html[data-flatstyle="2"]); CSS tetap sumber utama, tabel ini hanya cermin untuk canvas.
export interface FlatCols {
  bg: string; panel: string; raised: string; muted: string; border: string; grid: string; ctrlLine: string; text: string; text2: string; inverse: string;
  lavender: string; lavenderDark: string; orange: string; orangeDark: string; teal: string; tealDark: string; playhead: string; accent: string;
  green: string; yellow: string; gray: string; keyWhite: string; keyBlack: string; note: string; screen: string; onColor: string;
  keyText2: string;   // teks sekunder di atas tuts putih
  wave: string; scrim: string;   // waveform di layar editor; warna tirai / peredam (hitam di Style gelap)
  tickA: string; tickB: string; tickC: string;   // tick ruler (sama dengan --flat-pl-tick-a/b/c)
}
const FLAT_COLS: Record<string, FlatCols> = {
  // Style 1: Muted Flat Industrial (beige / taupe)
  '1': { bg: '#D2C7B5', panel: '#C7BBA8', raised: '#DDD3C2', muted: '#BDB19E', border: '#A69D8F', grid: '#B7AD9E', ctrlLine: '#8F887D', text: '#343536', text2: '#68665F', inverse: '#F3EBDD',
    lavender: '#B98AD0', lavenderDark: '#8D70A8', orange: '#F5A044', orangeDark: '#D98232', teal: '#5B9F9A', tealDark: '#397F7A', playhead: '#39C6C7', accent: '#D85A94',
    green: '#79B86A', yellow: '#E5C65A', gray: '#8F8F8F', keyWhite: '#F3EBDD', keyBlack: '#454545', note: '#454545', screen: '#F3EBDD', onColor: '#343536',
    keyText2: '#68665F', wave: '#454545', scrim: '#343536', tickA: '#68665F', tickB: '#8F887D', tickC: '#A69D8F' },
  // Style 2: Midnight Slate (grafit kebiruan gelap)
  '2': { bg: '#14161B', panel: '#1B1E25', raised: '#232730', muted: '#101216', border: '#343A46', grid: '#2A2F39', ctrlLine: '#4B5362', text: '#E7E9EE', text2: '#98A0AE', inverse: '#F2F3F6',
    lavender: '#B98AD0', lavenderDark: '#8D70A8', orange: '#F5A044', orangeDark: '#D98232', teal: '#3DBDB4', tealDark: '#247870', playhead: '#4FD1E0', accent: '#FF6B9D',
    green: '#5FCF80', yellow: '#F0C64E', gray: '#6B7280', keyWhite: '#E4E6EB', keyBlack: '#0E1014', note: '#0E1014', screen: '#101318', onColor: '#14161B',
    keyText2: '#5B6270', wave: '#B9BFCC', scrim: '#000000', tickA: '#98A0AE', tickB: '#6E7685', tickC: '#4B5362' }
};
export const flatCols = (): FlatCols => FLAT_COLS[flatStyle()] || FLAT_COLS['1'];
// '#RRGGBB' -> 'r,g,b' dan rgba(...) dengan alpha
export const rgbTriplet = (hex: string): string => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255); };
export const rgbaOf = (hex: string, a: number): string => 'rgba(' + rgbTriplet(hex) + ',' + a + ')';
// objek palet canvas yang dibangun dari FlatCols dan di-cache per style (dipanggil tiap frame, jadi tidak boleh membuat objek baru terus-menerus)
export const flatMemo = <T>(build: (c: FlatCols) => T): (() => T) => {
  let key = '', val: T | undefined;
  return () => { const k = flatStyle(); if (val === undefined || k !== key) { key = k; val = build(flatCols()); } return val; };
};
// Pilihan warna menu Customize (Color pattern / Color note) di tema Flat: 12 warna dari palet gambar referensi (lavender, oranye, teal, hijau/kuning meter, cyan playhead, magenta, white key, teks gelap)
export const FLAT_CUSTOM_SWATCHES = ['#B98AD0', '#8D70A8', '#F5A044', '#D98232', '#5B9F9A', '#397F7A', '#79B86A', '#E5C65A', '#39C6C7', '#D85A94', '#F3EBDD', '#343536'];
export const FLAT_TRACK_COLORS = ['#B98AD0', '#F5A044', '#5B9F9A', '#D85A94', '#8D70A8', '#D98232', '#397F7A', '#79B86A'];

// isi array warna di tempat (referensi lama tetap valid); track yang sudah ada tidak berubah warnanya
export const syncTrackColors = (target: string[]): void => { target.splice(0, target.length, ...(isFlat() ? FLAT_TRACK_COLORS : TRACK_COLORS[uiTheme()])); };
