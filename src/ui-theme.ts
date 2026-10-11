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
// Sub-tema Flat (atribut data-flatstyle, hanya ada saat Flat aktif): "1" = Style 1 = Muted Flat Industrial (beige, bawaan), "2" = Style 2 = Studio Gray (abu-abu terang).
export const flatStyle = (): string => document.documentElement.dataset.flatstyle || '1';
// Style 2 = Studio Gray (abu-abu terang netral). Warna track (FLAT_TRACK_COLORS) sengaja dipakai bersama semua style, jadi track / clip yang sudah ada tidak berubah warna saat ganti style.

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
  // Style 2: Studio Gray (abu-abu terang netral kebiruan tipis)
  '2': { bg: '#D9DBDF', panel: '#CDD0D5', raised: '#E6E8EB', muted: '#C0C4CA', border: '#AEB3BB', grid: '#BCC0C7', ctrlLine: '#8E949E', text: '#26292E', text2: '#50565F', inverse: '#F4F5F7',
    lavender: '#B98AD0', lavenderDark: '#8D70A8', orange: '#F5A044', orangeDark: '#D98232', teal: '#4C9F9A', tealDark: '#357F7A', playhead: '#1FB5D6', accent: '#E0568F',
    green: '#6BB86A', yellow: '#E5C65A', gray: '#8F9399', keyWhite: '#F4F5F7', keyBlack: '#3A3D42', note: '#3A3D42', screen: '#F4F5F7', onColor: '#26292E',
    keyText2: '#50565F', wave: '#3A3D42', scrim: '#26292E', tickA: '#50565F', tickB: '#8E949E', tickC: '#AEB3BB' }
};
export const flatCols = (): FlatCols => FLAT_COLS[flatStyle()] || FLAT_COLS['1'];
// '#RRGGBB' -> [r,g,b]; 'r,g,b'; rgba(...) dengan alpha
export const rgbArr = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
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
