# Web DAW

Hasil porting `web-daw.html` ke Vite + TypeScript (tahap 1, tanpa perubahan tampilan/perilaku).

## Jalankan
```
npm install
npm run dev        # development
npm run build      # typecheck + build ke dist/
npm run preview    # coba hasil build
```

## Struktur
- `index.html`     : markup (isi <body> asli, tidak diubah)
- `src/styles.css` : CSS asli (isi <style>, tidak diubah)
- `src/main.ts`    : logika asli (isi <script>, tidak diubah; `@ts-nocheck` untuk sementara)

## Tahap berikutnya
Pecah `main.ts` jadi modul: `engine/` (AudioContext, scheduler, graph per track, loader audio),
`store/` (project -> track -> clip/note), lalu UI. React dipasang saat engine dan store sudah berdiri.
