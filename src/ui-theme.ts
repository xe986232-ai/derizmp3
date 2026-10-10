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
export const FLAT_TRACK_COLORS = ['#B98AD0', '#F5A044', '#5B9F9A', '#D85A94', '#8D70A8', '#D98232', '#397F7A', '#79B86A'];

// isi array warna di tempat (referensi lama tetap valid); track yang sudah ada tidak berubah warnanya
export const syncTrackColors = (target: string[]): void => { target.splice(0, target.length, ...(isFlat() ? FLAT_TRACK_COLORS : TRACK_COLORS[uiTheme()])); };
