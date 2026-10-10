// Mesin MIDI untuk plugin Printer (Melody Printer): murni (tanpa DOM / Web Audio), jadi bisa dites di Node.
//   Note hasil analisis MPCS (frame, pitch pecahan)  ->  nada MIDI bulat (ketukan)  ->  file .mid (SMF format 0).
// Tanpa knob: setara Lock 100% / Human 0% / Glide 0%. Pitch selalu dibulatkan penuh ke semiton, tanpa vibrato dan luncuran.

import type { Note, PitchTrack } from './mpcs-dsp';

export interface PrintNote { p: number; s: number; l: number; v: number }   // p = nomor MIDI, s / l = ketukan (beat), v = velocity 1..127
export interface PrintOpts {
  bpm: number;
  minMs?: number;       // nada lebih pendek dari ini dibuang (bawaan 60 ms)
  mergeGapMs?: number;  // dua nada sama berurutan dengan jeda <= ini digabung (bawaan 40 ms)
  grid?: number;        // 0 / kosong = tanpa kuantisasi ritme; selain itu awal DAN akhir tiap nada menempel ke garis grid terdekat (dalam ketukan: 1 = 1/4, 0.5 = 1/8, 0.25 = 1/16, 0.125 = 1/32)
  scale?: { root: number; mode: 'major' | 'minor' } | null;   // kunci ke tangga nada (opsional)
}

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

