// MPCS (Manual Pitch Correct Sample): inti DSP, murni (tanpa DOM / Web Audio) supaya bisa dites di Node dan nanti diganti WASM tanpa menyentuh UI.
// Alur ala Melodyne: analyze() sekali (pitch pYIN + segmentasi nada), lalu render() ulang tiap kali nada diedit.
//   analyze : mono -> kurva pitch per frame (f0) + daftar nada
//             - pYIN: tiap frame menghasilkan beberapa kandidat F0 (bukan satu ambang tetap), HMM + Viterbi memilih jalur yang mulus
//             - segmentasi dengan hysteresis (Schmitt trigger) + envelope energi pendek untuk nada berulang
//   render  : nada yang bersambung dirender sebagai satu rangkaian TD-PSOLA dengan rasio geser yang berubah mulus di zona transisi
//             (tidak ada "tangga" di perbatasan nada); titik pitch dipilih dengan pruning + korelasi lokal, grain ditaruh fraksional
// Acuan: Mauch & Dixon (pYIN), Colotte & Laprie (pitch marking PSOLA), Smuts (hysteresis, metrik evaluasi), DAFx-2023 (dynamic pitch warping), alur transisi ala Melodyne.

export interface PitchTrack {
  sr: number;
  hop: number;          // jarak antar frame, dalam sample pada sample rate asli
  f0: Float32Array;     // Hz per frame, 0 = tanpa pitch (napas, konsonan, jeda)
  rms: Float32Array;    // level per frame (0..1) untuk menggambar
  env?: Float32Array;   // envelope energi pendek (~24 ms) per frame, untuk mendeteksi nada berulang (lembah energi)
}
export interface Note {
  s: number; e: number; // frame [s, e)
  midi: number;         // pitch asli (median), nomor MIDI pecahan
  target: number;       // pitch tujuan; selisih dari midi = geseran
  drift?: number;       // 0..1: seberapa banyak variasi lambat (drift) pitch asli dipertahankan; 1 = asli (default), 0 = diratakan ke target
  vib?: number;         // 0..1: seberapa banyak vibrato / variasi cepat dipertahankan; 1 = asli (default), 0 = vibrato dibuang
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

// ---------- analisis pitch: pYIN (kandidat banyak + HMM Viterbi), dikerjakan pada sample rate rendah supaya cepat ----------
const BIN_CENTS = 25;                                                       // resolusi state pitch HMM
const NBIN = Math.ceil(1200 * Math.log2(FMAX / FMIN) / BIN_CENTS) + 1;
const binHz = (b: number): number => FMIN * 2 ** (b * BIN_CENTS / 1200);
const binOf = (hz: number): number => 1200 * Math.log2(hz / FMIN) / BIN_CENTS;
const MAXC = 6;                                                             // kandidat F0 per frame
const JUMP = 6;                                                             // lompatan pitch maksimum antar frame (bin), ~1.5 semiton per ~5 ms
const NTH = 32;                                                             // jumlah ambang pYIN

export function analyze(x: Float32Array, sr: number, onProgress?: (p: number) => void): { pt: PitchTrack; notes: Note[] } {
  const d = Math.max(1, Math.round(sr / 12000)), srA = sr / d, n = Math.floor(x.length / d);
  const xs = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < d; k++) a += x[i * d + k]; xs[i] = a / d; }   // rata-rata d sample = low-pass sederhana

  const hopA = 64, hop = hopA * d, W = 384;
  const tauMin = Math.max(2, Math.floor(srA / FMAX)), tauMax = Math.min(Math.ceil(srA / FMIN), W - 1);
  const frames = Math.max(1, Math.floor(n / hopA));
  const f0 = new Float32Array(frames), rms = new Float32Array(frames);

  // 1) level tiap frame
  for (let fi = 0; fi < frames; fi++) {
    const st = fi * hopA - (W >> 1);
    let e = 0;
    for (let j = 0; j < W; j++) { const v = xs[st + j] ?? 0; e += v * v; }
    rms[fi] = Math.sqrt(e / W);
  }
  const env = new Float32Array(frames), EW = Math.max(16, Math.round(0.024 * srA));
  for (let fi = 0; fi < frames; fi++) { const st = fi * hopA - (EW >> 1); let e = 0; for (let j = 0; j < EW; j++) { const v = xs[st + j] ?? 0; e += v * v; } env[fi] = Math.sqrt(e / EW); }
  const sorted = Array.from(rms).sort((a, b) => a - b), ref = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const gate = Math.max(0.002, ref * 0.04);

  // ambang pYIN: bobot Beta(2,18), kandidat = lembah pertama di bawah tiap ambang
  const TH = new Float64Array(NTH), WT = new Float64Array(NTH);
  { let sum = 0; for (let k = 0; k < NTH; k++) { const s = (k + 0.5) / NTH; TH[k] = s; WT[k] = s * (1 - s) ** 17; sum += WT[k]; } for (let k = 0; k < NTH; k++) WT[k] /= sum; }

  // 2) kandidat F0 + peluang bersuara tiap frame
  const candBin = new Float32Array(frames * MAXC), candP = new Float32Array(frames * MAXC), nCand = new Uint8Array(frames), pvA = new Float32Array(frames);
  const dif = new Float32Array(tauMax + 2), cm = new Float32Array(tauMax + 2);
  const cTau = new Float64Array(64), cCm = new Float64Array(64), pr = new Float64Array(64), used = new Uint8Array(64);

  for (let fi = 0; fi < frames; fi++) {
    if (rms[fi] > 1e-4) {
      const st = fi * hopA - (W >> 1);
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const a = xs[st + j] ?? 0, b = xs[st + j + tau] ?? 0, df = a - b; s += df * df; }
        dif[tau] = s;
      }
      let run = 0; cm[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) { run += dif[tau]; cm[tau] = run > 0 ? dif[tau] * tau / run : 1; }

      let nc = 0, minCm = 1;
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (cm[tau] < minCm) minCm = cm[tau];
        if (cm[tau] < 0.75 && cm[tau] < cm[tau - 1] && cm[tau] <= cm[tau + 1] && nc < 64) {
          const a = cm[tau - 1], b = cm[tau], g = cm[tau + 1], den = a - 2 * b + g;
          const dl = den > 0 ? Math.max(-1, Math.min(1, 0.5 * (a - g) / den)) : 0;   // interpolasi parabola: akurasi di bawah 1 sample
          cTau[nc] = tau + dl; cCm[nc] = b; pr[nc] = 0; used[nc] = 0; nc++;
        }
      }
      let pv = 0;
      if (nc > 0) {
        let gi = 0; for (let i = 1; i < nc; i++) if (cCm[i] < cCm[gi]) gi = i;
        for (let k = 0; k < NTH; k++) {
          let hit = -1; for (let i = 0; i < nc; i++) if (cCm[i] < TH[k]) { hit = i; break; }   // lembah pertama (tau terkecil) di bawah ambang
          if (hit >= 0) { pr[hit] += WT[k]; pv += WT[k]; } else { pr[gi] += WT[k] * 0.01; pv += WT[k] * 0.01; }
        }
        for (let i = 0; i < nc; i++) pr[i] += 0.02 * (1 - cCm[i]) ** 4;   // bukti lunak: lembah yang dalam tetap berbobot walau di atas ambang (kasus glide)
        const m = Math.min(MAXC, nc);
        for (let q = 0; q < m; q++) {
          let bi = -1; for (let i = 0; i < nc; i++) if (!used[i] && (bi < 0 || pr[i] > pr[bi])) bi = i;
          used[bi] = 1; candBin[fi * MAXC + q] = binOf(srA / cTau[bi]); candP[fi * MAXC + q] = pr[bi];
        }
        nCand[fi] = m;
      }
      // frame glide / transisi: lembah dangkal (cm 0.3-0.5) tetap bukti periodik, asal energinya cukup. Tanpa ini glide dibuang jadi "tanpa suara".
      const soft = Math.max(0, Math.min(1, (0.75 - minCm) / 0.45)) * Math.max(0, Math.min(1, rms[fi] / (0.1 * ref + 1e-9)));
      pvA[fi] = Math.min(0.98, Math.max(Math.min(1, pv), 0.85 * soft));
    }
    if (onProgress && fi % 200 === 0) onProgress(0.9 * fi / frames);
  }

  // 3) HMM: state = NBIN bin pitch (25 cent) + 1 state tanpa suara, Viterbi
  const lStay = Math.log(0.99), lSwitch = Math.log(0.01), lToV = Math.log(0.01 / NBIN);
  const trW = new Float64Array(JUMP + 1);
  for (let k = 0; k <= JUMP; k++) trW[k] = Math.log(0.99 * (JUMP + 1 - k) / ((JUMP + 1) * (JUMP + 1)));
  const bp = new Uint8Array(frames * NBIN), uBack = new Int16Array(frames);
  let dv: Float64Array = new Float64Array(NBIN), nv: Float64Array = new Float64Array(NBIN), du = 0;
  const G = new Float64Array(NBIN), SQ2PI = Math.sqrt(2 * Math.PI);
  for (let fi = 0; fi < frames; fi++) {
    const pe = pvA[fi], nc = nCand[fi];
    G.fill(0);
    let ps = 0; for (let q = 0; q < nc; q++) ps += candP[fi * MAXC + q];
    if (nc > 0 && ps > 0) {
      for (let q = 0; q < nc; q++) {
        const bc = candBin[fi * MAXC + q], pw = candP[fi * MAXC + q] / ps / SQ2PI;
        for (let b = Math.max(0, Math.floor(bc) - 3); b <= Math.min(NBIN - 1, Math.ceil(bc) + 3); b++) G[b] += pw * Math.exp(-0.5 * (b - bc) * (b - bc));
      }
    } else G.fill(1 / NBIN);
    const lEu = Math.log(1 - pe + 1e-6);
    // energi tinggi = penyanyi masih bersuara: biaya pindah ke "tanpa suara" dinaikkan (glide / ujung nada tidak gampang kebuang)
    const hot = Math.max(0, Math.min(1, rms[fi] / (0.15 * ref + 1e-9))), lSw = lSwitch - 1.6 * hot;
    for (let b = 0; b < NBIN; b++) G[b] = Math.min(1, 2.5 * G[b]);
    let bestV = -Infinity, bestVi = 0;
    if (fi === 0) {
      for (let b = 0; b < NBIN; b++) { dv[b] = Math.log(pe * (0.9 * G[b] + 0.1 / NBIN) + 1e-12) - Math.log(2 * NBIN); }
      du = lEu - Math.log(2);
    } else {
      for (let b = 0; b < NBIN; b++) if (dv[b] > bestV) { bestV = dv[b]; bestVi = b; }
      const fromU = du + lToV;
      for (let b = 0; b < NBIN; b++) {
        let best = fromU, code = 254;
        for (let dd = -JUMP; dd <= JUMP; dd++) {
          const pb = b - dd; if (pb < 0 || pb >= NBIN) continue;
          const v = dv[pb] + trW[dd < 0 ? -dd : dd];
          if (v > best) { best = v; code = dd + JUMP; }
        }
        nv[b] = best + Math.log(pe * (0.9 * G[b] + 0.1 / NBIN) + 1e-12);
        bp[fi * NBIN + b] = code;
      }
      const stayU = du + lStay, fromV = bestV + lSw;
      if (stayU >= fromV) { uBack[fi] = -1; du = stayU + lEu; } else { uBack[fi] = bestVi; du = fromV + lEu; }
      const t = dv; dv = nv; nv = t;
      let mx = du; for (let b = 0; b < NBIN; b++) if (dv[b] > mx) mx = dv[b];
      du -= mx; for (let b = 0; b < NBIN; b++) dv[b] -= mx;
    }
    if (onProgress && fi % 400 === 0) onProgress(0.9 + 0.1 * fi / frames);
  }
  // telusur balik
  let state = NBIN, bestEnd = du;   // NBIN = state tanpa suara
  for (let b = 0; b < NBIN; b++) if (dv[b] > bestEnd) { bestEnd = dv[b]; state = b; }
  const pathBin = new Int16Array(frames);
  for (let fi = frames - 1; fi >= 0; fi--) {
    pathBin[fi] = state === NBIN ? -1 : state;
    if (fi === 0) break;
    if (state === NBIN) state = uBack[fi] >= 0 ? uBack[fi] : NBIN;
    else { const code = bp[fi * NBIN + state]; state = code === 254 ? NBIN : state - (code - JUMP); }
  }
  for (let fi = 0; fi < frames; fi++) {
    const b = pathBin[fi]; if (b < 0) continue;
    let hz = binHz(b), bd = 2.01;   // haluskan ke kandidat terdekat (resolusi lebih halus dari bin 25 cent)
    for (let q = 0; q < nCand[fi]; q++) { const dd = Math.abs(candBin[fi * MAXC + q] - b); if (dd < bd) { bd = dd; hz = binHz(candBin[fi * MAXC + q]); } }
    f0[fi] = hz;
  }

  // gerbang level: frame yang jauh lebih pelan dari bagian terkeras dianggap tanpa pitch
  for (let i = 0; i < frames; i++) if (rms[i] < gate) f0[i] = 0;

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

  const pt: PitchTrack = { sr, hop, f0, rms, env };
  return { pt, notes: segment(pt) };
}

