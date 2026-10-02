// Sampler DERIZ: nada (tuts + knob Pitch) dan kecepatan (knob Speed) dikendalikan TERPISAH.
// Tuts apa pun tetap memutar sample dengan kecepatan yang sama; hanya knob Speed yang mengubah kecepatan.
//
// Algoritma (jalan di AudioWorklet, polifonik):
//   1. Time-stretch WSOLA (waveform similarity overlap-add): sample dibaca per frame (jendela Hann 40 ms, hop sintesis 50%).
//      Posisi tiap frame digeser sedikit (korelasi silang ternormalisasi) ke titik yang paling nyambung dengan frame sebelumnya,
//      supaya sambungan tidak terdengar. Laju maju di sample = Speed / rasioNada.
//   2. Pitch shift: hasil stretch dibaca ulang dengan interpolasi linear pada laju = rasioNada
//      (rasioNada = 2^((tuts - C4 + Pitch) / 12)). Kecepatan bersih di sample = Speed, tidak tergantung nada.
//
// Pesan ke prosesor: buf (data sample), on / off (nada), p (parameter live), kill (hentikan semua).

const WORKLET_SRC = `
class DerizSampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; this.len = 0; this.bufRate = sampleRate;
    this.N = 0; this.win = null;
    this.voices = [];
    this.speed = 1; this.pitch = 0; this.vol = 0.9; this.volS = 0.9;
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(m) {
    if (m.t === 'buf') {
      this.bufRate = m.rate;
      this.N = 2 * Math.round(0.02 * m.rate);
      this.ch = m.ch.map(a => {   // sample lebih pendek dari satu frame: tambah nol supaya aman dibaca
        if (a.length >= this.N) return a;
        const p = new Float32Array(this.N); p.set(a); return p;
      });
      this.len = this.ch[0].length;
      this.win = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N);
      this.voices = [];
    } else if (m.t === 'on') {
      this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol;
      this.start(m);
    } else if (m.t === 'off') {
      for (const v of this.voices) if (v.id === m.id) v.rel = true;
    } else if (m.t === 'p') {
      this.speed = m.speed; this.pitch = m.pitch; this.vol = m.vol;
    } else if (m.t === 'kill') {
      this.voices = [];
    }
  }
  start(m) {
    if (!this.ch) return;
    const size = 1 << 15;
    const rho = Math.pow(2, (m.semis + this.pitch) / 12) * this.bufRate / sampleRate;
    this.voices.push({
      id: m.id, semis: m.semis, nom: Math.max(0, m.start), prev: 0, first: true, last: false,
      w: 0, cEnd: 0, rd: 0, rho: rho, size: size,
      T: [new Float32Array(size), new Float32Array(size)],
      env: 0, rel: false, atk: 1 / (0.006 * sampleRate), relK: Math.exp(-1 / (0.04 * sampleRate))
    });
  }
  // satu frame WSOLA ke buffer T milik voice
  gen(v) {
    const N = this.N, Hs = N >> 1, L = this.len, x = this.ch[0], mask = v.size - 1, win = this.win;
    const P = Math.pow(2, (v.semis + this.pitch) / 12);
    const a = this.speed / P;                 // maju di sample per frame sintesis (satuan sample)
    const maxC = Math.max(0, L - N);
    let c;
    if (v.first) {
      c = Math.min(maxC, Math.round(v.nom));
    } else {
      v.nom += Hs * a;
      const c0 = Math.round(v.nom), tp = v.prev + Hs;
      c = Math.max(0, Math.min(maxC, c0));
      if (tp + Hs <= L) {
        // cari geseran terbaik: korelasi silang ternormalisasi antara awal kandidat dan lanjutan alami frame sebelumnya
        const W = N >> 2, lo = Math.max(0, c0 - W), hi = Math.min(maxC, c0 + W);
        let best = -1e30, bc = c;
        for (let cand = lo; cand <= hi; cand += 2) {
          let dot = 0, en = 1e-9;
          for (let j = 0; j < Hs; j += 2) { const s = x[cand + j]; dot += s * x[tp + j]; en += s * s; }
          const score = dot / Math.sqrt(en);
          if (score > best) { best = score; bc = cand; }
        }
        c = bc;
      }
    }
    const wpos = v.w;
    for (let q = 0; q < 2; q++) {
      const src = this.ch[q] || x, T = v.T[q];
      if (v.first) {
        for (let i = 0; i < Hs; i++) T[(wpos + i) & mask] = src[c + i];      // awal tegas: tanpa fade-in
        for (let i = Hs; i < N; i++) T[(wpos + i) & mask] = src[c + i] * win[i];
      } else {
        for (let i = 0; i < Hs; i++) T[(wpos + i) & mask] += src[c + i] * win[i];
        for (let i = Hs; i < N; i++) T[(wpos + i) & mask] = src[c + i] * win[i];
      }
    }
    v.prev = c; v.first = false;
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
      const need = v.rd + v.rho * n + 2;
      while (!v.last && v.cEnd < need) this.gen(v);
      let dead = false;
      for (let i = 0; i < n; i++) {
        const pos = v.rd, i0 = Math.floor(pos);
        if (pos >= v.cEnd - 1) { dead = true; break; }
        const fr = pos - i0, j0 = i0 & mask, j1 = (i0 + 1) & mask;
        const sl = TL[j0] + (TL[j1] - TL[j0]) * fr, sr = TR[j0] + (TR[j1] - TR[j0]) * fr;
        if (!v.rel) { if (v.env < 1) v.env = Math.min(1, v.env + v.atk); } else v.env *= v.relK;
        const g = v.env * (g0 + (g1 - g0) * i / n);
        oL[i] += sl * g; oR[i] += sr * g;
        v.rd += v.rho;
      }
      if (dead || (v.rel && v.env < 1e-4)) this.voices.splice(vi, 1);
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
