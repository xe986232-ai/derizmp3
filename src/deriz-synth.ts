// Sampler DERIZ: nada (tuts + knob Pitch) dan kecepatan (knob Speed) dikendalikan TERPISAH.
// Tuts apa pun tetap memutar sample dengan kecepatan yang sama; hanya knob Speed yang mengubah kecepatan.
//
// Algoritma (jalan di AudioWorklet, polifonik):
//   1. Time-stretch WSOLA (waveform similarity overlap-add) dengan overlap 75%, jendela Hann ternormalisasi.
//      Posisi tiap frame dicari (kasar -> halus -> SUB-SAMPEL, korelasi silang ternormalisasi pada mono, templat 3 hop)
//      yang paling nyambung dengan lanjutan alami frame sebelumnya. Penyelarasan pecahan sampel penting untuk nada tinggi:
//      periode gelombang jarang bulat, dan galat pembulatan membuat harmonik atas bergeser fase di tiap sambungan (terdengar kasar / robot).
//      Panjang frame menyesuaikan nada: rendah = lebih panjang (memuat beberapa periode); tinggi = lebih panjang juga
//      (hop frame setelah di-resample naik tidak menjadi dengung).
//   2. Penjaga transien: awal ketukan / petikan (onset) dideteksi dari lonjakan energi. Saat stretch, onset TIDAK ikut
//      diulang atau melebar: frame dipotong tepat sebelum onset, lalu dimulai ulang tepat di onset dengan crossfade 2 ms.
//   3. Pitch shift: hasil stretch dibaca ulang pada laju = rasioNada (rasioNada = 2^((tuts - C4 + Pitch) / 12)).
//      Nada turun: interpolasi Hermite 4 titik. Nada NAIK: kernel sinc berjendela Blackman (16 lobus) dengan frekuensi potong
//      0.85/rasio, jadi low-pass terjadi SEBELUM decimate dan harmonik atas tidak terlipat (aliasing) melewati Nyquist.
//   4. Limiter lembut di keluaran supaya akor (banyak nada sekaligus) tidak pecah.
//
// Pesan ke prosesor: buf (data sample), on / off (nada), p (parameter live), kill (hentikan semua).