// ---------- segmentasi: bagian bernada -> daftar nada ----------
const MINLEN = 6;

function trimmedMidi(mid: Float32Array, s: number, e: number): number {
  const len = e - s, m = len >= 10 ? Math.floor(len * 0.2) : 0;   // bagian tengah saja: ujung nada sering berisi glide dari / ke nada lain
  const v: number[] = [];
  for (let t = s + m; t < e - m; t++) if (mid[t] > 0) v.push(mid[t]);
  if (!v.length) for (let t = s; t < e; t++) if (mid[t] > 0) v.push(mid[t]);
  return v.length ? median(v) : 0;
}

export function segment(pt: PitchTrack): Note[] {
  const { f0, rms } = pt, frames = f0.length, notes: Note[] = [];
  const mid = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mid[i] = f0[i] ? midiOf(f0[i]) : 0;
  const sm = new Float32Array(frames);   // median 5 frame supaya vibrato tidak memecah nada
  for (let i = 0; i < frames; i++) {
    if (!f0[i]) continue;
    const nb: number[] = []; for (let k = Math.max(0, i - 2); k <= Math.min(frames - 1, i + 2); k++) if (f0[k]) nb.push(mid[k]);
    sm[i] = median(nb);
  }
  const env = pt.env ?? rms;   // envelope energi pendek untuk mendeteksi nada berulang

  const HI = 0.75, LO = 0.35, CONFIRM = 4;   // hysteresis (Schmitt): masuk > HI, batal hanya jika kembali < LO; di antaranya keadaan ditahan
  let i = 0;
  while (i < frames) {
    if (!f0[i]) { i++; continue; }
    let j = i; while (j < frames && f0[j]) j++;
    if (j - i >= MINLEN) {
      let run: Array<{ s: number; e: number }> = [];
      let s = i, buf = [sm[i]], cand = -1, cnt = 0;
      for (let k = i + 1; k < j; k++) {
        const dev = Math.abs(sm[k] - median(buf.length > 160 ? buf.slice(-160) : buf));
        if (dev > HI) { if (cand < 0) cand = k; cnt++; } else if (dev < LO) { cand = -1; cnt = 0; }
        if (cnt >= CONFIRM) {
          run.push({ s, e: cand }); s = cand; buf = []; for (let q = cand; q <= k; q++) buf.push(sm[q]); cand = -1; cnt = 0;
        } else buf.push(sm[k]);
      }
      run.push({ s, e: j });
      for (let r = 0; r < run.length; r++) {   // potongan terlalu pendek digabung ke tetangga
        if (run[r].e - run[r].s < MINLEN) {
          if (r > 0) { run[r - 1].e = run[r].e; run.splice(r, 1); r--; }
          else if (run.length > 1) { run[1].s = run[0].s; run.splice(0, 1); r--; }
        }
      }
      // nada berulang di pitch yang sama: lembah energi yang dalam di tengah satu potongan = artikulasi ulang
      const split: Array<{ s: number; e: number }> = [];
      for (const q of run) {
        let st = q.s;
        for (let m = q.s + MINLEN; m < q.e - MINLEN; m++) {
          let isMin = true; for (let u = m - 3; u <= m + 3; u++) if (env[u] < env[m]) { isMin = false; break; }
          if (!isMin) continue;
          let lm = 0, rm = 0;
          for (let u = Math.max(q.s, m - 40); u < m; u++) lm = Math.max(lm, env[u]);
          for (let u = m + 1; u < Math.min(q.e, m + 41); u++) rm = Math.max(rm, env[u]);
          if (m - st >= MINLEN && env[m] < 0.5 * Math.min(lm, rm)) { split.push({ s: st, e: m }); st = m; m += MINLEN; }
        }
        split.push({ s: st, e: q.e });
      }
      run = split;
      for (const q of run) {
        const m = trimmedMidi(mid, q.s, q.e);
        if (m > 0) notes.push({ s: q.s, e: q.e, midi: m, target: m });
      }
    }
    i = j;
  }
  return notes;
}

