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

## Piano roll: optimasi gambar (tampilan tidak berubah)
Drag nada, geser, dan zoom dibuat lebih ringan tanpa mengubah hasil gambar (grid, nada, tuts, penggaris tetap sama).
- **Grid dua lapis** (`drawGrid`): lapis latar (baris + garis grid + garis akhir pattern) dipisah dari lapis nada yang transparan. Saat drag hanya lapis nada yang digambar ulang; lapis latar digambar ulang hanya kalau zoom / posisi canvas / hover / warna berubah (`bgSig`). Canvas yang masih menutupi layar dipakai lagi.
- **Tuts di-cache** (`drawKeys` / `paintKeys`): seluruh deret tuts digambar sekali ke bitmap offscreen (gradient + bayangan tuts hitam tetap sama), lalu tiap frame geser / zoom hanya di-blit. Saat pinch, bitmap diskalakan dulu seperti grid, lalu digambar ulang tajam begitu zoom berhenti.
- **Overscan searah gerak**: ukuran canvas tetap, tapi 3/4 margin ditaruh di sisi arah geser, jadi geser panjang lebih jarang memicu gambar ulang.
- **Geser murni** tidak lagi memicu gambar ulang grid setelah jari berhenti (`commitZoom`).
- **Drag / resize**: nada hidup di-cache per gesture (tanpa `find()` per nada per gerakan), frame dilewati kalau masih di kotak snap yang sama, deteksi nada baru / hilang tidak membuat Map / Set baru tiap frame.
- **`notifyChange` ditunda** selama gesture (JSON + render ulang pratinjau pattern di timeline), dikirim langsung saat jari lepas atau piano roll ditutup.

## Debug Audio (mencari penyebab glitch DERIZ di HP)
Pengaturan > **Debug Audio** (bawaan MATI) memunculkan panel kecil yang mengambang saat Play. Tidak mengubah suara (dites bit-per-bit sama dengan kode sebelumnya); saat mati tidak ada kerja tambahan.

| Baris | Artinya |
|---|---|
| **Beban DERIZ** | Waktu kerja semua plugin DERIZ per blok audio (128 sampel) dibanding jatahnya (~2,67 ms di 48 kHz), plus blok terberat dan waktunya. |
| **Blok telat** | Jumlah blok yang kerjanya melewati jatah. Kalau timer worklet hanya 1 ms (tanpa `performance`), hanya blok yang PASTI lewat jatah yang dihitung, jadi angkanya batas bawah. |
| **Nada telat (worklet)** | Nada terjadwal yang baru diproses > 6 ms setelah waktunya. Ini gejala melodi "tiba-tiba ngebut". |
| **Nada dijadwalkan** | Sisi main thread: sisa waktu terpendek antara nada dikirim dan waktu mulainya; "sudah lewat" = jadwal sudah terlambat saat dikirim. |
| **Nada dipotong** | Batas 12 nada per plugin: *ditahan* = nada yang masih ditekan terpotong (terdengar "tidak bunyi"), *ekor* = nada yang sudah dilepas dipercepat hilang. |
| **Nada hilang** | Tanpa sample (worklet belum menerima audio) atau jadwal terhapus karena sample baru masuk. |
| **Beban puncak / Frame WSOLA** | Voice dan DERIZ yang bunyi bersamaan paling banyak; frame penuh / ringan / dari cache. |
| **Main thread** | Timer 25 ms yang molor > 50 ms (tab sibuk: DOM, waveform, undo). |
| **Underrun browser** | Dari `AudioContext.playbackStats` kalau browser mendukung: bukti langsung suara putus, dari penyebab APA PUN (bukan hanya DERIZ). |

Hitungan direset tiap Play (atau tombol Reset). Kejadian bermasalah dicatat per jendela 0,5 detik dengan waktu relatif terhadap awal lagu (`@12.5s`), supaya bisa dicocokkan dengan bagian melodinya. Tombol **Salin** menyalin laporan teks (termasuk info perangkat) untuk ditempel ke chat.

Kode: `src/audio-debug.ts` (agregasi + panel), `src/deriz-synth.ts` (objek `G` + `finBlock` di worklet, `derizHooks`), `src/fx-rack.ts` (`dbgSched` di `derizPlay`), `src/menu-panel.ts` (switch), `src/main.ts` (`dbgRun` tiap Play).
Tes: `node --experimental-transform-types tools/deriz-debug-test.ts` (suara identik debug mati vs nyala, hitungan blok / nada telat / terpotong / hilang, timer presisi vs kasar, tambahan beban).

## Install ke beranda (PWA)
Web DAW bisa di-install seperti aplikasi: ikonnya muncul di beranda HP / desktop dan bisa dibuka tanpa internet.
- **Android / Chrome / Edge**: buka **Menu > Pengaturan > Install ke layar utama**, atau lewat menu browser (titik tiga) > *Install aplikasi*.
- **iPhone / iPad (Safari)**: ketuk Bagikan > *Tambah ke Layar Utama*.
- Syarat browser: halaman harus dibuka lewat **HTTPS** (atau `localhost`). Service worker hanya aktif pada hasil build (`npm run build` lalu `npm run preview`), bukan di `npm run dev`.

Berkas: `public/manifest.webmanifest` (nama, warna, ikon), `public/icons/*` (ikon 192 / 512 / maskable / iOS), `public/sw.js` (cache offline), `src/pwa.ts` (pendaftaran service worker + tombol Install). Daftar file cache diisi otomatis saat build oleh plugin `pwaPrecache` di `vite.config.ts`, jadi tidak perlu diedit manual.
Versi baru aplikasi aktif setelah semua tab Web DAW ditutup lalu dibuka lagi (supaya project yang sedang dikerjakan tidak terganggu).

