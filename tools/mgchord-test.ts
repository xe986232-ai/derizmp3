// Tes inti teori MGCHORD: node tools/mgchord-test.ts
import { chordAt, triadAt, voice, defaultVoicing, buildNotes, PRESETS, slotsOf, randomProgression, toMidi, totalBeats, VOICES, STYLES, type Settings } from '../src/mgchord-theory.ts';
let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' -> ' + JSON.stringify(a) + ' != ' + JSON.stringify(b))); };
const S = (o: Partial<Settings> = {}): Settings => ({ root: 0, scale: 'Major', octave: 0, chordType: 'Diatonic', ...o });

eq('C major I', chordAt(S(), 0).name, 'C');
eq('C major ii', chordAt(S(), 1).name, 'Dm');
eq('C major vii', chordAt(S(), 6).name, 'Bdim');
eq('C major V 7th', chordAt(S({ chordType: 'Diatonic 7th' }), 4).name, 'G7');
eq('C major I 7th', chordAt(S({ chordType: 'Diatonic 7th' }), 0).name, 'Cmaj7');
eq('C minor i 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 0).name, 'Cm9');
eq('C minor VI 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 5).name, 'G#maj9');
eq('C minor VII 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 6).name, 'A#9');
eq('fixed Major9 on iv', chordAt(S({ scale: 'Minor', chordType: 'Major9' }), 3).name, 'Fmaj9');
eq('A minor i', chordAt(S({ root: 9, scale: 'Minor' }), 0).name, 'Am');
eq('A minor root midi in C3..B3', chordAt(S({ root: 9, scale: 'Minor' }), 0).root, 57);
eq('octave +1', chordAt(S({ octave: 1 }), 0).root, 60);
eq('C iv in A minor stays low', chordAt(S({ root: 9, scale: 'Minor' }), 3).root, 50);

const c = chordAt(S(), 0), vc = { ...defaultVoicing(), on: [true, true, true, true, true] };   // tes voicing lama: 5 voice penuh (bawaan baru = 3 batang)
eq('5 voices triad doubles up', voice(c, vc).map(n => n.p), [48, 52, 55, 60, 64]);
eq('voice off', voice(c, { ...vc, on: [true, false, true, false, true] }).map(n => n.p), [48, 55, 64]);
eq('shift -12', voice(c, { ...vc, shift: [-12, 0, 0, 0, 0] })[0].p, 36);
eq('inversion 1', voice(c, { ...vc, invert: 1 }).map(n => n.p), [52, 55, 60, 64, 67]);

for (const p of PRESETS) {
  const st = S({ scale: p.scale }), sl = slotsOf(p), n = buildNotes(st, sl, vc, { style: 'Block', rate: 0.5, strum: 0.1 });
  eq('preset ' + p.name + ' notes', n.length, sl.length * VOICES);
}
const rp = randomProgression(16, (() => { let x = 7; return () => (x = (x * 16807) % 2147483647) / 2147483647; })());
eq('random fills 16 beats', totalBeats(rp), 16);
const mid = toMidi(buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Block', rate: 0.5, strum: 0 }), 120);
eq('midi header', String.fromCharCode(...mid.slice(0, 4)) + String.fromCharCode(...mid.slice(14, 18)), 'MThdMTrk');
eq('default voicing = 3 batang', voice(triadAt(0, 'Major'), defaultVoicing()).map(n => n.p), [48, 52, 55]);
eq('C minor = C D# G', voice(triadAt(0, 'Minor'), defaultVoicing()).map(n => n.p), [48, 51, 55]);
eq('triad names', [triadAt(0, 'Major').name, triadAt(1, 'Minor').name], ['C', 'C#m']);

// ---- style susunan nada (pola dari contoh MIDI Indian Beat) ----
eq('Block + 10 pola', STYLES.length, 11);
const v3 = defaultVoicing(), bar = [{ deg: 0, beats: 4 }], two = [{ deg: 0, beats: 4 }, { deg: 3, beats: 4 }];
const rh = (style: (typeof STYLES)[number]) => ({ style, rate: 0.5, strum: 0.12 });
for (const sty of STYLES) {
  const n = buildNotes(S(), two, v3, rh(sty));
  const ok = n.length > 0 && n.every(x => Number.isFinite(x.p) && x.p >= 12 && x.p <= 120 && x.s >= 0 && x.l > 0 && x.v > 0 && x.v <= 1 && x.s < 8 && x.slot === (x.s < 4 ? 0 : 1));
  eq('style ' + sty + ': nada valid, di dalam chordnya', ok, true);
  eq('style ' + sty + ': tidak melewati akhir bar (maks 1e-6)', n.every(x => x.s + x.l <= (x.slot + 1) * 4 + 1e-6), true);
}
// contoh MIDI: F# minor, chord F#m - D - A - E (derajat i VI III VII), tiap chord 1 bar. Pluck harus sama dengan bar 1 / bar 7 contoh.
const fsm = S({ root: 6, scale: 'Minor' }), prog = [0, 5, 2, 6].map(deg => ({ deg, beats: 4 }));
const pl = buildNotes(fsm, prog, v3, rh('Pluck')), at = (b: number) => pl.filter(n => n.slot === b);
eq('Pluck F#m = F#4 C#5 F#5 A5 F#5', at(0).map(n => n.p), [66, 73, 78, 81, 78]);
eq('Pluck F#m ketukan', at(0).map(n => n.s), [0, 0.5, 1, 1.5, 3]);
eq('Pluck A = A4 E5 A5 C#6 A5 (bar 7 contoh)', at(2).map(n => n.p), [69, 76, 81, 85, 81]);
eq('Pluck E = E4 B4 E5 G#5 E5 (bar 8 contoh)', at(3).map(n => n.p), [64, 71, 76, 80, 76]);
eq('Pluck ditahan sampai akhir bar', at(0).map(n => n.s + n.l), [4, 4, 4, 4, 4]);
eq('Pad Run F#m bagian lari', buildNotes(fsm, [prog[0]], v3, rh('Pad Run')).filter(n => n.s >= 2).map(n => [n.p, n.s]), [[73, 2], [81, 2.5], [85, 3], [81, 3.5]]);
eq('Tresillo = 3 pukulan x 3 nada', buildNotes(S(), bar, v3, rh('Tresillo')).length, 9);
eq('Dholak = 6 pukulan', buildNotes(S(), bar, v3, rh('Dholak')).length, 6);
eq('Tisra = 12 petikan triplet', buildNotes(S(), bar, v3, rh('Tisra')).length, 12);
eq('Roll = 10 nada', buildNotes(S(), bar, v3, rh('Roll')).length, 10);
eq('Block = 3 nada', buildNotes(S(), bar, v3, rh('Block')).length, 3);
eq('pola diulang tiap bar (8 ketukan = 2x Pluck)', buildNotes(S(), [{ deg: 0, beats: 8 }], v3, rh('Pluck')).length, 10);
eq('chord 2 ketukan dipotong di batasnya', buildNotes(S(), [{ deg: 0, beats: 2 }], v3, rh('Pluck')).every(n => n.s + n.l <= 2 + 1e-6), true);
eq('style lama / tak dikenal jatuh ke Block', buildNotes(S(), bar, v3, rh('Genjreng' as never)).length, 3);
console.log(fail ? fail + ' GAGAL' : 'semua lolos'); process.exit(fail ? 1 : 0);