// ---------- snap ke semiton dengan hysteresis ----------
// Nada yang bersambung dengan nada sebelumnya menahan target lama sampai pitch-nya melewati batas + margin, jadi pitch yang bergetar di
// perbatasan dua semiton tidak membuat target loncat-loncat.
export function snapTargets(notes: Note[], hyst = 0.15, gapFrames = 12): void {
  const order = notes.map((_, i) => i).sort((p, q) => notes[p].s - notes[q].s);
  let prev: Note | null = null;
  for (const idx of order) {
    const nt = notes[idx];
    let t = Math.round(nt.midi);
    if (prev && nt.s - prev.e <= gapFrames && Math.abs(nt.midi - prev.target) < 0.5 + hyst) t = prev.target;
    nt.target = t; prev = nt;
  }
}

// ---------- render: TD-PSOLA, satu rangkaian per kelompok nada bersambung ----------
function cubic(x: Float32Array, p: number): number {
  const i = Math.floor(p), f = p - i;
  if (i < 1 || i >= x.length - 2) return 0;
  const y0 = x[i - 1], y1 = x[i], y2 = x[i + 1], y3 = x[i + 2];
  return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
}

function boxSmooth(a: Float64Array, w: number): Float64Array {
  const n = a.length, out = new Float64Array(n), pre = new Float64Array(n + 1), h = w >> 1;
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  for (let i = 0; i < n; i++) { const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1); out[i] = (pre[hi] - pre[lo]) / (hi - lo); }
  return out;
}