const WORKLET_SRC = `
class DerizSampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; this.mono = null; this.len = 0; this.bufRate = sampleRate; this.ons = [];
    this.wins = new Map();
    // tabel kernel sinc berjendela Blackman (HW lobus tiap sisi, TR entri per lobus) untuk resampling anti-alias saat nada naik
    this.HW = 8; this.TR = 512;
    const tn = this.HW * this.TR + 2; this.sinc = new Float32Array(tn);
    for (let i = 0; i < tn; i++) {
      const x = i / this.TR, px = Math.PI * x, sc = x < 1e-9 ? 1 : Math.sin(px) / px, u = x / this.HW;
      this.sinc[i] = u >= 1 ? 0 : sc * (0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u));
    }
    this.voices = [];
    this.pend = [];   // perintah on / off yang dijadwalkan di waktu AudioContext tertentu (piano roll)
    this.speed = 1; this.pitch = 0; this.vol = 0.9; this.volS = 0.9;
    this.PF = 2;   // jatah frame prefetch per blok audio (di luar frame yang wajib)
    this.clean = []; this.dirty = []; this.POOL = 16;   // kolam ring buffer voice: disiapkan di blok senggang, bukan saat nada ditekan
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(m) {
    if (m.t === 'buf') { this.pend = []; this.setBuf(m); }
    else if (m.t === 'on' || m.t === 'off' || m.t === 'glide') { if (m.at && m.at > currentTime) this.pend.push(m); else this.apply(m); }
    else if (m.t === 'p') { this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol; }
    else if (m.t === 'relall') { this.pend = []; for (const v of this.voices) v.rel = true; }
    else if (m.t === 'kill') { this.recycleAll(); this.pend = []; }
  }
  apply(m) {
    if (m.t === 'on') { this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol; this.start(m); }
    else if (m.t === 'glide') { for (const v of this.voices) if (v.id === m.id) { v.gf = v.semis; v.gt = m.semis; v.g0 = m.at || currentTime; v.gd = Math.max(0.005, m.dur); } }
    else { for (const v of this.voices) if (v.id === m.id) v.rel = true; }
  }
  // jalankan perintah terjadwal yang jatuh tempo di blok audio ini (ketelitian satu blok = 128 sampel, sekitar 2,7 ms)
  flush() {
    if (!this.pend.length) return;
    const lim = currentTime + 128 / sampleRate, due = [], rest = [];
    for (const m of this.pend) (m.at <= lim ? due : rest).push(m);
    if (due.length) { this.pend = rest; for (const m of due) this.apply(m); }
  }
  setBuf(m) {
    this.bufRate = m.rate; this.wins.clear(); this.recycleAll();
    const minLen = Math.ceil(0.09 * m.rate) + 8;   // sample lebih pendek dari satu frame: tambah nol supaya aman dibaca
    this.ch = m.ch.map(a => { if (a.length >= minLen) return a; const p = new Float32Array(minLen); p.set(a); return p; });
    this.len = this.ch[0].length;
    const mono = new Float32Array(this.len), a = this.ch[0], b = this.ch[1];
    for (let i = 0; i < this.len; i++) mono[i] = b ? (a[i] + b[i]) * 0.5 : a[i];
    this.mono = mono;
    this.ons = this.detect(mono, m.rate);
  }
  // deteksi onset: lonjakan energi blok 4 ms terhadap rata-rata ~32 ms sebelumnya, lalu cari titik serangan di dalam blok
  detect(x, rate) {
    const B = Math.max(32, Math.round(0.004 * rate)), nb = Math.floor(x.length / B), e = new Float32Array(nb);
    let emax = 0;
    for (let j = 0; j < nb; j++) { let s = 0; for (let k = 0; k < B; k++) { const v = x[j * B + k]; s += v * v; } e[j] = s / B; if (e[j] > emax) emax = e[j]; }
    const floor = emax * 0.003, ons = [], gap = 0.06 * rate;
    let last = -1e9;
    for (let j = 3; j < nb; j++) {
      let avg = 0, cnt = 0;
      for (let q = 2; q <= 9 && j - q >= 0; q++) { avg += e[j - q]; cnt++; }
      avg /= cnt;
      if (e[j] > 5 * avg + 1e-12 && e[j] > floor && j * B - last > gap) {
        const a0 = Math.max(0, (j - 1) * B), a1 = Math.min(x.length, (j + 1) * B);
        let pk = 0; for (let i = a0; i < a1; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v; }
        let s = a0; while (s < a1 && Math.abs(x[s]) < 0.35 * pk) s++;
        ons.push(s); last = s;
      }
    }
    return ons;
  }
  // jendela per ukuran frame: W = Hann ternormalisasi (jumlah 4 geseran = 1), S = jendela awal (sama dengan kondisi tunak tapi tanpa frame sebelumnya)
  getWin(N) {
    let w = this.wins.get(N);
    if (w) return w;
    const Hs = N >> 2, W = new Float32Array(N), S = new Float32Array(N);
    for (let i = 0; i < N; i++) W[i] = (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)) * 0.5;
    for (let k = 0; k < 4; k++) for (let j = 0; j < Hs; j++) { let s = 0; for (let m = k; m < 4; m++) s += W[m * Hs + j]; S[k * Hs + j] = s; }
    w = { W, S }; this.wins.set(N, w); return w;
  }
  start(m) {
    if (!this.ch) return;
    const rate = this.bufRate, size = 1 << 15;
    const P0 = Math.pow(2, (m.semis + this.pitch) / 12);
    const dur = P0 < 1 ? 0.04 / Math.sqrt(P0) : 0.04 * Math.pow(P0, 0.35);   // rendah: muat beberapa periode; tinggi: hop lebih panjang supaya modulasi frame (x rasio nada) tidak jadi dengung
    const N = 4 * Math.max(8, Math.round(Math.min(0.085, Math.max(0.03, dur)) * rate / 4));
    const start = Math.max(0, m.start);
    let oi = 0; while (oi < this.ons.length && this.ons[oi] < start + 0.01 * rate) oi++;   // onset persis di awal = bagian dari frame pertama
    this.voices.push({
      id: m.id, semis: m.semis, N: N, nom: start, prev: 0, first: true, last: false, oi: oi,
      w: 0, cEnd: 0, vEnd: 0, rd: 0, rho: P0 * rate / sampleRate, size: size,
      T: this.takeRing(size),
      env: 0, rel: false, atk: 1 / (0.002 * sampleRate), relK: Math.exp(-1 / (0.04 * sampleRate)),
      vel: m.vel === undefined ? 1 : m.vel   // velocity per nada (penguatan 0..1), terpisah dari knob Volume yang berlaku untuk semua nada
    });
  }
  // interpolasi kubik (Catmull-Rom) pada array x di posisi pecahan pos (batas dijaga)
  cub(x, pos) {
    const L = x.length, i = Math.floor(pos), f = pos - i;
    const xm = x[i > 0 ? i - 1 : 0], x0 = x[i], x1 = x[i + 1 < L ? i + 1 : L - 1], x2 = x[i + 2 < L ? i + 2 : L - 1];
    return ((((x2 - xm) * 0.5 + (x0 - x1) * 1.5) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + (x1 - xm) * 0.5) * f + x0;
  }
  // cari posisi frame terbaik di sekitar c0: kasar (langkah 16, stride 8) lalu halus (langkah 1, stride 4), korelasi silang ternormalisasi,
  // lalu SUB-SAMPEL (parabola di puncak korelasi). Hasil: this.fr = bagian pecahan (-0.5..0.5), return = bagian bulat.
  // Templat = lanjutan alami frame sebelumnya (posisi pecahan tp) sepanjang 3 hop; ada sedikit bias ke posisi nominal
  // supaya posisi tidak melompat antar periode yang sama bagusnya (mengurangi flutter).
  search(c0, tp, N, Hs) {
    const x = this.mono, L = this.len, maxC = L - N, W = Hs;
    this.fr = 0;
    const tI = Math.floor(tp), tf = tp - tI;
    let M = 3 * Hs; if (tI + M + 3 > L) M = L - tI - 3;
    const cc = Math.max(0, Math.min(maxC, c0));
    if (M < Hs) return cc;
    if (!this.tm || this.tm.length < M) this.tm = new Float32Array(M + 64);
    const tm = this.tm;
    if (tf < 1e-4) for (let j = 0; j < M; j++) tm[j] = x[tI + j];
    else for (let j = 0; j < M; j++) { const q = tI + j; tm[j] = this.cub(x, q + tf); }
    const lo = Math.max(0, c0 - W), hi = Math.min(maxC, c0 + W);
    const score = (cand, step) => {
      let dot = 0, en = 1e-9;
      for (let j = 0; j < M; j += step) { const s = x[cand + j]; dot += s * tm[j]; en += s * s; }
      return dot / Math.sqrt(en);
    };
    const bias = (cand) => 1 - 0.06 * Math.abs(cand - c0) / W;
    let best = -1e30, bc = cc;
    for (let cand = lo; cand <= hi; cand += 16) { const sc = score(cand, 8) * bias(cand); if (sc > best) { best = sc; bc = cand; } }
    best = -1e30; let fc = bc;
    for (let cand = Math.max(lo, bc - 16); cand <= Math.min(hi, bc + 16); cand++) { const sc = score(cand, 4) * bias(cand); if (sc > best) { best = sc; fc = cand; } }
    if (fc > 1 && fc < maxC - 3) {
      // sub-sampel: skor langsung di posisi pecahan (interpolasi kubik), bagi dua lima kali (resolusi akhir ~1/32 sampel)
      const scoreF = (pos, st) => {
        const b0 = Math.floor(pos), f = pos - b0, f2 = f * f, f3 = f2 * f;
        const k0 = -0.5 * f3 + f2 - 0.5 * f, k1 = 1.5 * f3 - 2.5 * f2 + 1, k2 = -1.5 * f3 + 2 * f2 + 0.5 * f, k3 = 0.5 * f3 - 0.5 * f2;
        let dot = 0, en = 1e-9;
        for (let j = 0; j < M; j += st) { const q = b0 + j, s = k0 * x[q - 1] + k1 * x[q] + k2 * x[q + 1] + k3 * x[q + 2]; dot += s * tm[j]; en += s * s; }
        return dot / Math.sqrt(en);
      };
      let pc = fc, ps = scoreF(fc, 2), step = 0.5;
      for (let it = 0; it < 5; it++) {
        const st = it < 3 ? 2 : 1;
        if (it === 3) ps = scoreF(pc, 1);
        const a1 = scoreF(pc - step, st), a2 = scoreF(pc + step, st);
        if (a1 > ps && a1 >= a2) { ps = a1; pc -= step; } else if (a2 > ps) { ps = a2; pc += step; }
        step *= 0.5;
      }
      const fr = pc - fc; if (fr > -0.75 && fr < 0.75) this.fr = fr;
    }
    return fc;
  }
  // ---- kolam ring buffer voice: tanpa alokasi 256 KB per nada di tengah audio ----
  takeRing(size) {
    const r = this.clean.length ? this.clean.pop() : null;
    return r && r[0].length === size ? r : [new Float32Array(size), new Float32Array(size)];   // kolam kosong: alokasi seperti dulu
  }
  recycle(v) { if (this.clean.length + this.dirty.length < 2 * this.POOL) this.dirty.push(v.T); }
  recycleAll() { for (const v of this.voices) this.recycle(v); this.voices = []; }
  // satu langkah perawatan per blok senggang: bersihkan satu buffer bekas (harus nol lagi: ujung kiri sinc dibaca sebagai nol), atau isi kolam sampai POOL
  idle() {
    if (this.dirty.length) { const r = this.dirty.pop(); r[0].fill(0); r[1].fill(0); this.clean.push(r); }
    else if (this.clean.length < this.POOL) this.clean.push([new Float32Array(1 << 15), new Float32Array(1 << 15)]);
  }
  // apakah frame berikutnya voice ini adalah "mulai ulang di onset"? Frame itu bergantung pada posisi pembaca (v.rd),
  // jadi tidak boleh disiapkan lebih awal supaya hasilnya sama persis dengan penghitungan tepat waktu.
  restartNext(v) {
    if (v.first) return false;
    const ons = this.ons, pre = Math.round(0.0015 * this.bufRate);
    const nom = v.nom + (v.N >> 2) * (this.speed / Math.pow(2, (v.semis + this.pitch) / 12));
    let oi = v.oi;
    while (oi + 1 < ons.length && ons[oi + 1] - pre <= nom) oi++;
    return oi < ons.length && ons[oi] - pre <= nom;
  }
  frameBuf(N) {
    if (!this.fbs || this.fbs[0].length < N) this.fbs = [new Float32Array(N), new Float32Array(N)];
    return this.fbs;
  }
  // satu frame WSOLA ke buffer T milik voice
  gen(v) {
    const N = v.N, Hs = N >> 2, L = this.len, ons = this.ons, mask = v.size - 1;
    const rate = this.bufRate, pre = Math.round(0.0015 * rate), K = Math.round(0.002 * rate);
    const { W, S } = this.getWin(N);
    const P = Math.pow(2, (v.semis + this.pitch) / 12), a = this.speed / P;   // a = maju di sample per frame sintesis (satuan sample)
    const maxC = L - N;
    let c, fr = 0, mode = 0;   // 0 normal, 1 frame pertama, 2 mulai ulang di onset
    if (v.first) { c = Math.min(maxC, Math.round(v.nom)); mode = 1; }
    else {
      v.nom += Hs * a;
      while (v.oi + 1 < ons.length && ons[v.oi + 1] - pre <= v.nom) v.oi++;   // onset yang terlewati sekaligus: ambil yang terakhir
      if (v.oi < ons.length && ons[v.oi] - pre <= v.nom) {
        c = Math.max(0, Math.min(maxC, ons[v.oi] - pre)); v.nom = c; v.oi++; mode = 2;
      } else {
        c = this.search(Math.round(v.nom), v.prev + Hs, N, Hs); fr = this.fr;
        if (v.oi < ons.length) { const cm = ons[v.oi] - pre - 1; if (c + (fr < 0 ? -1 : 0) + N + 3 > cm + N) { /* dekat onset */ } if (c > cm) { c = cm; fr = 0; } }
        if (c < 0) { c = 0; fr = 0; }
        if (c < 3 || c + N + 4 >= L) fr = 0;   // pinggir sample: tanpa pecahan
      }
    }
    // frame sumber dengan posisi pecahan c+fr (interpolasi kubik); tanpa pecahan = salinan langsung
    const fb = this.frameBuf(N);
    for (let q = 0; q < 2; q++) {
      const src = this.ch[q] || this.ch[0], o = fb[q];
      if (fr === 0) { for (let i = 0; i < N; i++) o[i] = src[c + i]; }
      else {
        const b0 = fr < 0 ? c - 1 : c, f = fr < 0 ? 1 + fr : fr, f2 = f * f, f3 = f2 * f;
        const k0 = -0.5 * f3 + f2 - 0.5 * f, k1 = 1.5 * f3 - 2.5 * f2 + 1, k2 = -1.5 * f3 + 2 * f2 + 0.5 * f, k3 = 0.5 * f3 - 0.5 * f2;
        for (let i = 0; i < N; i++) { const j = b0 + i; o[i] = k0 * src[j - 1] + k1 * src[j] + k2 * src[j + 1] + k3 * src[j + 2]; }
      }
    }
    // potong frame tepat sebelum onset berikutnya supaya serangan tidak bocor lebih awal / terulang
    let lim = N;
    if (v.oi < ons.length && ons[v.oi] - pre > c && ons[v.oi] - pre < c + N) lim = ons[v.oi] - pre - c;
    const taper = (i) => (lim >= N || i < lim - K) ? 1 : (i >= lim ? 0 : (lim - i) / K);
    let wpos = v.w;
    if (mode === 2) {
      // posisi tulis: sambung tepat di ujung isi valid (tanpa celah), tapi tidak mundur melewati pembaca
      const rdC = Math.min(v.w, Math.ceil(v.rd));
      wpos = Math.max(Math.min(v.w, v.vEnd - K), rdC);
      const oldEnd = Math.max(wpos + N, v.w - Hs + N);
      for (let q = 0; q < 2; q++) {
        const T = v.T[q];
        for (let i = 0; i < K; i++) T[(wpos + i) & mask] *= 1 - i / K;
        for (let i = K; i < oldEnd - wpos; i++) T[(wpos + i) & mask] = 0;
      }
      v.vEnd = 0;
    }
    for (let q = 0; q < 2; q++) {
      const src = fb[q], T = v.T[q];
      if (mode === 1) {
        for (let i = 0; i < N; i++) T[(wpos + i) & mask] = src[i] * S[i] * taper(i);
      } else if (mode === 2) {
        for (let i = 0; i < K; i++) T[(wpos + i) & mask] += src[i] * S[i] * taper(i) * (i / K);
        for (let i = K; i < N; i++) T[(wpos + i) & mask] = src[i] * S[i] * taper(i);
      } else {
        const add = N - Hs;
        for (let i = 0; i < add; i++) T[(wpos + i) & mask] += src[i] * W[i] * taper(i);
        for (let i = add; i < N; i++) T[(wpos + i) & mask] = src[i] * W[i] * taper(i);
      }
    }
    v.prev = c + fr; v.first = false;
    v.vEnd = Math.max(v.vEnd, wpos + Math.min(N, lim));
    v.w = wpos + Hs; v.cEnd = wpos + Hs;
    if (c >= maxC || v.nom >= maxC) { v.last = true; v.cEnd = wpos + N; }   // sample habis: sisa ekor ikut dimainkan (sudah memudar)
  }
  process(inputs, outputs) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0], n = oL.length;
    this.flush();
    if (!this.voices.length) { this.idle(); return true; }
    const g0 = this.volS; this.volS += (this.vol - this.volS) * 0.25; const g1 = this.volS;
    // Tahap A: perbarui laju baca tiap voice, lalu pastikan frame yang DIPERLUKAN blok ini sudah ada (wajib).
    // Satu frame WSOLA mahal (search korelasi silang). Kalau dihitung hanya saat dibutuhkan, banyak voice yang butuh
    // frame baru di blok yang sama menumpuk jadi satu lonjakan > 2,7 ms -> gresek. Jadi setelah yang wajib, frame
    // berikutnya disiapkan LEBIH AWAL (maks PF per blok, voice dengan sisa terpendek duluan). Hasil per voice tetap sama:
    // urutan dan isi frame tidak berubah, hanya waktu penghitungannya yang disebar.
    const vs = this.voices, nv = vs.length, HWf = this.HW;
    let made = 0;
    for (let vi = 0; vi < nv; vi++) {
      const v = vs[vi];
      if (v.gd) { const f = Math.min(1, Math.max(0, (currentTime - v.g0) / v.gd)); v.semis = v.gf + (v.gt - v.gf) * f; if (f >= 1) v.gd = 0; }   // slide: tinggi nada meluncur linear (dalam semiton)
      const rhoT = Math.pow(2, (v.semis + this.pitch) / 12) * this.bufRate / sampleRate;
      v.rho += (rhoT - v.rho) * 0.3;
      const hhA = v.rho > 1 ? Math.ceil(HWf / (0.85 / Math.min(v.rho, 8))) : 2;
      v.need = v.rd + v.rho * n + hhA + 4;
      while (!v.last && v.cEnd < v.need) { this.gen(v); made++; }
    }
    // prefetch: sisa jatah dipakai voice yang cadangan frame-nya kurang dari 2 hop (ring buffer 32768 jauh lebih besar dari itu)
    while (made < this.PF) {
      let bv = null, bm = 0;
      for (let vi = 0; vi < nv; vi++) {
        const v = vs[vi];
        if (v.last || this.restartNext(v)) continue;
        const m = v.cEnd - v.need - 2 * (v.N >> 2);
        if (m < bm) { bm = m; bv = v; }
      }
      if (!bv) break;
      this.gen(bv); made++;
    }
    for (let vi = this.voices.length - 1; vi >= 0; vi--) {
      const v = this.voices[vi], mask = v.size - 1, TL = v.T[0], TR = v.T[1];
      // (glide dan laju baca rho sudah diperbarui di tahap A, di atas)
      // rho > 1 (nada naik): baca dengan kernel sinc yang frekuensi potongnya 0.85/rho (pita transisi filter muat di bawah Nyquist keluaran) (low-pass sebelum decimate) -> tidak ada aliasing
      // rho <= 1: Hermite 4 titik (tidak perlu filter)
      const rr = v.rho, aa = rr > 1, fc = aa ? 0.85 / Math.min(rr, 8) : 1, hh = aa ? Math.ceil(this.HW / fc) : 2, sk = this.sinc, TRf = this.TR * fc, lim = this.HW * this.TR;
      // (frame yang diperlukan sudah disiapkan di tahap A)
      let dead = false;
      for (let i = 0; i < n; i++) {
        const pos = v.rd, i0 = Math.floor(pos);
        if (pos >= v.cEnd - hh - 1) { dead = true; break; }
        const f = pos - i0;
        let sl, sr;
        if (aa) {
          // kernel simetris: sisi kiri (t <= 0) dan kanan (t >= 1), jarak bertambah TRf per tap; bobot dari tabel (terdekat), gain pita lolos = fc
          sl = 0; sr = 0;
          let d = f * TRf, k;
          for (let t = 0; t >= 1 - hh; t--) { k = (d + 0.5) | 0; if (k >= lim) break; const w = sk[k], j = (i0 + t) & mask; sl += w * TL[j]; sr += w * TR[j]; d += TRf; }
          d = (1 - f) * TRf;
          for (let t = 1; t <= hh; t++) { k = (d + 0.5) | 0; if (k >= lim) break; const w = sk[k], j = (i0 + t) & mask; sl += w * TL[j]; sr += w * TR[j]; d += TRf; }
          sl *= fc; sr *= fc;
        } else {
          const jm = (i0 - 1) & mask, j0 = i0 & mask, j1 = (i0 + 1) & mask, j2 = (i0 + 2) & mask;
          let xm = TL[jm], x0 = TL[j0], x1 = TL[j1], x2 = TL[j2];
          sl = ((((x2 - xm) * 0.5 + (x0 - x1) * 1.5) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + (x1 - xm) * 0.5) * f + x0;
          xm = TR[jm]; x0 = TR[j0]; x1 = TR[j1]; x2 = TR[j2];
          sr = ((((x2 - xm) * 0.5 + (x0 - x1) * 1.5) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + (x1 - xm) * 0.5) * f + x0;
        }
        if (!v.rel) { if (v.env < 1) v.env = Math.min(1, v.env + v.atk); } else v.env *= v.relK;
        const g = v.env * v.vel * (g0 + (g1 - g0) * i / n);
        oL[i] += sl * g; oR[i] += sr * g;
        v.rd += v.rho;
      }
      if (dead || (v.rel && v.env < 1e-4)) { this.voices.splice(vi, 1); this.recycle(v); }
    }
    // limiter lembut: sampai 0.9 lurus (satu nada di volume normal tidak tersentuh), di atasnya melengkung halus menuju 1.0 (hanya akor yang keras)
    for (let i = 0; i < n; i++) {
      const l = oL[i];
      if (l > 0.9 || l < -0.9) oL[i] = Math.sign(l) * (0.9 + 0.1 * Math.tanh((Math.abs(l) - 0.9) / 0.1));
      if (oR !== oL) { const r = oR[i]; if (r > 0.9 || r < -0.9) oR[i] = Math.sign(r) * (0.9 + 0.1 * Math.tanh((Math.abs(r) - 0.9) / 0.1)); }
    }
    if (made < this.PF) this.idle();   // blok ini ringan: sempatkan merawat kolam buffer
    return true;
  }
}
registerProcessor('deriz-sampler', DerizSampler);
`;

