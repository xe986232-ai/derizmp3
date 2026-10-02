// Sampler DERIZ: nada (tuts + knob Pitch) dan kecepatan (knob Speed) dikendalikan TERPISAH.
// Tuts apa pun tetap memutar sample dengan kecepatan yang sama; hanya knob Speed yang mengubah kecepatan.
//
// Algoritma (jalan di AudioWorklet, polifonik):
//   1. Time-stretch WSOLA (waveform similarity overlap-add) dengan overlap 75%, jendela Hann ternormalisasi.
//      Posisi tiap frame dicari (kasar -> halus, korelasi silang ternormalisasi pada mono)
//      yang paling nyambung dengan lanjutan alami frame sebelumnya, jadi sambungan tidak terdengar.
//      Panjang frame menyesuaikan nada (nada rendah = frame lebih panjang, supaya memuat beberapa periode gelombang).
//   2. Penjaga transien: awal ketukan / petikan (onset) dideteksi dari lonjakan energi. Saat stretch, onset TIDAK ikut
//      diulang atau melebar: frame dipotong tepat sebelum onset, lalu dimulai ulang tepat di onset dengan crossfade 2 ms.
//      Hasilnya serangan tetap tajam di kecepatan / nada berapa pun.
//   3. Pitch shift: hasil stretch dibaca ulang dengan interpolasi Hermite (kubik 4 titik) pada laju = rasioNada
//      (rasioNada = 2^((tuts - C4 + Pitch) / 12)). Kecepatan bersih di sample = Speed, tidak tergantung nada.
//   4. Limiter lembut di keluaran supaya akor (banyak nada sekaligus) tidak pecah.
//
// Pesan ke prosesor: buf (data sample), on / off (nada), p (parameter live), kill (hentikan semua).