// titik pitch (epoch): puncak dengan polaritas dominan; kandidat yang jaraknya tidak konsisten dengan periode dibuang,
// sisanya dipilih lewat korelasi lokal dengan siklus sebelumnya, lalu dihaluskan ke posisi pecahan (parabola)
function epochMarks(x: Float32Array, a: number, b: number, F: (t: number) => number, sr: number): number[] {
  const n = x.length;
  let pos = 0, neg = 0;
  for (let t = a; t < b;) {
    const T = Math.max(8, Math.round(sr / F(t))), e = Math.min(b, t + T);
    let mx = 0, mn = 0; for (let j = t; j < e; j++) { if (x[j] > mx) mx = x[j]; if (x[j] < mn) mn = x[j]; }
    pos += mx; neg -= mn; t += T;
  }
  const pol = neg > pos * 1.1 ? -1 : 1;
  const v = (i: number): number => pol * (x[i] ?? 0);
  const frac = (c: number): number => { const y0 = v(c - 1), y1 = v(c), y2 = v(c + 1), den = y0 - 2 * y1 + y2; return den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0; };
  const ncc = (p: number, q: number, L: number): number => {
    let sp = 0, sq = 0, sc = 0;
    for (let u = -L; u <= L; u++) { const A = v(p + u), B = v(q + u); sc += A * B; sp += A * A; sq += B * B; }
    return sc / Math.sqrt(sp * sq + 1e-12);
  };

  const marks: number[] = [];
  let T = sr / F(a), from = Math.max(0, a - Math.round(T)), to = Math.min(n, from + Math.round(T));
  let m = from; for (let j = from; j < to; j++) if (v(j) > v(m)) m = j;
  marks.push(m + frac(m));
  for (let guard = 0; m < b + T && guard < 4e6; guard++) {
    T = sr / F(m);
    const exp = m + T, lo = Math.max(m + 1, Math.ceil(m + 0.75 * T)), hi = Math.min(n - 2, Math.floor(m + 1.25 * T));
    if (lo >= n - 2) break;
    let cand: number[] = [];
    for (let j = lo; j <= hi; j++) if (v(j) > v(j - 1) && v(j) >= v(j + 1)) cand.push(j);
    if (!cand.length) { let p = lo; for (let j = lo; j <= hi; j++) if (v(j) > v(p)) p = j; cand.push(hi >= lo ? p : Math.round(exp)); }
    if (cand.length > 3) cand = cand.sort((p, q) => v(q) - v(p)).slice(0, 3);
    const L = Math.max(4, Math.round(T * 0.5));
    let best = cand[0], bs = -Infinity;
    for (const c of cand) { const sc = ncc(m, c, L) - 0.8 * Math.abs(c - exp) / T; if (sc > bs) { bs = sc; best = c; } }
    if (Math.abs(best - exp) > 0.3 * T) best = Math.min(n - 2, Math.round(exp));   // jarak tidak konsisten dengan periode: pakai posisi yang diharapkan
    if (best <= m) best = Math.min(n - 2, m + Math.max(1, Math.round(T)));
    m = best; marks.push(m + frac(m));
  }
  return marks;
}

