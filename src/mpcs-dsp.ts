// MPCS (Manual Pitch Correct Sample): inti DSP, murni (tanpa DOM / Web Audio) supaya bisa dites di Node dan nanti diganti WASM tanpa menyentuh UI.
// Alur ala Melodyne: analyze() sekali (pitch YIN + segmentasi nada), lalu render() ulang tiap kali nada diedit.
//   analyze : mono -> kurva pitch per frame (f0) + daftar nada
//   render  : geser tiap nada ke target dengan TD-PSOLA (formant ikut terjaga untuk geseran kecil-sedang), bagian tanpa pitch tidak disentuh

export interface PitchTrack {
  sr: number;
  hop: number;          // jarak antar frame, dalam sample pada sample rate asli
  f0: Float32Array;     // Hz per frame, 0 = tanpa pitch (napas, konsonan, jeda)
  rms: Float32Array;    // level per frame (0..1) untuk menggambar
}
export interface Note {
  s: number; e: number; // frame [s, e)
  midi: number;         // pitch asli (median), nomor MIDI pecahan
  target: number;       // pitch tujuan; selisih dari midi = geseran
}

const FMIN = 70, FMAX = 1000;
const midiOf = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export const hzOf = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export function toMono(chs: Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] / chs.length;
  return out;
}

function median(a: number[]): number {
  const b = a.slice().sort((p, q) => p - q), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

// ---------- analisis pitch (YIN, dikerjakan pada versi sample rate rendah supaya cepat) ----------
export function analyze(x: Float32Array, sr: number, onProgress?: (p: number) => void): { pt: PitchTrack; notes: Note[] } {
  const d = Math.max(1, Math.round(sr / 12000)), srA = sr / d, n = Math.floor(x.length / d);
  const xs = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < d; k++) a += x[i * d + k]; xs[i] = a / d; }   // rata-rata d sample = low-pass sederhana

  const hopA = 64, hop = hopA * d, W = 512;
  const tauMin = Math.max(2, Math.floor(srA / FMAX)), tauMax = Math.min(Math.ceil(srA / FMIN), W - 1);
  const frames = Math.max(1, Math.floor(n / hopA));
  const f0 = new Float32Array(frames), rms = new Float32Array(frames), conf = new Float32Array(frames);
  const dif = new Float32Array(tauMax + 2), cm = new Float32Array(tauMax + 2);

  for (let fi = 0; fi < frames; fi++) {
    const c = fi * hopA, st = c - (W >> 1);
    let e = 0;
    for (let j = 0; j < W; j++) { const v = xs[st + j] ?? 0; e += v * v; }
    rms[fi] = Math.sqrt(e / W);
    if (rms[fi] > 1e-4) {
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const a = xs[st + j] ?? 0, b = xs[st + j + tau] ?? 0, df = a - b; s += df * df; }
        dif[tau] = s;
      }
      let run = 0; cm[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) { run += dif[tau]; cm[tau] = run > 0 ? dif[tau] * tau / run : 1; }
      let best = -1;
      for (let tau = tauMin; tau < tauMax; tau++) {   // lembah pertama di bawah ambang, lalu turun sampai dasarnya
        if (cm[tau] < 0.15) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
      }
      if (best < 0) { let m = 1e9; for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < m) { m = cm[tau]; best = tau; } if (m > 0.3) best = -1; }
      if (best > 0) {
        const a = cm[best - 1], b = cm[best], g = cm[best + 1], den = a - 2 * b + g;   // interpolasi parabola: akurasi di bawah 1 sample
        const tau = den !== 0 ? best + 0.5 * (a - g) / den : best;
        f0[fi] = srA / tau; conf[fi] = 1 - cm[best];
      }
    }
    if (onProgress && fi % 200 === 0) onProgress(fi / frames);
  }

  // gerbang level: frame yang jauh lebih pelan dari bagian terkeras dianggap tanpa pitch
  const sorted = Array.from(rms).sort((a, b) => a - b), ref = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const gate = Math.max(0.002, ref * 0.04);
  for (let i = 0; i < frames; i++) if (rms[i] < gate) f0[i] = 0;

  // buang lompatan oktaf / pencilan terhadap median tetangga
  for (let i = 0; i < frames; i++) {
    if (!f0[i]) continue;
    const nb: number[] = [];
    for (let k = Math.max(0, i - 4); k <= Math.min(frames - 1, i + 4); k++) if (f0[k]) nb.push(f0[k]);
    if (nb.length >= 3) { const m = median(nb); if (f0[i] > m * 1.35 || f0[i] < m / 1.35) f0[i] = -1; }
  }
  for (let i = 0; i < frames; i++) if (f0[i] < 0) f0[i] = 0;

  // celah pendek (<= 3 frame) di antara dua bagian bernada ditambal supaya satu nada tidak terputus
  for (let i = 1; i < frames - 1; i++) {
    if (f0[i]) continue;
    let j = i; while (j < frames && !f0[j]) j++;
    if (j < frames && j - i <= 3 && f0[i - 1]) {
      const a = Math.log(f0[i - 1]), b = Math.log(f0[j]);
      if (Math.abs(a - b) < 0.12) for (let k = i; k < j; k++) f0[k] = Math.exp(a + (b - a) * (k - i + 1) / (j - i + 1));
    }
    i = j;
  }

  const pt: PitchTrack = { sr, hop, f0, rms };
  return { pt, notes: segment(pt) };
}

