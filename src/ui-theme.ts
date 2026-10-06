// Tema UI (atribut data-ui di <html>): 'ink' = Ink Rose (bawaan), 'mono' = Mono Graphite, 'classic' = tampilan asli (sedikit dipercantik).
// Warna CSS ada di styles.css; file ini hanya untuk bagian yang digambar lewat canvas / diisi dari JS.
export type UiTheme = 'ink' | 'mono' | 'classic';

export const uiTheme = (): UiTheme => {
  const v = document.documentElement.dataset.ui;
  return v === 'mono' || v === 'classic' ? v : 'ink';
};

const INK = ['#ff5c9e', '#a66cff', '#5b8ff3', '#2dd4bf', '#3fbf5f', '#f2b632', '#ff8a4c', '#ef4444'];
// warna track baru / menu warna: Classic memakai set asli sebelum identitas baru
export const TRACK_COLORS: Record<UiTheme, string[]> = {
  ink: INK,
  mono: INK,
  classic: ['#5b3de8', '#2f7bff', '#14b8a6', '#3fbf5f', '#ff9f1c', '#ff4d8d', '#ef4444', '#facc15']
};

// isi array warna di tempat (referensi lama tetap valid); track yang sudah ada tidak berubah warnanya
export const syncTrackColors = (target: string[]): void => { target.splice(0, target.length, ...TRACK_COLORS[uiTheme()]); };