const WORKLET_SRC = `
class DerizSampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; this.mono = null; this.len = 0; this.bufRate = sampleRate; this.ons = [];
    this.wins = new Map();
    this.voices = [];
    this.speed = 1; this.pitch = 0; this.vol = 0.9; this.volS = 0.9;
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(m) {
    if (m.t === 'buf') this.setBuf(m);
    else if (m.t === 'on') { this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol; this.start(m); }
    else if (m.t === 'off') { for (const v of this.voices) if (v.id === m.id) v.rel = true; }
    else if (m.t === 'p') { this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol; }
    else if (m.t === 'kill') this.voices = [];
  }
  setBuf(m) {
    this.bufRate = m.rate; this.wins.clear(); this.voices = [];
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
    const N = 4 * Math.max(8, Math.round(Math.min(0.07, Math.max(0.03, 0.04 / Math.sqrt(P0))) * rate / 4));
    const start = Math.max(0, m.start);
    let oi = 0; while (oi < this.ons.length && this.ons[oi] < start + 0.01 * rate) oi++;   // onset persis di awal = bagian dari frame pertama
    this.voices.push({
      id: m.id, semis: m.semis, N: N, nom: start, prev: 0, first: true, last: false, oi: oi,
      w: 0, cEnd: 0, vEnd: 0, rd: 0, rho: P0 * rate / sampleRate, size: size,
      T: [new Float32Array(size), new Float32Array(size)],
      env: 0, rel: false, atk: 1 / (0.002 * sampleRate), relK: Math.exp(-1 / (0.04 * sampleRate))
    });
  }
  // cari posisi frame terbaik di sekitar c0: kasar (langkah 4) lalu halus (langkah 1), korelasi silang ternormalisasi
  search(c0, tp, N, Hs) {
    const x = this.mono, L = this.len, maxC = L - N, M = 2 * Hs, W = Hs;
    const cc = Math.max(0, Math.min(maxC, c0));
    if (tp + M > L) return cc;
    const lo = Math.max(0, c0 - W), hi = Math.min(maxC, c0 + W);
    const score = (cand, step) => {
      let dot = 0, en = 1e-9;
      for (let j = 0; j < M; j += step) { const s = x[cand + j]; dot += s * x[tp + j]; en += s * s; }
      return dot / Math.sqrt(en);
    };
    let best = -1e30, bc = cc;
    for (let cand = lo; cand <= hi; cand += 4) { const sc = score(cand, 4); if (sc > best) { best = sc; bc = cand; } }
    best = -1e30; let fc = bc;
    for (let cand = Math.max(lo, bc - 3); cand <= Math.min(hi, bc + 3); cand++) { const sc = score(cand, 2); if (sc > best) { best = sc; fc = cand; } }
    return fc;
  }
  // satu frame WSOLA ke buffer T milik voice
  gen(v) {
    const N = v.N, Hs = N >> 2, L = this.len, ons = this.ons, mask = v.size - 1;
    const rate = this.bufRate, pre = Math.round(0.0015 * rate), K = Math.round(0.002 * rate);
    const { W, S } = this.getWin(N);
    const P = Math.pow(2, (v.semis + this.pitch) / 12), a = this.speed / P;   // a = maju di sample per frame sintesis (satuan sample)
    const maxC = L - N;
    let c, mode = 0;   // 0 normal, 1 frame pertama, 2 mulai ulang di onset
    if (v.first) { c = Math.min(maxC, Math.round(v.nom)); mode = 1; }
    else {
      v.nom += Hs * a;
      while (v.oi + 1 < ons.length && ons[v.oi + 1] - pre <= v.nom) v.oi++;   // onset yang terlewati sekaligus: ambil yang terakhir
      if (v.oi < ons.length && ons[v.oi] - pre <= v.nom) {
        c = Math.max(0, Math.min(maxC, ons[v.oi] - pre)); v.nom = c; v.oi++; mode = 2;
      } else {
        c = this.search(Math.round(v.nom), v.prev + Hs, N, Hs);
        if (v.oi < ons.length) c = Math.min(c, ons[v.oi] - pre - 1);
        c = Math.max(0, c);
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
      const src = this.ch[q] || this.ch[0], T = v.T[q];
      if (mode === 1) {
        for (let i = 0; i < N; i++) T[(wpos + i) & mask] = src[c + i] * S[i] * taper(i);
      } else if (mode === 2) {
        for (let i = 0; i < K; i++) T[(wpos + i) & mask] += src[c + i] * S[i] * taper(i) * (i / K);
        for (let i = K; i < N; i++) T[(wpos + i) & mask] = src[c + i] * S[i] * taper(i);
      } else {
        const add = N - Hs;
        for (let i = 0; i < add; i++) T[(wpos + i) & mask] += src[c + i] * W[i] * taper(i);
        for (let i = add; i < N; i++) T[(wpos + i) & mask] = src[c + i] * W[i] * taper(i);
      }
    }
    v.prev = c; v.first = false;
    v.vEnd = Math.max(v.vEnd, wpos + Math.min(N, lim));
    v.w = wpos + Hs; v.cEnd = wpos + Hs;
    if (c >= maxC || v.nom >= maxC) { v.last = true; v.cEnd = wpos + N; }   // sample habis: sisa ekor ikut dimainkan (sudah memudar)
  }
  process(inputs, outputs) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0], n = oL.length;
    if (!this.voices.length) return true;
    const g0 = this.volS; this.volS += (this.vol - this.volS) * 0.25; const g1 = this.volS;
    for (let vi = this.voices.length - 1; vi >= 0; vi--) {
      const v = this.voices[vi], mask = v.size - 1, TL = v.T[0], TR = v.T[1];
      const rhoT = Math.pow(2, (v.semis + this.pitch) / 12) * this.bufRate / sampleRate;
      v.rho += (rhoT - v.rho) * 0.3;
      const need = v.rd + v.rho * n + 4;
      while (!v.last && v.cEnd < need) this.gen(v);
      let dead = false;
      for (let i = 0; i < n; i++) {
        const pos = v.rd, i0 = Math.floor(pos);
        if (pos >= v.cEnd - 3) { dead = true; break; }
        const f = pos - i0, jm = (i0 - 1) & mask, j0 = i0 & mask, j1 = (i0 + 1) & mask, j2 = (i0 + 2) & mask;
        // interpolasi Hermite 4 titik
        let xm = TL[jm], x0 = TL[j0], x1 = TL[j1], x2 = TL[j2];
        const sl = ((((x2 - xm) * 0.5 + (x0 - x1) * 1.5) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + (x1 - xm) * 0.5) * f + x0;
        xm = TR[jm]; x0 = TR[j0]; x1 = TR[j1]; x2 = TR[j2];
        const sr = ((((x2 - xm) * 0.5 + (x0 - x1) * 1.5) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + (x1 - xm) * 0.5) * f + x0;
        if (!v.rel) { if (v.env < 1) v.env = Math.min(1, v.env + v.atk); } else v.env *= v.relK;
        const g = v.env * (g0 + (g1 - g0) * i / n);
        oL[i] += sl * g; oR[i] += sr * g;
        v.rd += v.rho;
      }
      if (dead || (v.rel && v.env < 1e-4)) this.voices.splice(vi, 1);
    }
    // limiter lembut: sampai 0.9 lurus (satu nada di volume normal tidak tersentuh), di atasnya melengkung halus menuju 1.0 (hanya akor yang keras)
    for (let i = 0; i < n; i++) {
      const l = oL[i];
      if (l > 0.9 || l < -0.9) oL[i] = Math.sign(l) * (0.9 + 0.1 * Math.tanh((Math.abs(l) - 0.9) / 0.1));
      if (oR !== oL) { const r = oR[i]; if (r > 0.9 || r < -0.9) oR[i] = Math.sign(r) * (0.9 + 0.1 * Math.tanh((Math.abs(r) - 0.9) / 0.1)); }
    }
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

  noteOn(id: number, semis: number, start: number, speed: number, pitch: number, vol: number): void {
    this.node.port.postMessage({ t: 'on', id, semis, start, speed, pitch, vol });
  }
  noteOff(id: number): void { this.node.port.postMessage({ t: 'off', id }); }
  params(speed: number, pitch: number, vol: number): void { this.node.port.postMessage({ t: 'p', speed, pitch, vol }); }

  dispose(): void {
    this.node.port.postMessage({ t: 'kill' });
    this.node.disconnect(); this.target = null;
  }
}
