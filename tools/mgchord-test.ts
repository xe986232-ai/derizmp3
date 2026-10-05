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
const arp = buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Arp Up', rate: 0.5, strum: 0 });
eq('arp 1/8 over 1 bar = 8 notes', arp.length, 8);
const str = buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Strum', rate: 0.5, strum: 0.2 });
eq('strum offsets', str.map(n => +n.s.toFixed(2)), [0, 0.2, 0.4, 0.6, 0.8]);
const mid = toMidi(buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Block', rate: 0.5, strum: 0 }), 120);
eq('midi header', String.fromCharCode(...mid.slice(0, 4)) + String.fromCharCode(...mid.slice(14, 18)), 'MThdMTrk');
eq('default voicing = 3 batang', voice(triadAt(0, 'Major'), defaultVoicing()).map(n => n.p), [48, 52, 55]);
eq('C minor = C D# G', voice(triadAt(0, 'Minor'), defaultVoicing()).map(n => n.p), [48, 51, 55]);
eq('triad names', [triadAt(0, 'Major').name, triadAt(1, 'Minor').name], ['C', 'C#m']);

// ---- 10 style susunan nada ----
eq('ada 10 style', STYLES.length, 10);
const v3 = defaultVoicing(), bar = [{ deg: 0, beats: 4 }], two = [{ deg: 0, beats: 4 }, { deg: 3, beats: 4 }];
const rh = (style: (typeof STYLES)[number]) => ({ style, rate: 0.5, strum: 0.12 });
for (const sty of STYLES) {
  const n = buildNotes(S(), two, v3, rh(sty));
  const ok = n.length > 0 && n.every(x => Number.isFinite(x.p) && x.p >= 12 && x.p <= 120 && x.s >= 0 && x.l > 0 && x.v > 0 && x.v <= 1 && x.s < 8 && x.slot === (x.s < 4 ? 0 : 1));
  eq('style ' + sty + ': nada valid, di dalam chordnya', ok, true);
  eq('style ' + sty + ': tidak ada nada melewati akhir chord (maks 1e-6)', n.every(x => x.s + x.l <= (x.slot + 1) * 4 + 1e-6), true);
}
eq('Block = 3 nada', buildNotes(S(), bar, v3, rh('Block')).length, 3);
eq('Genjreng = 6 sapuan x 3 nada per bar', buildNotes(S(), bar, v3, rh('Genjreng')).length, 18);
eq('Genjreng: awal tiap sapuan', [...new Set(buildNotes(S(), bar, v3, rh('Genjreng')).map(n => Math.floor(n.s * 2) / 2))], [0, 1, 1.5, 2.5, 3, 3.5]);
eq('Genjreng sapuan bawah naik, sapuan atas turun', [buildNotes(S(), bar, v3, rh('Genjreng')).slice(0, 3).map(n => n.p), buildNotes(S(), bar, v3, rh('Genjreng')).slice(6, 9).map(n => n.p)], [[48, 52, 55], [55, 52, 48]]);
eq('Alberti = 8 nada bawah-atas-tengah-atas', buildNotes(S(), bar, v3, rh('Alberti')).slice(0, 4).map(n => n.p), [48, 55, 52, 55]);
eq('Arp Ping urutan', buildNotes(S(), bar, v3, rh('Arp Ping')).map(n => n.p), [48, 52, 55, 60, 55, 52, 48, 52]);
eq('Oom-Pah: bass C2, chord, bass G2, chord', buildNotes(S(), bar, v3, rh('Oom-Pah')).filter(n => n.p < 48).map(n => [n.p, n.s]), [[36, 0], [43, 2]]);
eq('Charleston: 4 serangan x 3 nada', buildNotes(S(), bar, v3, rh('Charleston')).length, 12);
eq('Reggae: chord di offbeat saja', [...new Set(buildNotes(S(), bar, v3, rh('Reggae')).filter(n => n.p >= 48).map(n => Math.floor(n.s)))], [0, 1, 2, 3]);
eq('pola diulang tiap bar (8 ketukan = 2x Alberti)', buildNotes(S(), [{ deg: 0, beats: 8 }], v3, rh('Alberti')).length, 16);
eq('chord 2 ketukan dipotong di batasnya', buildNotes(S(), [{ deg: 0, beats: 2 }], v3, rh('Oom-Pah')).every(n => n.s + n.l <= 2 + 1e-6), true);
eq('style tak dikenal jatuh ke Block', buildNotes(S(), bar, v3, rh('Nope' as never)).length, 3);
console.log(fail ? fail + ' GAGAL' : 'semua lolos'); process.exit(fail ? 1 : 0);