export function snapToScale(p: number, root: number, mode: 'major' | 'minor'): number {
  const set = SCALES[mode];
  let best = p, bd = 99;
  for (let d = -6; d <= 6; d++) {
    const q = p + d, pc = (((q - root) % 12) + 12) % 12;
    if (set.includes(pc) && Math.abs(d) < bd) { bd = Math.abs(d); best = q; }   // seri: yang lebih rendah menang (d naik dari -6)
  }
  return best;
}

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/** Nada MPCS -> nada MIDI bulat. `pt` dipakai untuk waktu (hop / sr) dan kerasnya suara (rms -> velocity). */
export function notesToPrint(notes: Note[], pt: PitchTrack, o: PrintOpts): PrintNote[] {
  const bpm = o.bpm > 0 ? o.bpm : 120, minMs = o.minMs ?? 60, gapMs = o.mergeGapMs ?? 40;
  const fs = pt.hop / pt.sr;   // detik per frame
  const raw: { p: number; t0: number; t1: number; rms: number; sf: number; ef: number }[] = [];   // sf / ef = frame awal / akhir (untuk cek energi di celah)
  for (const n of notes) {
    const t0 = n.s * fs, t1 = n.e * fs;
    if ((t1 - t0) * 1000 < minMs) continue;
    let p = Math.round(Number.isFinite(n.target) ? n.target : n.midi);
    if (o.scale) p = snapToScale(p, o.scale.root, o.scale.mode);
    p = clamp(p, 0, 127);
    let sum = 0, c = 0;
    for (let f = n.s; f < n.e && f < pt.rms.length; f++) { sum += pt.rms[f]; c++; }
    raw.push({ p, t0, t1, rms: c ? sum / c : 0, sf: n.s, ef: n.e });
  }
  raw.sort((a, b) => a.t0 - b.t0);
  // Lembah energi di antara dua nada = penyanyi mengulang nada ("ta-ta-ta"), BUKAN satu nada yang dipotong tracker. Energi di celah jatuh di bawah separuh tepinya.
  const lev = pt.env ?? pt.rms;
  const peakAt = (a: number, b: number): number => { let m = 0; for (let f = Math.max(0, a); f <= Math.min(lev.length - 1, b); f++) if (lev[f] > m) m = lev[f]; return m; };
  const hasDip = (L: { ef: number }, R: { sf: number }): boolean => {
    const lo = Math.max(0, L.ef - 1), hi = Math.min(lev.length - 1, R.sf + 1);
    if (hi < lo) return false;
    let mn = Infinity; for (let f = lo; f <= hi; f++) if (lev[f] < mn) mn = lev[f];
    const edge = Math.min(peakAt(L.ef - 5, L.ef - 1), peakAt(R.sf, R.sf + 4));
    return edge > 0 && mn < 0.5 * edge;
  };
  // gabung nada sama yang berdempetan (tracker kadang memotong satu nada panjang jadi dua), kecuali ada lembah energi di antaranya
  const mg: typeof raw = [];
  for (const r of raw) {
    const L = mg[mg.length - 1];
    if (L && L.p === r.p && (r.t0 - L.t1) * 1000 <= gapMs && !hasDip(L, r)) { L.rms = (L.rms * (L.t1 - L.t0) + r.rms * (r.t1 - r.t0)) / Math.max(1e-9, r.t1 - L.t0); L.t1 = Math.max(L.t1, r.t1); L.ef = Math.max(L.ef, r.ef); }
    else mg.push({ ...r });
  }
  // Nada pendek yang jauh dari konteksnya (nada-nada di sekitarnya, +-1,2 detik) hampir pasti salah deteksi tracker:
  //   - selisihnya pas kelipatan harmonik (12 = oktaf, 19 = harmonik ke-3, 24 = dua oktaf) dan hasil lipatannya jatuh dekat konteks -> tracker mengunci harmonik / sub-harmonik: dilipat
  //   - selain itu (napas, konsonan, desis, getaran noise terbaca sebagai nada: E6, A1, dst) dan nyaris tak didukung nada lain yang sepitch di sekitarnya -> dibuang
  // Nada panjang (>= 350 ms) tidak pernah disentuh: itu lompatan melodi sungguhan. Bagian yang memang rendah / tinggi aman karena banyak nada lain yang sepitch mendukungnya.
  const CTX = 1.2, SHORT = 0.35;
  const mid = (r: { t0: number; t1: number }): number => (r.t0 + r.t1) / 2;
  const drop = new Set<number>();
  for (let i = 0; i < mg.length; i++) {
    const c = mg[i]; if (c.t1 - c.t0 >= SHORT) continue;
    const ctx: { p: number; l: number }[] = []; let support = 0;
    for (let j = 0; j < mg.length; j++) { if (j === i || drop.has(j) || Math.abs(mid(mg[j]) - mid(c)) > CTX) continue; const l = mg[j].t1 - mg[j].t0; ctx.push({ p: mg[j].p, l }); if (Math.abs(mg[j].p - c.p) <= 2) support += l; }
    if (ctx.length < 2) continue;
    ctx.sort((a, b) => a.p - b.p);
    let tot = 0; for (const k of ctx) tot += k.l;
    let acc = 0, med = ctx[0].p; for (const k of ctx) { acc += k.l; if (acc >= tot / 2) { med = k.p; break; } }   // median berbobot panjang nada
    const d = c.p - med;
    if (Math.abs(d) < 9) continue;
    const lone = support < 0.5;   // hampir tak ada nada lain yang sepitch di sekitarnya
    let folded = false;
    if (c.t1 - c.t0 < 0.25 || lone) {
      for (const sh of [12, 19, 24]) {
        if (Math.abs(Math.abs(d) - sh) > 1.5) continue;
        const np = c.p - Math.sign(d) * sh;
        if (Math.abs(np - med) <= 3) { c.p = clamp(np, 0, 127); folded = true; break; }
      }
    }
    if (!folded && lone) drop.add(i);
  }
  for (let i = mg.length - 1; i >= 0; i--) if (drop.has(i)) mg.splice(i, 1);
  // velocity: rms dinormalkan ke nada terkeras, dipetakan 40..120
  const peak = Math.max(1e-9, ...mg.map(r => r.rms));
  const spb = 60 / bpm;   // detik per ketukan
  const g = o.grid && o.grid > 0 ? o.grid : 0;
  const snap = (x: number): number => Math.round(Math.round(x / g) * g * 1e9) / 1e9;   // garis grid terdekat (dibulatkan 1e-9 supaya tidak ada sisa desimal)
  const vel = (rms: number): number => Math.round(clamp(40 + 80 * Math.sqrt(rms / peak), 1, 127));
  const out: PrintNote[] = [], raw0: number[] = [];   // raw0 = panjang asli (detik) tiap nada di out, untuk memilih pemenang kalau dua nada jatuh di langkah grid yang sama
  for (const r of mg) {
    let s = r.t0 / spb, e = r.t1 / spb;
    if (g) {
      // tiap nada menempel di grid terdekat: awal dan akhir sama-sama dibulatkan, panjang minimal satu langkah, jadi semua nada tepat di garis grid (tanpa geser / delay)
      s = snap(s); e = snap(e); if (e < s + g - 1e-9) e = s + g;
      const L = out[out.length - 1];
      if (L && L.s >= s - 1e-9) {   // dua nada jatuh di langkah grid yang sama (suara tunggal): pitch sama digabung, pitch beda -> yang aslinya lebih panjang menang
        if (L.p === r.p) L.l = Math.max(L.l, e - L.s);
        else if (r.t1 - r.t0 > raw0[raw0.length - 1]) { out[out.length - 1] = { p: r.p, s: L.s, l: Math.max(e - L.s, g), v: vel(r.rms) }; raw0[raw0.length - 1] = r.t1 - r.t0; }
        continue;
      }
    }
    const l = e - s; if (l <= 1e-6) continue;
    out.push({ p: r.p, s, l, v: vel(r.rms) }); raw0.push(r.t1 - r.t0);
  }
  // satu suara saja: potong nada yang menimpa nada berikutnya
  for (let i = 0; i + 1 < out.length; i++) { const lim = out[i + 1].s - out[i].s; if (out[i].l > lim) out[i].l = Math.max(1e-3, lim); }
  return out;
}

