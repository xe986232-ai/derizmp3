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

## MPCS: knob Center / Variation / Transition
Tiga knob global di toolbar MPCS, fungsinya meniru NewTone dan semuanya ikut dirender (bukan hiasan). Nilai dikirim ke Worker lewat `ctl`, dan garis oranye di editor memakai kurva yang sama dengan yang didengar (`shiftCurve`).

| Knob | Bawaan | Fungsi |
|---|---|---|
| **Center** | 0% | Menarik pitch pusat tiap nada ke semiton terdekat. 0% = pitch asli, 100% = tepat di nada. Geser terukur = Center × (target − pitch asli). Nada yang diseret tangan (`Note.man`) selalu dikoreksi penuh dan tidak ikut knob. |
| **Variation** | 100% | Mengalikan variasi alami di dalam nada (drift lambat + vibrato). 100% = asli, 0% = datar di pusat nada. Dikalikan dengan Drift / Vibrato per nada. |
| **Transition** | 50% | Cara pindah antar nada bersambung. 50% = luncuran asli dipertahankan (sama seperti perilaku lama). Ke kiri: luncuran dibuang, lompatan makin tajam (zona halus 2 ms, robotik). Ke kanan: luncuran asli diganti luncuran sintetis yang makin lebar (sampai 300 ms, legato). Arc knob dari tengah, seperti knob pan. |

Knob Drift / Vibrato per nada hanya muncul kalau ada nada terpilih. "Snap semua" = Center 100%; "Reset" mengembalikan semua knob ke bawaan. Klik dua kali pada knob = reset knob itu.

Kode: `src/mpcs-dsp.ts` (`Controls`, `transitionMs`, `groupShift`), `src/mpcs.ts` (knob + wiring), `src/mpcs-worker.ts` (meneruskan `ctl`).

Tes: `node tools/mpcs-knobs.ts` (Center / Variation / Transition diukur pada audio hasil render dengan estimator terpisah). `node tools/mpcs-eval.ts` dan `mpcs-eval-hard.ts` tetap dipakai untuk regresi; dengan kontrol tidak diberikan hasilnya identik dengan sebelum knob ada.
