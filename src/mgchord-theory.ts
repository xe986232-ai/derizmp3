// MGCHORD: inti teori musik (murni, tanpa DOM): skala, chord, voicing, progression, dan ekspor MIDI.
// Dipakai oleh mgchord.ts (UI) dan bisa dites langsung dengan node (tools/mgchord-test.ts).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Skala 7 nada (interval dari tonika, semitone)
export const SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
  'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
};
export const SCALE_NAMES = Object.keys(SCALES);

// Jenis chord: interval dari root (semitone) + akhiran nama. Tiga pertama = diatonis (ikut skala), sisanya kualitas tetap di tiap derajat.
export interface ChordType { name: string; iv?: number[]; suffix?: string; stack?: number }   // stack: jumlah nada diatonis (3 = triad, 4 = 7th, 5 = 9th)
export const CHORD_TYPES: ChordType[] = [
  { name: 'Diatonic', stack: 3 },
  { name: 'Diatonic 7th', stack: 4 },
  { name: 'Diatonic 9th', stack: 5 },
  { name: 'Major', iv: [0, 4, 7], suffix: '' },
  { name: 'Minor', iv: [0, 3, 7], suffix: 'm' },
  { name: 'Major7', iv: [0, 4, 7, 11], suffix: 'maj7' },
  { name: 'Minor7', iv: [0, 3, 7, 10], suffix: 'm7' },
  { name: 'Dominant7', iv: [0, 4, 7, 10], suffix: '7' },
  { name: 'Major9', iv: [0, 4, 7, 11, 14], suffix: 'maj9' },
  { name: 'Minor9', iv: [0, 3, 7, 10, 14], suffix: 'm9' },
  { name: 'Dominant9', iv: [0, 4, 7, 10, 14], suffix: '9' },
  { name: 'Add9', iv: [0, 4, 7, 14], suffix: 'add9' },
  { name: 'Sus2', iv: [0, 2, 7], suffix: 'sus2' },
  { name: 'Sus4', iv: [0, 5, 7], suffix: 'sus4' },
  { name: 'Major6', iv: [0, 4, 7, 9], suffix: '6' },
  { name: 'Dim', iv: [0, 3, 6], suffix: 'dim' },
  { name: 'Aug', iv: [0, 4, 8], suffix: 'aug' },
];
export const CHORD_TYPE_NAMES = CHORD_TYPES.map(c => c.name);

// Penamaan kualitas dari himpunan interval (dipakai chord diatonis)
const QUALITY: Record<string, string> = {
  '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug',
  '0,4,7,11': 'maj7', '0,4,7,10': '7', '0,3,7,10': 'm7', '0,3,6,10': 'm7b5', '0,3,6,9': 'dim7', '0,3,7,11': 'mMaj7', '0,4,8,11': 'maj7#5', '0,4,8,10': '7#5',
  '0,4,7,11,14': 'maj9', '0,4,7,10,14': '9', '0,3,7,10,14': 'm9', '0,3,6,10,13': 'm7b5b9', '0,3,6,10,14': 'm7b5(9)', '0,3,7,11,14': 'mMaj9', '0,3,6,9,14': 'dim7(9)', '0,4,8,11,14': 'maj9#5', '0,4,8,10,14': '9#5',
  '0,4,7,11,13': 'maj7b9', '0,4,7,10,13': '7b9', '0,3,7,10,13': 'm7b9',
};

export interface Chord { root: number; iv: number[]; name: string }   // root: MIDI absolut; iv: interval dari root (naik)

export interface Settings {
  root: number;          // 0..11 (C = 0)
  scale: string;         // kunci SCALES
  octave: number;        // -2..2
  chordType: string;     // nama di CHORD_TYPES
}

export const BASE_MIDI = 48;   // C3: root chord pada Octave 0

const mod = (n: number, m: number): number => ((n % m) + m) % m;
const typeOf = (name: string): ChordType => CHORD_TYPES.find(c => c.name === name) ?? CHORD_TYPES[0];