const loaded = new WeakSet<BaseAudioContext>();

export class DerizSynth {
  private sent: AudioBuffer | null = null;
  private target: AudioNode | null = null;
  private constructor(readonly ctx: AudioContext, readonly node: AudioWorkletNode) {}

  static async create(ctx: AudioContext): Promise<DerizSynth> {
    if (!loaded.has(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      loaded.add(ctx);
    }
    return new DerizSynth(ctx, new AudioWorkletNode(ctx, 'deriz-sampler', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }));
  }

  routeTo(dest: AudioNode): void {   // sambungkan keluaran ke jalur track (pindah kalau track berbeda)
    if (this.target === dest) return;
    this.node.disconnect(); this.node.connect(dest); this.target = dest;
  }

  setBuffer(buf: AudioBuffer): void {   // kirim data sample sekali per buffer
    if (this.sent === buf) return;
    this.sent = buf;
    const ch: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(buf.getChannelData(c).slice());
    this.node.port.postMessage({ t: 'buf', ch, rate: buf.sampleRate }, ch.map(a => a.buffer));
  }

  // at (opsional) = waktu AudioContext tempat nada mulai / dilepas; kosong = sekarang
  // vel (opsional) = penguatan nada ini 0..1 (1 = tidak berubah)
  noteOn(id: number, semis: number, start: number, speed: number, pitch: number, vol: number, at = 0, vel = 1): void {
    this.node.port.postMessage({ t: 'on', id, semis, start, speed, pitch, vol, at, vel });
  }
  noteOff(id: number, at = 0): void { this.node.port.postMessage({ t: 'off', id, at }); }
  glide(id: number, semis: number, at: number, dur: number): void { this.node.port.postMessage({ t: 'glide', id, semis, at, dur }); }   // slide: meluncur ke `semis` mulai `at` selama `dur` detik
  releaseAll(): void { this.node.port.postMessage({ t: 'relall' }); }   // lepas semua nada (peluruhan halus) dan batalkan yang terjadwal
  params(speed: number, pitch: number, vol: number): void { this.node.port.postMessage({ t: 'p', speed, pitch, vol }); }

  dispose(): void {
    this.node.port.postMessage({ t: 'kill' });
    this.node.disconnect(); this.target = null;
  }
}