// ---------- segmentasi: bagian bernada -> daftar nada ----------
export function segment(pt: PitchTrack): Note[] {
  const { f0 } = pt, frames = f0.length, notes: Note[] = [];
  const mid = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mid[i] = f0[i] ? midiOf(f0[i]) : 0;
  const sm = new Float32Array(frames);   // median 5 frame supaya vibrato tidak memecah nada
  for (let i = 0; i < frames; i++) {
    if (!f0[i]) continue;
    const nb: number[] = []; for (let k = Math.max(0, i - 2); k <= Math.min(frames - 1, i + 2); k++) if (f0[k]) nb.push(mid[k]);
    sm[i] = median(nb);
  }
  const MINLEN = 6, THR = 0.8, CONFIRM = 5;
  let i = 0;
  while (i < frames) {
    if (!f0[i]) { i++; continue; }
    let j = i; while (j < frames && f0[j]) j++;
    if (j - i >= MINLEN) {
      const run: Array<{ s: number; e: number }> = [];
      let s = i, buf = [sm[i]], dev = 0;
      for (let k = i + 1; k < j; k++) {
        if (Math.abs(sm[k] - median(buf)) > THR) dev++; else dev = 0;
        if (dev >= CONFIRM) {
          const cut = k - dev + 1;
          run.push({ s, e: cut }); s = cut; buf = []; for (let q = cut; q <= k; q++) buf.push(sm[q]); dev = 0;
        } else buf.push(sm[k]);
      }
      run.push({ s, e: j });
      for (let r = 0; r < run.length; r++) {   // potongan terlalu pendek digabung ke tetangga
        if (run[r].e - run[r].s < MINLEN) {
          if (r > 0) { run[r - 1].e = run[r].e; run.splice(r, 1); r--; }
          else if (run.length > 1) { run[1].s = run[0].s; run.splice(0, 1); r--; }
        }
      }
      for (const q of run) {
        const m = median(Array.from({ length: q.e - q.s }, (_, t) => mid[q.s + t]));
        notes.push({ s: q.s, e: q.e, midi: m, target: m });
      }
    }
    i = j;
  }
  return notes;
}

// ---------- render: TD-PSOLA per nada ----------
export function render(x: Float32Array, pt: PitchTrack, notes: Note[], fadeMs = 12): Float32Array {
  const { sr, hop, f0 } = pt, n = x.length;
  const fade = Math.max(2, Math.round(sr * fadeMs / 1000)) & ~1, hf = fade / 2;
  const acc = new Float32Array(n), W = new Float32Array(n);
  const ramp = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));   // naik halus 0 -> 1

  for (const nt of notes) {
    const shift = nt.target - nt.midi;
    if (Math.abs(shift) < 0.01) continue;
    const ratio = 2 ** (shift / 12);
    const Ls = Math.round((nt.s - 0.5) * hop), Le = Math.round((nt.e - 0.5) * hop);
    const a = Math.max(0, Ls - hf), b = Math.min(n, Le + hf);
    if (b - a < 8) continue;

    const F = (t: number): number => {   // f0 pada sample t (interpolasi antar frame, ditahan di ujung nada)
      const fp = Math.min(nt.e - 1, Math.max(nt.s, t / hop)), i0 = Math.floor(fp), i1 = Math.min(nt.e - 1, i0 + 1), fr = fp - i0;
      const v0 = f0[i0] || f0[nt.s], v1 = f0[i1] || v0;
      return v0 + (v1 - v0) * fr;
    };

    // titik pitch analisis: puncak positif sekitar satu periode
    const marks: number[] = [];
    let T = sr / F(a), from = Math.max(0, a - Math.round(T)), to = Math.min(n, from + Math.round(T));
    let m = from; for (let j = from; j < to; j++) if (x[j] > x[m]) m = j;
    marks.push(m);
    while (m < b + T) {
      T = sr / F(m);
      const lo = Math.round(m + 0.8 * T), hi = Math.min(n - 1, Math.round(m + 1.2 * T));
      if (lo >= n - 1) break;
      let p = lo; for (let j = lo; j <= hi; j++) if (x[j] > x[p]) p = j;
      if (p <= m) p = Math.min(n - 1, Math.round(m + T));
      marks.push(p); m = p;
    }

    // sintesis: grain Hann 2 periode di sekitar titik analisis terdekat, ditaruh dengan jarak periode baru
    const y = new Float32Array(b - a);
    let ts = a, k = 0;
    while (ts < b) {
      while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
      const mk = marks[k], Ta = sr / F(mk), Ts = sr / (F(ts) * ratio), half = Math.max(2, Math.round(Ta)), gain = Ts / Ta, c = Math.round(ts);
      for (let j = -half; j <= half; j++) {
        const src = mk + j, idx = c + j - a;
        if (src < 0 || src >= n || idx < 0 || idx >= y.length) continue;
        y[idx] += x[src] * (0.5 + 0.5 * Math.cos(Math.PI * j / half)) * gain;
      }
      ts += Ts;
    }

    // campur ke keluaran: bobot naik/turun di batas nada. Dua nada bersebelahan saling melengkapi (jumlah bobot = 1)
    for (let t = a; t < b; t++) {
      const w = ramp((t - (Ls - hf)) / fade) * ramp(((Le + hf) - t) / fade);
      acc[t] += y[t - a] * w; W[t] += w;
    }
  }

  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) { const w = Math.min(1, W[t]); out[t] = x[t] * (1 - w) + acc[t]; }
  return out;
}

// ---------- ekspor WAV 16-bit mono ----------
export function encodeWav(x: Float32Array, sr: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + x.length * 2), dv = new DataView(buf);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return buf;
}