/** Chord untuk derajat `deg` (0..6) pada skala terpilih. */
export function chordAt(s: Settings, deg: number): Chord {
  const sc = SCALES[s.scale] ?? SCALES.Major, d = mod(deg, 7), t = typeOf(s.chordType);
  const rootPc = mod(s.root + sc[d], 12);
  const rootMidi = BASE_MIDI + s.octave * 12 + mod(rootPc - BASE_MIDI, 12);   // root selalu di C3..B3 (+ oktaf)
  let iv: number[], name: string;
  if (t.stack) {   // diatonis: tumpuk terts pada skala
    const raw: number[] = [];
    for (let k = 0; k < t.stack; k++) { const idx = d + 2 * k; raw.push(sc[idx % 7] + 12 * Math.floor(idx / 7)); }
    iv = raw.map(x => x - raw[0]);
    name = NOTE_NAMES[rootPc] + (QUALITY[iv.join(',')] ?? '');
  } else {
    iv = t.iv!.slice();
    name = NOTE_NAMES[rootPc] + (t.suffix ?? '');
  }
  return { root: rootMidi, iv, name };
}

export interface Voicing {
  invert: number;            // 0..3
  on: boolean[];             // 5 voice menyala / mati
  shift: number[];           // 5 voice: -12 / 0 / +12
  vel: number[];             // 5 voice: velocity 0..1
}
export const VOICES = 5;
// 3 batang saja: root - terts - kuint
export const defaultVoicing = (): Voicing => ({ invert: 0, on: [true, true, true, false, false], shift: [0, 0, 0, 0, 0], vel: [0.52, 0.72, 0.18, 0.66, 0.74] });

export interface VNote { p: number; v: number }   // nada hasil voicing (MIDI + velocity 0..1), urut dari voice 1

/** Voicing: inversi, lalu voice i mengambil nada chord ke-i (berputar + naik oktaf kalau voice lebih banyak dari nada chord). */
export function voice(c: Chord, vc: Voicing): VNote[] {
  let tones = c.iv.map(i => c.root + i);
  for (let k = 0; k < Math.min(vc.invert, tones.length - 1); k++) { tones = [...tones.slice(1), tones[0] + 12]; }
  const out: VNote[] = [];
  for (let i = 0; i < VOICES; i++) {
    if (!vc.on[i]) continue;
    const p = tones[i % tones.length] + 12 * Math.floor(i / tones.length) + vc.shift[i];
    out.push({ p: Math.max(12, Math.min(120, p)), v: Math.max(0.05, Math.min(1, vc.vel[i])) });
  }
  return out;
}

// ---------- progression ----------
export interface Slot { deg: number; beats: number; root?: number; q?: 'Major' | 'Minor' }   // root + q (kalau ada) = triad langsung dari tuts keyboard; kalau tidak, chord diatonik derajat deg
export interface Preset { name: string; scale: 'Major' | 'Minor'; slots: number[] }   // slots: derajat 0..6, tiap slot 1 bar
export const PRESETS: Preset[] = [];   // dikosongkan dulu: progression dibuat sendiri lewat keyboard di kanan (contoh lama ada di riwayat git)
export const slotsOf = (p: Preset): Slot[] => p.slots.map(deg => ({ deg, beats: 4 }));

// Transisi harmoni fungsional sederhana untuk generator acak
const NEXT: number[][] = [[3, 4, 5, 1, 2, 6], [4, 6, 0], [5, 3, 1], [4, 0, 1, 6], [0, 5, 3], [3, 1, 4, 2], [0, 2, 5]];
export function randomProgression(totalBeats: number, rnd: () => number = Math.random): Slot[] {
  const out: Slot[] = [];
  let left = totalBeats, deg = 0;
  const lens = [4, 4, 4, 2, 2, 8];
  while (left > 0) {
    let b = lens[Math.floor(rnd() * lens.length)];
    if (b > left) b = left;
    out.push({ deg, beats: b }); left -= b;
    const opts = NEXT[deg]; deg = opts[Math.floor(rnd() * opts.length)];
  }
  if (out.length > 1 && rnd() < 0.7) out[out.length - 1].deg = [4, 6, 0, 3][Math.floor(rnd() * 4)];   // akhir kalimat: biasanya menggantung / resolusi
  return out;
}