export function render(x: Float32Array, pt: PitchTrack, notes: Note[], fadeMs = 12, transMs = 45): Float32Array {
  const { sr, hop, f0 } = pt, n = x.length;
  const fade = Math.max(2, Math.round(sr * fadeMs / 1000)) & ~1, hf = fade / 2;
  const acc = new Float32Array(n), W = new Float32Array(n);
  const ramp = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));   // naik halus 0 -> 1

  // nada yang bersambung (celah <= 3 frame) dirender sebagai satu rangkaian supaya geseran bisa berubah mulus di perbatasan
  const sorted = notes.slice().sort((p, q) => p.s - q.s), groups: Note[][] = [];
  for (const nt of sorted) { const g = groups[groups.length - 1]; if (g && nt.s - g[g.length - 1].e <= 3) g.push(nt); else groups.push([nt]); }
  const Z = Math.max(1, Math.round(transMs / 1000 * sr / hop)) | 1, zh = (Z - 1) / 2;   // lebar zona transisi (frame, ganjil)
  const kern = new Float64Array(Z); { let ks = 0; for (let q = -zh; q <= zh; q++) { kern[q + zh] = 0.5 + 0.5 * Math.cos(Math.PI * q / (zh + 1)); ks += kern[q + zh]; } for (let q = 0; q < Z; q++) kern[q] /= ks; }
  const DW = Math.max(3, Math.round(0.22 * sr / hop)) | 1;                               // jendela pemisah drift (lambat) dan vibrato (cepat)

  for (const g of groups) {
    const gs = g[0].s, ge = g[g.length - 1].e, L = ge - gs;
    if (L < 2) continue;
    // 1) kurva geseran: bagian tetap per nada, dihaluskan di zona transisi; ditambah koreksi drift / vibrato per nada
    const step = new Float64Array(L), has = new Uint8Array(L), extra = new Float64Array(L);
    for (const nt of g) {
      for (let f = nt.s; f < nt.e; f++) { step[f - gs] = nt.target - nt.midi; has[f - gs] = 1; }
      const dk = nt.drift ?? 1, vk = nt.vib ?? 1;
      if (dk !== 1 || vk !== 1) {
        const len = nt.e - nt.s, dev = new Float64Array(len);
        for (let q = 0; q < len; q++) { const hz = f0[nt.s + q]; dev[q] = hz ? Math.max(-3, Math.min(3, midiOf(hz) - nt.midi)) : (q ? dev[q - 1] : 0); }
        const slow = boxSmooth(dev, DW);
        for (let q = 0; q < len; q++) extra[nt.s + q - gs] = (dk - 1) * slow[q] + (vk - 1) * (dev[q] - slow[q]);
      }
    }
    for (let f = 1; f < L; f++) if (!has[f]) step[f] = step[f - 1];
    const sh = new Float64Array(L);
    let peak = 0;
    for (let f = 0; f < L; f++) {
      let v = 0; for (let q = -zh; q <= zh; q++) v += kern[q + zh] * step[Math.min(L - 1, Math.max(0, f + q))];
      sh[f] = v + extra[f]; peak = Math.max(peak, Math.abs(sh[f]));
    }
    if (peak < 0.005) continue;

    // 2) f0 di grup: frame tanpa pitch diisi interpolasi (log) supaya F(t) selalu ada
    const fg = new Float64Array(L); let any = false;
    for (let f = 0; f < L; f++) { fg[f] = f0[gs + f] || 0; if (fg[f]) any = true; }
    if (!any) continue;
    for (let f = 0; f < L; f++) {
      if (fg[f]) continue;
      let p = f - 1; while (p >= 0 && !fg[p]) p--;
      let q = f + 1; while (q < L && !fg[q]) q++;
      if (p >= 0 && q < L) fg[f] = Math.exp(Math.log(fg[p]) + (Math.log(fg[q]) - Math.log(fg[p])) * (f - p) / (q - p));
      else fg[f] = p >= 0 ? fg[p] : fg[q];
    }
    const at = (arr: Float64Array, t: number): number => {
      const fp = Math.min(L - 1, Math.max(0, t / hop - gs)), i0 = Math.floor(fp), i1 = Math.min(L - 1, i0 + 1);
      return arr[i0] + (arr[i1] - arr[i0]) * (fp - i0);
    };
    const F = (t: number): number => at(fg, t), S = (t: number): number => at(sh, t);

    const Ls = Math.round((gs - 0.5) * hop), Le = Math.round((ge - 0.5) * hop);
    const a = Math.max(0, Ls - hf), b = Math.min(n, Le + hf);
    if (b - a < 8) continue;

    // 3) titik pitch analisis
    const marks = epochMarks(x, a, b, F, sr);

    // 4) sintesis: grain Hann 2 periode di sekitar titik analisis terdekat, ditaruh dengan jarak periode baru, posisi pecahan (interpolasi kubik)
    const y = new Float32Array(b - a);
    let ts = a, k = 0;
    while (ts < b) {
      while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
      const mk = marks[k], Ta = sr / F(mk), Ts = sr / (F(ts) * 2 ** (S(ts) / 12)), half = Math.max(2, Math.round(Ta)), gain = Ts / Ta;
      const c = Math.floor(ts), fr = ts - c;
      for (let j = -half; j <= half + 1; j++) {
        const idx = c + j - a; if (idx < 0 || idx >= y.length) continue;
        const dt = j - fr; if (dt <= -half || dt >= half) continue;
        y[idx] += cubic(x, mk + dt) * (0.5 + 0.5 * Math.cos(Math.PI * dt / half)) * gain;
      }
      ts += Ts;
    }

    // 5) campur ke keluaran: bobot naik/turun hanya di ujung kelompok (di dalam kelompok tidak ada perbatasan lagi)
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