const vlq = (n: number): number[] => {
  let v = Math.max(0, Math.round(n)); const b = [v & 0x7f];
  while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80);
  return b;
};
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255];

export const PPQ = 480;

/** Tulis file .mid (SMF format 0, satu track, satu channel). */
export function writeMidiFile(notes: PrintNote[], bpm: number, name = 'Melody Printer'): Uint8Array {
  const ev: { t: number; order: number; d: number[] }[] = [];
  for (const n of notes) {
    const on = Math.round(n.s * PPQ), off = Math.max(on + 1, Math.round((n.s + n.l) * PPQ));
    ev.push({ t: on, order: 1, d: [0x90, n.p & 127, clamp(Math.round(n.v), 1, 127)] });
    ev.push({ t: off, order: 0, d: [0x80, n.p & 127, 0] });   // note off lebih dulu daripada note on di tick yang sama
  }
  ev.sort((a, b) => a.t - b.t || a.order - b.order);
  const tr: number[] = [];
  const us = Math.round(60_000_000 / (bpm > 0 ? bpm : 120));
  tr.push(0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
  const nm = Array.from(new TextEncoder().encode(name));
  tr.push(0, 0xff, 0x03, ...vlq(nm.length), ...nm);
  let last = 0;
  for (const e of ev) { tr.push(...vlq(e.t - last), ...e.d); last = e.t; }
  tr.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ), 0x4d, 0x54, 0x72, 0x6b, ...u32(tr.length), ...tr]);
}

/** Baca balik .mid buatan writeMidiFile (untuk tes). */
export function readMidiFile(b: Uint8Array): { bpm: number; ppq: number; notes: { p: number; on: number; off: number; v: number }[] } {
  let i = 14; const ppq = (b[12] << 8) | b[13]; i += 8;
  let t = 0, bpm = 120; const open = new Map<number, { on: number; v: number }>(), notes: { p: number; on: number; off: number; v: number }[] = [];
  const rd = (): number => { let v = 0, c: number; do { c = b[i++]; v = (v << 7) | (c & 127); } while (c & 128); return v; };
  while (i < b.length) {
    t += rd(); const st = b[i++];
    if (st === 0xff) { const ty = b[i++], len = rd(); if (ty === 0x51) bpm = 60_000_000 / ((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]); i += len; if (ty === 0x2f) break; }
    else if ((st & 0xf0) === 0x90) { const p = b[i++], v = b[i++]; if (v > 0) open.set(p, { on: t, v }); else { const o = open.get(p); if (o) { notes.push({ p, on: o.on, off: t, v: o.v }); open.delete(p); } } }
    else if ((st & 0xf0) === 0x80) { const p = b[i++]; i++; const o = open.get(p); if (o) { notes.push({ p, on: o.on, off: t, v: o.v }); open.delete(p); } }
  }
  return { bpm, ppq, notes };
}