// ---------- gaya main (style): 10 susunan nada ----------
// Block / Strum / Arp Up / Arp Down / Arp Ping punya logika sendiri di buildNotes; sisanya (Genjreng, Alberti, Oom-Pah, Charleston, Reggae)
// ditulis sebagai TABEL pola satu bar (4 ketukan) di PATTERNS di bawah, jadi gampang diubah / ditambah tanpa menyentuh kode lain.
export type PlayStyle = 'Block' | 'Strum' | 'Genjreng' | 'Arp Up' | 'Arp Down' | 'Arp Ping' | 'Alberti' | 'Oom-Pah' | 'Charleston' | 'Reggae';
export const STYLES: PlayStyle[] = ['Block', 'Strum', 'Genjreng', 'Arp Up', 'Arp Down', 'Arp Ping', 'Alberti', 'Oom-Pah', 'Charleston', 'Reggae'];
export const STYLE_INFO: Record<PlayStyle, { label: string; desc: string }> = {
  Block: { label: 'Block', desc: 'Semua nada chord bunyi bersamaan dan ditahan sepanjang chord' },
  Strum: { label: 'Strum', desc: 'Satu sapuan gitar pelan dari nada bawah ke atas, ditahan (cocok untuk balada)' },
  Genjreng: { label: 'Genjreng', desc: 'Genjrengan gitar bawah-bawah-atas-atas-bawah-atas (D DU UDU) dalam tiap bar' },
  'Arp Up': { label: 'Arp Up', desc: 'Nada dipetik satu-satu dari bawah ke atas (1/8, diulang)' },
  'Arp Down': { label: 'Arp Down', desc: 'Nada dipetik satu-satu dari atas ke bawah (1/8, diulang)' },
  'Arp Ping': { label: 'Arp Ping', desc: 'Naik sampai oktaf lalu turun lagi, bolak-balik' },
  Alberti: { label: 'Alberti', desc: 'Pola piano klasik bawah-atas-tengah-atas (fingerpicking 1/8)' },
  'Oom-Pah': { label: 'Oom-Pah', desc: 'Bass akar, chord, bass kuint, chord (gaya country / polka)' },
  Charleston: { label: 'Charleston', desc: 'Chord sinkopasi: ketukan 1, "dan" ketukan 2, ketukan 3, "dan" ketukan 4' },
  Reggae: { label: 'Reggae', desc: 'Chord pendek di tiap offbeat (skank) dengan bass akar di ketukan 1 dan 3' },
};
export interface Rhythm { style: PlayStyle; rate: number; strum: number }   // rate: panjang langkah arp (ketukan: 0.25 = 1/16, 0.5 = 1/8, 1 = 1/4); strum: jeda antar nada pada style Strum (ketukan)

export interface OutNote { p: number; s: number; l: number; v: number; slot: number }   // s / l dalam ketukan dari awal progression; slot = indeks chord asal

