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

## De-esser (efek track)
Pereda desis "S" untuk vokal (audio clip, DERIZ, dll.). Tambah lewat panel efek track: tombol + lalu **De-esser**. Selalu berada paling awal di jalur efek track (sebelum EQ / Filter / Reverb).

| Knob | Bawaan | Fungsi |
|---|---|---|
| **Freq** | 6,7 kHz | Batas bawah daerah desis (3-12 kHz). Sinyal dibelah di sini (crossover LR4); hanya bagian di atasnya yang bisa diredam, bagian bawah tidak disentuh. Vokal cowok biasanya 5-7 kHz, cewek 6-9 kHz. |
| **Thresh** | -32 dB | Desis di atas level ini mulai diredam (-60 sampai -10 dB). Makin kecil = makin sering bekerja. Kalau "S" tetap nusuk, turunkan; kalau huruf lain ikut redup, naikkan. |
| **Amount** | -10 dB | Peredaman maksimum (0-20 dB). 0 = mati. |

Cara kerja: level band di atas Freq dibaca detektor (attack 0,4 ms, release 30 ms), dikompres 10:1 dengan soft knee 6 dB, dibatasi Amount, lalu gain yang sama dipakai ke kiri dan kanan. Tanpa lookahead (tidak ada latensi tambahan). Saat tidak ada desis, suara sama persis dengan aslinya (magnitudo datar).

Kode: `src/deesser.ts` (worklet), `src/audio-engine.ts` (`setDeesser`, jalur efek), `src/fx-rack.ts` (kartu + knob). Tes: `node tools/deesser-test.ts`.

## Stem Splitter (vokal / instrumen)
Memisahkan lagu jadi dua stem: **vokal** dan **instrumen**, memakai model jaringan saraf **MDX-Net `Kim_Vocal_2`** (paket [`web-audio-separation`](https://github.com/incidentist/web-audio-separation), MIT, di atas `onnxruntime-web`) yang jalan langsung di browser. Instrumen = mix - vokal·compensate (cara UVR), jadi vokal + instrumen hampir sama dengan aslinya.

**Cara pakai di aplikasi:** tahan icon microphone di header audio clip (card yang sama dengan Tempo), pilih **Pisahkan Vokal & Instrumen**. Card menampilkan progres lalu menutup sendiri; hasilnya dua track audio baru tepat di bawah track asal, "<judul> (Vokal)" dan "<judul> (Instrumen)", dengan posisi / lebar / offset sama dengan clip asal. Clip asli tidak diubah. Yang dipisah audio aslinya (sebelum di-stretch); kalau clip sedang di-Tempo, kedua stem di-stretch dengan faktor yang sama sehingga tetap sejajar dengan project. Hanya mono / stereo.

Kode UI: `src/clip-icon-menu.ts` (item menu + tampilan progres), blok "Stem Splitter" di `src/main.ts` (cache, pembuatan track, pemilihan model / cadangan), gaya `.clip-card__stem` / `__bar` di `src/styles.css`.

**Model (jalur utama):** `separateMdx(chs, sr, onProgress?)` dari `src/stem-mdx.ts`, masukan 1 (mono) atau 2 (stereo) kanal `Float32Array`, hasil `{ vocal, instrumental }` (jumlah kanal, panjang, dan sample rate sama dengan masukan).
- Model ONNX `Kim_Vocal_2` (~67 MB) diunduh browser dari Hugging Face **sekali**, lalu disimpan di CacheStorage; pemisahan berikutnya tidak mengunduh lagi. Pemisahan pertama karenanya lebih lama dan butuh internet. Alternatif ukuran sama: `UVR-MDX-NET-Voc_FT` (ganti konstanta `MDX_MODEL`).
- Inferensi pakai WebGPU kalau ada, kalau tidak WASM (CPU; file WASM ONNX Runtime diambil dari CDN jsDelivr saat dipakai). WASM berthread (jauh lebih cepat) butuh halaman dengan header `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`; tanpa header itu tetap jalan, hanya satu thread.
- Model dilatih di 44,1 kHz: audio di-resample ke sana lalu dikembalikan ke sample rate asal.
- Berjalan di thread utama (paket ini men-decode lewat `OfflineAudioContext`, tidak ada di Worker) dan diantre satu per satu. Paket + `onnxruntime-web` dimuat lewat `import()` dinamis, jadi baru diunduh saat fitur ini dipakai pertama kali.
- `vite.config.ts` membuang file WASM ONNX Runtime (~28 MB) dari `dist` karena tidak terpakai (WASM-nya dari CDN).

**Cadangan (DSP klasik):** kalau model tidak bisa dimuat (offline pada pemisahan pertama, memori habis, dst), `main.ts` menampilkan toast lalu jatuh ke pemisahan klasik berbasis mask: `separate(chs, sr, opts?, onProgress?)` dari `src/stem-split.ts` di Worker `src/stem-worker.ts` (pesan `split` -> `progress` / `done` / `error`). STFT 4096 / hop 1024, satu mask lunak per bin dari pusat stereo + HPSS + pita vokal; vokal + instrumen persis sama dengan aslinya (instrumen = asli - vokal). Kualitasnya jauh di bawah model: terbaik hanya untuk stereo dengan vokal di tengah, piano / pad mono bisa bocor ke vokal, dan pada audio mono turun banyak. Opsi: `strength` (0..1, bawaan 0.5), `bassCutoff` (Hz, bawaan 120), `chunkSec` (bawaan 12). Tes: `node tools/stem-test.ts` (lagu sintetis dengan stem asli: SDR vokal -0,5 -> 11,5 dB, instrumen 0,5 -> 12,1 dB; lagu nyata hasilnya akan lebih rendah).

## Piano roll: optimasi gambar (tampilan tidak berubah)
Drag nada, geser, dan zoom dibuat lebih ringan tanpa mengubah hasil gambar (grid, nada, tuts, penggaris tetap sama).
- **Grid dua lapis** (`drawGrid`): lapis latar (baris + garis grid + garis akhir pattern) dipisah dari lapis nada yang transparan. Saat drag hanya lapis nada yang digambar ulang; lapis latar digambar ulang hanya kalau zoom / posisi canvas / hover / warna berubah (`bgSig`). Canvas yang masih menutupi layar dipakai lagi.
- **Tuts di-cache** (`drawKeys` / `paintKeys`): seluruh deret tuts digambar sekali ke bitmap offscreen (gradient + bayangan tuts hitam tetap sama), lalu tiap frame geser / zoom hanya di-blit. Saat pinch, bitmap diskalakan dulu seperti grid, lalu digambar ulang tajam begitu zoom berhenti.
- **Overscan searah gerak**: ukuran canvas tetap, tapi 3/4 margin ditaruh di sisi arah geser, jadi geser panjang lebih jarang memicu gambar ulang.
- **Geser murni** tidak lagi memicu gambar ulang grid setelah jari berhenti (`commitZoom`).
- **Drag / resize**: nada hidup di-cache per gesture (tanpa `find()` per nada per gerakan), frame dilewati kalau masih di kotak snap yang sama, deteksi nada baru / hilang tidak membuat Map / Set baru tiap frame.
- **`notifyChange` ditunda** selama gesture (JSON + render ulang pratinjau pattern di timeline), dikirim langsung saat jari lepas atau piano roll ditutup.