## MGCHORD (pembuat chord progression)
Plugin pembuat chord progression, tampilan panel biru: header abu (nama progression + **SAVE** + panah preset), blok **Key / Length / Audio** di kiri, tombol bulat besar di tengah (acak progression) dengan undo / redo di bawahnya, lalu penggaris bar, blok chord, piano roll gelap dengan pasak oranye di awal tiap chord, dan bar bawah **Play / Drag & drop MIDI / unduh**. Tambah lewat panel efek: halaman **Plugin** > tombol **+** > **MGCHORD** (satu per track, jendelanya langsung terbuka; klik kartu MGCHORD untuk membukanya lagi).

| Bagian | Fungsi |
|---|---|
| **Key** | Tonika + skala sekaligus (mis. F Minor). Pilihan skala: Major, Minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, Harmonic / Melodic Minor. |
| **Style / Chord** | Dua dropdown di baris yang sama: kiri = **Style** (susunan nada), kanan = Major / Minor (mutu chord untuk tuts yang diklik). **Block** = chord polos; 10 pola lain mengikuti contoh MIDI Indian Beat (petikan jarang + sinkop, dua oktaf, ditahan sampai akhir bar): Pluck, Pad Run (dua pola persis dari contoh), Turun, Tangga, Tresillo, Dholak, Tisra, Pad Pluck, Bell, Roll. Style dipakai untuk preview, piano roll, SAVE ke pattern, dan MIDI, serta ikut tersimpan di project. Memilih style / klik chord membunyikan satu bar contoh. |
| **Length** | 4 atau 8 bar. Progression dipotong atau diulang sesuai panjang. |
| **Audio** | On = chord berbunyi saat dipilih / diacak. Off = senyap (tombol Play tetap berbunyi). |
| **Tombol bulat** | Acak progression (aliran harmoni fungsional) sepanjang Length. **Undo / redo** menelusuri riwayat perubahan. |
| **Nama progression** | Ketuk untuk memilih preset (Basic, Pop I-V-vi-IV, Sad vi-IV-I-V, Jazz ii-V-I, Andalusian, dst.); panah kiri / kanan = preset sebelum / berikutnya. |
| **Blok chord** | Ketuk blok (atau area di piano roll) untuk memilih. Ikon panah di sisi kiri / kanan blok = derajat chord turun / naik. |
| **SAVE** | Kirim nada ke pattern yang sedang dipilih di timeline. Pattern dilebarkan otomatis kalau muat dan nada lama di pattern itu diganti. Suara keluar kalau track-nya Supersaw / DERIZ. Label di kanan atas berubah dari Unlinked ke Linked setelah berhasil. |
| **Drag & drop MIDI / unduh** | Seret ke DAW (Chrome / Edge) atau klik untuk mengunduh .mid (tempo mengikuti project). |

Voicing (5 suara, invert, velocity), Octave, dan Chord Type masih ada di data / mesin (`mgchord-theory.ts`) dengan nilai bawaan, tapi kontrolnya tidak ditampilkan di UI. Pola style adalah tabel satu bar (`PATTERNS` di `mgchord-theory.ts`): tiap nada = [ketukan, urutan nada chord dari bawah (0 akar, 1 terts, 2 kuint, 3 akar +1 oktaf, 4 terts +1 oktaf, ...), panjang (4 = ditahan sampai akhir bar), velocity]. Ubah angkanya atau tambah entri baru (plus namanya di `STYLES` dan `STYLE_INFO`) untuk membuat style lain. Project lama yang memakai style sebelumnya otomatis jatuh ke Block.

Tombol Play hanya preview (suara piano sample milik plugin sendiri, tempo ikut project); Spasi = play / stop, Esc = tutup. Setelan MGCHORD ikut tersimpan di file project (`mgchord`).

Suara preview = piano ASLI (sample), bukan sintesis: Salamander Grand Piano (Alexander Holm, CC BY 3.0, lihat `public/samples/piano/LICENSE.txt`), 21 file mp3 (~1,4 MB, C2..C7 tiap 3 nada) di `public/samples/piano/`. Sample dimuat saat jendela MGCHORD dibuka; tiap nada diambil dari sample terdekat lalu digeser pitch-nya, velocity mengatur volume + kecerahan, nada dilepas dengan damper. Selama sample belum selesai dimuat (atau gagal dimuat) dipakai piano sintetis cadangan (`synthTone`) dengan level yang disamakan. Sudah di-mixing di plugin (`createMaster`): low-cut 38 Hz -> EQ halus (gumam 300 Hz, presence 3,2 kHz, udara 9 kHz) -> compressor perekat -> limiter -> soft-clip pengaman (tidak pernah pecah), plus reverb ruang kecil paralel. Level progression sekitar -14 dBFS RMS (volume musik biasa); akor 7 nada velocity penuh tetap di bawah pecah.

Kode: `src/mgchord-theory.ts` (teori murni: skala, chord, voicing, progression, MIDI), `src/mgchord-audio.ts` (sampler piano + mixing, murni Web Audio), `src/mgchord.ts` (jendela + preview), blok "MGCHORD" di `src/styles.css`, kartu di `src/fx-rack.ts`, jembatan ke pattern + simpan project di `src/main.ts` (`setMgchordBridge`).
Tes: `node tools/mgchord-test.ts` (nama chord vs referensi, voicing, invert, strum / arp, panjang progression, header MIDI). Tes suara + mixing: `npm i --no-save node-web-audio-api && node tools/mgchord-audio-test.ts [hasil.wav]` (render offline dengan sample asli: 21 sample termuat, pitch tepat, peak / RMS, kasus terburuk, synth cadangan, ekor; opsional simpan WAV untuk didengar).