// Satu kejadian dalam pola satu bar. at / len dalam ketukan; v = pengali velocity.
//   chord = semua nada (up: disapu dari atas ke bawah, kalau tidak dari bawah ke atas), bass = akar satu oktaf di bawah, bass5 = kuint satu oktaf di bawah,
//   tone = satu nada chord urutan ke-i dari bawah (i melewati jumlah nada = naik oktaf).
interface Ev { at: number; len: number; v: number; k: 'chord' | 'bass' | 'bass5' | 'tone'; i?: number; up?: boolean }
const eighths = (seq: number[], vel: number[]): Ev[] => seq.map((i, n) => ({ at: n * 0.5, len: 0.475, v: vel[n % vel.length], k: 'tone' as const, i }));
export const PATTERNS: Partial<Record<PlayStyle, Ev[]>> = {
  Genjreng: [   // D  D U  U D U  (bawah = turun dari nada bawah, atas = naik dari nada atas, lebih lembut)
    { at: 0, len: 1, v: 1, k: 'chord' }, { at: 1, len: 0.5, v: 0.9, k: 'chord' }, { at: 1.5, len: 1, v: 0.62, k: 'chord', up: true },
    { at: 2.5, len: 0.5, v: 0.62, k: 'chord', up: true }, { at: 3, len: 0.5, v: 0.9, k: 'chord' }, { at: 3.5, len: 0.5, v: 0.68, k: 'chord', up: true },
  ],
  Alberti: eighths([0, 2, 1, 2, 0, 2, 1, 2], [1, 0.62, 0.8, 0.62, 0.95, 0.62, 0.8, 0.62]),
  'Oom-Pah': [
    { at: 0, len: 0.9, v: 0.95, k: 'bass' }, { at: 1, len: 0.9, v: 0.7, k: 'chord' }, { at: 2, len: 0.9, v: 0.85, k: 'bass5' }, { at: 3, len: 0.9, v: 0.7, k: 'chord' },
  ],
  Charleston: [
    { at: 0, len: 1.4, v: 1, k: 'chord' }, { at: 1.5, len: 0.4, v: 0.8, k: 'chord' }, { at: 2, len: 1.4, v: 0.9, k: 'chord' }, { at: 3.5, len: 0.4, v: 0.8, k: 'chord' },
  ],
  Reggae: [
    { at: 0, len: 1.4, v: 0.8, k: 'bass' }, { at: 0.5, len: 0.3, v: 0.85, k: 'chord' }, { at: 1.5, len: 0.3, v: 0.85, k: 'chord' },
    { at: 2, len: 1.4, v: 0.75, k: 'bass' }, { at: 2.5, len: 0.3, v: 0.85, k: 'chord' }, { at: 3.5, len: 0.3, v: 0.85, k: 'chord' },
  ],
};
const SWEEP = 0.04;   // jeda antar nada saat disapu (ketukan) pada style Genjreng
const lim = (p: number): number => Math.max(12, Math.min(120, p)), vlim = (v: number): number => Math.max(0.05, Math.min(1, v));

function patternNotes(ev: Ev[], c: Chord, vn: VNote[], t: number, beats: number, si: number, out: OutNote[]): void {
  const sorted = [...vn].sort((a, b) => a.p - b.p), n = sorted.length, five = c.iv.find(x => x >= 6 && x <= 8) ?? 7;
  for (let b0 = 0; b0 < beats - 1e-9; b0 += 4) {   // pola satu bar diulang sampai chord habis
    for (const e of ev) {
      const s = b0 + e.at; if (s >= beats - 1e-9) continue;
      const l = Math.min(e.len, beats - s);
      if (e.k === 'chord') {
        const seq = e.up ? [...sorted].reverse() : sorted;
        seq.forEach((x, j) => { const g = Math.min(SWEEP, (l * 0.5) / n); out.push({ p: x.p, s: t + s + j * g, l: Math.max(0.05, l - j * g), v: vlim(x.v * e.v), slot: si }); });
      } else if (e.k === 'tone') {
        const i = e.i ?? 0, x = sorted[i % n];
        out.push({ p: lim(x.p + 12 * Math.floor(i / n)), s: t + s, l, v: vlim(x.v * e.v), slot: si });
      } else {
        out.push({ p: lim(c.root + (e.k === 'bass5' ? five : 0) - 12), s: t + s, l, v: vlim(0.9 * e.v), slot: si });
      }
    }
  }
}

