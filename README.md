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

## Automation Clip
1. Putar sedikit knob / slider efek mana pun (mis. Filter > Cutoff).
2. Tekan titik tiga di kiri tombol M, pilih **Create Automation Clip**.
3. Clip baru muncul di track Automation (satu lane per knob) dan editornya langsung terbuka: ketuk area kosong = tambah titik, seret = atur, ketuk dua kali titik = hapus.
4. Saat Play, kurva menggerakkan knob-nya; setelah clip selesai, nilai terakhir ditahan. Clip bisa di-Copy, Bagi dua, dan disimpan bersama project.

Kode: `src/automation.ts` (data kurva + editor), `src/fx-rack.ts` (`lastTouched`, `setParam`, `fxExport/fxImport`), `src/main.ts` (blok "Automation Clip", `autoPump`).
