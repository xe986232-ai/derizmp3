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
Tampilan plugin: panel magenta logam sikat (header + bar kontrol), panel tengah perak berisi editor piano roll berbingkai hitam, layar LCD hitam untuk status, miring 3D tipis mengikuti kursor. Bar kontrol hanya berisi tombol Upload audio, tiga knob (Trans, Variation, Center), dan tombol Play / Pause; Snap / Reset, Hasil / Asli, Drift / Vibrato, zoom, dan ekspor WAV tidak ada di UI. Nada otomatis di-snap ke semiton terdekat saat audio dimuat. Ukuran kartu menyesuaikan HP (landscape 560x330, portrait lebih tinggi dengan knob di baris sendiri). Kode UI: `src/mpcs.ts` + blok "MPCS" di `src/styles.css`.

Tiga knob global di toolbar MPCS, fungsinya meniru NewTone dan semuanya ikut dirender (bukan hiasan). Nilai dikirim ke Worker lewat `ctl`, dan garis oranye di editor memakai kurva yang sama dengan yang didengar (`shiftCurve`).

| Knob | Bawaan | Fungsi |
|---|---|---|
| **Center** | 0% | Menarik pitch pusat tiap nada ke semiton terdekat. 0% = pitch asli, 100% = tepat di nada. Geser terukur = Center × (target − pitch asli). Nada yang diseret tangan (`Note.man`) selalu dikoreksi penuh dan tidak ikut knob. |
| **Variation** | 100% | Mengalikan variasi alami di dalam nada (drift lambat + vibrato). 100% = asli, 0% = datar di pusat nada. Dikalikan dengan Drift / Vibrato per nada. |
| **Transition** | 50% | Cara pindah antar nada bersambung. 50% = luncuran asli dipertahankan (sama seperti perilaku lama). Ke kiri: luncuran dibuang, lompatan makin tajam (zona halus 2 ms, robotik). Ke kanan: luncuran asli diganti luncuran sintetis yang makin lebar (sampai 300 ms, legato). Arc knob dari tengah, seperti knob pan. |

Knob Drift / Vibrato per nada hanya muncul kalau ada nada terpilih. "Snap semua" = Center 100%; "Reset" mengembalikan semua knob ke bawaan. Klik dua kali pada knob = reset knob itu.

Kode: `src/mpcs-dsp.ts` (`Controls`, `transitionMs`, `groupShift`), `src/mpcs.ts` (knob + wiring), `src/mpcs-worker.ts` (meneruskan `ctl`).

Tes: `node tools/mpcs-knobs.ts` (Center / Variation / Transition diukur pada audio hasil render dengan estimator terpisah). `node tools/mpcs-eval.ts` dan `mpcs-eval-hard.ts` tetap dipakai untuk regresi; dengan kontrol tidak diberikan hasilnya identik dengan sebelum knob ada.

## MPCS: luncuran lebar, scoop, dan jatuhan (supaya hasil benar-benar lurus)
Masalah sebelumnya: vokal yang meluncur lebar antar nada (2-5 semiton), naik dari bawah (scoop), atau jatuh di ujung nada dipecah tracker jadi beberapa potongan pendek, dan tiap potongan "dibulatkan" ke semitonnya sendiri. Hasilnya tangga semiton yang terdengar seperti slide, walau Center 100% / Variation 0% / Transition 0%.
Perbaikan (`segment()`, langkah b4 di `src/mpcs-dsp.ts`): rangkaian potongan pendek di antara dua nada panjang dihapus dan perbatasan nada ditaruh di titik tengah luncuran (satu lompatan bersih); scoop / jatuhan berlapis di awal / akhir rangkaian diserap ke nada panjangnya. Batas simpangan yang dikoreksi dinaikkan dari 3 ke 5 semiton.
Tes: `node tools/mpcs-straight.ts` mengukur pitch hasil render (estimator terpisah) pada vokal sintetis dengan scoop 1.5-3 st, luncuran 100-150 ms, jatuhan 1-2 st, vibrato + drift. Terburuk sebelum: rms 90 sen, simpangan dalam 40 ms sampai 230 sen. Sesudah: rms 5.7 sen.

## MPCS: pergantian kata (lonjakan nada di awal kata)
Tiga penyebab lonjakan di pergantian kata, dan perbaikannya (semua di `src/mpcs-dsp.ts`):
1. **Jembatan konsonan.** Tracker menambal jeda konsonan dengan pitch yang turun lalu naik lagi, dan potongan itu jadi "nada" sendiri yang dibulatkan ke semiton lain. Sekarang potongan pendek di antara dua nada panjang yang pitch-nya sama dibagi dua ke nada kiri-kanan (`segment()`, langkah b4 / 1b). Batas "nada panjang" naik ke ~130 ms.
2. **Awal kata belum terlacak.** Tracker baru menyala beberapa frame setelah sinyal sudah periodik, jadi bagian awal kata lewat tanpa koreksi (lengkap dengan lonjakan aslinya). `extendEdges()` menggeser tepi nada sampai ~35 ms ke frame yang masih periodik (autokorelasi > 0.7 dan cukup keras); konsonan gesek / letup tidak lolos uji ini.
3. **Kesalahan tracker ikut terbawa.** Saat Variation 0% (drift = vibrato = 0) pitch hasil sudah diketahui tanpa tracker, yaitu pusat nada yang dihaluskan di zona transisi. `render()` dan `shiftCurve()` sekarang memakai pitch absolut itu (`groupShift` mengembalikan `ab` / `aw`) alih-alih "f0 tracker dikurangi deviasi tracker". Mode Variation > 0 tidak berubah.
Tes: `node tools/mpcs-straight.ts` (sekarang termasuk skenario kata: lonjakan 2-3 st, scoop + konsonan, onset kasar, onset lambat). Tes regresi lama (`mpcs-eval`, `mpcs-eval-hard`, `mpcs-knobs`) hasilnya identik.

## MPCS: suara "burik" (serak / kasar) hasil render
Penyebab terukur: titik pitch (epoch) dipilih dari puncak gelombang + parabola, yang sering meleset ~0.5-1 sample. Meleset sekecil itu memutar fase harmonik atas antar grain TD-PSOLA, hasilnya noise antar-harmonik (serak). Perbaikan di `epochMarks()` (`src/mpcs-dsp.ts`): tiap titik diselaraskan lagi lewat korelasi bentuk gelombang satu periode dengan periode sebelumnya (geser pecahan 0.1 sample, dihaluskan parabola); kalau korelasinya lemah (< 0.5) dipakai posisi puncak seperti sebelumnya.
Ukur: `node tools/mpcs-straight.ts` sekarang juga melaporkan HNR hasil vs referensi vokal yang pitch-nya lurus sempurna dan jarak spektrum log ke referensi. Selisih HNR turun dari 4.9 dB ke 0.9 dB, jarak spektrum dari 11.9 ke 9.0 dB. Tes regresi: HNR rata-rata `mpcs-eval-hard` 20.0 -> 22.6 dB, `mpcs-eval` 21.7 -> 24.7 dB; akurasi pitch tidak turun.
Dicoba dan tidak membantu (tidak dipakai): normalisasi overlap-add dengan jumlah bobot jendela, dan grain lebih lebar.