export function buildNotes(st: Settings, slots: Slot[], vc: Voicing, rh: Rhythm): OutNote[] {
  const out: OutNote[] = [];
  let t = 0;
  slots.forEach((sl, si) => {
    const c = slotChord(st, sl), vn = voice(c, vc);
    if (vn.length) {
      if (rh.style === 'Strum') {
        const sorted = [...vn].sort((a, b) => a.p - b.p), gap = Math.min(rh.strum, sl.beats / (sorted.length + 1));
        sorted.forEach((n, i) => out.push({ p: n.p, s: t + i * gap, l: sl.beats - i * gap, v: n.v, slot: si }));
      } else if (rh.style === 'Arp Up' || rh.style === 'Arp Down' || rh.style === 'Arp Ping') {
        let sorted = [...vn].sort((a, b) => (rh.style === 'Arp Down' ? b.p - a.p : a.p - b.p));
        if (rh.style === 'Arp Ping') {   // naik sampai oktaf akar, lalu turun tanpa mengulang nada ujung: 0 1 2 3 2 1 | 0 1 2 3 ...
          const up = [...vn].sort((a, b) => a.p - b.p), top = { p: lim(up[0].p + 12), v: up[0].v };
          sorted = [...up, top, ...up.slice(1).reverse()];
        }
        const step = rh.rate, cnt = Math.max(1, Math.round(sl.beats / step));
        for (let k = 0; k < cnt; k++) { const n = sorted[k % sorted.length]; out.push({ p: n.p, s: t + k * step, l: step * 0.95, v: n.v, slot: si }); }
      } else if (PATTERNS[rh.style]) {
        patternNotes(PATTERNS[rh.style]!, c, vn, t, sl.beats, si, out);
      } else {   // Block (dan nama style yang tidak dikenal)
        for (const n of vn) out.push({ p: n.p, s: t, l: sl.beats, v: n.v, slot: si });
      }
    }
    t += sl.beats;
  });
  return out;
}

/** Triad mayor / minor di nada `rootPc` (0..11): C mayor = C E G, C minor = C D# G. Root di oktaf C3. */
export const triadAt = (rootPc: number, q: 'Major' | 'Minor'): Chord => {
  const pc = mod(rootPc, 12);
  return { root: BASE_MIDI + pc, iv: q === 'Minor' ? [0, 3, 7] : [0, 4, 7], name: NOTE_NAMES[pc] + (q === 'Minor' ? 'm' : '') };
};
export const slotChord = (st: Settings, sl: Slot): Chord => (sl.root !== undefined ? triadAt(sl.root, sl.q ?? 'Major') : chordAt(st, sl.deg));

export const totalBeats = (slots: Slot[]): number => slots.reduce((a, s) => a + s.beats, 0);

// ---------- ekspor MIDI (SMF type 0, 480 ppq) ----------
export function toMidi(notes: OutNote[], bpm: number): Uint8Array {
  const PPQ = 480, ev: { t: number; b: number[] }[] = [];
  for (const n of notes) {
    const s = Math.round(n.s * PPQ), e = Math.max(s + 1, Math.round((n.s + n.l) * PPQ)), vel = Math.max(1, Math.min(127, Math.round(n.v * 127)));
    ev.push({ t: s, b: [0x90, n.p, vel] }, { t: e, b: [0x80, n.p, 0] });
  }
  ev.sort((a, b) => a.t - b.t || (a.b[0] === 0x80 ? -1 : 1) - (b.b[0] === 0x80 ? -1 : 1));
  const vlq = (v: number): number[] => { const o = [v & 0x7f]; while ((v >>= 7) > 0) o.unshift((v & 0x7f) | 0x80); return o; };
  const us = Math.round(60000000 / Math.max(20, Math.min(400, bpm)));
  const trk: number[] = [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
  let last = 0;
  for (const e of ev) { trk.push(...vlq(e.t - last), ...e.b); last = e.t; }
  trk.push(0, 0xff, 0x2f, 0);
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const hdr = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255];
  return Uint8Array.from([...hdr, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk]);
}

export const midiName = (m: number): string => NOTE_NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1);
